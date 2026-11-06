import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { seedAuth } from "../src/auth/auth-seed.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { hashPassword } from "../src/auth/passwords.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_ORGANIZATION_ID,
  SEED_SEASON_ID,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import { EVENT_STORE, type EventStore } from "../src/store/store.js";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  seedTestAuth,
  TIBURONES_EMAIL,
  TIBURONES_PASSWORD,
  VERIFIER_EMAIL,
  VERIFIER_PASSWORD,
} from "./support/auth.js";

const VIEWER_EMAIL = "viewer@liga-metropolitana.olb";
const VIEWER_PASSWORD = "olb-demo-viewer";
const VIEWER_ID = "0192f3d0-0000-7000-8002-000000000777";

const NORTH_GAME = "0192f3d0-0000-7000-8000-000000000201";
const SOUTH_GAME = "0192f3d0-0000-7000-8000-000000000202";
const ADMIN_GAME = "0192f3d0-0000-7000-8000-000000000203";
const PROPOSAL_GAME = "0192f3d0-0000-7000-8000-000000000204";

let app: INestApplication;
let adminToken: string;
let tiburonesToken: string;
let verifierToken: string;
let viewerToken: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  await seedLeague(app.get<LeagueStore>(LEAGUE_STORE));
  await seedTestAuth(app);

  // The auth seed is deliberately separate from the league seed, but a
  // viewer is needed to prove that a signed-in user without a scoring role
  // is still refused.
  const authStore = app.get<AuthStore>(AUTH_STORE);
  await authStore.upsertUser({
    id: VIEWER_ID,
    email: VIEWER_EMAIL,
    name: "Viewer",
    passwordHash: hashPassword(VIEWER_PASSWORD),
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await authStore.upsertMembership({
    id: "0192f3d0-0000-7000-8002-000000000778",
    userId: VIEWER_ID,
    scopeType: "organization",
    scopeId: SEED_ORGANIZATION_ID,
    role: "viewer",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  [adminToken, tiburonesToken, verifierToken, viewerToken] = await Promise.all([
    login(app, ADMIN_EMAIL, ADMIN_PASSWORD),
    login(app, TIBURONES_EMAIL, TIBURONES_PASSWORD),
    login(app, VERIFIER_EMAIL, VERIFIER_PASSWORD),
    login(app, VIEWER_EMAIL, VIEWER_PASSWORD),
  ]);

  // The catalog seed does not write event-store rows. Access checks read the
  // catalog, but a positive start/append still needs the game's empty log.
  const events = app.get<EventStore>(EVENT_STORE);
  const games = await app.get<LeagueStore>(LEAGUE_STORE).listGames(SEED_SEASON_ID);
  for (const game of games) {
    await events.createGame({
      id: game.id,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      scheduledStart: game.scheduledStart,
      venue: game.venue,
      createdAt: game.createdAt,
    });
  }
});

afterAll(async () => {
  await app.close();
});

function post(path: string, token?: string) {
  const call = request(app.getHttpServer()).post(path);
  if (token !== undefined) call.set("authorization", `Bearer ${token}`);
  return call;
}

function pitch() {
  return {
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
}

const proposal = { payload: { kind: "pitch" as const, call: "S" as const } };

describe("legacy game writes require auth and scopes", () => {
  it("answers 401 for anonymous create, start, finish, append and proposal", async () => {
    await post("/games").send({ homeTeam: "Marlins", awayTeam: "Tiburones" }).expect(401);
    await post(`/games/${NORTH_GAME}/start`).send({}).expect(401);
    await post(`/games/${NORTH_GAME}/finish`).send({ reason: "completed" }).expect(401);
    await post(`/games/${NORTH_GAME}/events`).send(pitch()).expect(401);
    await post(`/games/${PROPOSAL_GAME}/proposals`).send(proposal).expect(401);
  });

  it("answers 403 for a viewer without a scoring role", async () => {
    await post("/games", viewerToken)
      .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
      .expect(403);
    await post(`/games/${NORTH_GAME}/start`, viewerToken).send({}).expect(403);
    await post(`/games/${PROPOSAL_GAME}/proposals`, viewerToken).send(proposal).expect(403);
    await post(`/games/${PROPOSAL_GAME}/events`, viewerToken).send(pitch()).expect(403);
  });

  it("lets a team scorer start its own team's catalog game", async () => {
    await post(`/games/${NORTH_GAME}/start`, tiburonesToken).send({}).expect(201);
  });

  it("refuses a team scorer for another team's catalog game", async () => {
    await post(`/games/${SOUTH_GAME}/start`, tiburonesToken).send({}).expect(403);
  });

  it("lets an organization admin score any catalog game", async () => {
    await post(`/games/${ADMIN_GAME}/start`, adminToken).send({}).expect(201);
  });

  it("lets a scoring member write a legacy game with no catalog row", async () => {
    const created = await post("/games", adminToken)
      .send({ homeTeam: "Marlins", awayTeam: "Tiburones" })
      .expect(201);

    await post(`/games/${created.body.id}/start`, tiburonesToken).send({}).expect(201);
    await post(`/games/${created.body.id}/events`, tiburonesToken).send(pitch()).expect(201);
    await post(`/games/${created.body.id}/events`, viewerToken).send(pitch()).expect(403);
  });
});

describe("proposal scopes", () => {
  it("lets a competition verifier propose inside its competition", async () => {
    await post(`/games/${PROPOSAL_GAME}/proposals`, verifierToken).send(proposal).expect(201);
  });

  it("refuses a verifier outside its competition", async () => {
    await post(`/games/${SOUTH_GAME}/proposals`, verifierToken).send(proposal).expect(403);
  });

  it("refuses a verifier on resolve and lets an org admin decide", async () => {
    const created = await post(`/games/${PROPOSAL_GAME}/proposals`, verifierToken)
      .send(proposal)
      .expect(201);

    await post(`/games/${PROPOSAL_GAME}/proposals/${created.body.id}/resolve`, verifierToken)
      .send({ status: "accepted" })
      .expect(403);

    const resolved = await post(
      `/games/${PROPOSAL_GAME}/proposals/${created.body.id}/resolve`,
      adminToken,
    )
      .send({ status: "accepted" })
      .expect(201);
    expect(resolved.body.status).toBe("accepted");
  });
});

describe("public reads", () => {
  it("serves games, state and proposals without a token", async () => {
    await request(app.getHttpServer()).get("/games").expect(200);
    await request(app.getHttpServer()).get(`/games/${NORTH_GAME}/state`).expect(200);
    await request(app.getHttpServer()).get(`/games/${PROPOSAL_GAME}/proposals`).expect(200);
  });
});
