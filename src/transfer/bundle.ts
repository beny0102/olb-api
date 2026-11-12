import { BadRequestException } from "@nestjs/common";
import {
  assertArray,
  assertObject,
  COMPETITION_KINDS,
  COVERAGES,
  DATA_SOURCES,
  hasField,
  MAX_ABBREVIATION,
  MAX_JERSEY,
  MAX_NAME,
  MAX_POSITION,
  MAX_SLUG,
  MAX_VENUE,
  optionalDate,
  optionalString,
  optionalTimestamp,
  optionalUuid,
  requiredEnum,
  requiredInteger,
  requiredString,
  requiredUuid,
  ROSTER_STATUSES,
  SEASON_STATUSES,
} from "../admin/catalog.dto.js";
import type {
  CompetitionKind,
  GameCoverage,
  GameDataSource,
  RosterStatus,
  SeasonStatus,
} from "../store/league.store.js";

export const LEAGUE_BUNDLE_FORMAT = "olb.league/1";

export interface LeagueBundleOrganization {
  slug: string;
  name: string;
}

export interface LeagueBundleCompetition {
  id: string;
  name: string;
  kind: CompetitionKind;
  parentId: string | null;
  level: number;
  sortOrder: number;
}

export interface LeagueBundleSeason {
  id: string;
  year: number;
  name: string;
  status: SeasonStatus;
  startsOn: string | null;
  endsOn: string | null;
  competitions: LeagueBundleCompetition[];
}

export interface LeagueBundleTeam {
  id: string;
  name: string;
  slug: string;
  abbreviation: string | null;
}

export interface LeagueBundlePlayer {
  id: string;
  firstName: string;
  lastName: string;
}

export interface LeagueBundleRosterEntry {
  id: string;
  player: LeagueBundlePlayer;
  jersey: string | null;
  primaryPosition: string | null;
  eligibilityStart: string | null;
  eligibilityEnd: string | null;
  status: RosterStatus;
}

export interface LeagueBundleTeamSeason {
  id: string;
  teamId: string;
  seasonId: string;
  competitionId: string | null;
  name: string;
  abbreviation: string | null;
  roster: LeagueBundleRosterEntry[];
}

export interface LeagueBundleGame {
  id: string;
  seasonId: string;
  competitionId: string | null;
  homeTeamSeasonId: string;
  awayTeamSeasonId: string;
  scheduledStart: string | null;
  venue: string | null;
  coverage: GameCoverage;
  dataSource: GameDataSource;
  rulesProfile: unknown;
}

export interface LeagueBundle {
  format: typeof LEAGUE_BUNDLE_FORMAT;
  exportedAt: string;
  organization: LeagueBundleOrganization;
  seasons: LeagueBundleSeason[];
  teams: LeagueBundleTeam[];
  teamSeasons: LeagueBundleTeamSeason[];
  games: LeagueBundleGame[];
}

const ORGANIZATION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requiredNullableString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string | null {
  if (!hasField(body, key)) throw new BadRequestException(`${key} is required`);
  return optionalString(body, key, maxLength);
}

function requiredNullableUuid(
  body: Record<string, unknown>,
  key: string,
): string | null {
  if (!hasField(body, key)) throw new BadRequestException(`${key} is required`);
  return optionalUuid(body, key);
}

function requiredNullableDate(
  body: Record<string, unknown>,
  key: string,
): string | null {
  if (!hasField(body, key)) throw new BadRequestException(`${key} is required`);
  return optionalDate(body, key);
}

function requiredNullableTimestamp(
  body: Record<string, unknown>,
  key: string,
): string | null {
  if (!hasField(body, key)) throw new BadRequestException(`${key} is required`);
  return optionalTimestamp(body, key);
}

