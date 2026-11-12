import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import {
  AUTH_STORE,
  DuplicateAuthRecordError,
  type AuthStore,
  type MembershipRecord,
  type PublicUser,
  type UserRecord,
} from "../auth/auth.store.js";
import { normalizeEmail, toPublicUser } from "../auth/auth.service.js";
import { assertEmail, assertPassword } from "../auth/credentials.js";
import { hashPassword } from "../auth/passwords.js";
import { uuidv7 } from "../domain/uuid7.js";
import { LEAGUE_STORE, type LeagueStore, type OrganizationRecord } from "../store/league.store.js";
import {
  assertKnownFields,
  assertObject,
  requiredString,
} from "../admin/catalog.dto.js";
import { removeSetupTokenFile, safeEqual, SETUP_TOKEN_STATE, type SetupTokenState } from "./setup-token.js";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG = 80;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

export interface SetupResult {
  organization: OrganizationRecord;
  user: PublicUser;
  membership: MembershipRecord;
}

export interface SetupStatus {
  required: boolean;
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);
  /** Attempt timestamps keyed by client IP; in-memory on purpose. */
  private readonly attempts = new Map<string, number[]>();
  /** Serializes setup requests so two concurrent calls cannot both win. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(AUTH_STORE) private readonly auth: AuthStore,
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(SETUP_TOKEN_STATE) private readonly tokenState: SetupTokenState,
  ) {}

  async status(): Promise<SetupStatus> {
    return { required: (await this.auth.countUsers()) === 0 };
  }

  async setup(body: unknown, clientIp: string): Promise<SetupResult> {
    const run = this.queue.then(
      () => this.runSetup(body, clientIp),
      () => this.runSetup(body, clientIp),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSetup(body: unknown, clientIp: string): Promise<SetupResult> {
    this.consumeAttempt(clientIp);

    if ((await this.auth.countUsers()) > 0) {
      throw new ConflictException("setup already completed");
    }

    const input = assertObject(body);
    assertKnownFields(input, ["token", "organization", "admin"]);

    const token = requiredString(input, "token", 512);
    if (!safeEqual(token, this.tokenState.token)) {
      throw new UnauthorizedException("invalid setup token");
    }

    const organizationInput = assertObject(input.organization);
    assertKnownFields(organizationInput, ["name", "slug"]);
    const adminInput = assertObject(input.admin);
    assertKnownFields(adminInput, ["name", "email", "password"]);

    const organizationName = requiredString(organizationInput, "name");
    const organizationSlug = requiredString(organizationInput, "slug", MAX_SLUG);
    if (!SLUG.test(organizationSlug)) {
      throw new BadRequestException(
        "organization slug must be lowercase kebab-case",
      );
    }
    const adminName = requiredString(adminInput, "name");
    const adminEmail = normalizeEmail(assertEmail(requiredString(adminInput, "email", 254)));
    const adminPassword = assertPassword(
      requiredString(adminInput, "password", 200),
    );

    const organizations = await this.league.listOrganizations();
    if (organizations.some((row) => row.slug === organizationSlug)) {
      throw new ConflictException(`organization slug ${organizationSlug} already exists`);
    }

    const now = new Date().toISOString();
    const organization: OrganizationRecord = {
      id: uuidv7(),
      name: organizationName,
      slug: organizationSlug,
      createdAt: now,
    };
    const userInput: UserRecord = {
      id: uuidv7(),
      email: adminEmail,
      name: adminName,
      passwordHash: hashPassword(adminPassword),
      status: "active",
      createdAt: now,
    };
    const membershipInput: MembershipRecord = {
      id: uuidv7(),
      userId: userInput.id,
      scopeType: "organization",
      scopeId: organization.id,
      role: "org_admin",
      createdAt: now,
    };

    // The auth and league stores share a pool but are separate objects and
    // cannot span one transaction here, so a failed second write is
    // compensated by deleting everything created in this call.
    let createdUser: UserRecord | null = null;
    try {
      await this.league.upsertOrganization(organization);
      createdUser = await this.auth.createUser(userInput);
      const membership = await this.auth.upsertMembership(membershipInput);
      removeSetupTokenFile(this.tokenState, (message) => this.logger.warn(message));

      return {
        organization,
        user: toPublicUser(createdUser),
        membership,
      };
    } catch (error) {
      await this.compensate(organization.id, createdUser?.id ?? null);
      if (error instanceof DuplicateAuthRecordError) {
        throw new ConflictException("email already exists");
      }
      throw error;
    }
  }

  /**
   * Sliding-window limiter: five attempts per minute per IP, counted before
   * the token is compared so a brute-force loop burns its budget either way.
   */
  private consumeAttempt(clientIp: string): void {
    const now = Date.now();
    const recent = (this.attempts.get(clientIp) ?? []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    if (recent.length >= RATE_LIMIT_MAX_ATTEMPTS) {
      this.attempts.set(clientIp, recent);
      throw new HttpException(
        "too many setup attempts",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.attempts.set(clientIp, recent);
  }

  private async compensate(organizationId: string, userId: string | null): Promise<void> {
    if (userId !== null) {
      await this.auth.deleteUser(userId).catch((error: unknown) => {
        this.logger.error(`setup compensation could not delete user: ${String(error)}`);
      });
    }
    await this.league.deleteOrganization(organizationId).catch((error: unknown) => {
      this.logger.error(
        `setup compensation could not delete organization: ${String(error)}`,
      );
    });
  }
}
