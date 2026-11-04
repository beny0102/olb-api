import { Body, Controller, Get, Inject, Param, Post, Query } from "@nestjs/common";
import { GamesService } from "./games.service.js";

function parseFromSeq(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

@Controller("games")
export class GamesController {
  constructor(@Inject(GamesService) private readonly games: GamesService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.games.createGame(body);
  }

  @Get()
  list() {
    return this.games.listGames();
  }

  @Post(":id/start")
  start(@Param("id") id: string, @Body() body: unknown) {
    return this.games.startGame(id, body);
  }

  @Post(":id/finish")
  finish(@Param("id") id: string, @Body() body: unknown) {
    return this.games.finishGame(id, body);
  }

  @Get(":id/boxscore")
  boxscore(@Param("id") id: string) {
    return this.games.getBoxScore(id);
  }

  @Get(":id/state")
  state(@Param("id") id: string) {
    return this.games.getState(id);
  }

  @Get(":id/events")
  events(@Param("id") id: string, @Query("fromSeq") fromSeq?: string) {
    return this.games.listEvents(id, parseFromSeq(fromSeq));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.games.getGame(id);
  }

  @Post(":id/events")
  append(@Param("id") id: string, @Body() body: unknown) {
    return this.games.appendEvent(id, body);
  }
}
