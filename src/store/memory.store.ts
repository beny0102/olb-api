import { Injectable } from "@nestjs/common";
import type { Event } from "@olb/contract/types";
import { GameNotFoundError } from "./errors.js";
import type { CreateGameInput, EventStore, GameRecord } from "./store.js";

/**
 * Development and test store. Single process only: the in-process tail chain
 * gives one writer per game, which is the same guarantee Postgres provides
 * with a row lock.
 */
@Injectable()
export class MemoryEventStore implements EventStore {
  readonly kind = "memory" as const;

  private readonly games = new Map<string, GameRecord>();
  private readonly events = new Map<string, Event[]>();
  private readonly tails = new Map<string, Promise<unknown>>();

  async createGame(input: CreateGameInput): Promise<GameRecord> {
    const record: GameRecord = { ...input, lastSeq: -1 };
    this.games.set(record.id, record);
    this.events.set(record.id, []);
    return { ...record };
  }

  async getGame(id: string): Promise<GameRecord | null> {
    const record = this.games.get(id);
    return record ? { ...record } : null;
  }

  async listGames(): Promise<GameRecord[]> {
    return [...this.games.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((record) => ({ ...record }));
  }

  async append(gameId: string, build: (seq: number) => Event): Promise<Event> {
    const previous = this.tails.get(gameId) ?? Promise.resolve();
    const run = previous.then(() => this.appendNow(gameId, build));
    this.tails.set(
      gameId,
      run.catch(() => undefined),
    );
    return run;
  }

  async listEvents(gameId: string, fromSeq: number): Promise<Event[]> {
    return (this.events.get(gameId) ?? []).filter((event) => event.seq >= fromSeq);
  }

  async ping(): Promise<void> {
    return;
  }

  private appendNow(gameId: string, build: (seq: number) => Event): Event {
    const game = this.games.get(gameId);
    const log = this.events.get(gameId);
    if (!game || !log) throw new GameNotFoundError(gameId);

    const seq = game.lastSeq + 1;
    const event = build(seq);
    log.push(event);
    game.lastSeq = seq;
    return event;
  }
}
