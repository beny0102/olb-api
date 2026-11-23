import { isDeepStrictEqual } from "node:util";
import type {
  CompetitionInput,
  CompetitionRecord,
  CreateLeagueGameInput,
  LeagueGameRecord,
  LeagueStore,
  PlayerInput,
  PlayerRecord,
  RosterEntryInput,
  RosterEntryRecord,
  SeasonInput,
  SeasonRecord,
  TeamInput,
  TeamRecord,
  TeamSeasonInput,
  TeamSeasonRecord,
} from "../store/league.store.js";
import type { LeagueBundle, LeagueBundleGame, LeagueBundleSeason } from "./bundle.js";

export interface LeagueImportCounts {
  seasons: number;
  competitions: number;
  teams: number;
  teamSeasons: number;
  players: number;
  rosterEntries: number;
  games: number;
}

export interface LeagueImportConflict {
  entity: string;
  id: string;
  key: string;
  message: string;
}

export interface LeagueImportResult {
  dryRun: boolean;
  created: LeagueImportCounts;
  updated: LeagueImportCounts;
  unchanged: LeagueImportCounts;
  conflicts: LeagueImportConflict[];
  warnings: string[];
}

export interface LeagueImportOptions {
  store: LeagueStore;
  bundle: LeagueBundle;
  organizationId: string;
  dryRun: boolean;
  gamesWithEvents: ReadonlySet<string>;
}

type CountKey = keyof LeagueImportCounts;

interface Write<T> {
  existing: boolean;
  input: T;
}

function emptyCounts(): LeagueImportCounts {
  return {
    seasons: 0,
    competitions: 0,
    teams: 0,
    teamSeasons: 0,
    players: 0,
    rosterEntries: 0,
    games: 0,
  };
}

function increment(counts: LeagueImportCounts, key: CountKey): void {
  counts[key] += 1;
}

function sameJson(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

function sameSeason(existing: SeasonRecord, next: SeasonInput): boolean {
  return (
    existing.organizationId === next.organizationId &&
    existing.name === next.name &&
    existing.year === next.year &&
    existing.status === next.status &&
    existing.startsOn === next.startsOn &&
    existing.endsOn === next.endsOn
  );
}

function sameCompetition(existing: CompetitionRecord, next: CompetitionInput): boolean {
  return (
    existing.seasonId === next.seasonId &&
    existing.parentId === next.parentId &&
    existing.name === next.name &&
    existing.kind === next.kind &&
    existing.level === next.level &&
    existing.sortOrder === next.sortOrder
  );
}

function sameTeam(existing: TeamRecord, next: TeamInput): boolean {
  return (
    existing.organizationId === next.organizationId &&
    existing.name === next.name &&
    existing.slug === next.slug &&
    existing.abbreviation === next.abbreviation
  );
}

function sameTeamSeason(existing: TeamSeasonRecord, next: TeamSeasonInput): boolean {
  return (
    existing.teamId === next.teamId &&
    existing.seasonId === next.seasonId &&
    existing.competitionId === next.competitionId &&
    existing.name === next.name &&
    existing.abbreviation === next.abbreviation
  );
}

function samePlayer(existing: PlayerRecord, next: PlayerInput): boolean {
  return (
    existing.organizationId === next.organizationId &&
    existing.firstName === next.firstName &&
    existing.lastName === next.lastName
  );
}

function sameRosterEntry(existing: RosterEntryRecord, next: RosterEntryInput): boolean {
  return (
    existing.teamSeasonId === next.teamSeasonId &&
    existing.playerId === next.playerId &&
    existing.jersey === next.jersey &&
    existing.primaryPosition === next.primaryPosition &&
    existing.eligibilityStart === next.eligibilityStart &&
    existing.eligibilityEnd === next.eligibilityEnd &&
    existing.status === next.status
  );
}

function sameGameIdentity(existing: LeagueGameRecord, next: CreateLeagueGameInput): boolean {
  return (
    existing.seasonId === next.seasonId &&
    existing.competitionId === next.competitionId &&
    existing.homeTeamSeasonId === next.homeTeamSeasonId &&
    existing.awayTeamSeasonId === next.awayTeamSeasonId &&
    existing.scheduledStart === next.scheduledStart
  );
}

function sameGame(existing: LeagueGameRecord, next: CreateLeagueGameInput): boolean {
  return (
    sameGameIdentity(existing, next) &&
    existing.venue === next.venue &&
    existing.coverage === next.coverage &&
    existing.dataSource === next.dataSource &&
    sameJson(existing.rulesProfile, next.rulesProfile)
  );
}

/** Parents before children, even when the bundle lists children first. */
function orderCompetitions(
  season: LeagueBundleSeason,
  inputs: Map<string, CompetitionInput>,
): CompetitionInput[] {
  const ordered: CompetitionInput[] = [];
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const input = inputs.get(id);
    if (input?.parentId) visit(input.parentId);
    visiting.delete(id);
    if (input) {
      ordered.push(input);
      done.add(id);
    }
  };

  for (const competition of season.competitions) visit(competition.id);
  return ordered;
}

