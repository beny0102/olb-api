import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { parseEvent } from "@olb/contract";
import type { Event } from "@olb/contract/types";
import { foldEvents, type GameState } from "../domain/fold.js";
import { uuidv7 } from "../domain/uuid7.js";
import { GameNotFoundError } from "../store/errors.js";
import { EVENT_STORE, type EventStore, type GameRecord } from "../store/store.js";

const MAX_NAME = 120;

function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function teamName(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_NAME) {
    throw new BadRequestException(`${key} must be a non-empty string of at most ${MAX_NAME} characters`);
  }
  return value.trim();
}

@Injectable()
export class GamesService {
  constructor(@Inject(EVENT_STORE) private readonly store: EventStore) {}

  listGames(): Promise<GameRecord[]> {
    return this.store.listGames();
  }

  async createGame(body: unknown): Promise<GameRecord> {
    const input = assertObject(body);
    const game = await this.store.createGame({
      id: uuidv7(),
      homeTeam: teamName(input, "homeTeam"),
      awayTeam: teamName(input, "awayTeam"),
      createdAt: new Date().toISOString(),
    });

    // A game is created live: the first event is always game.start, so the
    // log has no gap at sequence zero and the projection is never scheduled.
    await this.store.append(game.id, (seq) =>
      this.buildEvent(game.id, seq, {
        type: "game.start",
        source: "human",
        actor: { kind: "system", id: "olb-api" },
        payload: { startedAt: game.createdAt },
      }),
    );

    return { ...game, lastSeq: 0 };
  }

  async getGame(id: string): Promise<GameRecord> {
    const game = await this.store.getGame(id);
    if (!game) throw new GameNotFoundError(id);
    return game;
  }

  async getState(id: string): Promise<GameState> {
    await this.getGame(id);
    const events = await this.store.listEvents(id, 0);
    return foldEvents(events);
  }

  async listEvents(id: string, fromSeq: number): Promise<Event[]> {
    await this.getGame(id);
    return this.store.listEvents(id, fromSeq);
  }

  async appendEvent(id: string, body: unknown): Promise<Event> {
    const input = assertObject(body);
    return this.store.append(id, (seq) => this.buildEvent(id, seq, input));
  }

  /**
   * Stamps the fields the server owns. Everything else is passed through
   * untouched, including fields a newer producer added: the contract requires
   * unknown fields to survive, not to be silently dropped.
   */
  private buildEvent(gameId: string, seq: number, body: Record<string, unknown>): Event {
    const now = new Date().toISOString();
    const candidate: Record<string, unknown> = {
      ...body,
      contract: "olb.event/1",
      id: uuidv7(),
      gameId,
      seq,
      occurredAt: typeof body.occurredAt === "string" ? body.occurredAt : now,
      recordedAt: now,
    };

    try {
      return parseEvent(candidate);
    } catch (error) {
      throw new BadRequestException(`invalid event: ${(error as Error).message}`);
    }
  }
}
