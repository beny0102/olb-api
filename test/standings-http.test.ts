import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";

let app: INestApplication;

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

async function append(gameId: string, type: string, payload: unknown): Promise<void> {
  await request(app.getHttpServer())
    .post(`/games/${gameId}/events`)
    .send({
      type,
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload,
    })
    .expect(201);
}

async function scoreRuns(gameId: string, runs: number): Promise<void> {
  let remaining = runs;
  while (remaining > 0) {
    const chunk = Math.min(remaining, 4);
    await append(gameId, "ball_in_play", { batter, code: "HR", runsBattedIn: chunk });
    remaining -= chunk;
  }
}

async function play(
  homeTeam: string,
  awayTeam: string,
  homeRuns: number,
  awayRuns: number,
): Promise<string> {
  const created = await request(app.getHttpServer())
    .post("/games")
    .send({ homeTeam, awayTeam })
    .expect(201);
  const gameId = created.body.id;

  await request(app.getHttpServer()).post(`/games/${gameId}/start`).send({}).expect(201);

  await scoreRuns(gameId, awayRuns);
  await append(gameId, "inning.end", {
    inning: 1,
    half: "top",
    runsScored: awayRuns,
    outs: 3,
  });
  await scoreRuns(gameId, homeRuns);
  await append(gameId, "inning.end", {
    inning: 1,
    half: "bottom",
    runsScored: homeRuns,
    outs: 3,
  });

  await request(app.getHttpServer())
    .post(`/games/${gameId}/finish`)
    .send({ reason: "completed" })
    .expect(201);

  return gameId;
}

describe("GET /standings", () => {
  it("derives W/L, runs for and against from two finals, ordered by run differential", async () => {
    await play("Tiburones", "Marlins", 3, 1);
    await play("Tiburones", "Marlins", 2, 5);

    const response = await request(app.getHttpServer()).get("/standings").expect(200);

    expect(response.body).toEqual({
      games: 2,
      teams: [
        { team: "Marlins", w: 1, l: 1, runsFor: 6, runsAgainst: 5, pct: 0.5 },
        { team: "Tiburones", w: 1, l: 1, runsFor: 5, runsAgainst: 6, pct: 0.5 },
      ],
    });
  });
});
