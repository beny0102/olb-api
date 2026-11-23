import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import { login, seedTestAuth } from "./support/auth.js";
import { SseClient } from "./support/sse.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;

describe.skipIf(!databaseUrl || !redisUrl)("multi-replica HTTP", () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let baseB: string;
  let token: string;

  beforeAll(async () => {
    // AppModule reads these once per testing module, so set them before
    // compiling either replica.
    process.env.DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;
    process.env.REQUIRE_REDIS = "1";

    appA = await createApp();
    appB = await createApp();
    baseB = await appB.getUrl();
    await seedTestAuth(appA);
    token = await login(appA);
  });

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
  });

  async function createApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalFilters(new GameNotFoundFilter());
    await app.listen(0);
    return app;
  }

  function post(app: INestApplication, path: string) {
    return request(app.getHttpServer())
      .post(path)
      .set("authorization", `Bearer ${token}`);
  }

  it("delivers an append from replica A to an SSE subscriber on replica B", async () => {
    const created = await post(appA, "/games")
      .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
      .expect(201);
    const gameId = created.body.id as string;
    await post(appA, `/games/${gameId}/start`).send({}).expect(201);

    const client = new SseClient(`${baseB}/games/${gameId}/stream`);
    try {
      await client.ready;
      const snapshot = (await client.next()) as {
        type: string;
        lastSeq: number;
        state: { lastSeq: number };
      };
      expect(snapshot).toMatchObject({ type: "snapshot", lastSeq: 0 });
      expect(snapshot.state.lastSeq).toBe(0);

      await post(appA, `/games/${gameId}/events`)
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

      const update = (await client.next(5000)) as {
        type: string;
        lastSeq: number;
        state: { lastSeq: number; count: { balls: number; strikes: number } };
      };
      expect(update).toMatchObject({ type: "state", lastSeq: 1 });
      expect(update.state.lastSeq).toBe(1);
      expect(update.state.count).toEqual({ balls: 1, strikes: 0 });
    } finally {
      client.close();
    }
  });

  it("shares the failed-login budget across replicas", async () => {
    const email = `replica-${Date.now()}@example.test`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(appA.getHttpServer())
        .post("/auth/login")
        .send({ email, password: "wrong-password" })
        .expect(401);
    }

    const blocked = await request(appB.getHttpServer())
      .post("/auth/login")
      .send({ email, password: "wrong-password" })
      .expect(429);
    expect(blocked.body).toMatchObject({
      statusCode: 429,
      message: "too many login attempts",
    });
    expect(blocked.body.retryAfterSeconds).toBeGreaterThan(0);
  });
});
