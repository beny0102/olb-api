import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import { SseClient } from "./support/sse.js";

const UNKNOWN = "0192f3ff-0000-7000-8000-000000000000";

let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.listen(0);
  baseUrl = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

async function startedGame(): Promise<string> {
  const created = await request(app.getHttpServer())
    .post("/games")
    .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
    .expect(201);
  await request(app.getHttpServer())
    .post(`/games/${created.body.id}/start`)
    .send({})
    .expect(201);
  return created.body.id;
}

function pitch(call: "B" | "S") {
  return {
    type: "pitch",
    source: "human",
    actor: { kind: "user", id: "usr_01HX" },
    payload: {
      pitchNo: 1,
      batter: "0192f3a2-0001-7000-8000-000000000001",
      pitcher: "0192f3a2-0001-7000-8000-000000000002",
      count: { balls: 0, strikes: 0 },
      call,
    },
  };
}

describe("GET /games/:id/stream", () => {
  it("opens text/event-stream with an initial snapshot", async () => {
    const gameId = await startedGame();
    const client = new SseClient(`${baseUrl}/games/${gameId}/stream`);
    const { status, headers } = await client.ready;

    expect(status).toBe(200);
    expect(String(headers["content-type"])).toContain("text/event-stream");

    const message = (await client.next()) as {
      type: string;
      gameId: string;
      lastSeq: number;
      seq: number;
      state: { status: string; lastSeq: number };
    };
    expect(message).toMatchObject({ type: "snapshot", gameId, lastSeq: 0, seq: 0 });
    expect(message.state).toMatchObject({ status: "live", lastSeq: 0 });
    client.close();
  });

  it("emits a state message after an append", async () => {
    const gameId = await startedGame();
    const client = new SseClient(`${baseUrl}/games/${gameId}/stream`);
    await client.ready;
    await client.next();

    await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send(pitch("B"))
      .expect(201);

    const message = (await client.next()) as {
      type: string;
      gameId: string;
      lastSeq: number;
      state: { count: { balls: number; strikes: number }; lastSeq: number };
    };
    expect(message).toMatchObject({ type: "state", gameId, lastSeq: 1 });
    expect(message.state.count).toEqual({ balls: 1, strikes: 0 });
    expect(message.state.lastSeq).toBe(1);
    client.close();
  });

  it("emits a state message after the game is finished", async () => {
    const gameId = await startedGame();
    const client = new SseClient(`${baseUrl}/games/${gameId}/stream`);
    await client.ready;
    await client.next();

    await request(app.getHttpServer())
      .post(`/games/${gameId}/finish`)
      .send({ reason: "completed" })
      .expect(201);

    const message = (await client.next()) as {
      type: string;
      lastSeq: number;
      state: { status: string };
    };
    expect(message.type).toBe("state");
    expect(message.lastSeq).toBe(1);
    expect(message.state.status).toBe("final");
    client.close();
  });

  it("answers 404 for an unknown or invalid game before opening the stream", async () => {
    await request(app.getHttpServer()).get(`/games/${UNKNOWN}/stream`).expect(404);
    await request(app.getHttpServer()).get("/games/not-a-uuid/stream").expect(404);
  });
});
