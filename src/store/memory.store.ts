import { Injectable } from "@nestjs/common";
import type { Event } from "@olb/contract/types";
import { uuidv7 } from "../domain/uuid7.js";
import { GameNotFoundError } from "./errors.js";
import type {
  CreateGameInput,
  CreateProposalInput,
  EventStore,
  GameRecord,
  ProposalRecord,
  ProposalStatus,
} from "./store.js";

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
  private readonly eventsById = new Map<string, Event>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly proposalsByGame = new Map<string, string[]>();

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

  async findEventById(id: string): Promise<Event | null> {
    return this.eventsById.get(id) ?? null;
  }

  async createProposal(input: CreateProposalInput): Promise<ProposalRecord> {
    const record: ProposalRecord = {
      id: uuidv7(),
      gameId: input.gameId,
      createdAt: new Date().toISOString(),
      author: input.author,
      status: "open",
      payload: input.payload,
    };
    this.proposals.set(record.id, record);
    const index = this.proposalsByGame.get(record.gameId) ?? [];
    index.push(record.id);
    this.proposalsByGame.set(record.gameId, index);
    return { ...record };
  }

  async listProposals(gameId: string, status?: ProposalStatus): Promise<ProposalRecord[]> {
    const ids = this.proposalsByGame.get(gameId) ?? [];
    return ids
      .map((id) => this.proposals.get(id))
      .filter((record): record is ProposalRecord => record !== undefined)
      .filter((record) => status === undefined || record.status === status)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((record) => ({ ...record }));
  }

  async getProposal(id: string): Promise<ProposalRecord | null> {
    const record = this.proposals.get(id);
    return record ? { ...record } : null;
  }

  async resolveProposal(id: string, status: ProposalStatus): Promise<ProposalRecord | null> {
    const record = this.proposals.get(id);
    if (!record) return null;
    const updated: ProposalRecord = { ...record, status };
    this.proposals.set(id, updated);
    return { ...updated };
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
    this.eventsById.set(event.id, event);
    game.lastSeq = seq;
    return event;
  }
}
