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

export type ProposalStatus = "open" | "accepted" | "rejected";

export type ProposalPayload =
  | { kind: "pitch"; call: "B" | "C" | "S" | "F" | "T" }
  | { kind: "outcome"; code: "out" | "1B" | "2B" | "3B" | "HR" | "E" | "FC" };

export interface ProposalRecord {
  id: string;
  gameId: string;
  createdAt: string;
  author: string;
  status: ProposalStatus;
  payload: ProposalPayload;
}

export interface CreateProposalInput {
  gameId: string;
  author: string;
  payload: ProposalPayload;
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

  createProposal(input: CreateProposalInput): Promise<ProposalRecord>;
  listProposals(gameId: string, status?: ProposalStatus): Promise<ProposalRecord[]>;
  getProposal(id: string): Promise<ProposalRecord | null>;
  resolveProposal(id: string, status: ProposalStatus): Promise<ProposalRecord | null>;

  ping(): Promise<void>;
}

export const EVENT_STORE = Symbol("EVENT_STORE");
