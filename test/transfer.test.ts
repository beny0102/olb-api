import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { hashPassword } from "../src/auth/passwords.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_ORGANIZATION_ID,
  SEED_SEASON_ID,
  seedLeague,
} from "../src/scripts/league-seed.js";
import {
  LEAGUE_STORE,
  type CreateLeagueGameInput,
  type LeagueGameRecord,
  type LeagueStore,
} from "../src/store/league.store.js";
import { MemoryLeagueStore } from "../src/store/memory-league.store.js";
import { EVENT_STORE, type EventStore } from "../src/store/store.js";
import { runLeagueImport } from "../src/transfer/import.js";
import type { LeagueBundle } from "../src/transfer/bundle.js";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  NORTE_EMAIL,
  NORTE_PASSWORD,
  seedTestAuth,
} from "./support/auth.js";

const TARGET_ORGANIZATION_ID = "0192f3d0-0000-7010-8000-000000000001";
const TARGET_USER_ID = "0192f3d0-0000-7010-8000-000000000002";
const TARGET_MEMBERSHIP_ID = "0192f3d0-0000-7010-8000-000000000003";
const OTHER_ORGANIZATION_ID = "0192f3d0-0000-7010-8000-000000000004";
const TARGET_EMAIL = "admin@liga-metropolitana.olb";
const TARGET_PASSWORD = "olb-demo-admin";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

let source: INestApplication;
let sourceAdminToken: string;
let sourceNorteToken: string;
let bundle: LeagueBundle;

async function getBundle(token = sourceAdminToken): Promise<LeagueBundle> {
  const response = await request(source.getHttpServer())
    .get("/admin/export")
    .set("authorization", `Bearer ${token}`)
    .expect(200);
  return response.body as LeagueBundle;
}

interface TargetApp {
  app: INestApplication;
  token: string;
  league: LeagueStore;
  events: EventStore;
  auth: AuthStore;
}

let target: TargetApp | undefined;

async function createTarget(): Promise<TargetApp> {
  delete process.env.DATABASE_URL;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  const league = app.get<LeagueStore>(LEAGUE_STORE);
  await league.upsertOrganization({
    id: TARGET_ORGANIZATION_ID,
    name: "Liga Metropolitana",
    slug: "liga-metropolitana",
    createdAt: CREATED_AT,
  });

  const auth = app.get<AuthStore>(AUTH_STORE);
  await auth.upsertUser({
    id: TARGET_USER_ID,
    email: TARGET_EMAIL,
    name: "Target Admin",
    passwordHash: hashPassword(TARGET_PASSWORD),
    status: "active",
    createdAt: CREATED_AT,
  });
  await auth.upsertMembership({
    id: TARGET_MEMBERSHIP_ID,
    userId: TARGET_USER_ID,
    scopeType: "organization",
    scopeId: TARGET_ORGANIZATION_ID,
    role: "org_admin",
    createdAt: CREATED_AT,
  });

  const token = await login(app, TARGET_EMAIL, TARGET_PASSWORD);
  target = { app, token, league, events: app.get<EventStore>(EVENT_STORE), auth };
  return target;
}

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  source = moduleRef.createNestApplication();
  source.useGlobalFilters(new GameNotFoundFilter());
  await source.init();

  await seedLeague(source.get<LeagueStore>(LEAGUE_STORE));
  await seedTestAuth(source);
  sourceAdminToken = await login(source, ADMIN_EMAIL, ADMIN_PASSWORD);
  sourceNorteToken = await login(source, NORTE_EMAIL, NORTE_PASSWORD);
  bundle = await getBundle();
});

afterEach(async () => {
  await target?.app.close();
  target = undefined;
});

afterAll(async () => {
  await source?.close();
});

