import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { AuthContext } from "../auth/auth.service.js";
import {
  hasCompetitionAdmin,
  hasOrgAdmin,
  hasTeamRole,
  ScopesService,
} from "../auth/scopes.js";
import {
  LEAGUE_STORE,
  type CompetitionRecord,
  type LeagueGameRecord,
  type LeagueStore,
  type OrganizationRecord,
  type SeasonRecord,
  type TeamSeasonRecord,
} from "../store/league.store.js";

/**
 * Catalog scope checks shared by every admin route. The organization is the
 * root of the hierarchy; competition and team-season memberships inherit the
 * organization for read access but never grant organization-wide writes.
 */
@Injectable()
export class CatalogAccessService {
  constructor(
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(ScopesService) private readonly scopes: ScopesService,
  ) {}

  async organizationsFor(auth: AuthContext): Promise<OrganizationRecord[]> {
    const organizationIds = new Set<string>();

    for (const membership of auth.memberships) {
      if (membership.scopeType === "organization") {
        organizationIds.add(membership.scopeId);
        continue;
      }
      if (membership.scopeType === "competition") {
        const competition = await this.league.getCompetition(membership.scopeId);
        if (!competition) continue;
        const season = await this.league.getSeason(competition.seasonId);
        if (season) organizationIds.add(season.organizationId);
        continue;
      }
      const teamSeason = await this.league.getTeamSeason(membership.scopeId);
      if (!teamSeason) continue;
      const season = await this.league.getSeason(teamSeason.seasonId);
      if (season) organizationIds.add(season.organizationId);
    }

    const organizations = (await this.league.listOrganizations()).filter((organization) =>
      organizationIds.has(organization.id),
    );
    if (organizations.length === 0) {
      throw new ForbiddenException("organization membership required");
    }
    return organizations;
  }

  assertOrgAdmin(auth: AuthContext, organizationId: string): void {
    this.scopes.assertOrgAdmin(auth, organizationId);
  }

  isOrgAdmin(auth: AuthContext, organizationId: string): boolean {
    return hasOrgAdmin(auth, organizationId);
  }

  isCompetitionAdmin(auth: AuthContext, competitionId: string): boolean {
    return hasCompetitionAdmin(auth, competitionId);
  }

  assertCompetitionManager(
    auth: AuthContext,
    season: SeasonRecord,
    competition: CompetitionRecord,
  ): void {
    if (hasOrgAdmin(auth, season.organizationId)) return;
    if (hasCompetitionAdmin(auth, competition.id)) return;
    throw new ForbiddenException("organization or competition admin role required");
  }

  assertTeamSeasonManager(
    auth: AuthContext,
    season: SeasonRecord,
    teamSeason: TeamSeasonRecord,
  ): void {
    if (hasOrgAdmin(auth, season.organizationId)) return;
    if (
      teamSeason.competitionId !== null &&
      hasCompetitionAdmin(auth, teamSeason.competitionId)
    ) {
      return;
    }
    throw new ForbiddenException("organization or competition admin role required");
  }

  /**
   * Moving a team season to another competition needs authority over both the
   * current and the target competition, so a competition admin cannot export
   * a team out of their own scope.
   */
  assertTeamSeasonMove(
    auth: AuthContext,
    season: SeasonRecord,
    teamSeason: TeamSeasonRecord,
    target: CompetitionRecord,
  ): void {
    if (hasOrgAdmin(auth, season.organizationId)) return;
    if (
      teamSeason.competitionId !== null &&
      hasCompetitionAdmin(auth, teamSeason.competitionId) &&
      hasCompetitionAdmin(auth, target.id)
    ) {
      return;
    }
    throw new ForbiddenException(
      "organization admin or competition admin of both competitions required",
    );
  }

  assertRosterManager(
    auth: AuthContext,
    season: SeasonRecord,
    teamSeason: TeamSeasonRecord,
  ): void {
    if (hasOrgAdmin(auth, season.organizationId)) return;
    if (
      teamSeason.competitionId !== null &&
      hasCompetitionAdmin(auth, teamSeason.competitionId)
    ) {
      return;
    }
    if (hasTeamRole(auth, teamSeason.id, ["team_admin"])) return;
    throw new ForbiddenException("team, competition or organization admin role required");
  }

  assertGameManager(
    auth: AuthContext,
    season: SeasonRecord,
    game: LeagueGameRecord,
  ): void {
    if (hasOrgAdmin(auth, season.organizationId)) return;
    if (game.competitionId !== null && hasCompetitionAdmin(auth, game.competitionId)) {
      return;
    }
    throw new ForbiddenException("organization or competition admin role required");
  }

  /** Team admins may only reschedule their own games' start and venue. */
  assertGameReschedule(
    auth: AuthContext,
    season: SeasonRecord,
    game: LeagueGameRecord,
  ): void {
    if (hasOrgAdmin(auth, season.organizationId)) return;
    if (game.competitionId !== null && hasCompetitionAdmin(auth, game.competitionId)) {
      return;
    }
    if (
      game.homeTeamSeasonId !== null &&
      hasTeamRole(auth, game.homeTeamSeasonId, ["team_admin"])
    ) {
      return;
    }
    if (
      game.awayTeamSeasonId !== null &&
      hasTeamRole(auth, game.awayTeamSeasonId, ["team_admin"])
    ) {
      return;
    }
    throw new ForbiddenException("organization, competition or team admin role required");
  }
}
