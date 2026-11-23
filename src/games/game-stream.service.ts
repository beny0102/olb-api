import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { ReplaySubject, type Observable } from "rxjs";
import type { GameState } from "../domain/fold.js";
import { GAME_STREAM_BUS, type GameStreamBus, type GameStreamBusMessage } from "./game-stream.bus.js";

/**
 * SSE payload. The snapshot is the contract's `snapshot` envelope; later
 * messages carry the same projection after an append. `seq` and `lastSeq` are
 * both present so a client can resume by the same cursor the log exposes.
 */
export interface GameStreamMessage {
  type: "snapshot" | "state";
  gameId: string;
  seq: number;
  lastSeq: number;
  state: GameState;
}

export interface GameStreamUpdate {
  state: GameState;
}

interface Stream {
  subject: ReplaySubject<GameStreamUpdate>;
  /** Highest lastSeq delivered locally; used to drop duplicates and stale states. */
  latestSeq: number;
}

/**
 * Per-game fan-out on top of a bus. The local replay buffer of one closes the
 * gap between reading the initial snapshot and subscribing, and `lastSeq` is
 * the ordering key across API replicas.
 */
@Injectable()
export class GameStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly instanceId =
    process.env.INSTANCE_ID ?? process.env.HOSTNAME ?? randomUUID();
  private readonly streams = new Map<string, Stream>();

  constructor(@Inject(GAME_STREAM_BUS) private readonly bus: GameStreamBus) {}

  async onModuleInit(): Promise<void> {
    await this.bus.start((message) => this.accept(message));
  }

  async onModuleDestroy(): Promise<void> {
    // End every SSE stream before the HTTP server drains. Completing the
    // subjects lets clients reconnect to another replica and resume from
    // Postgres instead of holding the old process open.
    for (const stream of this.streams.values()) stream.subject.complete();
    this.streams.clear();
    await this.bus.stop();
  }

  get kind(): GameStreamBus["kind"] {
    return this.bus.kind;
  }

  health(): Promise<boolean> {
    return this.bus.health();
  }

  async publish(gameId: string, state: GameState): Promise<void> {
    const message: GameStreamBusMessage = {
      origin: this.instanceId,
      gameId,
      state,
    };
    await this.bus.publish(message);
  }

  watch(gameId: string): Observable<GameStreamUpdate> {
    return this.stream(gameId).subject.asObservable();
  }

  /**
   * Teach the buffer the snapshot's cursor. A publish that happened before the
   * snapshot was read must not be delivered on top of a newer state.
   */
  observe(gameId: string, lastSeq: number): void {
    const stream = this.stream(gameId);
    stream.latestSeq = Math.max(stream.latestSeq, lastSeq);
  }

  private accept(message: GameStreamBusMessage): void {
    if (message.state.lastSeq <= 0) return;

    const stream = this.stream(message.gameId);
    if (message.state.lastSeq <= stream.latestSeq) return;

    stream.latestSeq = message.state.lastSeq;
    stream.subject.next({ state: message.state });
  }

  private stream(gameId: string): Stream {
    let stream = this.streams.get(gameId);
    if (!stream) {
      stream = { subject: new ReplaySubject<GameStreamUpdate>(1), latestSeq: 0 };
      this.streams.set(gameId, stream);
    }
    return stream;
  }
}
