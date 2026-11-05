import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { LeagueService } from "./league.service.js";

function optional(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

@Controller()
export class LeagueController {
  constructor(@Inject(LeagueService) private readonly league: LeagueService) {}

  @Get("organizations")
  organizations() {
    return this.league.listOrganizations();
  }

  @Get("seasons")
  seasons(@Query("organizationId") organizationId?: string) {
    return this.league.listSeasons(optional(organizationId));
  }

  @Get("seasons/:id")
  season(@Param("id") id: string) {
    return this.league.getSeason(id);
  }

  @Get("seasons/:id/competitions")
  competitions(@Param("id") id: string) {
    return this.league.listCompetitions(id);
  }

  @Get("competitions/:id/teams")
  teams(@Param("id") id: string) {
    return this.league.listTeams(id);
  }

  @Get("team-seasons/:id")
  teamSeason(@Param("id") id: string) {
    return this.league.getTeamSeason(id);
  }

  @Get("seasons/:id/games")
  games(@Param("id") id: string, @Query("competitionId") competitionId?: string) {
    return this.league.listGames(id, optional(competitionId));
  }

  @Get("seasons/:id/standings")
  standings(@Param("id") id: string, @Query("competitionId") competitionId?: string) {
    return this.league.getStandings(id, optional(competitionId));
  }
}
