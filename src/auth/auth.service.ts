import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { uuidv7 } from "../domain/uuid7.js";
import { AUTH_STORE, type AuthStore, type MembershipRecord, type PublicUser, type UserRecord } from "./auth.store.js";
import { verifyPassword } from "./passwords.js";

const SESSION_DAYS = 7;
const SESSION_TTL_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;

export interface AuthContext {
  token: string;
  sessionId: string;
  expiresAt: string;
  user: PublicUser;
  memberships: MembershipRecord[];
}

export interface LoginResult {
  token: string;
  user: PublicUser;
  memberships: MembershipRecord[];
}

/** Email is the login key; case and surrounding spaces are not significant. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function toPublicUser(user: UserRecord): PublicUser {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

function assertLoginBody(body: unknown): { email: string; password: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("request body must be a JSON object");
  }
  const input = body as Record<string, unknown>;
  const email = input.email;
  const password = input.password;
  if (typeof email !== "string" || email.trim().length === 0) {
    throw new BadRequestException("email must be a non-empty string");
  }
  if (typeof password !== "string" || password.length === 0) {
    throw new BadRequestException("password must be a non-empty string");
  }
  return { email, password };
}

@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_STORE) private readonly store: AuthStore) {}

  async login(body: unknown): Promise<LoginResult> {
    const { email, password } = assertLoginBody(body);
    const user = await this.store.getUserByEmail(normalizeEmail(email));

    // Unknown email, disabled user and a bad password all answer the same
    // way so the endpoint does not reveal which accounts exist.
    if (!user || user.status !== "active" || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException("invalid credentials");
    }

    const token = randomBytes(32).toString("base64url");
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

    await this.store.createSession({
      id: uuidv7(),
      userId: user.id,
      tokenHash: hashToken(token),
      createdAt,
      expiresAt,
      revokedAt: null,
    });

    return {
      token,
      user: toPublicUser(user),
      memberships: await this.store.listMemberships(user.id),
    };
  }

  async authenticate(
    token: string,
    options: { allowRevoked?: boolean } = {},
  ): Promise<AuthContext | null> {
    if (token.length === 0) return null;

    const session = await this.store.getSessionByTokenHash(hashToken(token));
    if (
      !session ||
      (!options.allowRevoked && session.revokedAt !== null) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      return null;
    }

    const user = await this.store.getUserById(session.userId);
    if (!user || user.status !== "active") return null;

    return {
      token,
      sessionId: session.id,
      expiresAt: session.expiresAt,
      user: toPublicUser(user),
      memberships: await this.store.listMemberships(user.id),
    };
  }

  /** Idempotent: an already revoked or unknown token is not an error. */
  async logout(token: string): Promise<void> {
    await this.store.revokeSession(hashToken(token));
  }
}
