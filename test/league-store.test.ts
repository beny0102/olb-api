import { beforeAll, describe, expect, it } from "vitest";
import {
  SEED_COMPETITION_IDS,
  SEED_ORGANIZATION_ID,
  SEED_SEASON_ID,
  SEED_TEAM_SEASON_IDS,
  seedLeague,
} from "../src/scripts/league-seed.js";
import { MemoryLeagueStore } from "../src/store/memory-league.store.js";

describe("league store (memory)", () => {
  const store = new MemoryLeagueStore();

  beforeAll(async () => {
    await seedLeague(store);
  });

  it("reads the seeded organization and season", async () => {
    const organizations = await store.listOrganizations();
    expect(organizations).toHaveLength(1);
    expect(organizations[0]).toMatchObject({
      id: SEED_ORGANIZATION_ID,
      name: "Liga Metropolitana",
      slug: "liga-metropolitana",
    });

    const season = await store.getSeason(SEED_SEASON_ID);
    expect(season).toMatchObject({
      id: SEED_SEASON_ID,
      organizationId: SEED_ORGANIZATION_ID,
      name: "2026",
      year: 2026,
      status: "active",
      startsOn: "2026-03-01",
      endsOn: "2026-11-30",
    });

    expect(await store.listSeasons(SEED_ORGANIZATION_ID)).toHaveLength(1);
    expect(await store.getSeason("0192f3d0-0000-7000-8000-000000000099")).toBeNull();
  });

  it("reads two divisions in sort order", async () => {
    const competitions = await store.listCompetitions(SEED_SEASON_ID);
    expect(competitions.map((row) => row.name)).toEqual(["Zona Norte", "Zona Sur"]);
    expect(competitions.map((row) => row.id)).toEqual([...SEED_COMPETITION_IDS]);
    expect(competitions.every((row) => row.kind === "division" && row.level === 1)).toBe(true);
  });

  it("reads the four teams grouped by division", async () => {
    const norte = await store.listTeams(SEED_COMPETITION_IDS[0]);
    expect(norte.map((row) => row.name)).toEqual(["Faros", "Tiburones"]);
    expect(norte.every((row) => row.competitionName === "Zona Norte")).toBe(true);
    expect(norte.every((row) => row.teamName === row.name)).toBe(true);

    const sur = await store.listTeams(SEED_COMPETITION_IDS[1]);
    expect(sur.map((row) => row.name)).toEqual(["Corsarios", "Mantarrayos"]);
    expect(sur.every((row) => row.competitionName === "Zona Sur")).toBe(true);
  });

  it("reads one team season with team and competition names", async () => {
    const teamSeason = await store.getTeamSeason(SEED_TEAM_SEASON_IDS[0]);
    expect(teamSeason).toMatchObject({
      id: SEED_TEAM_SEASON_IDS[0],
      name: "Tiburones",
      abbreviation: "TIB",
      teamName: "Tiburones",
      competitionName: "Zona Norte",
    });
    expect(await store.getTeamSeason("0192f3d0-0000-7000-8000-000000000099")).toBeNull();
  });

  it("reads an 18-player roster ordered by jersey", async () => {
    const roster = await store.listRoster(SEED_TEAM_SEASON_IDS[0]);
    expect(roster).toHaveLength(18);
    expect(roster.map((row) => row.jersey)).toEqual(
      Array.from({ length: 18 }, (_, index) => String(index + 1)),
    );
    expect(roster[0]).toMatchObject({
      firstName: "Alejandro",
      lastName: "Aguilar",
      primaryPosition: "C",
      eligibilityStart: "2026-03-01",
      status: "active",
    });
    expect(roster.map((row) => row.primaryPosition).slice(0, 10)).toEqual([
      "C",
      "1B",
      "2B",
      "3B",
      "SS",
      "LF",
      "CF",
      "RF",
      "DH",
      "P",
    ]);

    let total = 0;
    for (const teamSeasonId of SEED_TEAM_SEASON_IDS) {
      total += (await store.listRoster(teamSeasonId)).length;
    }
    expect(total).toBe(72);
  });

  it("reads eight scheduled games and filters by competition", async () => {
    const games = await store.listGames(SEED_SEASON_ID);
    expect(games).toHaveLength(8);
    expect(games[0]).toMatchObject({
      id: "0192f3d0-0000-7000-8000-000000000200",
      homeTeam: "Tiburones",
      awayTeam: "Faros",
      scheduledStart: "2026-03-07T23:00:00.000Z",
      competitionId: SEED_COMPETITION_IDS[0],
      coverage: "full",
      dataSource: "official",
      lastSeq: -1,
    });
    expect(games[7]!.scheduledStart).toBe("2026-04-25T23:00:00.000Z");
    expect(games.every((row) => row.seasonId === SEED_SEASON_ID)).toBe(true);

    const norte = await store.listGames(SEED_SEASON_ID, SEED_COMPETITION_IDS[0]);
    expect(norte).toHaveLength(4);
    expect(norte.every((row) => row.competitionId === SEED_COMPETITION_IDS[0])).toBe(true);

    const sur = await store.listGames(SEED_SEASON_ID, SEED_COMPETITION_IDS[1]);
    expect(sur).toHaveLength(4);
    expect(sur.every((row) => row.competitionId === SEED_COMPETITION_IDS[1])).toBe(true);
  });

  it("seeds idempotently", async () => {
    await seedLeague(store);
    await seedLeague(store);

    const organizations = await store.listOrganizations();
    const seasons = await store.listSeasons(SEED_ORGANIZATION_ID);
    const competitions = await store.listCompetitions(SEED_SEASON_ID);
    const teams = (
      await Promise.all(competitions.map((row) => store.listTeams(row.id)))
    ).flat();
    const rosters = await Promise.all(teams.map((row) => store.listRoster(row.id)));
    const games = await store.listGames(SEED_SEASON_ID);

    expect(organizations).toHaveLength(1);
    expect(seasons).toHaveLength(1);
    expect(competitions).toHaveLength(2);
    expect(teams).toHaveLength(4);
    expect(rosters.flat()).toHaveLength(72);
    expect(games).toHaveLength(8);
  });
});
