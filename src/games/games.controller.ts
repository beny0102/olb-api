import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
  type MessageEvent,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { AuthGuard, CurrentAuth } from "../auth/auth.guard.js";
import type { AuthContext } from "../auth/auth.service.js";
import { GameAccessService } from "./game-access.service.js";
import { GamesService } from "./games.service.js";

function parseFromSeq(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return 0;
  return parsed;
}

@Controller("games")
export class GamesController {
  constructor(
    @Inject(GamesService) private readonly games: GamesService,
    @Inject(GameAccessService) private readonly access: GameAccessService,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  async create(@CurrentAuth() auth: AuthContext, @Body() body: unknown) {
    this.access.assertCanCreate(auth);
    return this.games.createGame(body);
  }

  @Get()
  list() {
    return this.games.listGames();
  }

  @Post(":id/start")
  @UseGuards(AuthGuard)
  async start(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.access.assertCanScore(auth, id);
    return this.games.startGame(id, body);
  }

  @Post(":id/finish")
  @UseGuards(AuthGuard)
  async finish(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.access.assertCanScore(auth, id);
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

  @Sse(":id/stream")
  async stream(@Param("id") id: string): Promise<Observable<MessageEvent>> {
    const messages = await this.games.streamGame(id);
    return messages.pipe(map((data): MessageEvent => ({ data })));
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.games.getGame(id);
  }

  @Post(":id/events")
  @UseGuards(AuthGuard)
  async append(
    @CurrentAuth() auth: AuthContext,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    await this.access.assertCanScore(auth, id);
    return this.games.appendEvent(id, body);
  }
}
