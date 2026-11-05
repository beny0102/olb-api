import { Injectable } from "@nestjs/common";
import { ReplaySubject, type Observable } from "rxjs";
import type { GameState } from "../domain/fold.js";

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
  /** Monotonic per game; distinguishes two publishes with the same lastSeq. */
  revision: number;
  state: GameState;
}

interface Stream {
  subject: ReplaySubject<GameStreamUpdate>;
  revision: number;
}

/**
 * One in-process fan-out per game. A replay buffer of one closes the gap
 * between reading the initial snapshot and subscribing: an append that lands
 * in that window is still delivered instead of being lost.
 */
@Injectable()
export class GameStreamService {
  private readonly streams = new Map<string, Stream>();

  publish(gameId: string, state: GameState): void {
    const stream = this.stream(gameId);
    stream.revision += 1;
    stream.subject.next({ revision: stream.revision, state });
  }

  watch(gameId: string): Observable<GameStreamUpdate> {
    return this.stream(gameId).subject.asObservable();
  }

  /** Current publish revision; a snapshot filters updates at or below it. */
  cursor(gameId: string): number {
    return this.streams.get(gameId)?.revision ?? 0;
  }

  private stream(gameId: string): Stream {
    let stream = this.streams.get(gameId);
    if (!stream) {
      stream = { subject: new ReplaySubject<GameStreamUpdate>(1), revision: 0 };
      this.streams.set(gameId, stream);
    }
    return stream;
  }
}