/**
 * Reads the target, plans every change and only then writes. A conflict
 * anywhere aborts the whole import, so nothing is applied partially.
 */
export async function runLeagueImport(
  options: LeagueImportOptions,
): Promise<LeagueImportResult> {
  const { store, bundle, organizationId, dryRun, gamesWithEvents } = options;
  const created = emptyCounts();
  const updated = emptyCounts();
  const unchanged = emptyCounts();
  const conflicts: LeagueImportConflict[] = [];
  const warnings: string[] = [];
  const now = new Date().toISOString();

  const conflict = (entity: string, id: string, key: string, message: string): void => {
    conflicts.push({ entity, id, key, message });
  };

  const targetSeasons = await store.listSeasons(organizationId);
  const seasonWrites: Write<SeasonInput>[] = [];
  const competitionWrites = new Map<string, Map<string, Write<CompetitionInput>>>();
  const teamWrites: Write<TeamInput>[] = [];
  const teamSeasonWrites: Write<TeamSeasonInput>[] = [];
  const playerWrites: Write<PlayerInput>[] = [];
  const rosterWrites: Write<RosterEntryInput>[] = [];
  const gameWrites: Write<CreateLeagueGameInput>[] = [];
  const existingSeasons = new Map<string, SeasonRecord>();
  const existingPlayers = new Map<string, PlayerRecord>();
  const conflictedPlayers = new Set<string>();

  for (const season of bundle.seasons) {
    const next: SeasonInput = {
      id: season.id,
      organizationId,
      name: season.name,
      year: season.year,
      status: season.status,
      startsOn: season.startsOn,
      endsOn: season.endsOn,
    };
    const existing = await store.getSeason(season.id);
    const sameYear = targetSeasons.find((row) => row.year === season.year);

    if (existing && existing.organizationId !== organizationId) {
      conflict(
        "season",
        season.id,
        `year:${season.year}`,
        `season id already belongs to another organization`,
      );
      continue;
    }
    if (sameYear && sameYear.id !== season.id) {
      conflict(
        "season",
        season.id,
        `year:${season.year}`,
        `season ${season.year} already exists as ${sameYear.id}`,
      );
      continue;
    }

    if (existing) {
      existingSeasons.set(season.id, existing);
      if (sameSeason(existing, next)) {
        increment(unchanged, "seasons");
      } else {
        seasonWrites.push({ existing: true, input: next });
        increment(updated, "seasons");
      }
    } else {
      seasonWrites.push({ existing: false, input: next });
      increment(created, "seasons");
    }
  }

  for (const season of bundle.seasons) {
    if (existingSeasons.has(season.id) || seasonWrites.some((w) => w.input.id === season.id)) {
      // The season is importable (new or updated); its children can follow.
    } else {
      continue;
    }

    const currentCompetitions = await store.listCompetitions(season.id);
    const seasonWritesById = new Map<string, Write<CompetitionInput>>();

    for (const competition of season.competitions) {
      const next: CompetitionInput = {
        id: competition.id,
        seasonId: season.id,
        parentId: competition.parentId,
        name: competition.name,
        kind: competition.kind,
        level: competition.level,
        sortOrder: competition.sortOrder,
      };
      const existing = await store.getCompetition(competition.id);
      const sameName = currentCompetitions.find((row) => row.name === competition.name);

      if (existing) {
        const ownerSeason = await store.getSeason(existing.seasonId);
        if (!ownerSeason || ownerSeason.organizationId !== organizationId) {
          conflict(
            "competition",
            competition.id,
            `season:${season.id}:name:${competition.name}`,
            "competition id already belongs to another organization",
          );
          continue;
        }
      }
      if (sameName && sameName.id !== competition.id) {
        conflict(
          "competition",
          competition.id,
          `season:${season.id}:name:${competition.name}`,
          `competition ${competition.name} already exists as ${sameName.id}`,
        );
        continue;
      }

      if (existing) {
        if (sameCompetition(existing, next)) {
          increment(unchanged, "competitions");
        } else {
          seasonWritesById.set(competition.id, { existing: true, input: next });
          increment(updated, "competitions");
        }
      } else {
        seasonWritesById.set(competition.id, { existing: false, input: next });
        increment(created, "competitions");
      }
    }

    competitionWrites.set(season.id, seasonWritesById);
  }

  for (const team of bundle.teams) {
    const next: TeamInput = {
      id: team.id,
      organizationId,
      name: team.name,
      slug: team.slug,
      abbreviation: team.abbreviation,
      createdAt: now,
    };
    const existing = await store.getTeam(team.id);
    const sameSlug = await store.getTeamBySlug(team.slug);

    if (existing && existing.organizationId !== organizationId) {
      conflict(
        "team",
        team.id,
        `slug:${team.slug}`,
        "team id already belongs to another organization",
      );
      continue;
    }
    if (sameSlug && sameSlug.id !== team.id) {
      conflict(
        "team",
        team.id,
        `slug:${team.slug}`,
        `team slug ${team.slug} already exists as ${sameSlug.id}`,
      );
      continue;
    }

    if (existing) {
      if (sameTeam(existing, next)) {
        increment(unchanged, "teams");
      } else {
        teamWrites.push({ existing: true, input: { ...next, createdAt: existing.createdAt } });
        increment(updated, "teams");
      }
    } else {
      teamWrites.push({ existing: false, input: next });
      increment(created, "teams");
    }
  }

  const teamSeasonsBySeason = new Map<string, TeamSeasonRecord[]>();
  for (const season of bundle.seasons) {
    teamSeasonsBySeason.set(season.id, await store.listTeamSeasonsBySeason(season.id));
  }

  for (const teamSeason of bundle.teamSeasons) {
    const next: TeamSeasonInput = {
      id: teamSeason.id,
      teamId: teamSeason.teamId,
      seasonId: teamSeason.seasonId,
      competitionId: teamSeason.competitionId,
      name: teamSeason.name,
      abbreviation: teamSeason.abbreviation,
    };
    const existing = await store.getTeamSeason(teamSeason.id);
    const seasonRows = teamSeasonsBySeason.get(teamSeason.seasonId) ?? [];
    const sameTeam = seasonRows.find(
      (row) => row.teamId === teamSeason.teamId && row.seasonId === teamSeason.seasonId,
    );
    const sameName = seasonRows.find((row) => row.name === teamSeason.name);

    if (existing) {
      const ownerSeason = await store.getSeason(existing.seasonId);
      if (!ownerSeason || ownerSeason.organizationId !== organizationId) {
        conflict(
          "teamSeason",
          teamSeason.id,
          `team:${teamSeason.teamId}:season:${teamSeason.seasonId}`,
          "team season id already belongs to another organization",
        );
        continue;
      }
    }
    if (sameTeam && sameTeam.id !== teamSeason.id) {
      conflict(
        "teamSeason",
        teamSeason.id,
        `team:${teamSeason.teamId}:season:${teamSeason.seasonId}`,
        `team is already registered in the season as ${sameTeam.id}`,
      );
      continue;
    }
    if (sameName && sameName.id !== teamSeason.id) {
      conflict(
        "teamSeason",
        teamSeason.id,
        `season:${teamSeason.seasonId}:name:${teamSeason.name}`,
        `team season name ${teamSeason.name} already exists as ${sameName.id}`,
      );
      continue;
    }

    if (existing) {
      if (sameTeamSeason(existing, next)) {
        increment(unchanged, "teamSeasons");
      } else {
        teamSeasonWrites.push({ existing: true, input: next });
        increment(updated, "teamSeasons");
      }
    } else {
      teamSeasonWrites.push({ existing: false, input: next });
      increment(created, "teamSeasons");
    }
  }

  for (const teamSeason of bundle.teamSeasons) {
    for (const entry of teamSeason.roster) {
      if (conflictedPlayers.has(entry.player.id)) continue;

      const next: PlayerInput = {
        id: entry.player.id,
        organizationId,
        firstName: entry.player.firstName,
        lastName: entry.player.lastName,
        namePublic: false,
        createdAt: now,
      };

      if (!existingPlayers.has(entry.player.id) && !playerWrites.some((w) => w.input.id === entry.player.id)) {
        const existing = await store.getPlayer(entry.player.id);
        if (existing && existing.organizationId !== organizationId) {
          conflictedPlayers.add(entry.player.id);
          conflict(
            "player",
            entry.player.id,
            `name:${entry.player.firstName} ${entry.player.lastName}`,
            "player id already belongs to another organization",
          );
          continue;
        }
        if (existing) {
          existingPlayers.set(entry.player.id, existing);
          if (samePlayer(existing, next)) {
            increment(unchanged, "players");
          } else {
            playerWrites.push({
              existing: true,
              input: { ...next, createdAt: existing.createdAt },
            });
            increment(updated, "players");
          }
        } else {
          playerWrites.push({ existing: false, input: next });
          increment(created, "players");
        }
      }

      const nextEntry: RosterEntryInput = {
        id: entry.id,
        teamSeasonId: teamSeason.id,
        playerId: entry.player.id,
        jersey: entry.jersey,
        primaryPosition: entry.primaryPosition,
        eligibilityStart: entry.eligibilityStart,
        eligibilityEnd: entry.eligibilityEnd,
        status: entry.status,
      };
      const existingEntry = await store.getRosterEntry(entry.id);
      const teamSeasonRoster = await store.listRoster(teamSeason.id);
      const sameKey = teamSeasonRoster.find(
        (row) =>
          row.playerId === entry.player.id &&
          row.eligibilityStart === entry.eligibilityStart,
      );

      if (existingEntry) {
        const ownerTeamSeason = await store.getTeamSeason(existingEntry.teamSeasonId);
        const ownerSeason = ownerTeamSeason
          ? await store.getSeason(ownerTeamSeason.seasonId)
          : null;
        if (!ownerSeason || ownerSeason.organizationId !== organizationId) {
          conflict(
            "rosterEntry",
            entry.id,
            `teamSeason:${teamSeason.id}:player:${entry.player.id}`,
            "roster entry id already belongs to another organization",
          );
          continue;
        }
      }
      if (sameKey && sameKey.id !== entry.id) {
        conflict(
          "rosterEntry",
          entry.id,
          `teamSeason:${teamSeason.id}:player:${entry.player.id}:start:${entry.eligibilityStart ?? ""}`,
          `player is already on the roster as ${sameKey.id}`,
        );
        continue;
      }

      if (existingEntry) {
        if (sameRosterEntry(existingEntry, nextEntry)) {
          increment(unchanged, "rosterEntries");
        } else {
          rosterWrites.push({ existing: true, input: nextEntry });
          increment(updated, "rosterEntries");
        }
      } else {
        rosterWrites.push({ existing: false, input: nextEntry });
        increment(created, "rosterEntries");
      }
    }
  }

  const gamesBySeason = new Map<string, LeagueGameRecord[]>();
  for (const season of bundle.seasons) {
    gamesBySeason.set(season.id, await store.listGames(season.id));
  }

  for (const game of bundle.games) {
    const next = gameInput(game, bundle, now);
    if (!next) {
      conflict(
        "game",
        game.id,
        `season:${game.seasonId}`,
        "game team seasons are not importable",
      );
      continue;
    }

    const existing = await store.getGame(game.id);
    const seasonRows = gamesBySeason.get(game.seasonId) ?? [];
    const sameKey = seasonRows.find(
      (row) =>
        row.competitionId === game.competitionId &&
        row.homeTeamSeasonId === game.homeTeamSeasonId &&
        row.awayTeamSeasonId === game.awayTeamSeasonId &&
        row.scheduledStart === game.scheduledStart,
    );

    if (existing) {
      const ownerSeason =
        existing.seasonId === null ? null : await store.getSeason(existing.seasonId);
      if (!ownerSeason || ownerSeason.organizationId !== organizationId) {
        conflict(
          "game",
          game.id,
          `season:${game.seasonId}:start:${game.scheduledStart ?? ""}`,
          "game id already belongs to another organization",
        );
        continue;
      }
    }
    if (sameKey && sameKey.id !== game.id) {
      conflict(
        "game",
        game.id,
        `season:${game.seasonId}:start:${game.scheduledStart ?? ""}`,
        `game already exists as ${sameKey.id}`,
      );
      continue;
    }

    if (existing) {
      if (gamesWithEvents.has(game.id)) {
        if (!sameGameIdentity(existing, next)) {
          conflict(
            "game",
            game.id,
            `season:${game.seasonId}:start:${game.scheduledStart ?? ""}`,
            "game has events; its season, competition, teams or start would change",
          );
        } else {
          warnings.push(`game ${game.id} has events and was left unchanged`);
          increment(unchanged, "games");
        }
        continue;
      }
      if (sameGame(existing, next)) {
        increment(unchanged, "games");
      } else {
        gameWrites.push({
          existing: true,
          input: { ...next, createdAt: existing.createdAt, lastSeq: existing.lastSeq },
        });
        increment(updated, "games");
      }
    } else {
      gameWrites.push({ existing: false, input: next });
      increment(created, "games");
    }
  }

  if (conflicts.length === 0 && !dryRun) {
    await applyWrites({
      store,
      bundle,
      seasons: seasonWrites,
      competitions: competitionWrites,
      teams: teamWrites,
      teamSeasons: teamSeasonWrites,
      players: playerWrites,
      rosterEntries: rosterWrites,
      games: gameWrites,
    });
  }

  return { dryRun, created, updated, unchanged, conflicts, warnings };
}