describe("league export", () => {
  it("exports the olb.league/1 bundle shape and headers", async () => {
    const response = await request(source.getHttpServer())
      .get("/admin/export")
      .set("authorization", `Bearer ${sourceAdminToken}`)
      .expect(200);

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="liga-metropolitana-league.json"',
    );

    const body = response.body as LeagueBundle;
    expect(body.format).toBe("olb.league/1");
    expect(Number.isNaN(Date.parse(body.exportedAt))).toBe(false);
    expect(body.organization).toEqual({
      slug: "liga-metropolitana",
      name: "Liga Metropolitana",
    });
    expect(body.seasons).toHaveLength(1);
    expect(body.seasons[0]!.id).toBe(SEED_SEASON_ID);
    expect(body.seasons[0]!.competitions).toHaveLength(2);
    expect(body.teams).toHaveLength(4);
    expect(body.teamSeasons).toHaveLength(4);
    expect(body.teamSeasons.flatMap((row) => row.roster)).toHaveLength(72);
    expect(body.games).toHaveLength(6);
    expect(body).not.toHaveProperty("users");
    expect(body).not.toHaveProperty("events");
    expect(body).not.toHaveProperty("proposals");
    expect(body).not.toHaveProperty("summaries");

    for (const game of body.games) {
      expect(game.coverage).toBe("full");
      expect(game.dataSource).toBe("official");
    }
  });

  it("exports only scheduled games with no events or summary", async () => {
    const events = source.get<EventStore>(EVENT_STORE);
    const league = source.get<LeagueStore>(LEAGUE_STORE);
    const scheduled = bundle.games[0]!;
    const final = (await league.listGames(SEED_SEASON_ID)).find(
      (game) => game.id !== scheduled.id,
    )!;

    await events.createGame({
      id: final.id,
      homeTeam: final.homeTeam,
      awayTeam: final.awayTeam,
      scheduledStart: final.scheduledStart,
      venue: final.venue,
      createdAt: final.createdAt,
    });
    await request(source.getHttpServer())
      .post(`/games/${final.id}/start`)
      .set("authorization", `Bearer ${sourceAdminToken}`)
      .send({})
      .expect(201);

    const exported = await getBundle();
    expect(exported.games.map((game) => game.id)).not.toContain(final.id);

    const seasonScoped = await request(source.getHttpServer())
      .get(`/admin/export?seasonId=${SEED_SEASON_ID}`)
      .set("authorization", `Bearer ${sourceAdminToken}`)
      .expect(200);
    expect(seasonScoped.body.seasons).toHaveLength(1);
  });

  it("requires an organization admin", async () => {
    await request(source.getHttpServer()).get("/admin/export").expect(401);
    await request(source.getHttpServer())
      .get("/admin/export")
      .set("authorization", `Bearer ${sourceNorteToken}`)
      .expect(403);
  });
});

