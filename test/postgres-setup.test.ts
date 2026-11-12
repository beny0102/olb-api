import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import { PG_POOL } from "../src/store/pg.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const schema = `olb_setup_${process.pid}`;
const SETUP_TOKEN = "postgres-setup-token-0123456789";
const API_EMAIL = "setup-admin@liga-postgres.olb";
const API_PASSWORD = "postgres-admin-1";

describe.skipIf(!enabled)("Postgres setup and users", () => {
  let app: INestApplication;
  let admin: Pool;
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;
  let previousSetupToken: string | undefined;
  let token: string;
  let organizationId: string;
  let seasonId: string;
  let competitionId: string;
  let userId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousSetupToken = process.env.SETUP_TOKEN;

    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);

    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();
    process.env.SETUP_TOKEN = SETUP_TOKEN;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GameNotFoundFilter());
    await app.init();
    pool = app.get<Pool>(PG_POOL);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSetupToken === undefined) delete process.env.SETUP_TOKEN;
    else process.env.SETUP_TOKEN = previousSetupToken;
  });

  function post(path: string, body: unknown) {
    return request(app.getHttpServer())
      .post(path)
      .set("authorization", `Bearer ${token}`)
      .send(body);
  }

  it("runs setup against Postgres", async () => {
    const status = await request(app.getHttpServer()).get("/setup/status").expect(200);
    expect(status.body).toEqual({ required: true });

    const created = await request(app.getHttpServer())
      .post("/setup")
      .send({
        token: SETUP_TOKEN,
        organization: { name: "Liga Postgres", slug: "liga-postgres" },
        admin: { name: "Postgres Admin", email: API_EMAIL, password: API_PASSWORD },
      })
      .expect(201);
    organizationId = created.body.organization.id as string;
    expect(created.body.membership).toMatchObject({
      scopeType: "organization",
      role: "org_admin",
    });

    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: API_EMAIL, password: API_PASSWORD })
      .expect(200);
    token = login.body.token as string;

    const second = await request(app.getHttpServer())
      .post("/setup")
      .send({
        token: SETUP_TOKEN,
        organization: { name: "Otra", slug: "otra" },
        admin: { name: "Otra", email: "otra@liga.olb", password: "otra-password-1" },
      })
      .expect(409);
    expect(second.body).toMatchObject({ statusCode: 409 });
  });

  it("lists, creates and updates users through the SQL store", async () => {
    const league = app.get<LeagueStore>(LEAGUE_STORE);
    seasonId = "0192f3d0-0000-7009-8000-000000000101";
    competitionId = "0192f3d0-0000-7009-8000-000000000102";
    await league.upsertSeason({
      id: seasonId,
      organizationId,
      name: "2026",
      year: 2026,
      status: "active",
      startsOn: null,
      endsOn: null,
    });
    await league.upsertCompetition({
      id: competitionId,
      seasonId,
      parentId: null,
      name: "Zona SQL",
      kind: "league",
      level: 1,
      sortOrder: 1,
    });

    const created = await post("/admin/users", {
      email: "Verifier@Liga-Postgres.OLB",
      name: "Verifier",
      password: "verifier-password-1",
      memberships: [
        {
          scopeType: "competition",
          scopeId: competitionId,
          role: "verifier",
        },
      ],
    }).expect(201);
    userId = created.body.user.id as string;
    expect(created.body.user.email).toBe("verifier@liga-postgres.olb");
    expect(created.body.memberships).toEqual([
      expect.objectContaining({ scopeType: "competition", role: "verifier" }),
    ]);

    const users = await request(app.getHttpServer())
      .get("/admin/users")
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(users.body.map((user: { email: string }) => user.email)).toEqual(
      expect.arrayContaining([API_EMAIL, "verifier@liga-postgres.olb"]),
    );

    const duplicates = await post("/admin/users", {
      email: API_EMAIL.toUpperCase(),
      name: "Duplicate",
      password: "duplicate-password-1",
    }).expect(409);
    expect(duplicates.body).toMatchObject({ statusCode: 409 });

    const patched = await request(app.getHttpServer())
      .patch(`/admin/users/${userId}`)
      .set("authorization", `Bearer ${token}`)
      .send({ name: "Verifier Renamed" })
      .expect(200);
    expect(patched.body.name).toBe("Verifier Renamed");

    const memberships = await request(app.getHttpServer())
      .get(`/admin/memberships?userId=${userId}`)
      .set("authorization", `Bearer ${token}`)
      .expect(200);
    expect(memberships.body).toEqual([
      expect.objectContaining({
        userId,
        scopeType: "competition",
        scopeId: competitionId,
      }),
    ]);
  });

  it("revokes sessions in Postgres when the password changes", async () => {
    const session = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "verifier@liga-postgres.olb", password: "verifier-password-1" })
      .expect(200);

    const changed = await request(app.getHttpServer())
      .post(`/admin/users/${userId}/password`)
      .set("authorization", `Bearer ${token}`)
      .send({ password: "verifier-password-2" })
      .expect(200);
    expect(changed.body.sessionsRevoked).toBeGreaterThanOrEqual(1);

    await request(app.getHttpServer())
      .get("/auth/me")
      .set("authorization", `Bearer ${session.body.token}`)
      .expect(401);
  });

  it("rejects a cross-organization membership scope", async () => {
    const league = app.get<LeagueStore>(LEAGUE_STORE);
    const otherOrganizationId = "0192f3d0-0000-7009-8000-000000000201";
    const otherSeasonId = "0192f3d0-0000-7009-8000-000000000202";
    const otherCompetitionId = "0192f3d0-0000-7009-8000-000000000203";
    await league.upsertOrganization({
      id: otherOrganizationId,
      name: "Otra Liga",
      slug: "otra-liga",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await league.upsertSeason({
      id: otherSeasonId,
      organizationId: otherOrganizationId,
      name: "2026",
      year: 2026,
      status: "active",
      startsOn: null,
      endsOn: null,
    });
    await league.upsertCompetition({
      id: otherCompetitionId,
      seasonId: otherSeasonId,
      parentId: null,
      name: "Otra Zona",
      kind: "league",
      level: 1,
      sortOrder: 1,
    });

    await post("/admin/memberships", {
      userId,
      scopeType: "competition",
      scopeId: otherCompetitionId,
      role: "viewer",
    }).expect(404);
  });
});
