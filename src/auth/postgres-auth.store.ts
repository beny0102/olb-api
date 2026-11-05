import type pg from "pg";
import type {
  AuthStore,
  MembershipRecord,
  Role,
  ScopeType,
  SessionRecord,
  UserRecord,
  UserStatus,
} from "./auth.store.js";

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  status: string;
  created_at: Date;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface MembershipRow {
  id: string;
  user_id: string;
  scope_type: string;
  scope_id: string;
  role: string;
  created_at: Date;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    status: row.status as UserStatus,
    createdAt: row.created_at.toISOString(),
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

function toMembership(row: MembershipRow): MembershipRecord {
  return {
    id: row.id,
    userId: row.user_id,
    scopeType: row.scope_type as ScopeType,
    scopeId: row.scope_id,
    role: row.role as Role,
    createdAt: row.created_at.toISOString(),
  };
}

/** Postgres auth store. Upserts use the same natural keys as the DDL. */
export class PostgresAuthStore implements AuthStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: pg.Pool) {}

  async upsertUser(input: UserRecord): Promise<UserRecord> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (id, email, name, password_hash, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         status = EXCLUDED.status
       RETURNING id, email, name, password_hash, status, created_at`,
      [input.id, input.email, input.name, input.passwordHash, input.status, input.createdAt],
    );
    return toUser(rows[0]!);
  }

  async getUserByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, email, name, password_hash, status, created_at
         FROM users WHERE email = $1`,
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, email, name, password_hash, status, created_at
         FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async createSession(input: SessionRecord): Promise<SessionRecord> {
    const { rows } = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, token_hash, created_at, expires_at, revoked_at`,
      [
        input.id,
        input.userId,
        input.tokenHash,
        input.createdAt,
        input.expiresAt,
        input.revokedAt,
      ],
    );
    return toSession(rows[0]!);
  }

  async getSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const { rows } = await this.pool.query<SessionRow>(
      `SELECT id, user_id, token_hash, created_at, expires_at, revoked_at
         FROM sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ? toSession(rows[0]) : null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  async upsertMembership(input: MembershipRecord): Promise<MembershipRecord> {
    const { rows } = await this.pool.query<MembershipRow>(
      `INSERT INTO memberships (id, user_id, scope_type, scope_id, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, scope_type, scope_id, role) DO UPDATE SET
         role = EXCLUDED.role
       RETURNING id, user_id, scope_type, scope_id, role, created_at`,
      [input.id, input.userId, input.scopeType, input.scopeId, input.role, input.createdAt],
    );
    return toMembership(rows[0]!);
  }

  async listMemberships(userId: string): Promise<MembershipRecord[]> {
    const { rows } = await this.pool.query<MembershipRow>(
      `SELECT id, user_id, scope_type, scope_id, role, created_at
         FROM memberships WHERE user_id = $1
        ORDER BY scope_type ASC, scope_id ASC, role ASC, id ASC`,
      [userId],
    );
    return rows.map(toMembership);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
