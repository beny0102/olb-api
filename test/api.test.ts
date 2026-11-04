import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { isRealtimeMessage } from "@olb/contract";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";

let app: INestApplication;

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

async function createGame(): Promise<string> {
  const response = await request(app.getHttpServer())
    .post("/games")
    .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
    .expect(201);
  await request(app.getHttpServer()).post(`/games/${response.body.id}/start`).send({}).expect(201);
  return response.body.id;
}

describe("olb-api", () => {
  it("reports health and the active storage", async () => {
    const response = await request(app.getHttpServer()).get("/health").expect(200);
    expect(response.body).toMatchObject({ status: "ok", contract: "olb.event/1", storage: "memory" });
  });

  it("creates a scheduled game and appends no event", async () => {
    const response = await request(app.getHttpServer())
      .post("/games")
      .send({
        homeTeam: "Marlins",
        awayTeam: "Tiburones",
        scheduledStart: "2026-04-11T23:40:00.000Z",
        venue: "Estadio Centenario",
      })
      .expect(201);

    expect(response.body).toMatchObject({
      homeTeam: "Marlins",
      awayTeam: "Tiburones",
      scheduledStart: "2026-04-11T23:40:00.000Z",
      venue: "Estadio Centenario",
      lastSeq: 0,
    });

    const events = await request(app.getHttpServer())
      .get(`/games/${response.body.id}/events`)
      .expect(200);

    expect(events.body).toHaveLength(0);

    const state = await request(app.getHttpServer())
      .get(`/games/${response.body.id}/state`)
      .expect(200);

    expect(state.body.status).toBe("scheduled");
  });

  it("starts a scheduled game with game.start at sequence zero", async () => {
    const created = await request(app.getHttpServer())
      .post("/games")
      .send({ homeTeam: "Marlins", awayTeam: "Tiburones", venue: "Estadio Centenario" })
      .expect(201);

    const started = await request(app.getHttpServer())
      .post(`/games/${created.body.id}/start`)
      .send({ venue: "Estadio Centenario", fieldCondition: "dry" })
      .expect(201);

    expect(started.body).toMatchObject({ homeTeam: "Marlins", lastSeq: 0 });
    expect(started.body.state).toMatchObject({
      status: "live",
      inning: 1,
      half: "top",
      battingTeam: "away",
    });

    const events = await request(app.getHttpServer())
      .get(`/games/${created.body.id}/events`)
      .expect(200);

    expect(events.body).toHaveLength(1);
    expect(events.body[0]).toMatchObject({ seq: 0, type: "game.start", contract: "olb.event/1" });
    expect(events.body[0].payload).toMatchObject({
      venue: "Estadio Centenario",
      fieldCondition: "dry",
    });
  });

  it("rejects a game without both teams", async () => {
    await request(app.getHttpServer()).post("/games").send({ homeTeam: "Marlins" }).expect(400);
  });

  it("assigns sequence numbers and rejects an invalid payload", async () => {
    const gameId = await createGame();

    const first = await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({
        type: "pitch",
        source: "human",
        actor: { kind: "user", id: "usr_01HX" },
        payload: {
          pitchNo: 1,
          batter: "0192f3a2-0001-7000-8000-000000000001",
          pitcher: "0192f3a2-0001-7000-8000-000000000002",
          count: { balls: 0, strikes: 0 },
          call: "S",
        },
      })
      .expect(201);

    expect(first.body).toMatchObject({ seq: 1, type: "pitch", gameId });

    const second = await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({
        type: "pitch",
        source: "human",
        actor: { kind: "user", id: "usr_01HX" },
        payload: {
          pitchNo: 2,
          batter: "0192f3a2-0001-7000-8000-000000000001",
          pitcher: "0192f3a2-0001-7000-8000-000000000002",
          count: { balls: 0, strikes: 1 },
          call: "B",
        },
      })
      .expect(201);

    expect(second.body.seq).toBe(2);

    await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({
        type: "pitch",
        source: "human",
        actor: { kind: "user", id: "usr_01HX" },
        payload: {
          pitchNo: 3,
          batter: "0192f3a2-0001-7000-8000-000000000001",
          pitcher: "0192f3a2-0001-7000-8000-000000000002",
          count: { balls: 1, strikes: 1 },
          call: "Z",
        },
      })
      .expect(400);
  });

  it("serves a projection that validates as a realtime snapshot", async () => {
    const gameId = await createGame();

    await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({
        type: "pitch",
        source: "human",
        actor: { kind: "user", id: "usr_01HX" },
        payload: {
          pitchNo: 1,
          batter: "0192f3a2-0001-7000-8000-000000000001",
          pitcher: "0192f3a2-0001-7000-8000-000000000002",
          count: { balls: 0, strikes: 0 },
          call: "B",
        },
      })
      .expect(201);

    const state = await request(app.getHttpServer()).get(`/games/${gameId}/state`).expect(200);

    expect(state.body).toMatchObject({ status: "live", inning: 1, half: "top", battingTeam: "away" });
    expect(state.body.count).toEqual({ balls: 1, strikes: 0 });
    expect(
      isRealtimeMessage({
        type: "snapshot",
        gameId,
        seq: state.body.lastSeq,
        state: state.body,
      }),
    ).toBe(true);
  });

  it("resumes the log from a sequence number", async () => {
    const gameId = await createGame();
    const pitch = {
      type: "pitch",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: {
        pitchNo: 1,
        batter: "0192f3a2-0001-7000-8000-000000000001",
        pitcher: "0192f3a2-0001-7000-8000-000000000002",
        count: { balls: 0, strikes: 0 },
        call: "S",
      },
    };

    await request(app.getHttpServer()).post(`/games/${gameId}/events`).send(pitch).expect(201);
    await request(app.getHttpServer()).post(`/games/${gameId}/events`).send(pitch).expect(201);

    const resumed = await request(app.getHttpServer())
      .get(`/games/${gameId}/events?fromSeq=1`)
      .expect(200);

    expect(resumed.body.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
  });

  it("returns 404 for an unknown game", async () => {
    const missing = "0192f3ff-0000-7000-8000-000000000000";
    await request(app.getHttpServer()).get(`/games/${missing}`).expect(404);
    await request(app.getHttpServer())
      .post(`/games/${missing}/events`)
      .send({ type: "note", source: "human", actor: { kind: "user", id: "u" }, payload: { text: "hi" } })
      .expect(404);
  });
});
