import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_COMPETITION_IDS,
  SEED_ORGANIZATION_ID,
  SEED_SEASON_ID,
  SEED_TEAM_SEASON_IDS,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";

const UNKNOWN = "0192f3d0-0000-7000-8000-000000000099";
const NORTH_GAME_ID = "0192f3d0-0000-7000-8000-000000000200";
const SOUTH_GAME_ID = "0192f3d0-0000-7000-8000-000000000202";

let app: INestApplication;
let league: LeagueStore;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  league = app.get<LeagueStore>(LEAGUE_STORE);
  await seedLeague(league);
});

afterAll(async () => {
  await app.close();
});

describe("league reads over the seeded catalog", () => {
  it("lists one organization", async () => {
    const response = await request(app.getHttpServer()).get("/organizations").expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({
      id: SEED_ORGANIZATION_ID,
      name: "Liga Metropolitana",
      slug: "liga-metropolitana",
    });
  });

  it("lists one active season and filters by organization", async () => {
    const response = await request(app.getHttpServer()).get("/seasons").expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ id: SEED_SEASON_ID, status: "active", year: 2026 });

    const filtered = await request(app.getHttpServer())
      .get(`/seasons?organizationId=${SEED_ORGANIZATION_ID}`)
      .expect(200);
    expect(filtered.body).toHaveLength(1);

    const empty = await request(app.getHttpServer())
      .get(`/seasons?organizationId=${UNKNOWN}`)
      .expect(200);
    expect(empty.body).toHaveLength(0);
  });

  it("returns a season with its two competitions", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}`)
      .expect(200);

    expect(response.body.season).toMatchObject({ id: SEED_SEASON_ID, name: "2026" });
    expect(response.body.competitions.map((row: { name: string }) => row.name)).toEqual([
      "Zona Norte",
      "Zona Sur",
    ]);

    const competitions = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/competitions`)
      .expect(200);
    expect(competitions.body).toHaveLength(2);
  });

  it("returns two teams per competition", async () => {
    for (const [index, competitionId] of SEED_COMPETITION_IDS.entries()) {
      const response = await request(app.getHttpServer())
        .get(`/competitions/${competitionId}/teams`)
        .expect(200);
      expect(response.body).toHaveLength(2);
      expect(response.body.every((row: { competitionId: string }) => row.competitionId === competitionId))
        .toBe(true);
      expect(response.body[0].competitionName).toBe(index === 0 ? "Zona Norte" : "Zona Sur");
    }
  });

  it("returns a team season with an 18-player roster and names", async () => {
    const response = await request(app.getHttpServer())
      .get(`/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`)
      .expect(200);

    expect(response.body.teamSeason).toMatchObject({
      id: SEED_TEAM_SEASON_IDS[0],
      name: "Tiburones",
      teamName: "Tiburones",
      competitionName: "Zona Norte",
    });
    expect(response.body.roster).toHaveLength(18);
    expect(response.body.roster[0]).toMatchObject({
      jersey: "2",
      firstName: "Alejandro",
      lastName: "Aguilar",
      primaryPosition: "C",
      status: "active",
    });
  });

  it("lists eight games with the two seeded summary finals", async () => {
    const all = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games`)
      .expect(200);
    expect(all.body).toHaveLength(8);

    const north = all.body.find((game: { id: string }) => game.id === NORTH_GAME_ID);
    expect(north).toMatchObject({
      id: NORTH_GAME_ID,
      homeTeam: "Tiburones",
      awayTeam: "Faros",
      status: "final",
      score: { home: 5, away: 3 },
      coverage: "summary",
    });

    const south = all.body.find((game: { id: string }) => game.id === SOUTH_GAME_ID);
    expect(south).toMatchObject({
      homeTeam: "Mantarrayos",
      awayTeam: "Corsarios",
      status: "final",
      score: { home: 2, away: 1 },
      coverage: "summary",
    });

    expect(
      all.body
        .filter((game: { id: string }) => game.id !== NORTH_GAME_ID && game.id !== SOUTH_GAME_ID)
        .every(
          (game: { status: string; score: unknown }) =>
            game.status === "scheduled" && game.score === null,
        ),
    ).toBe(true);

    const norte = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);
    expect(norte.body).toHaveLength(4);
    expect(
      norte.body.every(
        (game: { competitionId: string }) => game.competitionId === SEED_COMPETITION_IDS[0],
      ),
    ).toBe(true);
  });

  it("groups standings by competition with the seeded finals", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/standings`)
      .expect(200);

    expect(response.body).toHaveLength(2);
    expect(response.body.map((group: { competitionName: string }) => group.competitionName)).toEqual(
      ["Zona Norte", "Zona Sur"],
    );

    const norte = response.body[0];
    expect(norte.teams.map((row: { team: string }) => row.team)).toEqual(["Tiburones", "Faros"]);
    expect(norte.teams.map((row: { w: number; l: number }) => [row.w, row.l])).toEqual([
      [1, 0],
      [0, 1],
    ]);

    const sur = response.body[1];
    expect(sur.teams.map((row: { team: string }) => row.team)).toEqual([
      "Mantarrayos",
      "Corsarios",
    ]);
    expect(sur.teams.map((row: { w: number; l: number }) => [row.w, row.l])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });
});

