import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ScopeType } from "../auth/auth.store.js";
import { LEAGUE_STORE, type LeagueStore } from "../store/league.store.js";

/**
 * A membership may only point at a scope inside the caller's organization:
 * organization → itself, competition → its season's organization,
 * team season → its season's organization.
 *
 * Anything outside the organization answers `404` so the endpoint does not
 * reveal whether the id exists in another deployment/org.
 */
@Injectable()
export class MembershipScopeService {
  constructor(@Inject(LEAGUE_STORE) private readonly league: LeagueStore) {}

  async assertInOrganization(
    organizationId: string,
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<void> {
    switch (scopeType) {
      case "organization": {
        if (scopeId !== organizationId) throw this.notFound(scopeType, scopeId);
        return;
      }
      case "competition": {
        const competition = await this.league.getCompetition(scopeId);
        if (!competition) throw this.notFound(scopeType, scopeId);
        const season = await this.league.getSeason(competition.seasonId);
        if (!season || season.organizationId !== organizationId) {
          throw this.notFound(scopeType, scopeId);
        }
        return;
      }
      case "team_season": {
        const teamSeason = await this.league.getTeamSeason(scopeId);
        if (!teamSeason) throw this.notFound(scopeType, scopeId);
        const season = await this.league.getSeason(teamSeason.seasonId);
        if (!season || season.organizationId !== organizationId) {
          throw this.notFound(scopeType, scopeId);
        }
        return;
      }
    }
  }

  private notFound(scopeType: string, scopeId: string): NotFoundException {
    return new NotFoundException(`${scopeType} scope ${scopeId} not found`);
  }
}
