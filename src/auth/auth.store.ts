/** Persistent auth records. Passwords never leave the store unhashed. */

export type UserStatus = "active" | "disabled";
export type ScopeType = "organization" | "competition" | "team_season";
export type Role =
  | "org_admin"
  | "competition_admin"
  | "team_admin"
  | "scorer"
  | "verifier"
  | "viewer";

export const SCOPE_TYPES: readonly ScopeType[] = [
  "organization",
  "competition",
  "team_season",
];

export const ROLES: readonly Role[] = [
  "org_admin",
  "competition_admin",
  "team_admin",
  "scorer",
  "verifier",
  "viewer",
];

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  status: UserStatus;
  createdAt: string;
}

/** The shape returned to a client: `passwordHash` is never present. */
export type PublicUser = Omit<UserRecord, "passwordHash">;

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface MembershipRecord {
  id: string;
  userId: string;
  scopeType: ScopeType;
  scopeId: string;
  role: Role;
  createdAt: string;
}

/**
 * Raised by `createUser` when the email is already taken (case-insensitively).
 * Services translate it into the HTTP `409`.
 */
export class DuplicateAuthRecordError extends Error {
  readonly field: "email";

  constructor(field: "email" = "email") {
    super(`${field} already exists`);
    this.name = "DuplicateAuthRecordError";
    this.field = field;
  }
}

export interface AuthStore {
  readonly kind: "memory" | "postgres";

  upsertUser(input: UserRecord): Promise<UserRecord>;
  /** Inserts a new user; a duplicate email throws `DuplicateAuthRecordError`. */
  createUser(input: UserRecord): Promise<UserRecord>;
  updateUser(input: UserRecord): Promise<UserRecord | null>;
  deleteUser(id: string): Promise<boolean>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;
  countUsers(): Promise<number>;
  /**
   * Users holding any membership whose scope belongs to the organization.
   * `scopeIds` are the competition and team-season ids of that organization.
   */
  listUsersByOrganization(
    organizationId: string,
    scopeIds: readonly string[],
  ): Promise<PublicUser[]>;

  createSession(input: SessionRecord): Promise<SessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(tokenHash: string): Promise<void>;
  /** Revokes every active session of a user; returns the number revoked. */
  revokeSessionsByUser(userId: string): Promise<number>;

  upsertMembership(input: MembershipRecord): Promise<MembershipRecord>;
  getMembershipById(id: string): Promise<MembershipRecord | null>;
  listMemberships(userId: string): Promise<MembershipRecord[]>;
  /**
   * Memberships whose scope is the organization itself or one of `scopeIds`
   * (its competitions and team seasons).
   */
  listMembershipsByOrganization(
    organizationId: string,
    scopeIds: readonly string[],
  ): Promise<MembershipRecord[]>;
  deleteMembership(id: string): Promise<boolean>;

  /** Replaces the stored password hash; `false` when the user is gone. */
  setPasswordHash(userId: string, passwordHash: string): Promise<boolean>;

  ping(): Promise<void>;
}

export const AUTH_STORE = Symbol("AUTH_STORE");
