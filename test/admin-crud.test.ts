import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { AUTH_STORE, type AuthStore } from "../src/auth/auth.store.js";
import { hashPassword } from "../src/auth/passwords.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  SEED_COMPETITION_IDS,
  SEED_ORGANIZATION_ID,
  SEED_SEASON_ID,
  SEED_TEAM_SEASON_IDS,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import { EVENT_STORE, type EventStore } from "../src/store/store.js";
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  login,
  NORTE_EMAIL,
  NORTE_PASSWORD,
  seedTestAuth,
  TIBURONES_EMAIL,
  TIBURONES_PASSWORD,
  VERIFIER_EMAIL,
  VERIFIER_PASSWORD,
} from "./support/auth.js";

const SECOND_ORGANIZATION_ID = "0192f3d0-0000-7009-8000-000000000001";
const NO_MEMBER_USER_ID = "0192f3d0-0000-7009-8000-000000000002";
const NO_MEMBER_EMAIL = "nomember@liga-metropolitana.olb";
const NO_MEMBER_PASSWORD = "olb-demo-nomember";
const UNKNOWN_ID = "0192f3d0-0000-7009-8000-0000000000ff";

let app: INestApplication;
let adminToken: string;
let norteToken: string;
let tiburonesToken: string;
let verifierToken: string;
let noMemberToken: string;
let events: EventStore;

let season2027Id: string;
let competition2030Id: string;
let teamPatchId: string;
let teamConflictId: string;
let playerNoRosterId: string;
let rosterEntryOwnId: string;
let rosterEntryOtherId: string;
let gamePatchId: string;
let gameEventId: string;

