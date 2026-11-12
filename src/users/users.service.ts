import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  AUTH_STORE,
  DuplicateAuthRecordError,
  ROLES,
  SCOPE_TYPES,
  type AuthStore,
  type MembershipRecord,
  type PublicUser,
  type Role,
  type ScopeType,
  type UserRecord,
  type UserStatus,
} from "../auth/auth.store.js";
import { normalizeEmail, toPublicUser } from "../auth/auth.service.js";
import { assertEmail, assertPassword } from "../auth/credentials.js";
import { hashPassword } from "../auth/passwords.js";
import type { AuthContext } from "../auth/auth.service.js";
import { uuidv7 } from "../domain/uuid7.js";
import { LEAGUE_STORE, type LeagueStore } from "../store/league.store.js";
import {
  assertKnownFields,
  assertObject,
  isUuidV7,
  patchEnum,
  patchString,
  requiredEnum,
  requiredString,
  requiredUuid,
} from "../admin/catalog.dto.js";
import { MembershipScopeService } from "../memberships/membership-scope.service.js";

const USER_STATUSES = ["active", "disabled"] as const;
const MAX_EMAIL = 254;

export interface CreatedUser {
  user: PublicUser;
  memberships: MembershipRecord[];
}

export interface PasswordChange {
  updated: true;
  sessionsRevoked: number;
}

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

interface MembershipInput {
  scopeType: ScopeType;
  scopeId: string;
  role: Role;
}

