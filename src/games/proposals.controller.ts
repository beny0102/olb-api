import { Body, Controller, Get, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AuthGuard, CurrentAuth } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { GameAccessService } from "./game-access.service.js";
import { ProposalsService } from "./proposals.service.js";

@Controller("games")
export class ProposalsController {
  constructor(
    @Inject(ProposalsService) private readonly proposals: ProposalsService,
    @Inject(GameAccessService) private readonly access: GameAccessService,
  ) {}

  @Post(":id/proposals")
  @UseGuards(AuthGuard)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Param("id") gameId: string,
    @Body() body: unknown,
  ) {
    await this.access.assertCanPropose(auth, gameId);
    return this.proposals.createProposal(gameId, body);
  }

  @Get(":id/proposals")
  list(@Param("id") gameId: string, @Query("status") status?: string) {
    return this.proposals.listProposals(gameId, status);
  }

  @Post(":id/proposals/:pid/resolve")
  @UseGuards(AuthGuard)
  async resolve(
    @CurrentAuth() auth: AuthContext,
    @Param("id") gameId: string,
    @Param("pid") pid: string,
    @Body() body: unknown,
  ) {
    await this.access.assertCanResolve(auth, gameId);
    return this.proposals.resolveProposal(gameId, pid, body);
  }
}
