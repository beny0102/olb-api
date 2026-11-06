import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import { login, seedTestAuth } from "./support/auth.js";

let app: INestApplication;
let token: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  await seedTestAuth(app);
  token = await login(app);
});

afterAll(async () => {
  await app.close();
});

function post(path: string) {
  return request(app.getHttpServer()).post(path).set("authorization", `Bearer ${token}`);
}

async function createGame(): Promise<string> {
  const response = await post("/games")
    .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
    .expect(201);
  return response.body.id;
}

function pitch(call: "B" | "C" | "S" | "F" | "T" = "S") {
  return { kind: "pitch", call };
}

function outcome(code: "out" | "1B" | "2B" | "3B" | "HR" | "E" | "FC" = "out") {
  return { kind: "outcome", code };
}

describe("proposals", () => {
  it("creates a proposal and returns it with open status", async () => {
    const gameId = await createGame();

    const created = await post(`/games/${gameId}/proposals`)
      .send({ payload: pitch("S") })
      .expect(201);

    expect(created.body).toMatchObject({
      gameId,
      author: "Verificador",
      status: "open",
      payload: { kind: "pitch", call: "S" },
    });
    expect(created.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(Number.isNaN(Date.parse(created.body.createdAt))).toBe(false);

    const list = await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals`)
      .expect(200);

    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toEqual(created.body);
  });

  it("honours a custom author and rejects an invalid one", async () => {
    const gameId = await createGame();

    const created = await post(`/games/${gameId}/proposals`)
      .send({ author: "  Spotter  ", payload: outcome("1B") })
      .expect(201);

    expect(created.body.author).toBe("Spotter");
    expect(created.body.payload).toEqual({ kind: "outcome", code: "1B" });

    await post(`/games/${gameId}/proposals`)
      .send({ author: "", payload: pitch() })
      .expect(400);

    await post(`/games/${gameId}/proposals`)
      .send({ author: "x".repeat(61), payload: pitch() })
      .expect(400);
  });

  it("lists open by default and filters accepted and rejected", async () => {
    const gameId = await createGame();
    const created: string[] = [];

    for (const payload of [pitch("B"), pitch("C"), outcome("HR")]) {
      const response = await post(`/games/${gameId}/proposals`)
        .send({ payload })
        .expect(201);
      created.push(response.body.id);
    }

    await post(`/games/${gameId}/proposals/${created[1]}/resolve`)
      .send({ status: "accepted" })
      .expect(201);

    await post(`/games/${gameId}/proposals/${created[2]}/resolve`)
      .send({ status: "rejected" })
      .expect(201);

    const open = await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals?status=open`)
      .expect(200);
    expect(open.body.map((proposal: { id: string }) => proposal.id)).toEqual([created[0]]);

    const accepted = await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals?status=accepted`)
      .expect(200);
    expect(accepted.body.map((proposal: { id: string }) => proposal.id)).toEqual([created[1]]);

    const rejected = await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals?status=rejected`)
      .expect(200);
    expect(rejected.body.map((proposal: { id: string }) => proposal.id)).toEqual([created[2]]);

    const all = await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals?status=all`)
      .expect(200);
    expect(all.body.map((proposal: { id: string }) => proposal.id)).toEqual(created);

    const times = all.body.map((proposal: { createdAt: string }) => Date.parse(proposal.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));

    await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals?status=unknown`)
      .expect(400);
  });

  it("rejects an invalid kind, call or code", async () => {
    const gameId = await createGame();

    for (const payload of [
      { kind: "pitch", call: "Z" },
      { kind: "outcome", code: "X" },
      { kind: "other" },
      "not-an-object",
      undefined,
    ]) {
      await post(`/games/${gameId}/proposals`)
        .send({ payload })
        .expect(400);
    }
  });

  it("returns 404 for an unknown game", async () => {
    const missing = "0192f3ff-0000-7000-8000-000000000000";

    await post(`/games/${missing}/proposals`)
      .send({ payload: pitch() })
      .expect(404);

    await request(app.getHttpServer()).get(`/games/${missing}/proposals`).expect(404);
  });

  it("resolves accepted and keeps the first decision on a retry", async () => {
    const gameId = await createGame();

    const created = await post(`/games/${gameId}/proposals`)
      .send({ payload: pitch("S") })
      .expect(201);

    const accepted = await post(`/games/${gameId}/proposals/${created.body.id}/resolve`)
      .send({ status: "accepted" })
      .expect(201);
    expect(accepted.body.status).toBe("accepted");

    const retry = await post(`/games/${gameId}/proposals/${created.body.id}/resolve`)
      .send({ status: "rejected" })
      .expect(201);
    expect(retry.body).toEqual(accepted.body);

    const list = await request(app.getHttpServer())
      .get(`/games/${gameId}/proposals?status=accepted`)
      .expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].status).toBe("accepted");

    await post(`/games/${gameId}/proposals/${created.body.id}/resolve`)
      .send({ status: "open" })
      .expect(400);
  });

  it("returns 404 when the proposal belongs to another game", async () => {
    const owner = await createGame();
    const other = await createGame();

    const created = await post(`/games/${owner}/proposals`)
      .send({ payload: pitch() })
      .expect(201);

    await post(`/games/${other}/proposals/${created.body.id}/resolve`)
      .send({ status: "accepted" })
      .expect(404);

    const missing = "0192f3ff-0000-7000-8000-000000000001";
    await post(`/games/${owner}/proposals/${missing}/resolve`)
      .send({ status: "accepted" })
      .expect(404);
  });

  it("never appears in the game state or the event log", async () => {
    const gameId = await createGame();

    await post(`/games/${gameId}/start`).send({}).expect(201);

    const before = await request(app.getHttpServer())
      .get(`/games/${gameId}/state`)
      .expect(200);

    await post(`/games/${gameId}/proposals`)
      .send({ payload: pitch("S") })
      .expect(201);

    const events = await request(app.getHttpServer())
      .get(`/games/${gameId}/events`)
      .expect(200);
    expect(events.body).toHaveLength(1);
    expect(events.body[0].type).toBe("game.start");

    const after = await request(app.getHttpServer())
      .get(`/games/${gameId}/state`)
      .expect(200);
    expect(after.body).toEqual(before.body);
  });
});
