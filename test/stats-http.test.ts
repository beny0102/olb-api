import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_COMPETITION_IDS,
  SEED_SEASON_ID,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import { EVENT_STORE, type EventStore } from "../src/store/store.js";

const UNKNOWN = "0192f3d0-0000-7000-8000-000000000099";
const SUMMARY_GAME_ID = "0192f3d0-0000-7000-8000-000000000200";
const FULL_GAME_ID = "0192f3d0-0000-7000-8000-000000000201";
const SUMMARY_PLAYER = player(107);

let app: INestApplication;

function player(n: number): string {
  return `0192f3d0-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

const PITCHER = player(128);

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  const league = app.get<LeagueStore>(LEAGUE_STORE);
  const events = app.get<EventStore>(EVENT_STORE);
  await seedLeague(league);

  // The seed writes the league catalog; the memory event store is separate,
  // so the two full/summary games need their game rows before appending.
  for (const id of [SUMMARY_GAME_ID, FULL_GAME_ID]) {
    await events.createGame({
      id,
      homeTeam: "Faros",
      awayTeam: "Tiburones",
      scheduledStart: null,
      venue: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }

  await request(app.getHttpServer()).post(`/games/${FULL_GAME_ID}/start`).send({}).expect(201);

  const append = (gameId: string, body: unknown) =>
    request(app.getHttpServer()).post(`/games/${gameId}/events`).send(body).expect(201);

  const pitch = (batter: string, call: "B" | "S" | "H", balls: number, strikes: number) => ({
    type: "pitch",
    source: "human",
    actor: { kind: "user", id: "usr_01HX" },
    payload: {
      pitchNo: 1,
      batter,
      pitcher: PITCHER,
      count: { balls, strikes },
      call,
    },
  });

  const ballInPlay = (
    batter: string,
    code: string,
    runsBattedIn: number,
    runnersAdvanced: unknown[] = [],
  ) => ({
    type: "ball_in_play",
    source: "human",
    actor: { kind: "user", id: "usr_01HX" },
    payload: { batter, code, runsBattedIn, runnersAdvanced },
  });

  // HBP, single, home run, walk, strikeout, double play, sacrifice.
  await append(FULL_GAME_ID, pitch(player(100), "H", 0, 0));
  await append(FULL_GAME_ID, ballInPlay(player(101), "S7", 0));
  await append(FULL_GAME_ID, ballInPlay(player(101), "E5", 0));
  await append(FULL_GAME_ID, ballInPlay(player(101), "FC", 0));
  await append(
    FULL_GAME_ID,
    ballInPlay(player(102), "HR9", 1, [{ player: player(102), from: "B", to: "H", on: "hit" }]),
  );

  for (const balls of [0, 1, 2, 3]) {
    await append(FULL_GAME_ID, pitch(player(103), "B", balls, 0));
  }
  for (const strikes of [0, 1, 2]) {
    await append(FULL_GAME_ID, pitch(player(104), "S", 0, strikes));
  }

  await append(FULL_GAME_ID, ballInPlay(player(105), "DP", 0));
  await append(
    FULL_GAME_ID,
    ballInPlay(player(106), "SAC", 0, [
      { player: player(106), from: "B", to: "1", on: "sacrifice" },
    ]),
  );

  // A summary game has no play-by-play in the stats fold even if an event was
  // appended to its log: coverage, not the log, decides.
  await append(
    SUMMARY_GAME_ID,
    ballInPlay(SUMMARY_PLAYER, "HR", 1, [
      { player: SUMMARY_PLAYER, from: "B", to: "H", on: "hit" },
    ]),
  );
});

afterAll(async () => {
  await app.close();
});

async function leaders(query = ""): Promise<{
  seasonId: string;
  batting: Array<Record<string, unknown>>;
  pitching: Array<Record<string, unknown>>;
}> {
  const response = await request(app.getHttpServer())
    .get(`/seasons/${SEED_SEASON_ID}/leaders${query}`)
    .expect(200);
  return response.body;
}

function row(rows: Array<Record<string, unknown>>, playerId: string) {
  return rows.find((entry) => entry.playerId === playerId);
}

describe("season leaders and stats", () => {
  it("derives batting leaders from applied full-game events", async () => {
    const body = await leaders(`?competitionId=${SEED_COMPETITION_IDS[0]}`);

    expect(body.seasonId).toBe(SEED_SEASON_ID);
    expect(row(body.batting, player(100))).toMatchObject({
      player: "Alejandro Aguilar",
      team: "Tiburones",
      pa: 1,
      ab: 0,
      h: 0,
      hbp: 1,
      avg: null,
    });
    expect(row(body.batting, player(101))).toMatchObject({
      player: "Bruno Bermúdez",
      team: "Tiburones",
      pa: 3,
      ab: 3,
      h: 1,
      avg: 0.333,
    });
    expect(row(body.batting, player(102))).toMatchObject({
      player: "Camilo Castillo",
      team: "Tiburones",
      pa: 1,
      ab: 1,
      h: 1,
      hr: 1,
      rbi: 1,
      r: 1,
      avg: 1,
    });
    expect(row(body.batting, player(103))).toMatchObject({
      pa: 1,
      ab: 0,
      bb: 1,
      avg: null,
    });
    expect(row(body.batting, player(104))).toMatchObject({
      pa: 1,
      ab: 1,
      so: 1,
      avg: 0,
    });
    expect(row(body.batting, player(105))).toMatchObject({ pa: 1, ab: 1, h: 0, avg: 0 });
    expect(row(body.batting, player(106))).toMatchObject({ pa: 1, ab: 0, avg: null });

    // The summary game contributes standings but never a player line.
    expect(row(body.batting, SUMMARY_PLAYER)).toBeUndefined();
  });

  it("derives pitching leaders from pitch events", async () => {
    const body = await leaders(`?competitionId=${SEED_COMPETITION_IDS[0]}`);

    expect(row(body.pitching, PITCHER)).toEqual({
      playerId: PITCHER,
      player: "Lucas Galván",
      teamSeasonId: "0192f3d0-0000-7000-8000-000000000031",
      team: "Faros",
      jersey: "41",
      position: "P",
      pitches: 8,
      so: 1,
      bb: 1,
      appearances: 1,
    });
  });

  it("returns standings groups plus both leader tables from /stats", async () => {
    const response = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/stats?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);

    const standings = await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/standings?competitionId=${SEED_COMPETITION_IDS[0]}`)
      .expect(200);

    expect(response.body.seasonId).toBe(SEED_SEASON_ID);
    expect(response.body.groups).toEqual(standings.body);
    expect(response.body.batting.length).toBeGreaterThan(0);
    expect(response.body.pitching.length).toBeGreaterThan(0);
    expect(row(response.body.batting, SUMMARY_PLAYER)).toBeUndefined();
  });

  it("scopes leaders to one competition", async () => {
    const body = await leaders(`?competitionId=${SEED_COMPETITION_IDS[1]}`);
    expect(body.batting).toEqual([]);
    expect(body.pitching).toEqual([]);
  });

  it("answers 404 for unknown seasons, competitions and invalid ids", async () => {
    await request(app.getHttpServer()).get(`/seasons/${UNKNOWN}/leaders`).expect(404);
    await request(app.getHttpServer()).get(`/seasons/${UNKNOWN}/stats`).expect(404);
    await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/leaders?competitionId=${UNKNOWN}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/seasons/${SEED_SEASON_ID}/stats?competitionId=${UNKNOWN}`)
      .expect(404);
    await request(app.getHttpServer()).get("/seasons/not-a-uuid/leaders").expect(404);
  });
});
