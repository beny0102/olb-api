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
      jersey: "1",
      firstName: "Alejandro",
      lastName: "Aguilar",
      primaryPosition: "C",
      status: "active",
    });
  });

  it("lists eight scheduled games and filters by competition", async () => {
    const all = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games`)
      .expect(200);
    expect(all.body).toHaveLength(8);
    expect(all.body.every((game: { status: string }) => game.status === "scheduled")).toBe(true);
    expect(all.body.every((game: { score: unknown }) => game.score === null)).toBe(true);
    expect(all.body[0]).toMatchObject({
      id: NORTH_GAME_ID,
      homeTeam: "Tiburones",
      awayTeam: "Faros",
      status: "scheduled",
      score: null,
    });

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

  it("groups standings by competition with two 0-0 teams each", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/standings`)
      .expect(200);

    expect(response.body).toHaveLength(2);
    expect(response.body.map((group: { competitionName: string }) => group.competitionName)).toEqual(
      ["Zona Norte", "Zona Sur"],
    );
    for (const group of response.body) {
      expect(group.teams).toHaveLength(2);
      expect(
        group.teams.every(
          (row: { w: number; l: number; pct: number; gamesPlayed: number }) =>
            row.w === 0 && row.l === 0 && row.pct === 0 && row.gamesPlayed === 0,
        ),
      ).toBe(true);
    }
    expect(response.body[0].teams.map((row: { team: string }) => row.team)).toEqual([
      "Faros",
      "Tiburones",
    ]);
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

  it("marks the summarized game final with its stored score", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/games?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);

    const game = response.body.find((row: { id: string }) => row.id === NORTH_GAME_ID);
    expect(game).toMatchObject({
      status: "final",
      score: { home: 5, away: 3 },
    });
    expect(
      response.body
        .filter((row: { id: string }) => row.id !== NORTH_GAME_ID)
        .every((row: { status: string }) => row.status === "scheduled"),
    ).toBe(true);
  });

  it("counts the summary in Norte standings only", async () => {
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
    expect(sur.teams.every((row: { gamesPlayed: number }) => row.gamesPlayed === 0)).toBe(true);
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
});
