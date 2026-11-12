import { Injectable } from "@nestjs/common";
import {
  DuplicateAuthRecordError,
  type AuthStore,
  type MembershipRecord,
  type PublicUser,
  type SessionRecord,
  type UserRecord,
} from "./auth.store.js";

/**
 * Development and test auth store. Natural keys mirror the Postgres unique
 * constraints so seeding twice is a no-op in both implementations.
 */
@Injectable()
export class MemoryAuthStore implements AuthStore {
  readonly kind = "memory" as const;

  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();

  async upsertUser(input: UserRecord): Promise<UserRecord> {
    const existing = [...this.users.values()].find((row) => row.email === input.email);
    const record: UserRecord = { ...input, id: existing?.id ?? input.id };
    this.users.set(record.id, record);
    return { ...record };
  }

  async createUser(input: UserRecord): Promise<UserRecord> {
    const duplicate = [...this.users.values()].some(
      (row) => row.email.toLowerCase() === input.email.toLowerCase(),
    );
    if (duplicate) throw new DuplicateAuthRecordError("email");

    const record: UserRecord = { ...input };
    this.users.set(record.id, record);
    return { ...record };
  }

  async updateUser(input: UserRecord): Promise<UserRecord | null> {
    if (!this.users.has(input.id)) return null;
    const duplicate = [...this.users.values()].some(
      (row) =>
        row.id !== input.id && row.email.toLowerCase() === input.email.toLowerCase(),
    );
    if (duplicate) throw new DuplicateAuthRecordError("email");

    const record: UserRecord = { ...input };
    this.users.set(record.id, record);
    return { ...record };
  }

  async deleteUser(id: string): Promise<boolean> {
    if (!this.users.delete(id)) return false;
    for (const [sessionId, session] of this.sessions) {
      if (session.userId === id) this.sessions.delete(sessionId);
    }
    for (const [membershipId, membership] of this.memberships) {
      if (membership.userId === id) this.memberships.delete(membershipId);
    }
    return true;
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const record = [...this.users.values()].find(
      (row) => row.email.toLowerCase() === email.toLowerCase(),
    );
    return record ? { ...record } : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const record = this.users.get(id);
    return record ? { ...record } : null;
  }

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async listUsersByOrganization(
    organizationId: string,
    scopeIds: readonly string[],
  ): Promise<PublicUser[]> {
    const scopes = new Set(scopeIds);
    const userIds = new Set<string>();
    for (const membership of this.memberships.values()) {
      const matchesOrganization =
        membership.scopeType === "organization" && membership.scopeId === organizationId;
      const matchesChildScope =
        membership.scopeType !== "organization" && scopes.has(membership.scopeId);
      if (matchesOrganization || matchesChildScope) userIds.add(membership.userId);
    }

    return [...userIds]
      .map((userId) => this.users.get(userId))
      .filter((user): user is UserRecord => user !== undefined)
      .map((user) => {
        const { passwordHash: _passwordHash, ...publicUser } = user;
        return publicUser;
      })
      .sort((a, b) => a.email.localeCompare(b.email) || a.id.localeCompare(b.id));
  }

  async createSession(input: SessionRecord): Promise<SessionRecord> {
    const record: SessionRecord = { ...input };
    this.sessions.set(record.id, record);
    return { ...record };
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const record = [...this.sessions.values()].find((row) => row.tokenHash === tokenHash);
    return record ? { ...record } : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    const record = [...this.sessions.values()].find((row) => row.tokenHash === tokenHash);
    if (record && record.revokedAt === null) {
      record.revokedAt = new Date().toISOString();
    }
  }

  async revokeSessionsByUser(userId: string): Promise<number> {
    let revoked = 0;
    const revokedAt = new Date().toISOString();
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.revokedAt === null) {
        session.revokedAt = revokedAt;
        revoked += 1;
      }
    }
    return revoked;
  }

  async upsertMembership(input: MembershipRecord): Promise<MembershipRecord> {
    const existing = [...this.memberships.values()].find(
      (row) =>
        row.userId === input.userId &&
        row.scopeType === input.scopeType &&
        row.scopeId === input.scopeId &&
        row.role === input.role,
    );
    const record: MembershipRecord = { ...input, id: existing?.id ?? input.id };
    this.memberships.set(record.id, record);
    return { ...record };
  }

  async getMembershipById(id: string): Promise<MembershipRecord | null> {
    const record = this.memberships.get(id);
    return record ? { ...record } : null;
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    return [...this.memberships.values()]
      .filter((row) => row.userId === userId)
      .sort(
        (a, b) =>
          a.scopeType.localeCompare(b.scopeType) ||
          a.scopeId.localeCompare(b.scopeId) ||
          a.role.localeCompare(b.role) ||
          a.id.localeCompare(b.id),
      )
      .map((record) => ({ ...record }));
  }

  async listMembershipsByOrganization(
    organizationId: string,
    scopeIds: readonly string[],
  ): Promise<MembershipRecord[]> {
    const scopes = new Set(scopeIds);
    return [...this.memberships.values()]
      .filter((membership) => {
        if (membership.scopeType === "organization") {
          return membership.scopeId === organizationId;
        }
        return scopes.has(membership.scopeId);
      })
      .sort(
        (a, b) =>
          a.scopeType.localeCompare(b.scopeType) ||
          a.scopeId.localeCompare(b.scopeId) ||
          a.role.localeCompare(b.role) ||
          a.userId.localeCompare(b.userId) ||
          a.id.localeCompare(b.id),
      )
      .map((record) => ({ ...record }));
  }

  async deleteMembership(id: string): Promise<boolean> {
    return this.memberships.delete(id);
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    const record = this.users.get(userId);
    if (!record) return false;
    record.passwordHash = passwordHash;
    return true;
  }

  async ping(): Promise<void> {
    return;
  }
}
