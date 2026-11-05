import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { AuthContext } from "../auth/auth.service.js";
import { uuidv7 } from "../domain/uuid7.js";
import {
  hasCompetitionAdmin,
  hasOrgAdmin,
  hasTeamRole,
  ScopesService,
} from "../auth/scopes.js";
import {
  LEAGUE_STORE,
  type CompetitionKind,
  type CompetitionRecord,
  type GameCoverage,
  type GameDataSource,
  type LeagueGameRecord,
  type LeagueStore,
  type OrganizationRecord,
  type PlayerRecord,
  type RosterEntryRecord,
  type RosterStatus,
  type SeasonRecord,
  type SeasonStatus,
  type TeamRecord,
  type TeamSeasonRecord,
} from "../store/league.store.js";

const MAX_NAME = 120;
const MAX_SLUG = 80;
const MAX_ABBREVIATION = 16;
const MAX_VENUE = 200;
const MAX_JERSEY = 8;
const MAX_POSITION = 16;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const SEASON_STATUSES = ["active", "archived"] as const;
const COMPETITION_KINDS = ["league", "division"] as const;
const ROSTER_STATUSES = ["active", "inactive"] as const;
const COVERAGES = ["full", "summary", "external"] as const;
const DATA_SOURCES = ["official", "team_report", "import", "external"] as const;

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function requiredString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new BadRequestException(
      `${key} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value.trim();
}

function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new BadRequestException(`${key} must be a string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function isUuidV7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function requiredUuid(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (!isUuidV7(value)) {
    throw new BadRequestException(`${key} must be a lowercase UUIDv7`);
  }
  return value;
}

function optionalUuid(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!isUuidV7(value)) {
    throw new BadRequestException(`${key} must be a lowercase UUIDv7`);
  }
  return value;
}

function requiredInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = body[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestException(`${key} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestException(`${key} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function requiredEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = body[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new BadRequestException(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  return requiredEnum(body, key, values);
}

function optionalDate(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`${key} must be a date in YYYY-MM-DD form`);
  }
  return value;
}

function optionalTimestamp(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`${key} must be an ISO-8601 timestamp`);
  }
  return value;
}