function gameInput(
  game: LeagueBundleGame,
  bundle: LeagueBundle,
  now: string,
): CreateLeagueGameInput | null {
  const teamSeasons = new Map(bundle.teamSeasons.map((row) => [row.id, row]));
  const teams = new Map(bundle.teams.map((row) => [row.id, row]));
  const home = teamSeasons.get(game.homeTeamSeasonId);
  const away = teamSeasons.get(game.awayTeamSeasonId);
  const homeTeam = home ? teams.get(home.teamId) : undefined;
  const awayTeam = away ? teams.get(away.teamId) : undefined;
  if (!homeTeam || !awayTeam) return null;

  return {
    id: game.id,
    seasonId: game.seasonId,
    competitionId: game.competitionId,
    homeTeamSeasonId: game.homeTeamSeasonId,
    awayTeamSeasonId: game.awayTeamSeasonId,
    homeTeam: homeTeam.name,
    awayTeam: awayTeam.name,
    scheduledStart: game.scheduledStart,
    venue: game.venue,
    coverage: game.coverage,
    dataSource: game.dataSource,
    rulesProfile: game.rulesProfile,
    createdAt: now,
    lastSeq: -1,
  };
}

async function applyWrites(input: {
  store: LeagueStore;
  bundle: LeagueBundle;
  seasons: Write<SeasonInput>[];
  competitions: Map<string, Map<string, Write<CompetitionInput>>>;
  teams: Write<TeamInput>[];
  teamSeasons: Write<TeamSeasonInput>[];
  players: Write<PlayerInput>[];
  rosterEntries: Write<RosterEntryInput>[];
  games: Write<CreateLeagueGameInput>[];
}): Promise<void> {
  const { store } = input;

  for (const write of input.seasons) {
    if (write.existing) {
      await mustUpdate(store.updateSeason(write.input), "season", write.input.id);
    } else {
      await store.upsertSeason(write.input);
    }
  }

  for (const season of input.bundle.seasons) {
    const writes = input.competitions.get(season.id);
    if (!writes) continue;
    const inputs = new Map([...writes].map(([id, write]) => [id, write.input]));
    for (const competition of orderCompetitions(season, inputs)) {
      const write = writes.get(competition.id)!;
      if (write.existing) {
        await mustUpdate(store.updateCompetition(competition), "competition", competition.id);
      } else {
        await store.upsertCompetition(competition);
      }
    }
  }

  for (const write of input.teams) {
    if (write.existing) {
      await mustUpdate(store.updateTeam(write.input), "team", write.input.id);
    } else {
      await store.upsertTeam(write.input);
    }
  }

  for (const write of input.teamSeasons) {
    if (write.existing) {
      await mustUpdate(
        store.updateTeamSeason(write.input),
        "team season",
        write.input.id,
      );
    } else {
      await store.upsertTeamSeason(write.input);
    }
  }

  for (const write of input.players) {
    if (write.existing) {
      await mustUpdate(store.updatePlayer(write.input), "player", write.input.id);
    } else {
      await store.upsertPlayer(write.input);
    }
  }

  for (const write of input.rosterEntries) {
    if (write.existing) {
      await mustUpdate(
        store.updateRosterEntry(write.input),
        "roster entry",
        write.input.id,
      );
    } else {
      await store.upsertRosterEntry(write.input);
    }
  }

  for (const write of input.games) {
    if (write.existing) {
      await mustUpdate(store.updateGame(write.input), "game", write.input.id);
    } else {
      await store.upsertGame(write.input);
    }
  }
}

async function mustUpdate(
  promise: Promise<unknown | null>,
  entity: string,
  id: string,
): Promise<void> {
  if (!(await promise)) throw new Error(`${entity} ${id} disappeared during import`);
}