interface Claim {
  entity: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Parses an `olb.league/1` bundle. Unknown fields are ignored on purpose:
 * a newer producer may add metadata without breaking an older consumer.
 */
export function parseLeagueBundle(body: unknown): LeagueBundle {
  const input = assertObject(body);

  if (input.format !== LEAGUE_BUNDLE_FORMAT) {
    const format = typeof input.format === "string" ? input.format : "(missing)";
    throw new BadRequestException(
      `unsupported bundle format ${format}; expected ${LEAGUE_BUNDLE_FORMAT}`,
    );
  }

  const exportedAt = requiredNullableTimestamp(input, "exportedAt");
  if (exportedAt === null) throw new BadRequestException("exportedAt is required");

  const organizationInput = assertObject(input.organization);
  const slug = requiredString(organizationInput, "slug", MAX_SLUG);
  if (!ORGANIZATION_SLUG.test(slug)) {
    throw new BadRequestException("organization.slug must be a lowercase kebab-case slug");
  }
  const organization: LeagueBundleOrganization = {
    slug,
    name: requiredString(organizationInput, "name", MAX_NAME),
  };

  const claims = new Map<string, Claim>();
  const playerClaims = new Map<string, Claim>();

  const claim = (id: string, entity: string): void => {
    if (claims.has(id)) {
      throw new BadRequestException(`duplicate id ${id} in bundle`);
    }
    claims.set(id, { entity });
  };

  const seasonIds = new Set<string>();
  const competitionSeasons = new Map<string, string>();
  const seasons: LeagueBundleSeason[] = assertArray(input, "seasons").map((raw) => {
    const row = assertObject(raw);
    const id = requiredUuid(row, "id");
    claim(id, "season");
    seasonIds.add(id);

    const competitions: LeagueBundleCompetition[] = assertArray(row, "competitions").map(
      (rawCompetition) => {
        const competition = assertObject(rawCompetition);
        const competitionId = requiredUuid(competition, "id");
        claim(competitionId, "competition");
        competitionSeasons.set(competitionId, id);
        return {
          id: competitionId,
          name: requiredString(competition, "name", MAX_NAME),
          kind: requiredEnum<CompetitionKind>(competition, "kind", COMPETITION_KINDS),
          parentId: requiredNullableUuid(competition, "parentId"),
          level: requiredInteger(competition, "level", 0, 100),
          sortOrder: requiredInteger(competition, "sortOrder", -10000, 10000),
        } satisfies LeagueBundleCompetition;
      },
    );

    return {
      id,
      year: requiredInteger(row, "year", 1900, 9999),
      name: requiredString(row, "name", MAX_NAME),
      status: requiredEnum<SeasonStatus>(row, "status", SEASON_STATUSES),
      startsOn: requiredNullableDate(row, "startsOn"),
      endsOn: requiredNullableDate(row, "endsOn"),
      competitions,
    } satisfies LeagueBundleSeason;
  });

  const teamIds = new Set<string>();
  const teams: LeagueBundleTeam[] = assertArray(input, "teams").map((raw) => {
    const row = assertObject(raw);
    const id = requiredUuid(row, "id");
    claim(id, "team");
    teamIds.add(id);
    return {
      id,
      name: requiredString(row, "name", MAX_NAME),
      slug: requiredString(row, "slug", MAX_SLUG),
      abbreviation: requiredNullableString(row, "abbreviation", MAX_ABBREVIATION),
    } satisfies LeagueBundleTeam;
  });

  const teamSeasonById = new Map<string, LeagueBundleTeamSeason>();
  const teamSeasons: LeagueBundleTeamSeason[] = assertArray(input, "teamSeasons").map((raw) => {
    const row = assertObject(raw);
    const id = requiredUuid(row, "id");
    claim(id, "teamSeason");

    const roster = assertArray(row, "roster").map((rawEntry) => {
      const entry = assertObject(rawEntry);
      const entryId = requiredUuid(entry, "id");
      claim(entryId, "rosterEntry");

      const playerInput = assertObject(entry.player);
      const playerId = requiredUuid(playerInput, "id");
      const firstName = requiredString(playerInput, "firstName", MAX_NAME);
      const lastName = requiredString(playerInput, "lastName", MAX_NAME);

      const previous = playerClaims.get(playerId);
      if (previous) {
        if (previous.firstName !== firstName || previous.lastName !== lastName) {
          throw new BadRequestException(
            `player ${playerId} appears with different names in the bundle`,
          );
        }
      } else {
        if (claims.has(playerId)) {
          throw new BadRequestException(`duplicate id ${playerId} in bundle`);
        }
        playerClaims.set(playerId, { entity: "player", firstName, lastName });
      }

      return {
        id: entryId,
        player: { id: playerId, firstName, lastName },
        jersey: requiredNullableString(entry, "jersey", MAX_JERSEY),
        primaryPosition: requiredNullableString(entry, "primaryPosition", MAX_POSITION),
        eligibilityStart: requiredNullableDate(entry, "eligibilityStart"),
        eligibilityEnd: requiredNullableDate(entry, "eligibilityEnd"),
        status: requiredEnum<RosterStatus>(entry, "status", ROSTER_STATUSES),
      } satisfies LeagueBundleRosterEntry;
    });

    const teamSeason: LeagueBundleTeamSeason = {
      id,
      teamId: requiredUuid(row, "teamId"),
      seasonId: requiredUuid(row, "seasonId"),
      competitionId: requiredNullableUuid(row, "competitionId"),
      name: requiredString(row, "name", MAX_NAME),
      abbreviation: requiredNullableString(row, "abbreviation", MAX_ABBREVIATION),
      roster,
    };
    teamSeasonById.set(id, teamSeason);
    return teamSeason;
  });

  const games: LeagueBundleGame[] = assertArray(input, "games").map((raw) => {
    const row = assertObject(raw);
    const id = requiredUuid(row, "id");
    claim(id, "game");
    return {
      id,
      seasonId: requiredUuid(row, "seasonId"),
      competitionId: requiredNullableUuid(row, "competitionId"),
      homeTeamSeasonId: requiredUuid(row, "homeTeamSeasonId"),
      awayTeamSeasonId: requiredUuid(row, "awayTeamSeasonId"),
      scheduledStart: requiredNullableTimestamp(row, "scheduledStart"),
      venue: requiredNullableString(row, "venue", MAX_VENUE),
      coverage: requiredEnum<GameCoverage>(row, "coverage", COVERAGES),
      dataSource: requiredEnum<GameDataSource>(row, "dataSource", DATA_SOURCES),
      rulesProfile: hasField(row, "rulesProfile") ? row.rulesProfile : null,
    } satisfies LeagueBundleGame;
  });

  validateReferences({
    seasons,
    teams,
    teamSeasons,
    games,
    seasonIds,
    teamIds,
    competitionSeasons,
    teamSeasonById,
  });

  return {
    format: LEAGUE_BUNDLE_FORMAT,
    exportedAt,
    organization,
    seasons,
    teams,
    teamSeasons,
    games,
  };
}

function validateReferences(input: {
  seasons: LeagueBundleSeason[];
  teams: LeagueBundleTeam[];
  teamSeasons: LeagueBundleTeamSeason[];
  games: LeagueBundleGame[];
  seasonIds: Set<string>;
  teamIds: Set<string>;
  competitionSeasons: Map<string, string>;
  teamSeasonById: Map<string, LeagueBundleTeamSeason>;
}): void {
  const teamSlugs = new Set<string>();
  for (const team of input.teams) {
    if (teamSlugs.has(team.slug)) {
      throw new BadRequestException(`duplicate team slug ${team.slug} in bundle`);
    }
    teamSlugs.add(team.slug);
  }

  const seasonYears = new Set<number>();
  for (const season of input.seasons) {
    if (seasonYears.has(season.year)) {
      throw new BadRequestException(`duplicate season year ${season.year} in bundle`);
    }
    seasonYears.add(season.year);

    const competitionNames = new Set<string>();
    for (const competition of season.competitions) {
      if (competitionNames.has(competition.name)) {
        throw new BadRequestException(
          `duplicate competition ${competition.name} in season ${season.id}`,
        );
      }
      competitionNames.add(competition.name);

      if (competition.parentId !== null) {
        const parentSeason = input.competitionSeasons.get(competition.parentId);
        if (parentSeason === undefined) {
          throw new BadRequestException(
            `competition ${competition.id} parent ${competition.parentId} is not in the bundle`,
          );
        }
        if (parentSeason !== season.id) {
          throw new BadRequestException(
            `competition ${competition.id} parent must belong to the same season`,
          );
        }
      }
    }
    assertNoCompetitionCycle(season.competitions);
  }

  const teamSeasonKeys = new Set<string>();
  const teamSeasonNames = new Set<string>();
  for (const teamSeason of input.teamSeasons) {
    if (!input.teamIds.has(teamSeason.teamId)) {
      throw new BadRequestException(
        `team season ${teamSeason.id} references unknown team ${teamSeason.teamId}`,
      );
    }
    if (!input.seasonIds.has(teamSeason.seasonId)) {
      throw new BadRequestException(
        `team season ${teamSeason.id} references unknown season ${teamSeason.seasonId}`,
      );
    }
    if (teamSeason.competitionId !== null) {
      if (input.competitionSeasons.get(teamSeason.competitionId) !== teamSeason.seasonId) {
        throw new BadRequestException(
          `team season ${teamSeason.id} competition must belong to the same season`,
        );
      }
    }

    const key = `${teamSeason.teamId}\u0000${teamSeason.seasonId}`;
    if (teamSeasonKeys.has(key)) {
      throw new BadRequestException(
        `duplicate team season for team ${teamSeason.teamId} in season ${teamSeason.seasonId}`,
      );
    }
    teamSeasonKeys.add(key);

    const nameKey = `${teamSeason.seasonId}\u0000${teamSeason.name}`;
    if (teamSeasonNames.has(nameKey)) {
      throw new BadRequestException(
        `duplicate team season name ${teamSeason.name} in season ${teamSeason.seasonId}`,
      );
    }
    teamSeasonNames.add(nameKey);

    const rosterKeys = new Set<string>();
    for (const entry of teamSeason.roster) {
      const rosterKey = `${entry.player.id}\u0000${entry.eligibilityStart ?? ""}`;
      if (rosterKeys.has(rosterKey)) {
        throw new BadRequestException(
          `duplicate roster entry for player ${entry.player.id} in team season ${teamSeason.id}`,
        );
      }
      rosterKeys.add(rosterKey);
    }
  }

  const gameKeys = new Set<string>();
  for (const game of input.games) {
    if (!input.seasonIds.has(game.seasonId)) {
      throw new BadRequestException(
        `game ${game.id} references unknown season ${game.seasonId}`,
      );
    }
    if (
      game.competitionId !== null &&
      input.competitionSeasons.get(game.competitionId) !== game.seasonId
    ) {
      throw new BadRequestException(
        `game ${game.id} competition must belong to the same season`,
      );
    }

    const home = input.teamSeasonById.get(game.homeTeamSeasonId);
    const away = input.teamSeasonById.get(game.awayTeamSeasonId);
    if (!home || !away) {
      throw new BadRequestException(`game ${game.id} references an unknown team season`);
    }
    if (home.seasonId !== game.seasonId || away.seasonId !== game.seasonId) {
      throw new BadRequestException(`game ${game.id} team seasons must belong to its season`);
    }
    if (home.id === away.id) {
      throw new BadRequestException(`game ${game.id} requires two different team seasons`);
    }
    if (
      game.competitionId !== null &&
      (home.competitionId !== game.competitionId || away.competitionId !== game.competitionId)
    ) {
      throw new BadRequestException(
        `game ${game.id} team seasons must belong to its competition`,
      );
    }

    const key = [
      game.seasonId,
      game.competitionId ?? "",
      game.homeTeamSeasonId,
      game.awayTeamSeasonId,
      game.scheduledStart ?? "",
    ].join("\u0000");
    if (gameKeys.has(key)) {
      throw new BadRequestException(`duplicate game ${game.id} in bundle`);
    }
    gameKeys.add(key);
  }
}

function assertNoCompetitionCycle(competitions: LeagueBundleCompetition[]): void {
  const byId = new Map(competitions.map((competition) => [competition.id, competition]));
  const visiting = new Set<string>();
  const done = new Set<string>();

  const visit = (id: string): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new BadRequestException("competition parent chain contains a cycle");
    }
    visiting.add(id);
    const parentId = byId.get(id)?.parentId;
    if (parentId !== null && parentId !== undefined) visit(parentId);
    visiting.delete(id);
    done.add(id);
  };

  for (const competition of competitions) visit(competition.id);
}
