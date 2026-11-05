import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { seedAuth, SEED_AUTH_EMAILS } from "../src/auth/auth-seed.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_COMPETITION_IDS,
  SEED_ORGANIZATION_ID,
  SEED_SEASON_ID,
  SEED_TEAM_SEASON_IDS,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";

const ADMIN_EMAIL = SEED_AUTH_EMAILS[0];
const NORTE_EMAIL = SEED_AUTH_EMAILS[1];
const TIBURONES_EMAIL = SEED_AUTH_EMAILS[2];
const VERIFIER_EMAIL = SEED_AUTH_EMAILS[3];

let app: INestApplication;
let adminToken: string;
let norteToken: string;
let tiburonesToken: string;
let verifierToken: string;

let season2027Id: string;
let teamAId: string;
let teamBId: string;
let playerId: string;
let competitionId: string;
let teamSeasonAId: string;
let teamSeasonBId: string;
let gameId: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  await seedLeague(app.get<LeagueStore>(LEAGUE_STORE));
  await seedAuth(app.get<AuthStore>(AUTH_STORE));

  const tokens = await Promise.all(
    [
      [ADMIN_EMAIL, "olb-demo-admin"],
      [NORTE_EMAIL, "olb-demo-norte"],
      [TIBURONES_EMAIL, "olb-demo-tiburones"],
      [VERIFIER_EMAIL, "olb-demo-verificador"],
    ].map(async ([email, password]) => {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password })
        .expect(200);
      return response.body.token as string;
    }),
  );

  [adminToken, norteToken, tiburonesToken, verifierToken] = tokens;
});

afterAll(async () => {
  await app.close();
});

function post(path: string, token: string | null, body: unknown) {
  const call = request(app.getHttpServer()).post(path);
  if (token !== null) call.set("authorization", `Bearer ${token}`);
  return call.send(body as object);
}

describe("league admin writes", () => {
  it("lets an organization admin create an active season and archives the old one", async () => {
    const response = await post("/admin/seasons", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "2027",
      year: 2027,
      status: "active",
      startsOn: "2027-03-01",
      endsOn: "2027-11-30",
    }).expect(201);

    expect(response.body).toMatchObject({
      organizationId: SEED_ORGANIZATION_ID,
      name: "2027",
      year: 2027,
      status: "active",
      startsOn: "2027-03-01",
      endsOn: "2027-11-30",
    });
    season2027Id = response.body.id;

    const seasons = await request(app.getHttpServer())
      .get(`/seasons?organizationId=${SEED_ORGANIZATION_ID}`)
      .expect(200);
    expect(seasons.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: season2027Id, year: 2027, status: "active" }),
        expect.objectContaining({ id: SEED_SEASON_ID, year: 2026, status: "archived" }),
      ]),
    );
  });

  it("lets an organization admin create teams and a player", async () => {
    const teamA = await post("/admin/teams", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "Astros del Puerto",
      slug: "astros-del-puerto",
      abbreviation: "AST",
    }).expect(201);
    expect(teamA.body).toMatchObject({ name: "Astros del Puerto", slug: "astros-del-puerto" });
    teamAId = teamA.body.id;

    const teamB = await post("/admin/teams", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "Bucaneros",
      slug: "bucaneros",
    }).expect(201);
    teamBId = teamB.body.id;

    const player = await post("/admin/players", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      firstName: "Daniel",
      lastName: "Sosa",
    }).expect(201);
    expect(player.body).toMatchObject({ firstName: "Daniel", lastName: "Sosa" });
    playerId = player.body.id;
  });

  it("lets a competition admin create a competition in their season", async () => {
    const response = await post("/admin/competitions", norteToken, {
      seasonId: SEED_SEASON_ID,
      name: "Zona Este",
      kind: "division",
      sortOrder: 3,
    }).expect(201);

    expect(response.body).toMatchObject({
      seasonId: SEED_SEASON_ID,
      name: "Zona Este",
      kind: "division",
      level: 1,
      sortOrder: 3,
    });
    competitionId = response.body.id;
    expect(competitionId).not.toBe(SEED_COMPETITION_IDS[0]);
  });

  it("lets a competition admin add team seasons to their competition", async () => {
    const teamSeasonA = await post("/admin/team-seasons", norteToken, {
      teamId: teamAId,
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
    }).expect(201);
    expect(teamSeasonA.body).toMatchObject({
      teamId: teamAId,
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      name: "Astros del Puerto",
      teamName: "Astros del Puerto",
      competitionName: "Zona Norte",
    });
    teamSeasonAId = teamSeasonA.body.id;

    const teamSeasonB = await post("/admin/team-seasons", norteToken, {
      teamId: teamBId,
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      name: "Bucaneros del Norte",
      abbreviation: "BUC",
    }).expect(201);
    teamSeasonBId = teamSeasonB.body.id;
  });

  it("lets a competition admin create a scheduled game and exposes it in the season games", async () => {
    const response = await post("/admin/games", norteToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: teamSeasonAId,
      awayTeamSeasonId: teamSeasonBId,
      scheduledStart: "2027-04-10T23:00:00.000Z",
      venue: "Estadio Metropolitano",
    }).expect(201);

    expect(response.body).toMatchObject({
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: teamSeasonAId,
      awayTeamSeasonId: teamSeasonBId,
      homeTeam: "Astros del Puerto",
      awayTeam: "Bucaneros",
      scheduledStart: "2027-04-10T23:00:00.000Z",
      venue: "Estadio Metropolitano",
      coverage: "full",
      dataSource: "official",
      lastSeq: -1,
    });
    gameId = response.body.id;

    const games = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);
    expect(games.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: gameId, status: "scheduled", score: null }),
      ]),
    );
  });

  it("lets a team admin add a roster entry for their own team", async () => {
    const response = await post("/admin/roster-entries", tiburonesToken, {
      teamSeasonId: SEED_TEAM_SEASON_IDS[0],
      playerId,
      jersey: "99",
      primaryPosition: "RF",
    }).expect(201);

    expect(response.body).toMatchObject({
      teamSeasonId: SEED_TEAM_SEASON_IDS[0],
      playerId,
      jersey: "99",
      primaryPosition: "RF",
      status: "active",
      firstName: "Daniel",
      lastName: "Sosa",
    });

    const teamSeason = await request(app.getHttpServer())
      .get(`/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`)
      .expect(200);
    expect(teamSeason.body.roster).toEqual(
      expect.arrayContaining([expect.objectContaining({ jersey: "99", playerId })]),
    );
  });

  it("answers 403 when a team admin writes for another team", async () => {
    await post("/admin/roster-entries", tiburonesToken, {
      teamSeasonId: SEED_TEAM_SEASON_IDS[1],
      playerId,
    }).expect(403);
  });

  it("answers 403 for a verifier trying to write", async () => {
    await post("/admin/teams", verifierToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "No Permitido",
      slug: "no-permitido",
    }).expect(403);
  });

  it("answers 400 for an invalid body", async () => {
    await post("/admin/seasons", adminToken, {}).expect(400);
    await post("/admin/games", norteToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: teamSeasonAId,
      awayTeamSeasonId: teamSeasonAId,
    }).expect(400);
  });

  it("answers 401 without a token", async () => {
    await post("/admin/teams", null, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "Sin Token",
      slug: "sin-token",
    }).expect(401);
  });

  it("keeps public league reads open", async () => {
    await request(app.getHttpServer()).get("/organizations").expect(200);
    await request(app.getHttpServer()).get(`/seasons/${SEED_SEASON_ID}`).expect(200);
    await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/standings`)
      .expect(200);
  });
});
