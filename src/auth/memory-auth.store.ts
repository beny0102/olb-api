import { Injectable } from "@nestjs/common";
import type {
  AuthStore,
  MembershipRecord,
  SessionRecord,
  UserRecord,
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

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const record = [...this.users.values()].find((row) => row.email === email);
    return record ? { ...record } : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const record = this.users.get(id);
    return record ? { ...record } : null;
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

  async ping(): Promise<void> {
    return;
  }
}
