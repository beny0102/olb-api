import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { CurrentAuth, AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { AdminService } from "./admin.service.js";

function parseForce(value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new BadRequestException("force must be true or false");
}

@Controller("admin")
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get("organizations")
  listOrganizations(@CurrentAuth() auth: AuthContext) {
    return this.admin.listOrganizations(auth);
  }

  @Get("organizations/:id/teams")
  listOrganizationTeams(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
  ) {
    return this.admin.listOrganizationTeams(auth, id);
  }

  @Get("organizations/:id/players")
  listOrganizationPlayers(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
  ) {
    return this.admin.listOrganizationPlayers(auth, id);
  }

  @Patch("organizations/:id")
  updateOrganization(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateOrganization(auth, id, body);
  }

  @Post("seasons")
  createSeason(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createSeason(auth, body);
  }

  @Patch("seasons/:id")
  updateSeason(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateSeason(auth, id, body);
  }

  @Delete("seasons/:id")
  deleteSeason(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.deleteSeason(auth, id);
  }

  @Post("competitions")
  createCompetition(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createCompetition(auth, body);
  }

  @Patch("competitions/:id")
  updateCompetition(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateCompetition(auth, id, body);
  }

  @Delete("competitions/:id")
  deleteCompetition(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.deleteCompetition(auth, id);
  }

  @Post("teams")
  createTeam(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createTeam(auth, body);
  }

  @Patch("teams/:id")
  updateTeam(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateTeam(auth, id, body);
  }

  @Delete("teams/:id")
  deleteTeam(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.deleteTeam(auth, id);
  }

  @Post("team-seasons")
  createTeamSeason(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createTeamSeason(auth, body);
  }

  @Post("team-seasons/:id/roster-import")
  importRoster(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.importRoster(auth, id, body);
  }

  @Patch("team-seasons/:id")
  updateTeamSeason(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateTeamSeason(auth, id, body);
  }

  @Delete("team-seasons/:id")
  deleteTeamSeason(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.deleteTeamSeason(auth, id);
  }

  @Get("team-seasons/:id")
  getTeamSeason(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.getTeamSeason(auth, id);
  }

  @Post("players")
  createPlayer(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createPlayer(auth, body);
  }

  @Patch("players/:id")
  updatePlayer(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updatePlayer(auth, id, body);
  }

  @Get("players/:id/consent")
  getNameConsent(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.getNameConsent(auth, id);
  }

  @Post("players/:id/consent")
  grantNameConsent(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.grantNameConsent(auth, id, body);
  }

  @Delete("players/:id/consent")
  revokeNameConsent(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.revokeNameConsent(auth, id);
  }

  @Delete("players/:id")
  deletePlayer(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Query("force") force?: string,
  ) {
    return this.admin.deletePlayer(auth, id, parseForce(force));
  }

  @Post("roster-entries")
  createRosterEntry(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createRosterEntry(auth, body);
  }

  @Patch("roster-entries/:id")
  updateRosterEntry(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateRosterEntry(auth, id, body);
  }

  @Delete("roster-entries/:id")
  deleteRosterEntry(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.deleteRosterEntry(auth, id);
  }

  @Post("games")
  createGame(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createGame(auth, body);
  }

  @Patch("games/:id")
  updateGame(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.admin.updateGame(auth, id, body);
  }

  @Delete("games/:id")
  deleteGame(@CurrentAuth() auth: AuthContext, @Param("id") id: string) {
    return this.admin.deleteGame(auth, id);
  }
}
