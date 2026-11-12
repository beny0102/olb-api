import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { hashPassword } from "../src/auth/passwords.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_ORGANIZATION_ID,
  SEED_TEAM_SEASON_IDS,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  NORTE_EMAIL,
  NORTE_PASSWORD,
  seedTestAuth,
} from "./support/auth.js";

const SECOND_ORGANIZATION_ID = "0192f3d0-0000-7009-8000-000000000001";
const SECOND_SEASON_ID = "0192f3d0-0000-7009-8000-000000000002";
const SECOND_COMPETITION_ID = "0192f3d0-0000-7009-8000-000000000003";
const SECOND_USER_ID = "0192f3d0-0000-7009-8000-000000000004";
const SECOND_MEMBERSHIP_ID = "0192f3d0-0000-7009-8000-000000000005";
const UNKNOWN_ID = "0192f3d0-0000-7009-8000-0000000000ee";

let app: INestApplication;
let adminToken: string;
let norteToken: string;
let adminUserId: string;
let createdUserId: string;
let createdUserEmail: string;
let createdUserPassword: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.SETUP_TOKEN = "users-test-setup-token";
  delete process.env.SETUP_TOKEN_FILE;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  const league = app.get<LeagueStore>(LEAGUE_STORE);
  await seedLeague(league);
  await seedTestAuth(app);
  const auth = app.get<AuthStore>(AUTH_STORE);

  await league.upsertOrganization({
    id: SECOND_ORGANIZATION_ID,
    name: "Otra Liga",
    slug: "otra-liga",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await league.upsertSeason({
    id: SECOND_SEASON_ID,
    organizationId: SECOND_ORGANIZATION_ID,
    name: "2026",
    year: 2026,
    status: "active",
    startsOn: null,
    endsOn: null,
  });
  await league.upsertCompetition({
    id: SECOND_COMPETITION_ID,
    seasonId: SECOND_SEASON_ID,
    parentId: null,
    name: "Otra Zona",
    kind: "league",
    level: 1,
    sortOrder: 1,
  });
  await auth.upsertUser({
    id: SECOND_USER_ID,
    email: "outside@otra-liga.olb",
    name: "Outside User",
    passwordHash: hashPassword("outside-password"),
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await auth.upsertMembership({
    id: SECOND_MEMBERSHIP_ID,
    userId: SECOND_USER_ID,
    scopeType: "organization",
    scopeId: SECOND_ORGANIZATION_ID,
    role: "org_admin",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  adminToken = await login(app, ADMIN_EMAIL, ADMIN_PASSWORD);
  norteToken = await login(app, NORTE_EMAIL, NORTE_PASSWORD);
  const me = await request(app.getHttpServer())
    .get("/auth/me")
    .set("authorization", `Bearer ${adminToken}`)
    .expect(200);
  adminUserId = me.body.user.id as string;

  createdUserEmail = "manager@liga-metropolitana.olb";
  createdUserPassword = "manager-password-1";
  const created = await request(app.getHttpServer())
    .post("/admin/users")
    .set("authorization", `Bearer ${adminToken}`)
    .send({
      email: createdUserEmail,
      name: "Team Manager",
      password: createdUserPassword,
      memberships: [
        {
          scopeType: "team_season",
          scopeId: SEED_TEAM_SEASON_IDS[1],
          role: "team_admin",
        },
      ],
    })
    .expect(201);
  createdUserId = created.body.user.id as string;
});

afterAll(async () => {
  await app.close();
});

function asAdmin(method: "get" | "post" | "patch" | "delete", path: string) {
  return request(app.getHttpServer())[method](path).set(
    "authorization",
    `Bearer ${adminToken}`,
  );
}

describe("admin users", () => {
  it("requires a token and an org_admin membership", async () => {
    await request(app.getHttpServer()).get("/admin/users").expect(401);

    await request(app.getHttpServer())
      .get("/admin/users")
      .set("authorization", `Bearer ${norteToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post("/admin/users")
      .set("authorization", `Bearer ${norteToken}`)
      .send({ email: "x@y.olb", name: "X", password: "long-enough-1" })
      .expect(403);
  });

  it("creates a user with memberships and never returns the hash", async () => {
    const response = await asAdmin("get", `/admin/users`).expect(200);
    const users = response.body as Array<Record<string, unknown>>;

    expect(users.map((user) => user.email)).toContain(createdUserEmail);
    expect(users.map((user) => user.email)).toContain(
      "tiburones@liga-metropolitana.olb",
    );
    expect(users.map((user) => user.email)).not.toContain("outside@otra-liga.olb");
    expect(JSON.stringify(users)).not.toContain("passwordHash");
    expect(JSON.stringify(users)).not.toContain("scrypt$");

    const memberships = await asAdmin(
      "get",
      `/admin/memberships?userId=${createdUserId}`,
    ).expect(200);
    expect(memberships.body).toEqual([
      expect.objectContaining({
        userId: createdUserId,
        scopeType: "team_season",
        scopeId: SEED_TEAM_SEASON_IDS[1],
        role: "team_admin",
      }),
    ]);
  });

  it("rejects a duplicate email case-insensitively", async () => {
    await asAdmin("post", "/admin/users")
      .send({
        email: createdUserEmail.toUpperCase(),
        name: "Duplicado",
        password: "another-password-1",
      })
      .expect(409);
  });

  it("rejects short passwords and unknown users", async () => {
    await asAdmin("post", "/admin/users")
      .send({ email: "short@liga-metropolitana.olb", name: "Short", password: "short" })
      .expect(400);

    await asAdmin("patch", `/admin/users/${UNKNOWN_ID}`)
      .send({ name: "Ghost" })
      .expect(404);
  });

  it("updates the name and disables another user", async () => {
    const patched = await asAdmin("patch", `/admin/users/${createdUserId}`)
      .send({ name: "Team Manager Renamed" })
      .expect(200);
    expect(patched.body.name).toBe("Team Manager Renamed");

    const disabled = await asAdmin("patch", `/admin/users/${createdUserId}`)
      .send({ status: "disabled" })
      .expect(200);
    expect(disabled.body.status).toBe("disabled");

    const restored = await asAdmin("patch", `/admin/users/${createdUserId}`)
      .send({ status: "active" })
      .expect(200);
    expect(restored.body.status).toBe("active");
  });

  it("does not let an admin disable themselves", async () => {
    await asAdmin("patch", `/admin/users/${adminUserId}`)
      .send({ status: "disabled" })
      .expect(409);
  });

  it("hides users from another organization behind a 404", async () => {
    await asAdmin("patch", `/admin/users/${SECOND_USER_ID}`)
      .send({ name: "Hijacked" })
      .expect(404);

    await asAdmin("post", `/admin/users/${SECOND_USER_ID}/password`)
      .send({ password: "hijacked-password-1" })
      .expect(404);

    await asAdmin("post", "/admin/memberships")
      .send({
        userId: SECOND_USER_ID,
        scopeType: "organization",
        scopeId: SECOND_ORGANIZATION_ID,
        role: "viewer",
      })
      .expect(404);

    await asAdmin("delete", `/admin/memberships/${SECOND_MEMBERSHIP_ID}`).expect(404);
  });

  it("rejects a user created with a cross-organization membership", async () => {
    await asAdmin("post", "/admin/users")
      .send({
        email: "crossorg@liga-metropolitana.olb",
        name: "Cross Org",
        password: "cross-org-password-1",
        memberships: [
          {
            scopeType: "competition",
            scopeId: SECOND_COMPETITION_ID,
            role: "competition_admin",
          },
        ],
      })
      .expect(404);

    const users = await asAdmin("get", "/admin/users").expect(200);
    expect(JSON.stringify(users.body)).not.toContain("crossorg@liga-metropolitana.olb");
  });

  it("changes a password and revokes the user's sessions", async () => {
    const session = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: createdUserEmail, password: createdUserPassword })
      .expect(200);
    const userToken = session.body.token as string;

    const changed = await asAdmin("post", `/admin/users/${createdUserId}/password`)
      .send({ password: "manager-password-2" })
      .expect(200);
    expect(changed.body.updated).toBe(true);
    expect(changed.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", `Bearer ${userToken}`)
      .expect(401);

    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: createdUserEmail, password: "manager-password-2" })
      .expect(200);
  });

  it("validates membership scope types, roles and ownership", async () => {
    const base = {
      userId: createdUserId,
      scopeType: "competition",
      scopeId: SEED_ORGANIZATION_ID,
      role: "competition_admin",
    };

    await asAdmin("post", "/admin/memberships")
      .send({ ...base, scopeType: "league" })
      .expect(400);

    await asAdmin("post", "/admin/memberships")
      .send({ ...base, scopeId: SECOND_COMPETITION_ID })
      .expect(404);

    await asAdmin("post", "/admin/memberships")
      .send({ ...base, scopeId: UNKNOWN_ID })
      .expect(404);

    await asAdmin("post", "/admin/memberships")
      .send({ ...base, role: "owner" })
      .expect(400);
  });

  it("creates and deletes a membership in the organization", async () => {
    const created = await asAdmin("post", "/admin/memberships")
      .send({
        userId: createdUserId,
        scopeType: "team_season",
        scopeId: SEED_TEAM_SEASON_IDS[1],
        role: "scorer",
      })
      .expect(201);
    expect(created.body).toMatchObject({
      userId: createdUserId,
      scopeType: "team_season",
      scopeId: SEED_TEAM_SEASON_IDS[1],
      role: "scorer",
    });

    await asAdmin("delete", `/admin/memberships/${created.body.id}`).expect(200);

    const remaining = await asAdmin(
      "get",
      `/admin/memberships?userId=${createdUserId}`,
    ).expect(200);
    expect(remaining.body).toEqual([
      expect.objectContaining({ role: "team_admin" }),
    ]);
  });

  it("does not let an admin remove their own last org_admin membership", async () => {
    const memberships = await asAdmin(
      "get",
      `/admin/memberships?userId=${adminUserId}`,
    ).expect(200);
    const own = (memberships.body as Array<Record<string, unknown>>).find(
      (row) => row.role === "org_admin" && row.scopeId === SEED_ORGANIZATION_ID,
    );
    expect(own).toBeDefined();

    await asAdmin("delete", `/admin/memberships/${String(own!.id)}`).expect(409);
  });

  it("answers 404 for an unknown membership", async () => {
    await asAdmin("delete", `/admin/memberships/${UNKNOWN_ID}`).expect(404);
  });
});
