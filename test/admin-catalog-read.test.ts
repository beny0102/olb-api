import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_ORGANIZATION_ID,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  NORTE_EMAIL,
  NORTE_PASSWORD,
  seedTestAuth,
  TIBURONES_EMAIL,
  TIBURONES_PASSWORD,
} from "./support/auth.js";

const UNKNOWN_ID = "0192f3d0-0000-7009-8000-0000000000ff";
const INVALID_ID = "not-a-uuid";
const UUID_V4_ID = "0192f3d0-0000-4000-8000-000000000001";

let app: INestApplication;
let adminToken: string;
let norteToken: string;
let tiburonesToken: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  await seedLeague(app.get<LeagueStore>(LEAGUE_STORE));
  await seedTestAuth(app);

  [adminToken, norteToken, tiburonesToken] = await Promise.all([
    login(app, ADMIN_EMAIL, ADMIN_PASSWORD),
    login(app, NORTE_EMAIL, NORTE_PASSWORD),
    login(app, TIBURONES_EMAIL, TIBURONES_PASSWORD),
  ]);
});

afterAll(async () => {
  await app.close();
});

function get(path: string, token: string | null = null) {
  const call = request(app.getHttpServer()).get(path);
  if (token !== null) call.set("authorization", `Bearer ${token}`);
  return call;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

describe("admin catalog reads", () => {
  it("lists every team of the organization for an organization admin", async () => {
    const response = await get(
      `/admin/organizations/${SEED_ORGANIZATION_ID}/teams`,
      adminToken,
    ).expect(200);

    expect(response.body).toHaveLength(4);
    expect(response.body.map((row: { name: string }) => row.name)).toEqual([
      "Corsarios",
      "Faros",
      "Mantarrayos",
      "Tiburones",
    ]);
    for (const team of response.body) {
      expect(Object.keys(team).sort()).toEqual([
        "abbreviation",
        "createdAt",
        "id",
        "name",
        "organizationId",
        "slug",
      ]);
      expect(team.organizationId).toBe(SEED_ORGANIZATION_ID);
    }
    expect(response.body[0]).toMatchObject({
      name: "Corsarios",
      slug: "corsarios",
      abbreviation: "COR",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("lists every player of the organization ordered by last then first name", async () => {
    const response = await get(
      `/admin/organizations/${SEED_ORGANIZATION_ID}/players`,
      adminToken,
    ).expect(200);

    expect(response.body).toHaveLength(72);
    for (const player of response.body) {
      expect(Object.keys(player).sort()).toEqual([
        "createdAt",
        "firstName",
        "id",
        "lastName",
        "organizationId",
      ]);
      expect(player.organizationId).toBe(SEED_ORGANIZATION_ID);
    }

    const keys = response.body.map(
      (row: { lastName: string; firstName: string }) =>
        `${row.lastName}\u0000${row.firstName}`,
    );
    expect(keys).toEqual([...keys].sort(compareText));
    expect(response.body[0]).toMatchObject({
      firstName: "Emilio",
      lastName: "Acosta",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("answers 401 without a token", async () => {
    await get(`/admin/organizations/${SEED_ORGANIZATION_ID}/teams`).expect(401);
    await get(`/admin/organizations/${SEED_ORGANIZATION_ID}/players`).expect(401);
  });

  it("answers 403 for competition and team scopes", async () => {
    for (const token of [norteToken, tiburonesToken]) {
      await get(
        `/admin/organizations/${SEED_ORGANIZATION_ID}/teams`,
        token,
      ).expect(403);
      await get(
        `/admin/organizations/${SEED_ORGANIZATION_ID}/players`,
        token,
      ).expect(403);
    }
  });

  it("answers 404 for an unknown organization", async () => {
    await get(`/admin/organizations/${UNKNOWN_ID}/teams`, adminToken).expect(404);
    await get(`/admin/organizations/${UNKNOWN_ID}/players`, adminToken).expect(404);
  });

  it("answers 400 for an id that is not a UUIDv7", async () => {
    for (const id of [INVALID_ID, UUID_V4_ID]) {
      await get(`/admin/organizations/${id}/teams`, adminToken).expect(400);
      await get(`/admin/organizations/${id}/players`, adminToken).expect(400);
    }
  });
});
