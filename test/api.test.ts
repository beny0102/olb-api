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

  it("folds hit by pitch, interference, substitution and suspension over HTTP", async () => {
    const created = await request(app.getHttpServer())
      .post("/games")
      .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
      .expect(201);
    const gameId = created.body.id;

    await request(app.getHttpServer())
      .post(`/games/${gameId}/start`)
      .send({
        rules: {
          innings: 7,
          mercy: true,
          dh: true,
          pitchLimit: 80,
          extraInningsPlacedRunner: true,
        },
      })
      .expect(201);

    const playerId = (n: number) =>
      `0192f3a2-${String(n).padStart(4, "0")}-7000-8000-${String(n).padStart(12, "0")}`;
    const positions = ["8", "4", "9", "3", "5", "6", "7", "2", "1"];
    const away = Array.from({ length: 9 }, (_, index) => playerId(401 + index));
    const home = Array.from({ length: 9 }, (_, index) => playerId(421 + index));
    const order = (players: string[]) =>
      players.map((player, index) => ({ player, position: positions[index] }));

    const append = (body: unknown) =>
      request(app.getHttpServer()).post(`/games/${gameId}/events`).send(body).expect(201);

    await append({
      type: "lineup.set",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: { team: "away", battingOrder: order(away), pitcher: away[8], dh: true },
    });
    await append({
      type: "lineup.set",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: { team: "home", battingOrder: order(home), pitcher: home[8], dh: true },
    });

    const interferenceBatter = playerId(441);
    await append({
      type: "pitch",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: {
        pitchNo: 1,
        batter: away[0],
        pitcher: home[8],
        count: { balls: 0, strikes: 0 },
        call: "H",
      },
    });
    await append({
      type: "interference",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: { batter: interferenceBatter, kind: "catcher", description: "Catcher's interference" },
    });

    const replacement = playerId(442);
    await append({
      type: "substitution",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: {
        team: "away",
        playerIn: replacement,
        playerOut: away[0],
        position: "7",
        battingSlot: 1,
        reason: "reentry",
        reentry: true,
      },
    });
    await append({
      type: "game.suspend",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: { reason: "rain", at: "2026-04-11T23:48:00.000Z" },
    });

    const suspended = await request(app.getHttpServer())
      .get(`/games/${gameId}/state`)
      .expect(200);
    expect(suspended.body.status).toBe("suspended");

    await append({
      type: "game.resume",
      source: "human",
      actor: { kind: "user", id: "usr_01HX" },
      payload: { at: "2026-04-12T00:20:00.000Z" },
    });

    const state = await request(app.getHttpServer())
      .get(`/games/${gameId}/state`)
      .expect(200);

    expect(state.body).toMatchObject({
      status: "live",
      count: { balls: 0, strikes: 0 },
      batter: replacement,
      pitcher: home[8],
      pitchCounts: { [home[8]]: 1 },
      rules: { innings: 7, mercy: true, dh: true, pitchLimit: 80, extraInningsPlacedRunner: true },
    });
    expect(state.body.bases).toEqual({
      first: interferenceBatter,
      second: away[0],
      third: null,
    });
    expect(state.body.lineups.away).toMatchObject({ pitcher: away[8], dh: true });
    expect(state.body.lineups.home).toMatchObject({ pitcher: home[8], dh: true });
    expect(state.body.lineups.away.battingOrder[0]).toEqual({
      player: replacement,
      position: "7",
    });

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

  it("keeps a client event id and treats a retry as the same event", async () => {
    const gameId = await createGame();
    const clientId = "0192f3b1-0000-7000-8000-000000000001";
    const occurredAt = "2026-04-11T23:41:07.412Z";

    const first = await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({ ...pitch("S"), id: clientId, occurredAt })
      .expect(201);

    expect(first.body).toMatchObject({ id: clientId, occurredAt, seq: 1 });
    expect(first.body.payload.call).toBe("S");

    const retry = await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({ ...pitch("B"), id: clientId })
      .expect(201);

    expect(retry.body).toEqual(first.body);

    const events = await request(app.getHttpServer())
      .get(`/games/${gameId}/events`)
      .expect(200);

    expect(events.body).toHaveLength(2);
  });

  it("rejects an invalid client event id", async () => {
    const gameId = await createGame();

    await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({ ...pitch("S"), id: "not-a-uuid" })
      .expect(400);
  });

  it("applies a revision instead of the original event", async () => {
    const gameId = await createGame();
    const originalId = "0192f3b1-0000-7000-8000-000000000002";

    const original = await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({ ...pitch("S"), id: originalId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({
        ...pitch("B"),
        id: "0192f3b1-0000-7000-8000-000000000003",
        revisionOf: originalId,
      })
      .expect(201);

    const state = await request(app.getHttpServer())
      .get(`/games/${gameId}/state`)
      .expect(200);

    expect(state.body.count).toEqual({ balls: 1, strikes: 0 });
    expect(state.body.lastSeq).toBe(original.body.seq + 1);
  });

  it("voids an event through an amendment", async () => {
    const gameId = await createGame();

    const original = await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({ ...pitch("B"), id: "0192f3b1-0000-7000-8000-000000000004" })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/games/${gameId}/events`)
      .send({
        id: "0192f3b1-0000-7000-8000-000000000005",
        type: "amendment",
        source: "human",
        actor: { kind: "user", id: "usr_01HX" },
        payload: { targetSeq: original.body.seq, reason: "other", replacement: null },
      })
      .expect(201);

    const state = await request(app.getHttpServer())
      .get(`/games/${gameId}/state`)
      .expect(200);

    expect(state.body.count).toEqual({ balls: 0, strikes: 0 });
    expect(state.body.lastSeq).toBe(original.body.seq + 1);
  });

  it("answers 404 for an invalid game id instead of a storage error", async () => {
    await request(app.getHttpServer()).get("/games/not-a-uuid").expect(404);
    await request(app.getHttpServer()).get("/games/not-a-uuid/state").expect(404);
  });
});

function pitch(call: "S" | "B") {
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
