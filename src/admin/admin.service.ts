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
  type RosterImportRowInput,
  type RosterStatus,
  type SeasonRecord,
  type SeasonStatus,
  type TeamRecord,
  type TeamSeasonRecord,
} from "../store/league.store.js";
import { EVENT_STORE, type EventStore } from "../store/store.js";
import { CatalogAccessService } from "./catalog-access.service.js";
import {
  assertArray,
  assertKnownFields,
  assertObject,
  COMPETITION_KINDS,
  COVERAGES,
  DATA_SOURCES,
  hasField,
  isUuidV7,
  MAX_ABBREVIATION,
  MAX_JERSEY,
  MAX_POSITION,
  MAX_SLUG,
  MAX_VENUE,
  optionalBoolean,
  optionalDate,
  optionalEnum,
  optionalInteger,
  optionalString,
  optionalTimestamp,
  optionalUuid,
  patchEnum,
  patchInteger,
  patchNullableDate,
  patchNullableString,
  patchNullableTimestamp,
  patchNullableUuid,
  patchString,
  requiredEnum,
  requiredInteger,
  requiredString,
  requiredUuid,
  ROSTER_STATUSES,
  SEASON_STATUSES,
} from "./catalog.dto.js";

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
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
    @Inject(CatalogAccessService) private readonly access: CatalogAccessService,
    @Inject(EVENT_STORE) private readonly events: EventStore,
  ) {}

  listOrganizations(auth: AuthContext): Promise<OrganizationRecord[]> {
    return this.access.organizationsFor(auth);
  }

  async updateOrganization(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<OrganizationRecord> {
    const organization = await this.requireOrganization(id);
    this.scopes.assertOrgAdmin(auth, organization.id);

    const input = assertObject(body);
    assertKnownFields(input, ["name", "slug"]);

    const name = valueOr(patchString(input, "name"), organization.name);
    const slug = valueOr(patchString(input, "slug", MAX_SLUG), organization.slug);

    if (slug !== organization.slug) {
      const organizations = await this.league.listOrganizations();
      if (organizations.some((row) => row.id !== organization.id && row.slug === slug)) {
        throw new ConflictException(`organization slug ${slug} already exists`);
      }
    }

    const updated = await this.league.updateOrganization({
      ...organization,
      name,
      slug,
    });
    if (!updated) throw new NotFoundException(`organization ${id} not found`);
    return updated;
  }

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

  async updateSeason(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<SeasonRecord> {
    const season = await this.requireSeason(id);
    this.scopes.assertOrgAdmin(auth, season.organizationId);

    const input = assertObject(body);
    assertKnownFields(input, ["name", "year", "status", "startsOn", "endsOn"]);

    const name = valueOr(patchString(input, "name"), season.name);
    const year = valueOr(patchInteger(input, "year", 1900, 9999), season.year);
    const status = valueOr(
      patchEnum<SeasonStatus>(input, "status", SEASON_STATUSES),
      season.status,
    );
    const startsOn = valueOr(patchNullableDate(input, "startsOn"), season.startsOn);
    const endsOn = valueOr(patchNullableDate(input, "endsOn"), season.endsOn);

    if (year !== season.year) {
      const siblings = await this.league.listSeasons(season.organizationId);
      if (siblings.some((row) => row.id !== season.id && row.year === year)) {
        throw new ConflictException(
          `season ${year} already exists for this organization`,
        );
      }
    }

    const updated = await this.league.updateSeason({
      ...season,
      name,
      year,
      status,
      startsOn,
      endsOn,
    });
    if (!updated) throw new NotFoundException(`season ${id} not found`);

    if (updated.status === "active") {
      await this.league.archiveActiveSeasons(season.organizationId, updated.id);
    }
    return updated;
  }

  async deleteSeason(auth: AuthContext, id: string): Promise<{ deleted: true }> {
    const season = await this.requireSeason(id);
    this.scopes.assertOrgAdmin(auth, season.organizationId);

    const competitions = await this.league.listCompetitions(season.id);
    const teamSeasons = await this.league.listTeamSeasonsBySeason(season.id);
    const games = await this.league.listGames(season.id);
    if (competitions.length > 0 || teamSeasons.length > 0 || games.length > 0) {
      throw new ConflictException("season still has competitions, team seasons or games");
    }

    if (!(await this.league.deleteSeason(season.id))) {
      throw new NotFoundException(`season ${id} not found`);
    }
    return { deleted: true };
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

  async updateCompetition(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<CompetitionRecord> {
    const competition = await this.requireCompetition(id);
    const season = await this.requireSeason(competition.seasonId);
    this.access.assertCompetitionManager(auth, season, competition);

    const input = assertObject(body);
    assertKnownFields(input, ["name", "kind", "parentId", "sortOrder"]);

    const name = valueOr(patchString(input, "name"), competition.name);
    const kind = valueOr(
      patchEnum<CompetitionKind>(input, "kind", COMPETITION_KINDS),
      competition.kind,
    );
    const parentId = valueOr(
      patchNullableUuid(input, "parentId"),
      competition.parentId,
    );
    const sortOrder = valueOr(
      patchInteger(input, "sortOrder", -10000, 10000),
      competition.sortOrder,
    );

    if (parentId !== null) {
      if (parentId === competition.id) {
        throw new BadRequestException("parentId cannot reference the competition itself");
      }
      const parent = await this.requireCompetition(parentId);
      if (parent.seasonId !== competition.seasonId) {
        throw new BadRequestException("parentId must belong to the same season");
      }
      await this.assertNoParentCycle(parentId, competition.id);
    }

    const updated = await this.league.updateCompetition({
      ...competition,
      parentId,
      name,
      kind,
      sortOrder,
    });
    if (!updated) throw new NotFoundException(`competition ${id} not found`);
    return updated;
  }

  async deleteCompetition(
    auth: AuthContext,
    id: string,
  ): Promise<{ deleted: true }> {
    const competition = await this.requireCompetition(id);
    const season = await this.requireSeason(competition.seasonId);
    this.scopes.assertOrgAdmin(auth, season.organizationId);

    const teamSeasons = await this.league.listTeams(competition.id);
    const games = await this.league.listGames(season.id, competition.id);
    if (teamSeasons.length > 0 || games.length > 0) {
      throw new ConflictException("competition still has team seasons or games");
    }

    if (!(await this.league.deleteCompetition(competition.id))) {
      throw new NotFoundException(`competition ${id} not found`);
    }
    return { deleted: true };
  }

  async createTeam(auth: AuthContext, body: unknown): Promise<TeamRecord> {
    const input = assertObject(body);
    const organizationId = requiredUuid(input, "organizationId");
    await this.requireOrganization(organizationId);
    this.scopes.assertOrgAdmin(auth, organizationId);

    const slug = requiredString(input, "slug", MAX_SLUG);
    if (await this.league.getTeamBySlug(slug)) {
      throw new ConflictException(`team slug ${slug} already exists`);
    }

    return this.league.upsertTeam({
      id: uuidv7(),
      organizationId,
      name: requiredString(input, "name"),
      slug,
      abbreviation: optionalString(input, "abbreviation", MAX_ABBREVIATION),
      createdAt: new Date().toISOString(),
    });
  }

  async updateTeam(auth: AuthContext, id: string, body: unknown): Promise<TeamRecord> {
    const team = await this.requireTeam(id);
    this.scopes.assertOrgAdmin(auth, team.organizationId);

    const input = assertObject(body);
    assertKnownFields(input, ["name", "slug", "abbreviation"]);

    const name = valueOr(patchString(input, "name"), team.name);
    const slug = valueOr(patchString(input, "slug", MAX_SLUG), team.slug);
    const abbreviation = valueOr(
      patchNullableString(input, "abbreviation", MAX_ABBREVIATION),
      team.abbreviation,
    );

    if (slug !== team.slug) {
      const existing = await this.league.getTeamBySlug(slug);
      if (existing && existing.id !== team.id) {
        throw new ConflictException(`team slug ${slug} already exists`);
      }
    }

    const updated = await this.league.updateTeam({
      ...team,
      name,
      slug,
      abbreviation,
    });
    if (!updated) throw new NotFoundException(`team ${id} not found`);
    return updated;
  }

  async deleteTeam(auth: AuthContext, id: string): Promise<{ deleted: true }> {
    const team = await this.requireTeam(id);
    this.scopes.assertOrgAdmin(auth, team.organizationId);

    const teamSeasons = await this.league.listTeamSeasonsByTeam(team.id);
    if (teamSeasons.length > 0) {
      throw new ConflictException("team still has team seasons");
    }

    if (!(await this.league.deleteTeam(team.id))) {
      throw new NotFoundException(`team ${id} not found`);
    }
    return { deleted: true };
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

  async updateTeamSeason(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<TeamSeasonRecord> {
    const teamSeason = await this.requireTeamSeason(id);
    const season = await this.requireSeason(teamSeason.seasonId);
    this.access.assertTeamSeasonManager(auth, season, teamSeason);

    const input = assertObject(body);
    assertKnownFields(input, ["name", "abbreviation", "competitionId"]);

    const name = valueOr(patchString(input, "name"), teamSeason.name);
    const abbreviation = valueOr(
      patchNullableString(input, "abbreviation", MAX_ABBREVIATION),
      teamSeason.abbreviation,
    );
    const competitionId = valueOr(
      patchNullableUuid(input, "competitionId"),
      teamSeason.competitionId,
    );

    if (competitionId !== teamSeason.competitionId) {
      if (competitionId !== null) {
        const target = await this.requireCompetition(competitionId);
        if (target.seasonId !== teamSeason.seasonId) {
          throw new BadRequestException("competitionId must belong to the same season");
        }
        this.access.assertTeamSeasonMove(auth, season, teamSeason, target);
      } else {
        this.scopes.assertOrgAdmin(auth, season.organizationId);
      }
    }

    if (name !== teamSeason.name) {
      const siblings = await this.league.listTeamSeasonsBySeason(teamSeason.seasonId);
      if (siblings.some((row) => row.id !== teamSeason.id && row.name === name)) {
        throw new ConflictException(
          `team season name ${name} already exists in this season`,
        );
      }
    }

    const updated = await this.league.updateTeamSeason({
      ...teamSeason,
      competitionId,
      name,
      abbreviation,
    });
    if (!updated) throw new NotFoundException(`team season ${id} not found`);
    return updated;
  }

  async deleteTeamSeason(
    auth: AuthContext,
    id: string,
  ): Promise<{ deleted: true }> {
    const teamSeason = await this.requireTeamSeason(id);
    const season = await this.requireSeason(teamSeason.seasonId);
    this.scopes.assertOrgAdmin(auth, season.organizationId);

    const games = await this.league.listGamesByTeamSeason(teamSeason.id);
    if (games.length > 0) {
      throw new ConflictException("team season still has games");
    }

    if (!(await this.league.deleteTeamSeason(teamSeason.id))) {
      throw new NotFoundException(`team season ${id} not found`);
    }
    return { deleted: true };
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

  async updatePlayer(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<PlayerRecord> {
    const player = await this.requirePlayer(id);
    this.scopes.assertOrgAdmin(auth, player.organizationId);

    const input = assertObject(body);
    assertKnownFields(input, ["firstName", "lastName"]);

    const updated = await this.league.updatePlayer({
      ...player,
      firstName: valueOr(patchString(input, "firstName"), player.firstName),
      lastName: valueOr(patchString(input, "lastName"), player.lastName),
    });
    if (!updated) throw new NotFoundException(`player ${id} not found`);
    return updated;
  }

  async deletePlayer(
    auth: AuthContext,
    id: string,
    force: boolean,
  ): Promise<{ deleted: true; rosterEntriesDeleted: number }> {
    const player = await this.requirePlayer(id);
    this.scopes.assertOrgAdmin(auth, player.organizationId);

    const rosterEntries = await this.league.listRosterByPlayer(player.id);
    if (rosterEntries.length > 0 && !force) {
      throw new ConflictException("player still has roster entries; use force=true");
    }

    const rosterEntriesDeleted = force
      ? await this.league.deleteRosterEntriesByPlayer(player.id)
      : 0;
    if (!(await this.league.deletePlayer(player.id))) {
      throw new NotFoundException(`player ${id} not found`);
    }
    return { deleted: true, rosterEntriesDeleted };
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

    this.access.assertRosterManager(auth, season, teamSeason);

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

  async updateRosterEntry(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<RosterEntryRecord> {
    const entry = await this.requireRosterEntry(id);
    const teamSeason = await this.requireTeamSeason(entry.teamSeasonId);
    const season = await this.requireSeason(teamSeason.seasonId);
    this.access.assertRosterManager(auth, season, teamSeason);

    const input = assertObject(body);
    assertKnownFields(input, [
      "jersey",
      "primaryPosition",
      "eligibilityStart",
      "eligibilityEnd",
      "status",
    ]);

    const updated = await this.league.updateRosterEntry({
      ...entry,
      jersey: valueOr(patchNullableString(input, "jersey", MAX_JERSEY), entry.jersey),
      primaryPosition: valueOr(
        patchNullableString(input, "primaryPosition", MAX_POSITION),
        entry.primaryPosition,
      ),
      eligibilityStart: valueOr(
        patchNullableDate(input, "eligibilityStart"),
        entry.eligibilityStart,
      ),
      eligibilityEnd: valueOr(
        patchNullableDate(input, "eligibilityEnd"),
        entry.eligibilityEnd,
      ),
      status: valueOr(
        patchEnum<RosterStatus>(input, "status", ROSTER_STATUSES),
        entry.status,
      ),
    });
    if (!updated) throw new NotFoundException(`roster entry ${id} not found`);
    return updated;
  }

  async deleteRosterEntry(
    auth: AuthContext,
    id: string,
  ): Promise<{ deleted: true }> {
    const entry = await this.requireRosterEntry(id);
    const teamSeason = await this.requireTeamSeason(entry.teamSeasonId);
    const season = await this.requireSeason(teamSeason.seasonId);
    this.access.assertRosterManager(auth, season, teamSeason);

    if (!(await this.league.deleteRosterEntry(entry.id))) {
      throw new NotFoundException(`roster entry ${id} not found`);
    }
    return { deleted: true };
  }

  async importRoster(
    auth: AuthContext,
    teamSeasonId: string,
    body: unknown,
  ) {
    const teamSeason = await this.requireTeamSeason(teamSeasonId);
    const season = await this.requireSeason(teamSeason.seasonId);
    this.access.assertRosterManager(auth, season, teamSeason);

    const input = assertObject(body);
    assertKnownFields(input, ["rows", "dryRun"]);
    const rawRows = assertArray(input, "rows");
    const dryRun = optionalBoolean(input, "dryRun", false);

    const rows: RosterImportRowInput[] = [];
    const seen = new Set<string>();
    for (const raw of rawRows) {
      const row = assertObject(raw);
      assertKnownFields(row, [
        "firstName",
        "lastName",
        "jersey",
        "primaryPosition",
        "eligibilityStart",
        "eligibilityEnd",
        "status",
      ]);
      const firstName = requiredString(row, "firstName");
      const lastName = requiredString(row, "lastName");
      const key = `${firstName.toLowerCase()}\u0000${lastName.toLowerCase()}`;
      if (seen.has(key)) {
        throw new BadRequestException(
          `duplicate roster row for ${firstName} ${lastName}`,
        );
      }
      seen.add(key);
      rows.push({
        firstName,
        lastName,
        jersey: optionalString(row, "jersey", MAX_JERSEY),
        primaryPosition: optionalString(row, "primaryPosition", MAX_POSITION),
        eligibilityStart: optionalDate(row, "eligibilityStart"),
        eligibilityEnd: optionalDate(row, "eligibilityEnd"),
        status: optionalEnum<RosterStatus>(row, "status", ROSTER_STATUSES, "active"),
      });
    }

    return this.league.importRoster({
      teamSeasonId: teamSeason.id,
      organizationId: season.organizationId,
      dryRun,
      rows,
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
      !hasCompetitionAdmin(auth, competition.id)
    ) {
      throw new ForbiddenException("organization or competition admin role required");
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

  async updateGame(
    auth: AuthContext,
    id: string,
    body: unknown,
  ): Promise<LeagueGameRecord> {
    const game = await this.requireGame(id);
    if (game.seasonId === null) {
      throw new ForbiddenException("game has no league scope");
    }
    const season = await this.requireSeason(game.seasonId);

    const input = assertObject(body);
    assertKnownFields(input, [
      "scheduledStart",
      "venue",
      "coverage",
      "dataSource",
      "rulesProfile",
      "seasonId",
      "competitionId",
      "homeTeamSeasonId",
      "awayTeamSeasonId",
    ]);

    const privileged =
      this.access.isOrgAdmin(auth, season.organizationId) ||
      (game.competitionId !== null &&
        this.access.isCompetitionAdmin(auth, game.competitionId));
    if (!privileged) {
      this.access.assertGameReschedule(auth, season, game);
      const allowed = new Set(["scheduledStart", "venue"]);
      if (Object.keys(input).some((key) => !allowed.has(key))) {
        throw new ForbiddenException(
          "team admins may only change scheduledStart and venue",
        );
      }
    }

    const scheduledStart = patchNullableTimestamp(input, "scheduledStart");
    const venue = patchNullableString(input, "venue", MAX_VENUE);
    const coverage = patchEnum<GameCoverage>(input, "coverage", COVERAGES);
    const dataSource = patchEnum<GameDataSource>(
      input,
      "dataSource",
      DATA_SOURCES,
    );
    const seasonId = valueOr(patchNullableUuid(input, "seasonId"), game.seasonId);
    const competitionId = valueOr(
      patchNullableUuid(input, "competitionId"),
      game.competitionId,
    );
    const homeTeamSeasonId = valueOr(
      patchNullableUuid(input, "homeTeamSeasonId"),
      game.homeTeamSeasonId,
    );
    const awayTeamSeasonId = valueOr(
      patchNullableUuid(input, "awayTeamSeasonId"),
      game.awayTeamSeasonId,
    );

    const identityChanged =
      seasonId !== game.seasonId ||
      competitionId !== game.competitionId ||
      homeTeamSeasonId !== game.homeTeamSeasonId ||
      awayTeamSeasonId !== game.awayTeamSeasonId;

    let homeTeam = game.homeTeam;
    let awayTeam = game.awayTeam;

    if (identityChanged) {
      if (await this.hasGameEvents(game.id)) {
        throw new ConflictException("game has events; teams, season and competition are frozen");
      }
      if (
        seasonId === null ||
        competitionId === null ||
        homeTeamSeasonId === null ||
        awayTeamSeasonId === null
      ) {
        throw new BadRequestException(
          "seasonId, competitionId, homeTeamSeasonId and awayTeamSeasonId are required",
        );
      }

      const targetSeason = await this.requireSeason(seasonId);
      const competition = await this.requireCompetition(competitionId);
      const home = await this.requireTeamSeason(homeTeamSeasonId);
      const away = await this.requireTeamSeason(awayTeamSeasonId);

      if (targetSeason.organizationId !== season.organizationId) {
        throw new BadRequestException("seasonId must belong to the game's organization");
      }
      if (competition.seasonId !== targetSeason.id) {
        throw new BadRequestException("competitionId must belong to the same season");
      }
      for (const [key, teamSeason] of [
        ["homeTeamSeasonId", home],
        ["awayTeamSeasonId", away],
      ] as const) {
        if (teamSeason.seasonId !== targetSeason.id) {
          throw new BadRequestException(`${key} must belong to the same season`);
        }
        if (teamSeason.competitionId !== competition.id) {
          throw new BadRequestException(`${key} must belong to the same competition`);
        }
      }
      if (home.id === away.id) {
        throw new BadRequestException(
          "homeTeamSeasonId and awayTeamSeasonId must differ",
        );
      }

      homeTeam = home.teamName;
      awayTeam = away.teamName;
    }

    const updated = await this.league.updateGame({
      id: game.id,
      seasonId,
      competitionId,
      homeTeamSeasonId,
      awayTeamSeasonId,
      homeTeam,
      awayTeam,
      scheduledStart: valueOr(scheduledStart, game.scheduledStart),
      venue: valueOr(venue, game.venue),
      coverage: valueOr(coverage, game.coverage),
      dataSource: valueOr(dataSource, game.dataSource),
      rulesProfile: hasField(input, "rulesProfile")
        ? input.rulesProfile
        : game.rulesProfile,
      createdAt: game.createdAt,
      lastSeq: game.lastSeq,
    });
    if (!updated) throw new NotFoundException(`game ${id} not found`);
    return updated;
  }

  async deleteGame(auth: AuthContext, id: string): Promise<{ deleted: true }> {
    const game = await this.requireGame(id);
    if (game.seasonId === null) {
      throw new ForbiddenException("game has no league scope");
    }
    const season = await this.requireSeason(game.seasonId);
    this.access.assertGameManager(auth, season, game);

    if (await this.hasGameEvents(game.id)) {
      throw new ConflictException("game has events and cannot be deleted");
    }

    const summary = await this.league.getGameSummary(game.id);
    if (summary && summary.homeScore !== null && summary.awayScore !== null) {
      throw new ConflictException("only a scheduled game can be deleted");
    }

    const eventDeleted = await this.events.deleteGame(game.id);
    const catalogDeleted = await this.league.deleteGame(game.id);
    if (!eventDeleted && !catalogDeleted) {
      throw new NotFoundException(`game ${id} not found`);
    }
    return { deleted: true };
  }

  private async hasGameEvents(gameId: string): Promise<boolean> {
    const game = await this.events.getGame(gameId);
    if (game && game.lastSeq >= 0) return true;
    return (await this.events.listEvents(gameId, 0)).length > 0;
  }

  private async assertNoParentCycle(parentId: string, competitionId: string): Promise<void> {
    const seen = new Set<string>();
    let current: string | null = parentId;
    while (current !== null) {
      if (current === competitionId) {
        throw new BadRequestException("parentId would create a competition cycle");
      }
      if (seen.has(current)) {
        throw new BadRequestException("competition parent chain contains a cycle");
      }
      seen.add(current);
      const competition = await this.league.getCompetition(current);
      current = competition?.parentId ?? null;
    }
  }

  private async requireOrganization(id: string): Promise<OrganizationRecord> {
    if (!isUuidV7(id)) {
      throw new NotFoundException(`organization ${id} not found`);
    }
    const organizations = await this.league.listOrganizations();
    const organization = organizations.find((row) => row.id === id);
    if (!organization) throw new NotFoundException(`organization ${id} not found`);
    return organization;
  }

  private async requireSeason(id: string): Promise<SeasonRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`season ${id} not found`);
    const season = await this.league.getSeason(id);
    if (!season) throw new NotFoundException(`season ${id} not found`);
    return season;
  }

  private async requireCompetition(id: string): Promise<CompetitionRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`competition ${id} not found`);
    const competition = await this.league.getCompetition(id);
    if (!competition) throw new NotFoundException(`competition ${id} not found`);
    return competition;
  }

  private async requireTeam(id: string): Promise<TeamRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`team ${id} not found`);
    const team = await this.league.getTeam(id);
    if (!team) throw new NotFoundException(`team ${id} not found`);
    return team;
  }

  private async requireTeamSeason(id: string): Promise<TeamSeasonRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`team season ${id} not found`);
    const teamSeason = await this.league.getTeamSeason(id);
    if (!teamSeason) throw new NotFoundException(`team season ${id} not found`);
    return teamSeason;
  }

  private async requirePlayer(id: string): Promise<PlayerRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`player ${id} not found`);
    const player = await this.league.getPlayer(id);
    if (!player) throw new NotFoundException(`player ${id} not found`);
    return player;
  }

  private async requireRosterEntry(id: string): Promise<RosterEntryRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`roster entry ${id} not found`);
    const entry = await this.league.getRosterEntry(id);
    if (!entry) throw new NotFoundException(`roster entry ${id} not found`);
    return entry;
  }

  private async requireGame(id: string): Promise<LeagueGameRecord> {
    if (!isUuidV7(id)) throw new NotFoundException(`game ${id} not found`);
    const game = await this.league.getGame(id);
    if (!game) throw new NotFoundException(`game ${id} not found`);
    return game;
  }
}
