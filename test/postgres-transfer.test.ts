import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { hashPassword } from "../src/auth/passwords.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import { seedLeague } from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import { PG_POOL } from "../src/store/pg.js";
import type { LeagueBundle } from "../src/transfer/bundle.js";
import { ADMIN_EMAIL, ADMIN_PASSWORD, login, seedTestAuth } from "./support/auth.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const sourceSchema = `olb_transfer_src_${process.pid}`;
const targetSchema = `olb_transfer_dst_${process.pid}`;
const TARGET_ORGANIZATION_ID = "0192f3d0-0000-7011-8000-000000000001";
const TARGET_USER_ID = "0192f3d0-0000-7011-8000-000000000002";
const TARGET_MEMBERSHIP_ID = "0192f3d0-0000-7011-8000-000000000003";
const TARGET_EMAIL = "admin@liga-metropolitana.olb";
const TARGET_PASSWORD = "olb-demo-admin";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

describe.skipIf(!enabled)("Postgres league transfer", () => {
  let admin: Pool;
  let source: INestApplication;
  let target: INestApplication;
  let sourcePool: Pool;
  let targetPool: Pool;
  let previousDatabaseUrl: string | undefined;
  let sourceToken: string;
  let targetToken: string;
  let targetLeague: LeagueStore;
  let bundle: LeagueBundle;

  function scopedUrl(schema: string): string {
    const scoped = new URL(process.env.TEST_DATABASE_URL!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    return scoped.toString();
  }

  async function compileApp(databaseUrl: string): Promise<INestApplication> {
    process.env.DATABASE_URL = databaseUrl;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GameNotFoundFilter());
    await app.listen(0);
    return app;
  }

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL! });
    await admin.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
    await admin.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${sourceSchema}"`);
    await admin.query(`CREATE SCHEMA "${targetSchema}"`);

    source = await compileApp(scopedUrl(sourceSchema));
    sourcePool = source.get<Pool>(PG_POOL);
    await seedLeague(source.get<LeagueStore>(LEAGUE_STORE));
    await seedTestAuth(source);
    sourceToken = await login(source, ADMIN_EMAIL, ADMIN_PASSWORD);

    const exported = await request(source.getHttpServer())
      .get("/admin/export")
      .set("authorization", `Bearer ${sourceToken}`)
      .expect(200);
    bundle = exported.body as LeagueBundle;

    target = await compileApp(scopedUrl(targetSchema));
    targetPool = target.get<Pool>(PG_POOL);
    targetLeague = target.get<LeagueStore>(LEAGUE_STORE);
    await targetLeague.upsertOrganization({
      id: TARGET_ORGANIZATION_ID,
      name: "Liga Metropolitana",
      slug: "liga-metropolitana",
      createdAt: CREATED_AT,
    });
    const auth = target.get<AuthStore>(AUTH_STORE);
    await auth.upsertUser({
      id: TARGET_USER_ID,
      email: TARGET_EMAIL,
      name: "Target Admin",
      passwordHash: hashPassword(TARGET_PASSWORD),
      status: "active",
      createdAt: CREATED_AT,
    });
    await auth.upsertMembership({
      id: TARGET_MEMBERSHIP_ID,
      userId: TARGET_USER_ID,
      scopeType: "organization",
      scopeId: TARGET_ORGANIZATION_ID,
      role: "org_admin",
      createdAt: CREATED_AT,
    });
    targetToken = await login(target, TARGET_EMAIL, TARGET_PASSWORD);
  });

  afterAll(async () => {
    await source?.close();
    await target?.close();
    await sourcePool?.end();
    await targetPool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
    await admin?.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
    await admin?.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("dry-runs, round-trips and then is idempotent", async () => {
    const dryRun = await request(target.getHttpServer())
      .post("/admin/import?dryRun=true")
      .set("authorization", `Bearer ${targetToken}`)
      .send(bundle)
      .expect(200);

    expect(dryRun.body).toMatchObject({
      dryRun: true,
      created: {
        seasons: 1,
        competitions: 2,
        teams: 4,
        teamSeasons: 4,
        players: 72,
        rosterEntries: 72,
        games: 6,
      },
    });
    expect(await targetLeague.listSeasons(TARGET_ORGANIZATION_ID)).toHaveLength(0);

    const applied = await request(target.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${targetToken}`)
      .send(bundle)
      .expect(201);

    expect(applied.body).toMatchObject({
      dryRun: false,
      created: {
        seasons: 1,
        competitions: 2,
        teams: 4,
        teamSeasons: 4,
        players: 72,
        rosterEntries: 72,
        games: 6,
      },
      conflicts: [],
    });

    const seasons = await targetLeague.listSeasons(TARGET_ORGANIZATION_ID);
    expect(seasons).toHaveLength(1);
    expect(await targetLeague.listTeamsByOrganization(TARGET_ORGANIZATION_ID)).toHaveLength(4);
    const teamSeasons = await targetLeague.listTeamSeasonsBySeason(seasons[0]!.id);
    expect(teamSeasons).toHaveLength(4);
    for (const teamSeason of teamSeasons) {
      expect(await targetLeague.listRoster(teamSeason.id)).toHaveLength(18);
    }
    expect(await targetLeague.listGames(seasons[0]!.id)).toHaveLength(6);

    const second = await request(target.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${targetToken}`)
      .send(bundle)
      .expect(201);

    expect(second.body.created).toMatchObject({
      seasons: 0,
      competitions: 0,
      teams: 0,
      teamSeasons: 0,
      players: 0,
      rosterEntries: 0,
      games: 0,
    });
    expect(second.body.updated).toMatchObject({ games: 0, rosterEntries: 0, players: 0 });
    expect(second.body.unchanged).toMatchObject({
      seasons: 1,
      competitions: 2,
      teams: 4,
      teamSeasons: 4,
      players: 72,
      rosterEntries: 72,
      games: 6,
    });

    const reexported = await request(target.getHttpServer())
      .get("/admin/export")
      .set("authorization", `Bearer ${targetToken}`)
      .expect(200);
    expect(reexported.body.organization).toEqual({
      slug: "liga-metropolitana",
      name: "Liga Metropolitana",
    });
    expect(reexported.body.games).toHaveLength(6);
  });
});
