import {
  SEED_COMPETITION_IDS,
  SEED_ORGANIZATION_ID,
  SEED_TEAM_SEASON_IDS,
} from "../scripts/league-seed.js";
import type { AuthStore, Role, ScopeType } from "./auth.store.js";
import { hashPassword } from "./passwords.js";

/**
 * Fixed demo identities. They are fictional and deliberately separate from
 * the domain seed so `seedAuth` can run after `seedLeague` in any order of
 * catalog rows. Passwords are demo-only; production operators must replace
 * them with real accounts.
 */

const NAMESPACE = "0192f3d0-0000-7000-8002";

function id(value: number): string {
  return `${NAMESPACE}-${String(value).padStart(12, "0")}`;
}

const CREATED_AT = "2026-01-01T00:00:00.000Z";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "olb-demo-admin";
const NORTE_PASSWORD = process.env.SEED_NORTE_PASSWORD ?? "olb-demo-norte";
const TIBURONES_PASSWORD = process.env.SEED_TIBURONES_PASSWORD ?? "olb-demo-tiburones";
const VERIFIER_PASSWORD = process.env.SEED_VERIFIER_PASSWORD ?? "olb-demo-verificador";

export const SEED_AUTH_EMAILS = [
  "admin@liga-metropolitana.olb",
  "norte@liga-metropolitana.olb",
  "tiburones@liga-metropolitana.olb",
  "verificador@liga-metropolitana.olb",
] as const;

interface SeedUser {
  id: string;
  email: string;
  name: string;
  password: string;
}

interface SeedMembership {
  id: string;
  email: string;
  scopeType: ScopeType;
  scopeId: string;
  role: Role;
}

const USERS: SeedUser[] = [
  {
    id: id(1),
    email: SEED_AUTH_EMAILS[0],
    name: "Administración Liga Metropolitana",
    password: ADMIN_PASSWORD,
  },
  {
    id: id(2),
    email: SEED_AUTH_EMAILS[1],
    name: "Coordinación Zona Norte",
    password: NORTE_PASSWORD,
  },
  {
    id: id(3),
    email: SEED_AUTH_EMAILS[2],
    name: "Tiburones",
    password: TIBURONES_PASSWORD,
  },
  {
    id: id(4),
    email: SEED_AUTH_EMAILS[3],
    name: "Verificación Zona Norte",
    password: VERIFIER_PASSWORD,
  },
];

const MEMBERSHIPS: SeedMembership[] = [
  {
    id: id(101),
    email: SEED_AUTH_EMAILS[0],
    scopeType: "organization",
    scopeId: SEED_ORGANIZATION_ID,
    role: "org_admin",
  },
  {
    id: id(102),
    email: SEED_AUTH_EMAILS[1],
    scopeType: "competition",
    scopeId: SEED_COMPETITION_IDS[0],
    role: "competition_admin",
  },
  {
    id: id(103),
    email: SEED_AUTH_EMAILS[2],
    scopeType: "team_season",
    scopeId: SEED_TEAM_SEASON_IDS[0],
    role: "team_admin",
  },
  {
    id: id(104),
    email: SEED_AUTH_EMAILS[2],
    scopeType: "team_season",
    scopeId: SEED_TEAM_SEASON_IDS[0],
    role: "scorer",
  },
  {
    id: id(105),
    email: SEED_AUTH_EMAILS[3],
    scopeType: "competition",
    scopeId: SEED_COMPETITION_IDS[0],
    role: "verifier",
  },
];

/** Upserts four users and their five memberships; safe to run repeatedly. */
export async function seedAuth(store: AuthStore): Promise<void> {
  const userIds = new Map<string, string>();

  for (const user of USERS) {
    const record = await store.upsertUser({
      id: user.id,
      email: user.email,
      name: user.name,
      passwordHash: hashPassword(user.password),
      status: "active",
      createdAt: CREATED_AT,
    });
    userIds.set(record.email, record.id);
  }

  for (const membership of MEMBERSHIPS) {
    const userId = userIds.get(membership.email);
    if (userId === undefined) {
      throw new Error(`seed membership references an unknown user: ${membership.email}`);
    }

    await store.upsertMembership({
      id: membership.id,
      userId,
      scopeType: membership.scopeType,
      scopeId: membership.scopeId,
      role: membership.role,
      createdAt: CREATED_AT,
    });
  }
}
