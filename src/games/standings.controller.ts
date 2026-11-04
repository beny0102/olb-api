import { Controller, Get, Inject } from "@nestjs/common";
import { GamesService } from "./games.service.js";

@Controller()
export class StandingsController {
  constructor(@Inject(GamesService) private readonly games: GamesService) {}

  @Get("standings")
  standings() {
    return this.games.getStandings();
  }
}