/**
 * League admin writes. Reads stay public; every method here receives the
 * authenticated context and checks the scope before touching the catalog.
 * The legacy game-event writes are deliberately still open until D2.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(ScopesService) private readonly scopes: ScopesService,
  ) {}

  async createSeason(auth: AuthContext, body: unknown): Promise<SeasonRecord> {
    const input = assertObject(body);
    const organizationId = requiredUuid(input, "organizationId");
    await this.requireOrganization(organizationId);
    this.scopes.assertOrgAdmin(auth, organizationId);

    const name = requiredString(input, "name");
    const year = requiredInteger(input, "year", 1900, 9999);
    const status = requiredEnum<SeasonStatus>(input, "status", SEASON_STATUSES);

    const existing = await this.league.listSeasons(organizationId);
    if (existing.some((season) => season.year === year)) {
      throw new ConflictException(`season ${year} already exists for this organization`);
    }

    const season = await this.league.upsertSeason({
      id: uuidv7(),
      organizationId,
      name,
      year,
      status,
      startsOn: optionalDate(input, "startsOn"),
      endsOn: optionalDate(input, "endsOn"),
    });

    if (season.status === "active") {
      await this.league.archiveActiveSeasons(organizationId, season.id);
    }

    return season;
  }

  async createCompetition(auth: AuthContext, body: unknown): Promise<CompetitionRecord> {
    const input = assertObject(body);
    const seasonId = requiredUuid(input, "seasonId");
    const season = await this.requireSeason(seasonId);

    if (!hasOrgAdmin(auth, season.organizationId)) {
      const seasonCompetitions = await this.league.listCompetitions(season.id);
      if (!seasonCompetitions.some((competition) => hasCompetitionAdmin(auth, competition.id))) {
        throw new ForbiddenException("organization or competition admin role required");
      }
    }

    const parentId = optionalUuid(input, "parentId");
    if (parentId !== null) {
      const parent = await this.requireCompetition(parentId);
      if (parent.seasonId !== season.id) {
        throw new BadRequestException("parentId must belong to the same season");
      }
    }

    return this.league.upsertCompetition({
      id: uuidv7(),
      seasonId: season.id,
      parentId,
      name: requiredString(input, "name"),
      kind: requiredEnum<CompetitionKind>(input, "kind", COMPETITION_KINDS),
      level: optionalInteger(input, "level", 1, 0, 100),
      sortOrder: optionalInteger(input, "sortOrder", 0, -10000, 10000),
    });
  }

  async createTeam(auth: AuthContext, body: unknown): Promise<TeamRecord> {
    const input = assertObject(body);
    const organizationId = requiredUuid(input, "organizationId");
    await this.requireOrganization(organizationId);
    this.scopes.assertOrgAdmin(auth, organizationId);

    return this.league.upsertTeam({
      id: uuidv7(),
      organizationId,
      name: requiredString(input, "name"),
      slug: requiredString(input, "slug", MAX_SLUG),
      abbreviation: optionalString(input, "abbreviation", MAX_ABBREVIATION),
      createdAt: new Date().toISOString(),
    });
  }

  async createTeamSeason(auth: AuthContext, body: unknown): Promise<TeamSeasonRecord> {
    const input = assertObject(body);
    const teamId = requiredUuid(input, "teamId");
    const seasonId = requiredUuid(input, "seasonId");
    const competitionId = requiredUuid(input, "competitionId");

    const team = await this.requireTeam(teamId);
    const season = await this.requireSeason(seasonId);
    const competition = await this.requireCompetition(competitionId);

    if (competition.seasonId !== season.id) {
      throw new BadRequestException("competitionId must belong to the same season");
    }
    if (team.organizationId !== season.organizationId) {
      throw new BadRequestException("teamId must belong to the season's organization");
    }
    if (
      !hasOrgAdmin(auth, season.organizationId) &&
      !hasCompetitionAdmin(auth, competition.id)
    ) {
      throw new ForbiddenException("organization or competition admin role required");
    }

    return this.league.upsertTeamSeason({
      id: uuidv7(),
      teamId: team.id,
      seasonId: season.id,
      competitionId: competition.id,
      name: optionalString(input, "name") ?? team.name,
      abbreviation:
        optionalString(input, "abbreviation", MAX_ABBREVIATION) ?? team.abbreviation,
    });
  }

  async createPlayer(auth: AuthContext, body: unknown): Promise<PlayerRecord> {
    const input = assertObject(body);
    const organizationId = requiredUuid(input, "organizationId");
    await this.requireOrganization(organizationId);
    this.scopes.assertOrgAdmin(auth, organizationId);

    return this.league.upsertPlayer({
      id: uuidv7(),
      organizationId,
      firstName: requiredString(input, "firstName"),
      lastName: requiredString(input, "lastName"),
      createdAt: new Date().toISOString(),
    });
  }

  async createRosterEntry(auth: AuthContext, body: unknown): Promise<RosterEntryRecord> {
    const input = assertObject(body);
    const teamSeasonId = requiredUuid(input, "teamSeasonId");
    const playerId = requiredUuid(input, "playerId");

    const teamSeason = await this.requireTeamSeason(teamSeasonId);
    const player = await this.requirePlayer(playerId);
    const team = await this.requireTeam(teamSeason.teamId);
    const season = await this.requireSeason(teamSeason.seasonId);

    if (player.organizationId !== team.organizationId) {
      throw new BadRequestException("playerId must belong to the team's organization");
    }

    const competitionAdmin =
      teamSeason.competitionId !== null && hasCompetitionAdmin(auth, teamSeason.competitionId);
    const teamAdmin = hasTeamRole(auth, teamSeason.id, ["team_admin", "scorer"]);
    if (!hasOrgAdmin(auth, season.organizationId) && !competitionAdmin && !teamAdmin) {
      throw new ForbiddenException("team, competition or organization admin role required");
    }

    return this.league.upsertRosterEntry({
      id: uuidv7(),
      teamSeasonId: teamSeason.id,
      playerId: player.id,
      jersey: optionalString(input, "jersey", MAX_JERSEY),
      primaryPosition: optionalString(input, "primaryPosition", MAX_POSITION),
      eligibilityStart: optionalDate(input, "eligibilityStart"),
      eligibilityEnd: optionalDate(input, "eligibilityEnd"),
      status: optionalEnum<RosterStatus>(input, "status", ROSTER_STATUSES, "active"),
    });
  }

  async createGame(auth: AuthContext, body: unknown): Promise<LeagueGameRecord> {
    const input = assertObject(body);
    const seasonId = requiredUuid(input, "seasonId");
    const competitionId = requiredUuid(input, "competitionId");
    const homeTeamSeasonId = requiredUuid(input, "homeTeamSeasonId");
    const awayTeamSeasonId = requiredUuid(input, "awayTeamSeasonId");

    const season = await this.requireSeason(seasonId);
    const competition = await this.requireCompetition(competitionId);
    const home = await this.requireTeamSeason(homeTeamSeasonId);
    const away = await this.requireTeamSeason(awayTeamSeasonId);

    if (competition.seasonId !== season.id) {
      throw new BadRequestException("competitionId must belong to the same season");
    }

    for (const [key, teamSeason] of [
      ["homeTeamSeasonId", home],
      ["awayTeamSeasonId", away],
    ] as const) {
      if (teamSeason.seasonId !== season.id) {
        throw new BadRequestException(`${key} must belong to the same season`);
      }
      if (teamSeason.competitionId !== competition.id) {
        throw new BadRequestException(`${key} must belong to the same competition`);
      }
    }

    if (home.id === away.id) {
      throw new BadRequestException("homeTeamSeasonId and awayTeamSeasonId must differ");
    }

    if (
      !hasOrgAdmin(auth, season.organizationId) &&
      !hasCompetitionAdmin(auth, competition.id) &&
      !hasTeamRole(auth, home.id, ["team_admin", "scorer"]) &&
      !hasTeamRole(auth, away.id, ["team_admin", "scorer"])
    ) {
      throw new ForbiddenException("organization, competition or team admin role required");
    }

    return this.league.upsertGame({
      id: uuidv7(),
      seasonId: season.id,
      competitionId: competition.id,
      homeTeamSeasonId: home.id,
      awayTeamSeasonId: away.id,
      homeTeam: home.teamName,
      awayTeam: away.teamName,
      scheduledStart: optionalTimestamp(input, "scheduledStart"),
      venue: optionalString(input, "venue", MAX_VENUE),
      coverage: optionalEnum<GameCoverage>(input, "coverage", COVERAGES, "full"),
      dataSource: optionalEnum<GameDataSource>(input, "dataSource", DATA_SOURCES, "official"),
      rulesProfile: null,
      createdAt: new Date().toISOString(),
      lastSeq: -1,
    });
  }

  private async requireOrganization(id: string): Promise<OrganizationRecord> {
    const organizations = await this.league.listOrganizations();
    const organization = organizations.find((row) => row.id === id);
    if (!organization) throw new NotFoundException(`organization ${id} not found`);
    return organization;
  }

  private async requireSeason(id: string): Promise<SeasonRecord> {
    const season = await this.league.getSeason(id);
    if (!season) throw new NotFoundException(`season ${id} not found`);
    return season;
  }

  private async requireCompetition(id: string): Promise<CompetitionRecord> {
    const competition = await this.league.getCompetition(id);
    if (!competition) throw new NotFoundException(`competition ${id} not found`);
    return competition;
  }

  private async requireTeam(id: string): Promise<TeamRecord> {
    const team = await this.league.getTeam(id);
    if (!team) throw new NotFoundException(`team ${id} not found`);
    return team;
  }

  private async requireTeamSeason(id: string): Promise<TeamSeasonRecord> {
    const teamSeason = await this.league.getTeamSeason(id);
    if (!teamSeason) throw new NotFoundException(`team season ${id} not found`);
    return teamSeason;
  }

  private async requirePlayer(id: string): Promise<PlayerRecord> {
    const player = await this.league.getPlayer(id);
    if (!player) throw new NotFoundException(`player ${id} not found`);
    return player;
  }
}
