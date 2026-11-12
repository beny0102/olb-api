import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { seedAuth } from "../src/auth/auth-seed.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_COMPETITION_IDS,
  SEED_SEASON_ID,
  SEED_TEAM_SEASON_IDS,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import { PG_POOL } from "../src/store/pg.js";
import { SseClient } from "./support/sse.js";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const FULL_GAME_ID = "0192f3d0-0000-7000-8000-000000000201";
const OTHER_TEAM_GAME_ID = "0192f3d0-0000-7000-8000-000000000202";
const BATTER = "0192f3d0-0000-7000-8000-000000000100";
const schema = `olb_smoke_${process.pid}`;

describe.skipIf(!enabled)("Postgres smoke", () => {
  let app: INestApplication;
  let baseUrl: string;
  let admin: Pool;
  let pool: Pool;
  let previousDatabaseUrl: string | undefined;
  let token: string;
  let tiburonesToken: string;

  beforeAll(async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    previousDatabaseUrl = process.env.DATABASE_URL;

    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);

    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    process.env.DATABASE_URL = scoped.toString();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GameNotFoundFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();
    pool = app.get<Pool>(PG_POOL);

    const league = app.get<LeagueStore>(LEAGUE_STORE);
    await seedLeague(league);
    await seedAuth(app.get<AuthStore>(AUTH_STORE));

    const loggedIn = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "admin@liga-metropolitana.olb", password: "olb-demo-admin" })
      .expect(200);
    token = loggedIn.body.token as string;

    const teamLogin = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "tiburones@liga-metropolitana.olb", password: "olb-demo-tiburones" })
      .expect(200);
    tiburonesToken = teamLogin.body.token as string;
  });

  function post(path: string) {
    return request(app.getHttpServer()).post(path).set("authorization", `Bearer ${token}`);
  }

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("serves seed standings and leaders from Postgres", async () => {
    const stats = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/stats?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);

    expect(stats.body.groups.length).toBeGreaterThan(0);
    expect(stats.body.groups[0].teams.length).toBeGreaterThan(0);
    expect(Array.isArray(stats.body.batting)).toBe(true);
    expect(Array.isArray(stats.body.pitching)).toBe(true);
  });

  it("streams an initial snapshot, then the state after one append", async () => {
    await post(`/games/${FULL_GAME_ID}/start`).send({}).expect(201);

    const client = new SseClient(`${baseUrl}/games/${FULL_GAME_ID}/stream`);
    const { status, headers } = await client.ready;
    expect(status).toBe(200);
    expect(String(headers["content-type"])).toContain("text/event-stream");

    const snapshot = (await client.next()) as {
      type: string;
      lastSeq: number;
      state: { status: string };
    };
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.lastSeq).toBe(0);
    expect(snapshot.state.status).toBe("live");

    await post(`/games/${FULL_GAME_ID}/events`)
      .send({
        type: "ball_in_play",
        source: "human",
        actor: { kind: "user", id: "usr_01HX" },
        payload: {
          batter: BATTER,
          code: "HR9",
          runsBattedIn: 1,
          runnersAdvanced: [{ player: BATTER, from: "B", to: "H", on: "hit" }],
        },
      })
      .expect(201);

    const update = (await client.next()) as {
      type: string;
      lastSeq: number;
      state: { status: string };
    };
    expect(update).toMatchObject({ type: "state", lastSeq: 1 });
    expect(update.state.status).toBe("live");
    client.close();

    const stats = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/stats?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);
    expect(
      stats.body.batting.find((entry: { playerId: string }) => entry.playerId === BATTER),
    ).toMatchObject({ h: 1, hr: 1, rbi: 1, r: 1, avg: 1 });
  });

  it("creates league and legacy games, appends and enforces write scopes", async () => {
    const leagueGame = await post("/admin/games")
      .send({
        seasonId: SEED_SEASON_ID,
        competitionId: SEED_COMPETITION_IDS[0],
        homeTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
        awayTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
        scheduledStart: "2026-05-02T23:00:00.000Z",
      })
      .expect(201);

    const pitch = {
      type: "pitch",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: {
        pitchNo: 1,
        batter: BATTER,
        pitcher: "0192f3d0-0000-7000-8000-000000000128",
        count: { balls: 0, strikes: 0 },
        call: "S",
      },
    };

    await request(app.getHttpServer())
      .post(`/games/${leagueGame.body.id}/start`)
      .set("authorization", `Bearer ${tiburonesToken}`)
      .send({})
      .expect(201);

    await request(app.getHttpServer())
      .post(`/games/${leagueGame.body.id}/events`)
      .set("authorization", `Bearer ${tiburonesToken}`)
      .send(pitch)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/games/${OTHER_TEAM_GAME_ID}/start`)
      .set("authorization", `Bearer ${tiburonesToken}`)
      .send({})
      .expect(403);

    await request(app.getHttpServer())
      .post(`/games/${leagueGame.body.id}/events`)
      .send(pitch)
      .expect(401);

    const legacy = await post("/games")
      .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
      .expect(201);
    await post(`/games/${legacy.body.id}/start`).send({}).expect(201);
    await post(`/games/${legacy.body.id}/events`).send(pitch).expect(201);
  });

  it("supports catalog CRUD and roster import on Postgres", async () => {
    const admin = (path: string) =>
      request(app.getHttpServer()).get(path).set("authorization", `Bearer ${token}`);
    const adminPatch = (path: string, body: unknown) =>
      request(app.getHttpServer())
        .patch(path)
        .set("authorization", `Bearer ${token}`)
        .send(body as object);
    const adminDelete = (path: string) =>
      request(app.getHttpServer()).delete(path).set("authorization", `Bearer ${token}`);

    const organizations = await admin("/admin/organizations").expect(200);
    expect(organizations.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "0192f3d0-0000-7000-8000-000000000001" })]),
    );

    const organizationTeams = await admin(
      "/admin/organizations/0192f3d0-0000-7000-8000-000000000001/teams",
    ).expect(200);
    expect(organizationTeams.body.map((row: { name: string }) => row.name)).toEqual([
      "Corsarios",
      "Faros",
      "Mantarrayos",
      "Tiburones",
    ]);

    const organizationPlayers = await admin(
      "/admin/organizations/0192f3d0-0000-7000-8000-000000000001/players",
    ).expect(200);
    expect(organizationPlayers.body).toHaveLength(72);
    expect(organizationPlayers.body[0]).toMatchObject({ lastName: "Acosta" });

    await adminPatch("/admin/organizations/0192f3d0-0000-7000-8000-000000000001", {
      name: "Liga Metropolitana Postgres",
    }).expect(200);
    await adminPatch(`/admin/seasons/${SEED_SEASON_ID}`, {
      startsOn: "2026-03-01",
    }).expect(200);
    await adminPatch(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, {
      sortOrder: 9,
    }).expect(200);

    const team = await post("/admin/teams")
      .send({
        organizationId: "0192f3d0-0000-7000-8000-000000000001",
        name: "Postgres Team",
        slug: "postgres-team",
        abbreviation: "PGT",
      })
      .expect(201);
    await adminPatch(`/admin/teams/${team.body.id}`, {
      name: "Postgres Team Edited",
    }).expect(200);

    const player = await post("/admin/players")
      .send({
        organizationId: "0192f3d0-0000-7000-8000-000000000001",
        firstName: "Postgres",
        lastName: "Player",
      })
      .expect(201);
    await adminPatch(`/admin/players/${player.body.id}`, {
      firstName: "Postgres Edited",
    }).expect(200);

    const teamSeason = await post("/admin/team-seasons")
      .send({
        teamId: team.body.id,
        seasonId: SEED_SEASON_ID,
        competitionId: SEED_COMPETITION_IDS[0],
        name: "Postgres Team Season",
      })
      .expect(201);
    await adminPatch(`/admin/team-seasons/${teamSeason.body.id}`, {
      abbreviation: "PGS",
    }).expect(200);

    const dryRun = await post(`/admin/team-seasons/${teamSeason.body.id}/roster-import`)
      .send({
        rows: [
          { firstName: "Imported", lastName: "One", jersey: "1", primaryPosition: "P" },
        ],
        dryRun: true,
      })
      .expect(201);
    expect(dryRun.body).toMatchObject({
      dryRun: true,
      created: { players: 1, rosterEntries: 1 },
      unchanged: 0,
    });

    const imported = await post(`/admin/team-seasons/${teamSeason.body.id}/roster-import`)
      .send({
        rows: [
          { firstName: "Imported", lastName: "One", jersey: "1", primaryPosition: "P" },
        ],
      })
      .expect(201);
    expect(imported.body).toMatchObject({
      created: { players: 1, rosterEntries: 1 },
      updated: { rosterEntries: 0 },
    });
    const rosterEntryId = imported.body.rows[0].rosterEntryId as string;

    await adminPatch(`/admin/roster-entries/${rosterEntryId}`, {
      status: "inactive",
    }).expect(200);

    const game = await post("/admin/games")
      .send({
        seasonId: SEED_SEASON_ID,
        competitionId: SEED_COMPETITION_IDS[0],
        homeTeamSeasonId: teamSeason.body.id,
        awayTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
        scheduledStart: "2026-07-01T23:00:00.000Z",
      })
      .expect(201);
    await adminPatch(`/admin/games/${game.body.id}`, {
      venue: "Postgres Park",
    }).expect(200);
    await adminDelete(`/admin/games/${game.body.id}`).expect(200);

    const usedPlayer = await post("/admin/players")
      .send({
        organizationId: "0192f3d0-0000-7000-8000-000000000001",
        firstName: "Used",
        lastName: "Player",
      })
      .expect(201);
    await post("/admin/roster-entries")
      .send({
        teamSeasonId: SEED_TEAM_SEASON_IDS[0],
        playerId: usedPlayer.body.id,
        jersey: "99",
      })
      .expect(201);
    await adminDelete(`/admin/players/${usedPlayer.body.id}?force=true`).expect(200);

    await adminDelete(`/admin/team-seasons/${teamSeason.body.id}`).expect(200);
    await adminDelete(`/admin/teams/${team.body.id}`).expect(200);
    await adminDelete(`/admin/players/${player.body.id}`).expect(200);

    const season = await post("/admin/seasons")
      .send({
        organizationId: "0192f3d0-0000-7000-8000-000000000001",
        name: "2040",
        year: 2040,
        status: "archived",
      })
      .expect(201);
    const competition = await post("/admin/competitions")
      .send({
        seasonId: season.body.id,
        name: "Postgres Cup",
        kind: "division",
      })
      .expect(201);
    await adminDelete(`/admin/competitions/${competition.body.id}`).expect(200);
    await adminDelete(`/admin/seasons/${season.body.id}`).expect(200);
  });
});
