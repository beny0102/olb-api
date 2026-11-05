import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { seedAuth, SEED_AUTH_EMAILS } from "../src/auth/auth-seed.js";
import { hashToken } from "../src/auth/auth.service.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { hashPassword } from "../src/auth/passwords.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import { seedLeague } from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";

const ADMIN_EMAIL = SEED_AUTH_EMAILS[0];
const ADMIN_PASSWORD = "olb-demo-admin";

let app: INestApplication;
let authStore: AuthStore;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  await seedLeague(app.get<LeagueStore>(LEAGUE_STORE));
  authStore = app.get<AuthStore>(AUTH_STORE);
  await seedAuth(authStore);
});

afterAll(async () => {
  await app.close();
});

function login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  return request(app.getHttpServer()).post("/auth/login").send({ email, password });
}

describe("auth login", () => {
  it("logs in a seeded user and returns a token without the password hash", async () => {
    const response = await login(`  ${ADMIN_EMAIL.toUpperCase()}  `).expect(200);

    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.token.length).toBeGreaterThan(20);
    expect(response.body.user).toMatchObject({
      email: ADMIN_EMAIL,
      name: "Administración Liga Metropolitana",
      status: "active",
    });
    expect(response.body.user).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    expect(response.body.memberships).toEqual([
      expect.objectContaining({ role: "org_admin", scopeType: "organization" }),
    ]);
  });

  it("stores only a scrypt hash and a hashed session token", async () => {
    const user = await authStore.getUserByEmail(ADMIN_EMAIL);
    expect(user?.passwordHash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(user?.passwordHash).not.toContain(ADMIN_PASSWORD);

    const response = await login().expect(200);
    const session = await authStore.getSessionByTokenHash(hashToken(response.body.token));
    expect(session).not.toBeNull();
    expect(session?.tokenHash).not.toBe(response.body.token);
  });

  it("rejects a bad password and an unknown email with the same 401", async () => {
    const badPassword = await login(ADMIN_EMAIL, "wrong-password").expect(401);
    expect(badPassword.body.message).toBe("invalid credentials");

    const unknown = await login("nobody@liga-metropolitana.olb", ADMIN_PASSWORD).expect(401);
    expect(unknown.body.message).toBe("invalid credentials");
  });

  it("rejects a disabled user with the same 401", async () => {
    await authStore.upsertUser({
      id: "0192f3d0-0000-7000-8002-000000008888",
      email: "disabled@liga-metropolitana.olb",
      name: "Disabled",
      passwordHash: hashPassword("olb-demo-disabled"),
      status: "disabled",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const response = await login("disabled@liga-metropolitana.olb", "olb-demo-disabled").expect(
      401,
    );
    expect(response.body.message).toBe("invalid credentials");
  });

  it("rejects an invalid body with 400", async () => {
    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: ADMIN_EMAIL })
      .expect(400);
  });
});

describe("guarded auth endpoints", () => {
  it("returns the current user and memberships", async () => {
    const loggedIn = await login().expect(200);
    const response = await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", `Bearer ${loggedIn.body.token}`)
      .expect(200);

    expect(response.body.user).toMatchObject({ email: ADMIN_EMAIL });
    expect(response.body.user).not.toHaveProperty("passwordHash");
    expect(response.body.memberships).toHaveLength(1);
  });

  it("answers 401 without a token or with an invalid token", async () => {
    await request(app.getHttpServer()).get("/auth/me").expect(401);
    await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", "Bearer not-a-real-token")
      .expect(401);
    await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", "Basic abc")
      .expect(401);
  });

  it("answers 401 for an expired session", async () => {
    const user = await authStore.getUserByEmail(ADMIN_EMAIL);
    expect(user).not.toBeNull();

    const token = "expired-demo-token";
    await authStore.createSession({
      id: "0192f3d0-0000-7000-8002-000000009999",
      userId: user!.id,
      tokenHash: hashToken(token),
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-02T00:00:00.000Z",
      revokedAt: null,
    });

    await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", `Bearer ${token}`)
      .expect(401);
  });

  it("logs out idempotently and invalidates the token", async () => {
    const loggedIn = await login().expect(200);
    const token = loggedIn.body.token as string;

    await request(app.getHttpServer())
      .post("/auth/logout")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", `Bearer ${token}`)
      .expect(401);

    // A replay of the same logout is a no-op, not a 401.
    await request(app.getHttpServer())
      .post("/auth/logout")
      .set("authorization", `Bearer ${token}`)
      .expect(200);

    await request(app.getHttpServer()).post("/auth/logout").expect(401);
  });
});
