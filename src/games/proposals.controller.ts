import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { ProposalsService } from "./proposals.service.js";

@Controller("games")
export class ProposalsController {
  constructor(@Inject(ProposalsService) private readonly proposals: ProposalsService) {}

  @Post(":id/proposals")
  create(@Param("id") gameId: string, @Body() body: unknown) {
    return this.proposals.createProposal(gameId, body);
  }

  @Get(":id/proposals")
  list(@Param("id") gameId: string, @Query("status") status?: string) {
    return this.proposals.listProposals(gameId, status);
  }

  @Post(":id/proposals/:pid/resolve")
  resolve(@Param("id") gameId: string, @Param("pid") pid: string, @Body() body: unknown) {
    return this.proposals.resolveProposal(gameId, pid, body);
  }
}
