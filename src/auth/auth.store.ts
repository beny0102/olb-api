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

export interface AuthStore {
  readonly kind: "memory" | "postgres";

  upsertUser(input: UserRecord): Promise<UserRecord>;
  getUserByEmail(email: string): Promise<UserRecord | null>;
  getUserById(id: string): Promise<UserRecord | null>;

  createSession(input: SessionRecord): Promise<SessionRecord>;
  getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  revokeSession(tokenHash: string): Promise<void>;

  upsertMembership(input: MembershipRecord): Promise<MembershipRecord>;
  listMemberships(userId: string): Promise<MembershipRecord[]>;

  ping(): Promise<void>;
}

export const AUTH_STORE = Symbol("AUTH_STORE");
