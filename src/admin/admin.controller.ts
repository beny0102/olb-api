import { Body, Controller, Inject, Post, UseGuards } from "@nestjs/common";
import { CurrentAuth, AuthGuard } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { AdminService } from "./admin.service.js";

@Controller("admin")
@UseGuards(AuthGuard)
export class AdminController {
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Post("seasons")
  createSeason(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createSeason(auth, body);
  }

  @Post("competitions")
  createCompetition(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createCompetition(auth, body);
  }

  @Post("teams")
  createTeam(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createTeam(auth, body);
  }

  @Post("team-seasons")
  createTeamSeason(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createTeamSeason(auth, body);
  }

  @Post("players")
  createPlayer(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createPlayer(auth, body);
  }

  @Post("roster-entries")
  createRosterEntry(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createRosterEntry(auth, body);
  }

  @Post("games")
  createGame(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    return this.admin.createGame(auth, body);
  }
}