describe("league import", () => {
  it("round-trips the bundle into an empty organization", async () => {
    const draft = await createTarget();
    const applied = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(201);

    expect(applied.body).toMatchObject({
      dryRun: false,
      created: {
        seasons: 1,
        competitions: 2,
        teams: 4,
        teamSeasons: 4,
        players: 72,
        rosterEntries: 72,
        games: 6,
      },
      updated: {
        seasons: 0,
        competitions: 0,
        teams: 0,
        teamSeasons: 0,
        players: 0,
        rosterEntries: 0,
        games: 0,
      },
      conflicts: [],
      warnings: [],
    });

    const seasons = await draft.league.listSeasons(TARGET_ORGANIZATION_ID);
    expect(seasons).toHaveLength(1);
    expect(await draft.league.listTeamsByOrganization(TARGET_ORGANIZATION_ID)).toHaveLength(4);
    const teamSeasons = await draft.league.listTeamSeasonsBySeason(seasons[0]!.id);
    expect(teamSeasons).toHaveLength(4);
    for (const teamSeason of teamSeasons) {
      expect(await draft.league.listRoster(teamSeason.id)).toHaveLength(18);
    }
    expect(await draft.league.listGames(seasons[0]!.id)).toHaveLength(6);
  });

  it("is idempotent on a second identical import", async () => {
    const draft = await createTarget();
    await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(201);

    const second = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(201);

    expect(second.body.created).toMatchObject({
      seasons: 0,
      competitions: 0,
      teams: 0,
      teamSeasons: 0,
      players: 0,
      rosterEntries: 0,
      games: 0,
    });
    expect(second.body.updated).toMatchObject({
      seasons: 0,
      competitions: 0,
      teams: 0,
      teamSeasons: 0,
      players: 0,
      rosterEntries: 0,
      games: 0,
    });
    expect(second.body.unchanged).toMatchObject({
      seasons: 1,
      competitions: 2,
      teams: 4,
      teamSeasons: 4,
      players: 72,
      rosterEntries: 72,
      games: 6,
    });
  });

  it("writes nothing on a dry run", async () => {
    const draft = await createTarget();
    const preview = await request(draft.app.getHttpServer())
      .post("/admin/import?dryRun=true")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(200);

    expect(preview.body.dryRun).toBe(true);
    expect(preview.body.created.games).toBe(6);
    expect(await draft.league.listSeasons(TARGET_ORGANIZATION_ID)).toHaveLength(0);
    expect(await draft.league.listTeamsByOrganization(TARGET_ORGANIZATION_ID)).toHaveLength(0);
  });

  it("rejects a bundle organization mismatch with 409", async () => {
    const draft = await createTarget();
    const mismatched = structuredClone(bundle);
    mismatched.organization.slug = "otra-liga";

    const response = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(mismatched)
      .expect(409);

    expect(response.body).toMatchObject({ code: "organization_mismatch" });
    expect(await draft.league.listSeasons(TARGET_ORGANIZATION_ID)).toHaveLength(0);
  });

  it("rejects a natural-key conflict without writing", async () => {
    const draft = await createTarget();
    await draft.league.upsertTeam({
      id: "0192f3d0-0000-7010-8000-000000000010",
      organizationId: TARGET_ORGANIZATION_ID,
      name: "Existing Tiburones",
      slug: "tiburones",
      abbreviation: "TIB",
      createdAt: CREATED_AT,
    });

    const response = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(409);

    expect(response.body.code).toBe("import_conflicts");
    expect(response.body.conflicts[0]).toMatchObject({ entity: "team" });
    expect(await draft.league.listSeasons(TARGET_ORGANIZATION_ID)).toHaveLength(0);
  });

  it("rejects a bundle id owned by another organization", async () => {
    const draft = await createTarget();
    await draft.league.upsertOrganization({
      id: OTHER_ORGANIZATION_ID,
      name: "Otra Liga",
      slug: "otra-liga",
      createdAt: CREATED_AT,
    });
    await draft.league.upsertSeason({
      id: bundle.seasons[0]!.id,
      organizationId: OTHER_ORGANIZATION_ID,
      name: "Otra",
      year: 2026,
      status: "active",
      startsOn: null,
      endsOn: null,
    });

    const response = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(409);

    expect(response.body.code).toBe("import_conflicts");
    expect(response.body.conflicts[0]).toMatchObject({ entity: "season" });
    expect(await draft.league.listTeamsByOrganization(TARGET_ORGANIZATION_ID)).toHaveLength(0);
  });

  it("rejects malformed bodies and unauthenticated or non-admin callers", async () => {
    const draft = await createTarget();
    const viewerId = "0192f3d0-0000-7010-8000-000000000020";
    const viewerEmail = "viewer@liga-metropolitana.olb";
    const viewerPassword = "olb-demo-viewer";
    await draft.auth.upsertUser({
      id: viewerId,
      email: viewerEmail,
      name: "Target Viewer",
      passwordHash: hashPassword(viewerPassword),
      status: "active",
      createdAt: CREATED_AT,
    });
    await draft.auth.upsertMembership({
      id: "0192f3d0-0000-7010-8000-000000000021",
      userId: viewerId,
      scopeType: "organization",
      scopeId: TARGET_ORGANIZATION_ID,
      role: "viewer",
      createdAt: CREATED_AT,
    });
    const viewerToken = await login(draft.app, viewerEmail, viewerPassword);

    await request(draft.app.getHttpServer()).post("/admin/import").send(bundle).expect(401);
    await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${viewerToken}`)
      .send(bundle)
      .expect(403);

    await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send({ bundle })
      .expect(400);
    await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send({ format: "olb.league/2" })
      .expect(400);
    await request(draft.app.getHttpServer())
      .post("/admin/import?dryRun=maybe")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(400);
  });

  it("leaves a game with events untouched and reports a warning", async () => {
    const draft = await createTarget();
    await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(bundle)
      .expect(201);

    const game = bundle.games[0]!;
    await draft.events.createGame({
      id: game.id,
      homeTeam: "Home",
      awayTeam: "Away",
      scheduledStart: game.scheduledStart,
      venue: game.venue,
      createdAt: CREATED_AT,
    });
    await request(draft.app.getHttpServer())
      .post(`/games/${game.id}/start`)
      .set("authorization", `Bearer ${draft.token}`)
      .send({})
      .expect(201);

    const venueChange = structuredClone(bundle);
    venueChange.games[0]!.venue = "Changed Park";
    const changed = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(venueChange)
      .expect(201);

    expect(changed.body.warnings).toContain(
      `game ${game.id} has events and was left unchanged`,
    );
    const stored = await draft.league.getGame(game.id);
    expect(stored?.venue).toBe(game.venue);
    expect(await draft.events.listEvents(game.id, 0)).toHaveLength(1);

    const identityChange = structuredClone(bundle);
    identityChange.games[0]!.scheduledStart = "2027-01-01T00:00:00.000Z";
    const conflict = await request(draft.app.getHttpServer())
      .post("/admin/import")
      .set("authorization", `Bearer ${draft.token}`)
      .send(identityChange)
      .expect(409);
    expect(conflict.body.conflicts[0]).toMatchObject({ entity: "game" });
    expect((await draft.league.getGame(game.id))?.scheduledStart).toBe(game.scheduledStart);
  });
});

class FailingGameStore extends MemoryLeagueStore {
  override async upsertGame(_input: CreateLeagueGameInput): Promise<LeagueGameRecord> {
    throw new Error("late failure while writing games");
  }
}

describe("import transaction", () => {
  it("rolls back every earlier write when a late write fails", async () => {
    const store = new FailingGameStore();

    await expect(
      store.transaction((scoped) =>
        runLeagueImport({
          store: scoped,
          bundle,
          organizationId: TARGET_ORGANIZATION_ID,
          dryRun: false,
          gamesWithEvents: new Set(),
        }),
      ),
    ).rejects.toThrow("late failure");

    expect(await store.listSeasons(TARGET_ORGANIZATION_ID)).toHaveLength(0);
    expect(await store.listTeamsByOrganization(TARGET_ORGANIZATION_ID)).toHaveLength(0);
    expect(await store.listOrganizations()).toHaveLength(0);
  });
});

describe("export source", () => {
  it("keeps the seeded organization id stable for the fixture", () => {
    expect(bundle.seasons[0]!.id).toBe(SEED_SEASON_ID);
    expect(bundle.teams.some((team) => team.slug === "tiburones")).toBe(true);
    expect(SEED_ORGANIZATION_ID.length).toBe(36);
  });
});