/**
 * User and membership administration. Every method starts from the caller's
 * organization, which is the scope of their `org_admin` membership. A user or
 * membership outside that organization answers `404`, never `403`, so the API
 * does not reveal that another deployment/organization has that id.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(AUTH_STORE) private readonly auth: AuthStore,
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(MembershipScopeService) private readonly scopes: MembershipScopeService,
  ) {}

  async listUsers(auth: AuthContext): Promise<PublicUser[]> {
    const organizationId = this.callerOrganization(auth);
    return this.auth.listUsersByOrganization(
      organizationId,
      await this.organizationScopeIds(organizationId),
    );
  }

  async createUser(auth: AuthContext, body: unknown): Promise<CreatedUser> {
    const organizationId = this.callerOrganization(auth);
    const input = assertObject(body);
    assertKnownFields(input, ["email", "name", "password", "memberships"]);

    const email = normalizeEmail(
      assertEmail(requiredString(input, "email", MAX_EMAIL)),
    );
    const name = requiredString(input, "name");
    const password = assertPassword(requiredString(input, "password", 200));
    const membershipInputs = await this.parseMemberships(
      organizationId,
      input.memberships,
    );

    if (await this.auth.getUserByEmail(email)) {
      throw new ConflictException("email already exists");
    }

    const userInput: UserRecord = {
      id: uuidv7(),
      email,
      name,
      passwordHash: hashPassword(password),
      status: "active",
      createdAt: new Date().toISOString(),
    };

    let created: UserRecord;
    try {
      created = await this.auth.createUser(userInput);
    } catch (error) {
      if (error instanceof DuplicateAuthRecordError) {
        throw new ConflictException("email already exists");
      }
      throw error;
    }

    try {
      const memberships: MembershipRecord[] = [];
      for (const membership of membershipInputs) {
        memberships.push(
          await this.auth.upsertMembership({
            id: uuidv7(),
            userId: created.id,
            scopeType: membership.scopeType,
            scopeId: membership.scopeId,
            role: membership.role,
            createdAt: new Date().toISOString(),
          }),
        );
      }
      return { user: toPublicUser(created), memberships };
    } catch (error) {
      await this.auth.deleteUser(created.id).catch(() => undefined);
      throw error;
    }
  }

  async updateUser(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<PublicUser> {
    const organizationId = this.callerOrganization(auth);
    const user = await this.requireManagedUser(organizationId, id);

    const input = assertObject(body);
    assertKnownFields(input, ["name", "email", "status"]);

    const name = valueOr(patchString(input, "name"), user.name);
    const rawEmail = valueOr(patchString(input, "email", MAX_EMAIL), user.email);
    const email = normalizeEmail(assertEmail(rawEmail));
    const status = valueOr(
      patchEnum<UserStatus>(input, "status", USER_STATUSES),
      user.status,
    );

    if (user.id === auth.user.id && status === "disabled") {
      throw new ConflictException("an admin cannot disable their own account");
    }

    if (email !== user.email) {
      const existing = await this.auth.getUserByEmail(email);
      if (existing && existing.id !== user.id) {
        throw new ConflictException("email already exists");
      }
    }

    let updated: UserRecord | null;
    try {
      updated = await this.auth.updateUser({ ...user, name, email, status });
    } catch (error) {
      if (error instanceof DuplicateAuthRecordError) {
        throw new ConflictException("email already exists");
      }
      throw error;
    }
    if (!updated) throw new NotFoundException(`user ${id} not found`);
    return toPublicUser(updated);
  }

  async setPassword(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<PasswordChange> {
    const organizationId = this.callerOrganization(auth);
    const user = await this.requireManagedUser(organizationId, id);

    const input = assertObject(body);
    assertKnownFields(input, ["password"]);
    const password = assertPassword(requiredString(input, "password", 200));

    if (!(await this.auth.setPasswordHash(user.id, hashPassword(password)))) {
      throw new NotFoundException(`user ${id} not found`);
    }
    const sessionsRevoked = await this.auth.revokeSessionsByUser(user.id);
    return { updated: true, sessionsRevoked };
  }

  async listMemberships(
    auth: AuthContext,
    userId?: string,
  ): Promise<MembershipRecord[]> {
    const organizationId = this.callerOrganization(auth);
    if (userId !== undefined) {
      await this.requireManagedUser(organizationId, userId);
    }
    const memberships = await this.auth.listMembershipsByOrganization(
      organizationId,
      await this.organizationScopeIds(organizationId),
    );
    return userId === undefined
      ? memberships
      : memberships.filter((membership) => membership.userId === userId);
  }

  async createMembership(
    auth: AuthContext,
    body: unknown,
  ): Promise<MembershipRecord> {
    const organizationId = this.callerOrganization(auth);
    const input = assertObject(body);
    assertKnownFields(input, ["userId", "scopeType", "scopeId", "role"]);

    const userId = requiredUuid(input, "userId");
    await this.requireManagedUser(organizationId, userId);

    const scopeType = requiredEnum<ScopeType>(input, "scopeType", SCOPE_TYPES);
    const scopeId = requiredUuid(input, "scopeId");
    const role = requiredEnum<Role>(input, "role", ROLES);
    await this.scopes.assertInOrganization(organizationId, scopeType, scopeId);

    return this.auth.upsertMembership({
      id: uuidv7(),
      userId,
      scopeType,
      scopeId,
      role,
      createdAt: new Date().toISOString(),
    });
  }

  async deleteMembership(
    auth: AuthContext,
    id: string,
  ): Promise<{ deleted: true }> {
    const organizationId = this.callerOrganization(auth);
    if (!isUuidV7(id)) throw new NotFoundException(`membership ${id} not found`);
    const membership = await this.auth.getMembershipById(id);
    if (!membership) throw new NotFoundException(`membership ${id} not found`);

    await this.scopes.assertInOrganization(
      organizationId,
      membership.scopeType,
      membership.scopeId,
    );

    if (
      membership.userId === auth.user.id &&
      membership.scopeType === "organization" &&
      membership.scopeId === organizationId &&
      membership.role === "org_admin"
    ) {
      const memberships = await this.auth.listMemberships(auth.user.id);
      const orgAdmins = memberships.filter(
        (row) =>
          row.scopeType === "organization" &&
          row.scopeId === organizationId &&
          row.role === "org_admin",
      );
      if (orgAdmins.length <= 1) {
        throw new ConflictException(
          "an admin cannot remove their own last org_admin membership",
        );
      }
    }

    if (!(await this.auth.deleteMembership(id))) {
      throw new NotFoundException(`membership ${id} not found`);
    }
    return { deleted: true };
  }

  /** The organization of the caller's `org_admin` membership. */
  private callerOrganization(auth: AuthContext): string {
    const membership = auth.memberships.find(
      (row) => row.scopeType === "organization" && row.role === "org_admin",
    );
    if (!membership) {
      throw new ForbiddenException("organization admin role required");
    }
    return membership.scopeId;
  }

  /** Competition and team-season ids that live inside the organization. */
  private async organizationScopeIds(organizationId: string): Promise<string[]> {
    const seasons = await this.league.listSeasons(organizationId);
    const ids: string[] = [];
    for (const season of seasons) {
      const [competitions, teamSeasons] = await Promise.all([
        this.league.listCompetitions(season.id),
        this.league.listTeamSeasonsBySeason(season.id),
      ]);
      ids.push(...competitions.map((row) => row.id));
      ids.push(...teamSeasons.map((row) => row.id));
    }
    return ids;
  }

  /**
   * A user is manageable when they already hold a scope in the caller's
   * organization, or when they hold no membership at all (created here but
   * not assigned yet). Users of another organization answer `404`.
   */
  private async requireManagedUser(
    organizationId: string,
    userId: string,
  ): Promise<UserRecord> {
    if (!isUuidV7(userId)) throw new NotFoundException(`user ${userId} not found`);
    const user = await this.auth.getUserById(userId);
    if (!user) throw new NotFoundException(`user ${userId} not found`);

    const memberships = await this.auth.listMemberships(user.id);
    if (memberships.length === 0) return user;

    const scopeIds = new Set(await this.organizationScopeIds(organizationId));
    const belongs = memberships.some((membership) =>
      membership.scopeType === "organization"
        ? membership.scopeId === organizationId
        : scopeIds.has(membership.scopeId),
    );
    if (!belongs) throw new NotFoundException(`user ${userId} not found`);
    return user;
  }

  private async parseMemberships(
    organizationId: string,
    raw: unknown,
  ): Promise<MembershipInput[]> {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw new BadRequestException("memberships must be an array");
    }

    const memberships: MembershipInput[] = [];
    for (const value of raw) {
      const input = assertObject(value);
      assertKnownFields(input, ["scopeType", "scopeId", "role"]);
      const scopeType = requiredEnum<ScopeType>(input, "scopeType", SCOPE_TYPES);
      const scopeId = requiredUuid(input, "scopeId");
      const role = requiredEnum<Role>(input, "role", ROLES);
      await this.scopes.assertInOrganization(organizationId, scopeType, scopeId);
      memberships.push({ scopeType, scopeId, role });
    }
    return memberships;
  }
}
