import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";

let app: INestApplication;

const missing = "0192f3ff-0000-7000-8000-000000000000";
const batter = "0192f3a2-0001-7000-8000-000000000001";

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

async function schedule(homeTeam = "Tiburones", awayTeam = "Marlins"): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/games")
    .send({ homeTeam, awayTeam })
    .expect(201);
  return response.body.id;
}

async function start(gameId: string): Promise<void> {
  await request(app.getHttpServer()).post(`/games/${gameId}/start`).send({}).expect(201);
}

async function append(gameId: string, body: unknown): Promise<void> {
  await request(app.getHttpServer()).post(`/games/${gameId}/events`).send(body).expect(201);
}

function ballInPlay(runsBattedIn: number) {
  return {
    type: "ball_in_play",
    source: "human",
    actor: { kind: "user", id: "usr_01HX" },
    payload: { batter, code: "HR", runsBattedIn },
  };
}

describe("game lifecycle", () => {
  it("starts a scheduled game and refuses a second start", async () => {
    const gameId = await schedule();

    const state = await request(app.getHttpServer()).get(`/games/${gameId}/state`).expect(200);
    expect(state.body.status).toBe("scheduled");

    const started = await request(app.getHttpServer())
      .post(`/games/${gameId}/start`)
      .send({ venue: "Estadio Centenario", startedAt: "2026-04-11T23:41:07.412Z" })
      .expect(201);

    expect(started.body.state).toMatchObject({ status: "live", inning: 1, half: "top" });
    expect(started.body.lastSeq).toBe(0);

    await request(app.getHttpServer()).post(`/games/${gameId}/start`).send({}).expect(409);
  });

  it("returns 404 when starting, finishing or reading the box score of an unknown game", async () => {
    await request(app.getHttpServer()).post(`/games/${missing}/start`).send({}).expect(404);
    await request(app.getHttpServer())
      .post(`/games/${missing}/finish`)
      .send({ reason: "completed" })
      .expect(404);
    await request(app.getHttpServer()).get(`/games/${missing}/boxscore`).expect(404);
  });

  it("refuses a finisher whose finalScore disagrees with the fold and appends nothing", async () => {
    const gameId = await schedule();
    await start(gameId);

    await append(gameId, ballInPlay(2));
    await append(gameId, {
      type: "inning.end",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: { inning: 1, half: "top", runsScored: 2, outs: 3 },
    });

    const before = await request(app.getHttpServer())
      .get(`/games/${gameId}/events`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/games/${gameId}/finish`)
      .send({ reason: "completed", finalScore: { home: 0, away: 3 } })
      .expect(409);

    const after = await request(app.getHttpServer()).get(`/games/${gameId}/events`).expect(200);
    expect(after.body).toHaveLength(before.body.length);

    const finished = await request(app.getHttpServer())
      .post(`/games/${gameId}/finish`)
      .send({ reason: "completed" })
      .expect(201);

    expect(finished.body.state).toMatchObject({
      status: "final",
      score: { home: 0, away: 2 },
    });

    const box = await request(app.getHttpServer())
      .get(`/games/${gameId}/boxscore`)
      .expect(200);

    expect(box.body).toMatchObject({
      gameId,
      status: "final",
      away: { runs: 2, hits: 1, errors: 0 },
      home: { runs: 0, hits: 0, errors: 0 },
    });
    expect(box.body.away.linescore).toEqual([2, null, null, null, null, null, null, null, null]);

    await request(app.getHttpServer())
      .post(`/games/${gameId}/finish`)
      .send({ reason: "completed" })
      .expect(409);
  });

  it("uses the folded score when finalScore is omitted and accepts an explicit match", async () => {
    const gameId = await schedule("Norteños", "Sureños");
    await start(gameId);
    await append(gameId, ballInPlay(1));

    const finished = await request(app.getHttpServer())
      .post(`/games/${gameId}/finish`)
      .send({ reason: "rain", finalScore: { home: 0, away: 1 } })
      .expect(201);

    expect(finished.body.state).toMatchObject({
      status: "suspended",
      score: { home: 0, away: 1 },
    });
  });

  it("rejects an invalid schedule and an invalid finish reason", async () => {
    await request(app.getHttpServer())
      .post("/games")
      .send({ homeTeam: "Tiburones", awayTeam: "Marlins", scheduledStart: "tomorrow" })
      .expect(400);

    await request(app.getHttpServer())
      .post("/games")
      .send({ homeTeam: "Tiburones", awayTeam: "Marlins", venue: "x".repeat(201) })
      .expect(400);

    const gameId = await schedule();
    await start(gameId);
    await request(app.getHttpServer())
      .post(`/games/${gameId}/finish`)
      .send({ reason: "mercy" })
      .expect(400);
  });
});