describe("league game detail", () => {
  it("returns a summary final with its stored score", async () => {
    const response = await request(app.getHttpServer())
      .get(`/league-games/${NORTH_GAME_ID}`)
      .expect(200);

    expect(response.body.game).toMatchObject({
      id: NORTH_GAME_ID,
      homeTeam: "Tiburones",
      awayTeam: "Faros",
      coverage: "summary",
      status: "final",
      score: { home: 5, away: 3 },
    });
    expect(response.body.summary).toMatchObject({
      gameId: NORTH_GAME_ID,
      homeScore: 5,
      awayScore: 3,
      linescore: null,
      teamBox: null,
      source: "seed",
    });
  });

  it("returns the second seeded summary final", async () => {
    const response = await request(app.getHttpServer())
      .get("/league-games/0192f3d0-0000-7000-8000-000000000202")
      .expect(200);

    expect(response.body.game).toMatchObject({
      homeTeam: "Mantarrayos",
      awayTeam: "Corsarios",
      status: "final",
      score: { home: 2, away: 1 },
    });
    expect(response.body.summary).toMatchObject({ homeScore: 2, awayScore: 1, source: "seed" });
  });

  it("answers 404 for an unknown league game", async () => {
    await request(app.getHttpServer()).get(`/league-games/${UNKNOWN}`).expect(404);
  });
});

describe("stored summary standings", () => {
  beforeAll(async () => {
    await league.upsertGameSummary({
      gameId: NORTH_GAME_ID,
      homeScore: 5,
      awayScore: 3,
      linescore: null,
      teamBox: null,
      source: "import",
      updatedAt: "2026-03-08T00:00:00.000Z",
    });
  });

  it("marks both summarized games final with their stored scores", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games`)
      .expect(200);

    const game = response.body.find((row: { id: string }) => row.id === NORTH_GAME_ID);
    expect(game).toMatchObject({
      status: "final",
      score: { home: 5, away: 3 },
    });

    const south = response.body.find((row: { id: string }) => row.id === SOUTH_GAME_ID);
    expect(south).toMatchObject({
      status: "final",
      score: { home: 2, away: 1 },
    });

    expect(
      response.body
        .filter((row: { id: string }) => row.id !== NORTH_GAME_ID && row.id !== SOUTH_GAME_ID)
        .every((row: { status: string }) => row.status === "scheduled"),
    ).toBe(true);
  });

  it("counts the summaries in their own division", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/standings`)
      .expect(200);

    const norte = response.body.find(
      (group: { competitionId: string }) => group.competitionId === SEED_COMPETITION_IDS[0],
    );
    expect(norte.teams).toEqual([
      {
        teamSeasonId: SEED_TEAM_SEASON_IDS[0],
        team: "Tiburones",
        w: 1,
        l: 0,
        runsFor: 5,
        runsAgainst: 3,
        pct: 1,
        gamesPlayed: 1,
      },
      {
        teamSeasonId: SEED_TEAM_SEASON_IDS[1],
        team: "Faros",
        w: 0,
        l: 1,
        runsFor: 3,
        runsAgainst: 5,
        pct: 0,
        gamesPlayed: 1,
      },
    ]);

    const sur = response.body.find(
      (group: { competitionId: string }) => group.competitionId === SEED_COMPETITION_IDS[1],
    );
    expect(sur.teams).toEqual([
      {
        teamSeasonId: SEED_TEAM_SEASON_IDS[2],
        team: "Mantarrayos",
        w: 1,
        l: 0,
        runsFor: 2,
        runsAgainst: 1,
        pct: 1,
        gamesPlayed: 1,
      },
      {
        teamSeasonId: SEED_TEAM_SEASON_IDS[3],
        team: "Corsarios",
        w: 0,
        l: 1,
        runsFor: 1,
        runsAgainst: 2,
        pct: 0,
        gamesPlayed: 1,
      },
    ]);
  });
});

describe("missing league resources", () => {
  it("answers 404 for unknown season, competition and team season", async () => {
    await request(app.getHttpServer()).get(`/seasons/${UNKNOWN}`).expect(404);
    await request(app.getHttpServer()).get(`/seasons/${UNKNOWN}/competitions`).expect(404);
    await request(app.getHttpServer()).get(`/seasons/${UNKNOWN}/games`).expect(404);
    await request(app.getHttpServer()).get(`/seasons/${UNKNOWN}/standings`).expect(404);
    await request(app.getHttpServer()).get(`/competitions/${UNKNOWN}/teams`).expect(404);
    await request(app.getHttpServer()).get(`/team-seasons/${UNKNOWN}`).expect(404);
  });

  it("answers 404 for an unknown competition filter", async () => {
    await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games?competitionId=${UNKNOWN}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/standings?competitionId=${UNKNOWN}`)
      .expect(404);
  });

  it("answers 404 for invalid ids in the path", async () => {
    await request(app.getHttpServer()).get("/league-games/not-a-uuid").expect(404);
    await request(app.getHttpServer()).get("/seasons/not-a-uuid").expect(404);
    await request(app.getHttpServer()).get("/competitions/not-a-uuid/teams").expect(404);
  });
});
