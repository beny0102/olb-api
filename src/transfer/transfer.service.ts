import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { hasOrgAdmin } from "../auth/scopes.js";
import type { AuthContext } from "../auth/auth.service.js";
import { isUuidV7 } from "../admin/catalog.dto.js";
import {
  LEAGUE_STORE,
  type LeagueGameRecord,
  type LeagueStore,
  type OrganizationRecord,
  type SeasonRecord,
  type TeamRecord,
  type TeamSeasonRecord,
} from "../store/league.store.js";
import { EVENT_STORE, type EventStore } from "../store/store.js";
import {
  LEAGUE_BUNDLE_FORMAT,
  parseLeagueBundle,
  type LeagueBundle,
  type LeagueBundleCompetition,
  type LeagueBundleGame,
  type LeagueBundleRosterEntry,
  type LeagueBundleSeason,
  type LeagueBundleTeam,
  type LeagueBundleTeamSeason,
} from "./bundle.js";
import {
  runLeagueImport,
  type LeagueImportConflict,
  type LeagueImportResult,
} from "./import.js";

export interface LeagueExportResult {
  fileName: string;
  bundle: LeagueBundle;
}

function requireId(id: string | null | undefined, entity: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new InternalServerErrorException(`${entity} is missing its id`);
  }
  return id;
}

@Injectable()
export class TransferService {
  constructor(
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(EVENT_STORE) private readonly events: EventStore,
  ) {}

