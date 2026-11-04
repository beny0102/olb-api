import type { Event } from "@olb/contract/types";

export interface GameRecord {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledStart: string | null;
  venue: string | null;
  createdAt: string;
  lastSeq: number;
}

export interface CreateGameInput {
  id: string;
  homeTeam: string;
  awayTeam: string;
  scheduledStart: string | null;
  venue: string | null;
  createdAt: string;
}

/**
 * The sequence number, contract tag and recording timestamp are always
 * assigned by the store. A client may supply `id` and `occurredAt` so that a
 * retried POST keeps the same identity; an omitted id is generated.
 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventDraft = DistributiveOmit<Event, "id" | "seq" | "contract" | "recordedAt"> & {
  id?: Event["id"];
};

export interface EventStore {
  readonly kind: "memory" | "postgres";

  createGame(input: CreateGameInput): Promise<GameRecord>;
  getGame(id: string): Promise<GameRecord | null>;
  listGames(): Promise<GameRecord[]>;

  /**
   * Appends one event, assigning the next sequence number atomically.
   * The callback runs inside the critical section so `build(seq)` cannot
   * observe a sequence number that another writer later reuses.
   */
  append(gameId: string, build: (seq: number) => Event): Promise<Event>;

  listEvents(gameId: string, fromSeq: number): Promise<Event[]>;

  /** Looks up one event by its client-visible id, across every game. */
  findEventById(id: string): Promise<Event | null>;

  ping(): Promise<void>;
}

export const EVENT_STORE = Symbol("EVENT_STORE");