beforeAll(async () => {
  delete process.env.DATABASE_URL;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();

  const league = app.get<LeagueStore>(LEAGUE_STORE);
  await seedLeague(league);
  await seedTestAuth(app);
  events = app.get<EventStore>(EVENT_STORE);

  await league.upsertOrganization({
    id: SECOND_ORGANIZATION_ID,
    name: "Otra Liga",
    slug: "otra-liga",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  const authStore = app.get<AuthStore>(AUTH_STORE);
  await authStore.upsertUser({
    id: NO_MEMBER_USER_ID,
    email: NO_MEMBER_EMAIL,
    name: "No Membership",
    passwordHash: hashPassword(NO_MEMBER_PASSWORD),
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  [adminToken, norteToken, tiburonesToken, verifierToken, noMemberToken] =
    await Promise.all([
      login(app, ADMIN_EMAIL, ADMIN_PASSWORD),
      login(app, NORTE_EMAIL, NORTE_PASSWORD),
      login(app, TIBURONES_EMAIL, TIBURONES_PASSWORD),
      login(app, VERIFIER_EMAIL, VERIFIER_PASSWORD),
      login(app, NO_MEMBER_EMAIL, NO_MEMBER_PASSWORD),
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

function post(path: string, token: string | null, body: unknown) {
  const call = request(app.getHttpServer()).post(path);
  if (token !== null) call.set("authorization", `Bearer ${token}`);
  return call.send(body as object);
}

function patch(path: string, token: string | null, body: unknown) {
  const call = request(app.getHttpServer()).patch(path);
  if (token !== null) call.set("authorization", `Bearer ${token}`);
  return call.send(body as object);
}

function del(path: string, token: string | null, query = "") {
  const call = request(app.getHttpServer()).delete(`${path}${query}`);
  if (token !== null) call.set("authorization", `Bearer ${token}`);
  return call;
}

async function rosterLength(teamSeasonId: string): Promise<number> {
  const response = await get(`/team-seasons/${teamSeasonId}`).expect(200);
  return response.body.roster.length as number;
}

describe("admin catalog CRUD", () => {
  it("lists only the caller's organizations", async () => {
    await get("/admin/organizations").expect(401);
    await get("/admin/organizations", noMemberToken).expect(403);

    const admin = await get("/admin/organizations", adminToken).expect(200);
    expect(admin.body).toEqual([
      expect.objectContaining({ id: SEED_ORGANIZATION_ID, name: "Liga Metropolitana" }),
    ]);
    expect(admin.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: SECOND_ORGANIZATION_ID })]),
    );

    await get("/admin/organizations", norteToken).expect(200);
    await get("/admin/organizations", tiburonesToken).expect(200);
  });

  it("patches an organization and rejects slug conflicts", async () => {
    await patch(`/admin/organizations/${SEED_ORGANIZATION_ID}`, null, {}).expect(401);
    await patch(`/admin/organizations/${SEED_ORGANIZATION_ID}`, norteToken, {
      name: "No permitido",
    }).expect(403);
    await patch(`/admin/organizations/${UNKNOWN_ID}`, adminToken, {
      name: "No existe",
    }).expect(404);
    await patch(`/admin/organizations/${SEED_ORGANIZATION_ID}`, adminToken, {
      slug: "otra-liga",
    }).expect(409);

    const response = await patch(
      `/admin/organizations/${SEED_ORGANIZATION_ID}`,
      adminToken,
      { name: "Liga Metropolitana CRUD", slug: "liga-metropolitana-crud" },
    ).expect(200);
    expect(response.body).toMatchObject({
      id: SEED_ORGANIZATION_ID,
      name: "Liga Metropolitana CRUD",
      slug: "liga-metropolitana-crud",
    });
  });

  it("patches a season, enforces the active-season rule and year uniqueness", async () => {
    const created = await post("/admin/seasons", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "2027",
      year: 2027,
      status: "active",
      startsOn: "2027-03-01",
      endsOn: "2027-11-30",
    }).expect(201);
    season2027Id = created.body.id;

    await patch(`/admin/seasons/${SEED_SEASON_ID}`, null, {}).expect(401);
    await patch(`/admin/seasons/${SEED_SEASON_ID}`, norteToken, {
      status: "archived",
    }).expect(403);
    await patch(`/admin/seasons/${UNKNOWN_ID}`, adminToken, {
      status: "archived",
    }).expect(404);
    await patch(`/admin/seasons/${SEED_SEASON_ID}`, adminToken, {
      year: 2027,
    }).expect(409);
    await patch(`/admin/seasons/${SEED_SEASON_ID}`, adminToken, {
      unknown: true,
    }).expect(400);

    const response = await patch(`/admin/seasons/${SEED_SEASON_ID}`, adminToken, {
      name: "Temporada 2026",
      status: "active",
      startsOn: "2026-03-02",
    }).expect(200);
    expect(response.body).toMatchObject({
      id: SEED_SEASON_ID,
      name: "Temporada 2026",
      status: "active",
      startsOn: "2026-03-02",
    });

    const seasons = await get(
      `/seasons?organizationId=${SEED_ORGANIZATION_ID}`,
    ).expect(200);
    expect(seasons.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: SEED_SEASON_ID, status: "active" }),
        expect.objectContaining({ id: season2027Id, status: "archived" }),
      ]),
    );
  });

  it("deletes an empty season but refuses a season with dependencies", async () => {
    await del(`/admin/seasons/${SEED_SEASON_ID}`, null).expect(401);
    await del(`/admin/seasons/${SEED_SEASON_ID}`, norteToken).expect(403);
    await del(`/admin/seasons/${UNKNOWN_ID}`, adminToken).expect(404);
    await del(`/admin/seasons/${SEED_SEASON_ID}`, adminToken).expect(409);

    const season = await post("/admin/seasons", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "2029",
      year: 2029,
      status: "archived",
    }).expect(201);

    const response = await del(`/admin/seasons/${season.body.id}`, adminToken).expect(200);
    expect(response.body).toEqual({ deleted: true });
    await get(`/seasons/${season.body.id}`).expect(404);
  });

  it("patches a competition for its admin and refuses another competition", async () => {
    await patch(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, null, {}).expect(401);
    await patch(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, tiburonesToken, {
      name: "No permitido",
    }).expect(403);
    await patch(`/admin/competitions/${UNKNOWN_ID}`, adminToken, {
      name: "No existe",
    }).expect(404);
    await patch(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, adminToken, {
      unknown: true,
    }).expect(400);

    const byOrg = await patch(
      `/admin/competitions/${SEED_COMPETITION_IDS[0]}`,
      adminToken,
      { name: "Zona Norte CRUD", sortOrder: 5 },
    ).expect(200);
    expect(byOrg.body).toMatchObject({
      id: SEED_COMPETITION_IDS[0],
      name: "Zona Norte CRUD",
      sortOrder: 5,
    });

    const byCompetition = await patch(
      `/admin/competitions/${SEED_COMPETITION_IDS[0]}`,
      norteToken,
      { sortOrder: 6 },
    ).expect(200);
    expect(byCompetition.body).toMatchObject({ sortOrder: 6 });

    await patch(`/admin/competitions/${SEED_COMPETITION_IDS[1]}`, norteToken, {
      name: "No permitido",
    }).expect(403);
  });

  it("deletes an empty competition but refuses one with team seasons", async () => {
    await del(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, null).expect(401);
    await del(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, norteToken).expect(403);
    await del(`/admin/competitions/${UNKNOWN_ID}`, adminToken).expect(404);
    await del(`/admin/competitions/${SEED_COMPETITION_IDS[0]}`, adminToken).expect(409);

    const season = await post("/admin/seasons", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "2030",
      year: 2030,
      status: "archived",
    }).expect(201);
    const competition = await post("/admin/competitions", adminToken, {
      seasonId: season.body.id,
      name: "Copa CRUD",
      kind: "division",
    }).expect(201);
    competition2030Id = competition.body.id;

    const response = await del(
      `/admin/competitions/${competition2030Id}`,
      adminToken,
    ).expect(200);
    expect(response.body).toEqual({ deleted: true });
    await get(`/seasons/${season.body.id}/competitions`).expect(200);
  });

  it("patches teams and enforces global slug uniqueness", async () => {
    const created = await post("/admin/teams", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "Equipo Patch",
      slug: "equipo-patch",
      abbreviation: "EP",
    }).expect(201);
    teamPatchId = created.body.id;

    const conflict = await post("/admin/teams", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "Equipo Conflicto",
      slug: "equipo-conflicto",
    }).expect(201);
    teamConflictId = conflict.body.id;

    await patch(`/admin/teams/${teamPatchId}`, null, {}).expect(401);
    await patch(`/admin/teams/${teamPatchId}`, norteToken, {
      name: "No permitido",
    }).expect(403);
    await patch(`/admin/teams/${UNKNOWN_ID}`, adminToken, {
      name: "No existe",
    }).expect(404);
    await patch(`/admin/teams/${teamPatchId}`, adminToken, {
      slug: "equipo-conflicto",
    }).expect(409);
    await patch(`/admin/teams/${teamPatchId}`, adminToken, {
      unknown: true,
    }).expect(400);

    const response = await patch(`/admin/teams/${teamPatchId}`, adminToken, {
      name: "Equipo Patch Editado",
      abbreviation: "EPE",
    }).expect(200);
    expect(response.body).toMatchObject({
      id: teamPatchId,
      name: "Equipo Patch Editado",
      abbreviation: "EPE",
    });
  });

  it("deletes a team without team seasons but refuses a team in use", async () => {
    await del(`/admin/teams/${teamPatchId}`, null).expect(401);
    await del(`/admin/teams/${teamPatchId}`, norteToken).expect(403);
    await del(`/admin/teams/${UNKNOWN_ID}`, adminToken).expect(404);

    const seeded = await get(`/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`).expect(200);
    await del(`/admin/teams/${seeded.body.teamSeason.teamId}`, adminToken).expect(409);

    const response = await del(`/admin/teams/${teamConflictId}`, adminToken).expect(200);
    expect(response.body).toEqual({ deleted: true });
  });

  it("patches a team season for its competition admin and enforces name uniqueness", async () => {
    await patch(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`, null, {}).expect(401);
    await patch(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[1]}`, tiburonesToken, {
      abbreviation: "NO",
    }).expect(403);
    await patch(`/admin/team-seasons/${UNKNOWN_ID}`, adminToken, {
      abbreviation: "NO",
    }).expect(404);
    await patch(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`, adminToken, {
      unknown: true,
    }).expect(400);

    const response = await patch(
      `/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`,
      norteToken,
      { name: "Tiburones del Norte", abbreviation: "TIB" },
    ).expect(200);
    expect(response.body).toMatchObject({
      id: SEED_TEAM_SEASON_IDS[0],
      name: "Tiburones del Norte",
      abbreviation: "TIB",
    });

    await patch(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[1]}`, adminToken, {
      name: "Tiburones del Norte",
    }).expect(409);
  });

  it("deletes a team season without games but refuses one with games", async () => {
    await del(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`, null).expect(401);
    await del(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`, norteToken).expect(403);
    await del(`/admin/team-seasons/${UNKNOWN_ID}`, adminToken).expect(404);
    await del(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`, adminToken).expect(409);

    const team = await post("/admin/teams", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      name: "Equipo Borrar",
      slug: "equipo-borrar",
    }).expect(201);
    const teamSeason = await post("/admin/team-seasons", adminToken, {
      teamId: team.body.id,
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[1],
      name: "Equipo Borrar",
    }).expect(201);

    await del(`/admin/team-seasons/${teamSeason.body.id}`, adminToken).expect(200);
    await del(`/admin/teams/${team.body.id}`, adminToken).expect(200);
  });

  it("patches a player and rejects writes outside the organization admin scope", async () => {
    const created = await post("/admin/players", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      firstName: "Jugador",
      lastName: "Patch",
    }).expect(201);
    playerNoRosterId = created.body.id;

    await patch(`/admin/players/${playerNoRosterId}`, null, {}).expect(401);
    await patch(`/admin/players/${playerNoRosterId}`, norteToken, {
      lastName: "No permitido",
    }).expect(403);
    await patch(`/admin/players/${UNKNOWN_ID}`, adminToken, {
      lastName: "No existe",
    }).expect(404);
    await patch(`/admin/players/${playerNoRosterId}`, adminToken, {
      unknown: true,
    }).expect(400);

    const response = await patch(`/admin/players/${playerNoRosterId}`, adminToken, {
      firstName: "Jugador Editado",
      lastName: "Patch Editado",
    }).expect(200);
    expect(response.body).toMatchObject({
      id: playerNoRosterId,
      firstName: "Jugador Editado",
      lastName: "Patch Editado",
    });
  });

  it("deletes a player without roster entries, or only with force when used", async () => {
    await del(`/admin/players/${playerNoRosterId}`, null).expect(401);
    await del(`/admin/players/${playerNoRosterId}`, norteToken).expect(403);
    await del(`/admin/players/${UNKNOWN_ID}`, adminToken).expect(404);
    await del(`/admin/players/${playerNoRosterId}`, adminToken, "?force=maybe").expect(400);
    await del(`/admin/players/${playerNoRosterId}`, adminToken).expect(200);

    const player = await post("/admin/players", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      firstName: "Jugador",
      lastName: "Con Roster",
    }).expect(201);
    const entry = await post("/admin/roster-entries", tiburonesToken, {
      teamSeasonId: SEED_TEAM_SEASON_IDS[0],
      playerId: player.body.id,
      jersey: "77",
    }).expect(201);

    await del(`/admin/players/${player.body.id}`, adminToken).expect(409);
    const response = await del(
      `/admin/players/${player.body.id}`,
      adminToken,
      "?force=true",
    ).expect(200);
    expect(response.body).toEqual({ deleted: true, rosterEntriesDeleted: 1 });
    const roster = await get(`/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`).expect(200);
    expect(roster.body.roster.map((row: { id: string }) => row.id)).not.toContain(entry.body.id);
  });

  it("patches roster entries for the team, competition or organization admin", async () => {
    const own = await get(`/team-seasons/${SEED_TEAM_SEASON_IDS[0]}`).expect(200);
    const other = await get(`/team-seasons/${SEED_TEAM_SEASON_IDS[1]}`).expect(200);
    rosterEntryOwnId = own.body.roster[0].id;
    rosterEntryOtherId = other.body.roster[0].id;

    await patch(`/admin/roster-entries/${rosterEntryOwnId}`, null, {}).expect(401);
    await patch(`/admin/roster-entries/${rosterEntryOtherId}`, tiburonesToken, {
      jersey: "99",
    }).expect(403);
    await patch(`/admin/roster-entries/${UNKNOWN_ID}`, adminToken, {
      jersey: "99",
    }).expect(404);
    await patch(`/admin/roster-entries/${rosterEntryOwnId}`, adminToken, {
      unknown: true,
    }).expect(400);

    const byTeam = await patch(
      `/admin/roster-entries/${rosterEntryOwnId}`,
      tiburonesToken,
      { jersey: "88", status: "inactive" },
    ).expect(200);
    expect(byTeam.body).toMatchObject({
      id: rosterEntryOwnId,
      jersey: "88",
      status: "inactive",
    });

    const byCompetition = await patch(
      `/admin/roster-entries/${rosterEntryOwnId}`,
      norteToken,
      { primaryPosition: "UTIL" },
    ).expect(200);
    expect(byCompetition.body).toMatchObject({ primaryPosition: "UTIL" });

    const byOrg = await patch(
      `/admin/roster-entries/${rosterEntryOwnId}`,
      adminToken,
      { eligibilityEnd: "2026-11-30" },
    ).expect(200);
    expect(byOrg.body).toMatchObject({ eligibilityEnd: "2026-11-30" });
  });

  it("deletes a roster entry only for its team, competition or organization admin", async () => {
    const player = await post("/admin/players", adminToken, {
      organizationId: SEED_ORGANIZATION_ID,
      firstName: "Jugador",
      lastName: "Roster Borrar",
    }).expect(201);
    const entry = await post("/admin/roster-entries", tiburonesToken, {
      teamSeasonId: SEED_TEAM_SEASON_IDS[0],
      playerId: player.body.id,
      jersey: "66",
    }).expect(201);

    await del(`/admin/roster-entries/${entry.body.id}`, null).expect(401);
    await del(`/admin/roster-entries/${rosterEntryOtherId}`, tiburonesToken).expect(403);
    await del(`/admin/roster-entries/${UNKNOWN_ID}`, adminToken).expect(404);

    const response = await del(`/admin/roster-entries/${entry.body.id}`, tiburonesToken).expect(
      200,
    );
    expect(response.body).toEqual({ deleted: true });
  });

  it("imports a roster atomically, supports dry-run and rejects duplicate rows", async () => {
    await post(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}/roster-import`, null, {
      rows: [],
    }).expect(401);
    await post(`/admin/team-seasons/${SEED_TEAM_SEASON_IDS[1]}/roster-import`, tiburonesToken, {
      rows: [],
    }).expect(403);
    await post(`/admin/team-seasons/${UNKNOWN_ID}/roster-import`, adminToken, {
      rows: [],
    }).expect(404);

    const rows = [
      { firstName: "Importado", lastName: "Uno", jersey: "1", primaryPosition: "P" },
      { firstName: "Importado", lastName: "Dos", jersey: "2", primaryPosition: "C" },
    ];
    const before = await rosterLength(SEED_TEAM_SEASON_IDS[0]);

    const dryRun = await post(
      `/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}/roster-import`,
      adminToken,
      { rows, dryRun: true },
    ).expect(201);
    expect(dryRun.body).toMatchObject({
      dryRun: true,
      created: { players: 2, rosterEntries: 2 },
      updated: { rosterEntries: 0 },
      unchanged: 0,
    });
    expect(dryRun.body.rows).toEqual([
      expect.objectContaining({ lastName: "Uno", action: "create_player", playerId: null }),
      expect.objectContaining({ lastName: "Dos", action: "create_player", playerId: null }),
    ]);
    expect(await rosterLength(SEED_TEAM_SEASON_IDS[0])).toBe(before);

    const applied = await post(
      `/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}/roster-import`,
      adminToken,
      { rows },
    ).expect(201);
    expect(applied.body).toMatchObject({
      dryRun: false,
      created: { players: 2, rosterEntries: 2 },
      updated: { rosterEntries: 0 },
      unchanged: 0,
    });
    expect(await rosterLength(SEED_TEAM_SEASON_IDS[0])).toBe(before + 2);

    const again = await post(
      `/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}/roster-import`,
      adminToken,
      { rows },
    ).expect(201);
    expect(again.body).toMatchObject({
      created: { players: 0, rosterEntries: 0 },
      updated: { rosterEntries: 0 },
      unchanged: 2,
    });
    expect(await rosterLength(SEED_TEAM_SEASON_IDS[0])).toBe(before + 2);

    const duplicateRows = [
      { firstName: "Duplicado", lastName: "Mismo" },
      { firstName: "Duplicado", lastName: "Mismo" },
    ];
    await post(
      `/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}/roster-import`,
      adminToken,
      { rows: duplicateRows },
    ).expect(400);
    await post(
      `/admin/team-seasons/${SEED_TEAM_SEASON_IDS[0]}/roster-import`,
      adminToken,
      { rows: [{ firstName: "Invalido", lastName: "Fila", unknown: true }] },
    ).expect(400);
    expect(await rosterLength(SEED_TEAM_SEASON_IDS[0])).toBe(before + 2);
  });

  it("patches games with full scope and limits team admins to start and venue", async () => {
    const created = await post("/admin/games", adminToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      scheduledStart: "2026-06-01T23:00:00.000Z",
      venue: "Parque Original",
    }).expect(201);
    gamePatchId = created.body.id;

    const otherGame = await post("/admin/games", adminToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[1],
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[2],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[3],
      scheduledStart: "2026-06-02T23:00:00.000Z",
    }).expect(201);

    await patch(`/admin/games/${gamePatchId}`, null, {}).expect(401);
    await patch(`/admin/games/${UNKNOWN_ID}`, adminToken, {
      venue: "No existe",
    }).expect(404);
    await patch(`/admin/games/${gamePatchId}`, adminToken, {
      unknown: true,
    }).expect(400);

    const rescheduled = await patch(`/admin/games/${gamePatchId}`, tiburonesToken, {
      scheduledStart: "2026-06-01T19:00:00-05:00",
      venue: "Parque Tiburones",
    }).expect(200);
    expect(rescheduled.body).toMatchObject({
      scheduledStart: "2026-06-02T00:00:00.000Z",
      venue: "Parque Tiburones",
    });

    await patch(`/admin/games/${gamePatchId}`, tiburonesToken, {
      coverage: "summary",
    }).expect(403);
    await patch(`/admin/games/${otherGame.body.id}`, tiburonesToken, {
      venue: "No permitido",
    }).expect(403);

    const byCompetition = await patch(`/admin/games/${gamePatchId}`, norteToken, {
      coverage: "summary",
      dataSource: "import",
      venue: "Parque Norte",
      rulesProfile: { innings: 7 },
    }).expect(200);
    expect(byCompetition.body).toMatchObject({
      coverage: "summary",
      dataSource: "import",
      venue: "Parque Norte",
      rulesProfile: { innings: 7 },
    });

    const swapped = await patch(`/admin/games/${gamePatchId}`, adminToken, {
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
    }).expect(200);
    expect(swapped.body).toMatchObject({
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
      homeTeam: "Faros",
      awayTeam: "Tiburones",
    });
  });

  it("freezes game identity once the event log has events", async () => {
    const created = await post("/admin/games", adminToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      scheduledStart: "2026-06-03T23:00:00.000Z",
    }).expect(201);
    gameEventId = created.body.id;

    await events.createGame({
      id: gameEventId,
      homeTeam: created.body.homeTeam,
      awayTeam: created.body.awayTeam,
      scheduledStart: created.body.scheduledStart,
      venue: created.body.venue,
      createdAt: created.body.createdAt,
    });
    await post(`/games/${gameEventId}/start`, adminToken, {}).expect(201);

    await patch(`/admin/games/${gameEventId}`, adminToken, {
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
    }).expect(409);

    const rescheduled = await patch(`/admin/games/${gameEventId}`, tiburonesToken, {
      venue: "Parque con Eventos",
    }).expect(200);
    expect(rescheduled.body).toMatchObject({ venue: "Parque con Eventos" });
  });

  it("deletes only scheduled games with zero events", async () => {
    await del(`/admin/games/${gamePatchId}`, null).expect(401);
    await del(`/admin/games/${gamePatchId}`, tiburonesToken).expect(403);
    await del(`/admin/games/${UNKNOWN_ID}`, adminToken).expect(404);
    await del(
      `/admin/games/${"0192f3d0-0000-7000-8000-000000000200"}`,
      adminToken,
    ).expect(409);
    await del(`/admin/games/${gameEventId}`, adminToken).expect(409);

    const scheduled = await post("/admin/games", adminToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      scheduledStart: "2026-06-04T23:00:00.000Z",
    }).expect(201);

    const response = await del(`/admin/games/${scheduled.body.id}`, adminToken).expect(200);
    expect(response.body).toEqual({ deleted: true });
    await get(`/league-games/${scheduled.body.id}`).expect(404);

    const byCompetition = await post("/admin/games", adminToken, {
      seasonId: SEED_SEASON_ID,
      competitionId: SEED_COMPETITION_IDS[0],
      homeTeamSeasonId: SEED_TEAM_SEASON_IDS[0],
      awayTeamSeasonId: SEED_TEAM_SEASON_IDS[1],
      scheduledStart: "2026-06-05T23:00:00.000Z",
    }).expect(201);
    await del(`/admin/games/${byCompetition.body.id}`, norteToken).expect(200);
  });
});