  async exportLeague(auth: AuthContext, seasonId?: string): Promise<LeagueExportResult> {
    let organization: OrganizationRecord;
    let seasons: SeasonRecord[];

    if (seasonId !== undefined) {
      if (!isUuidV7(seasonId)) {
        throw new BadRequestException("seasonId must be a lowercase UUIDv7");
      }
      const season = await this.league.getSeason(seasonId);
      if (!season) throw new NotFoundException(`season ${seasonId} not found`);
      organization = await this.requireOrganization(season.organizationId);
      if (!hasOrgAdmin(auth, organization.id)) {
        throw new ForbiddenException("organization admin role required");
      }
      seasons = [season];
    } else {
      const organizations = await this.adminOrganizations(auth);
      if (organizations.length === 0) {
        throw new ForbiddenException("organization admin role required");
      }
      if (organizations.length > 1) {
        throw new BadRequestException(
          "seasonId is required when the user administers more than one organization",
        );
      }
      organization = organizations[0]!;
      seasons = await this.league.listSeasons(organization.id);
    }

    const bundleSeasons: LeagueBundleSeason[] = [];
    const teamSeasons: LeagueBundleTeamSeason[] = [];
    const games: LeagueBundleGame[] = [];
    const referencedTeams = new Set<string>();

    for (const season of seasons) {
      const competitions = await this.league.listCompetitions(season.id);
      const bundleCompetitions: LeagueBundleCompetition[] = competitions.map((competition) => ({
        id: requireId(competition.id, "competition"),
        name: competition.name,
        kind: competition.kind,
        parentId: competition.parentId,
        level: competition.level,
        sortOrder: competition.sortOrder,
      }));

      const seasonTeamSeasons = await this.league.listTeamSeasonsBySeason(season.id);
      for (const teamSeason of seasonTeamSeasons) {
        referencedTeams.add(teamSeason.teamId);
        teamSeasons.push(await this.exportTeamSeason(teamSeason));
      }

      bundleSeasons.push({
        id: requireId(season.id, "season"),
        year: season.year,
        name: season.name,
        status: season.status,
        startsOn: season.startsOn,
        endsOn: season.endsOn,
        competitions: bundleCompetitions,
      });

      for (const game of await this.league.listGames(season.id)) {
        if (await this.isScheduledGame(game)) {
          const exported = this.exportGame(game);
          if (exported) games.push(exported);
        }
      }
    }

    const allTeams =
      seasonId === undefined
        ? await this.league.listTeamsByOrganization(organization.id)
        : await Promise.all(
            [...referencedTeams].map((teamId) => this.requireTeam(teamId)),
          );
    const teams: LeagueBundleTeam[] = allTeams
      .filter((team) => seasonId === undefined || referencedTeams.has(team.id))
      .sort((left, right) => {
        if (left.name !== right.name) return left.name < right.name ? -1 : 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .map((team) => ({
        id: requireId(team.id, "team"),
        name: team.name,
        slug: team.slug,
        abbreviation: team.abbreviation,
      }));

    if (seasonId !== undefined && teams.length !== referencedTeams.size) {
      const known = new Set(teams.map((team) => team.id));
      const missing = [...referencedTeams].find((id) => !known.has(id));
      if (missing) {
        throw new InternalServerErrorException(`team ${missing} is missing from the catalog`);
      }
    }

    games.sort((left, right) => {
      const leftStart = left.scheduledStart ?? "";
      const rightStart = right.scheduledStart ?? "";
      if (leftStart !== rightStart) return leftStart < rightStart ? -1 : 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    return {
      fileName: `${organization.slug}-league.json`,
      bundle: {
        format: LEAGUE_BUNDLE_FORMAT,
        exportedAt: new Date().toISOString(),
        organization: { slug: organization.slug, name: organization.name },
        seasons: bundleSeasons,
        teams,
        teamSeasons,
        games,
      },
    };
  }

  async importLeague(
    auth: AuthContext,
    body: unknown,
    dryRun: boolean,
  ): Promise<LeagueImportResult> {
    const bundle = parseLeagueBundle(body);
    const organizations = await this.adminOrganizations(auth);
    if (organizations.length === 0) {
      throw new ForbiddenException("organization admin role required");
    }
    if (organizations.length > 1) {
      throw new BadRequestException(
        "import target is ambiguous; the user administers more than one organization",
      );
    }
    const organization = organizations[0]!;

    if (bundle.organization.slug !== organization.slug) {
      throw new ConflictException({
        statusCode: 409,
        code: "organization_mismatch",
        message: `bundle organization ${bundle.organization.slug} does not match ${organization.slug}`,
      });
    }

    const gamesWithEvents = new Set<string>();
    for (const game of bundle.games) {
      if (await this.hasEvents(game.id)) gamesWithEvents.add(game.id);
    }

    if (dryRun) {
      return runLeagueImport({
        store: this.league,
        bundle,
        organizationId: organization.id,
        dryRun: true,
        gamesWithEvents,
      });
    }

    const result = await this.league.transaction((store) =>
      runLeagueImport({
        store,
        bundle,
        organizationId: organization.id,
        dryRun: false,
        gamesWithEvents,
      }),
    );
    if (result.conflicts.length > 0) {
      throw this.conflictError(result.conflicts);
    }
    return result;
  }

  private conflictError(conflicts: LeagueImportConflict[]): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: "import_conflicts",
      message: "import conflicts",
      conflicts,
    });
  }

  private async adminOrganizations(auth: AuthContext): Promise<OrganizationRecord[]> {
    const organizations = await this.league.listOrganizations();
    return organizations.filter((organization) => hasOrgAdmin(auth, organization.id));
  }

  private async requireOrganization(id: string): Promise<OrganizationRecord> {
    const organizations = await this.league.listOrganizations();
    const organization = organizations.find((row) => row.id === id);
    if (!organization) {
      throw new InternalServerErrorException(`organization ${id} is missing from the catalog`);
    }
    return organization;
  }

  private async requireTeam(id: string): Promise<TeamRecord> {
    const team = await this.league.getTeam(id);
    if (!team) {
      throw new InternalServerErrorException(`team ${id} is missing from the catalog`);
    }
    return team;
  }

  private async exportTeamSeason(teamSeason: TeamSeasonRecord): Promise<LeagueBundleTeamSeason> {
    const roster = await this.league.listRoster(teamSeason.id);
    const entries: LeagueBundleRosterEntry[] = [];

    for (const entry of roster) {
      const player = await this.league.getPlayer(entry.playerId);
      if (!player) {
        throw new InternalServerErrorException(
          `roster entry ${entry.id} references missing player ${entry.playerId}`,
        );
      }
      entries.push({
        id: requireId(entry.id, "roster entry"),
        player: {
          id: requireId(player.id, "player"),
          firstName: player.firstName,
          lastName: player.lastName,
        },
        jersey: entry.jersey,
        primaryPosition: entry.primaryPosition,
        eligibilityStart: entry.eligibilityStart,
        eligibilityEnd: entry.eligibilityEnd,
        status: entry.status,
      });
    }

    return {
      id: requireId(teamSeason.id, "team season"),
      teamId: requireId(teamSeason.teamId, "team"),
      seasonId: requireId(teamSeason.seasonId, "season"),
      competitionId: teamSeason.competitionId,
      name: teamSeason.name,
      abbreviation: teamSeason.abbreviation,
      roster: entries,
    };
  }

  private async isScheduledGame(game: LeagueGameRecord): Promise<boolean> {
    if (game.lastSeq >= 0) return false;
    if (await this.hasEvents(game.id)) return false;
    if (await this.league.getGameSummary(game.id)) return false;
    return true;
  }

  private exportGame(game: LeagueGameRecord): LeagueBundleGame | null {
    if (
      game.seasonId === null ||
      game.homeTeamSeasonId === null ||
      game.awayTeamSeasonId === null
    ) {
      return null;
    }
    return {
      id: requireId(game.id, "game"),
      seasonId: game.seasonId,
      competitionId: game.competitionId,
      homeTeamSeasonId: game.homeTeamSeasonId,
      awayTeamSeasonId: game.awayTeamSeasonId,
      scheduledStart: game.scheduledStart,
      venue: game.venue,
      coverage: game.coverage,
      dataSource: game.dataSource,
      rulesProfile: game.rulesProfile ?? null,
    };
  }

  private async hasEvents(gameId: string): Promise<boolean> {
    const game = await this.events.getGame(gameId);
    if (game && game.lastSeq >= 0) return true;
    return (await this.events.listEvents(gameId, 0)).length > 0;
  }
}
