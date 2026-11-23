import { Logger } from "@nestjs/common";
import { createClient, type RedisClientType } from "redis";
import type { GameState } from "../domain/fold.js";

export const GAME_STREAM_BUS = Symbol("GAME_STREAM_BUS");

const CHANNEL_PREFIX = "olb:game:";
const CHANNEL_PATTERN = `${CHANNEL_PREFIX}*`;
const MESSAGE_VERSION = 1;
const REDIS_COMMAND_TIMEOUT_MS = 1_000;

/**
 * Internal fan-out envelope. It is not part of `@olb/contract`; the wire
 * payload sent to SSE clients is still `GameStreamMessage`.
 */
export interface GameStreamBusMessage {
  origin: string;
  gameId: string;
  state: GameState;
}

export interface GameStreamBus {
  readonly kind: "memory" | "redis";
  start(handler: (message: GameStreamBusMessage) => void): Promise<void>;
  publish(message: GameStreamBusMessage): Promise<void>;
  health(): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * One-process bus for development, tests and the Redis-free `basic` profile.
 * `GameStreamService` still owns the per-game replay subjects.
 */
export class MemoryGameStreamBus implements GameStreamBus {
  readonly kind = "memory" as const;
  private handler: ((message: GameStreamBusMessage) => void) | null = null;

  async start(handler: (message: GameStreamBusMessage) => void): Promise<void> {
    this.handler = handler;
  }

  async publish(message: GameStreamBusMessage): Promise<void> {
    this.handler?.(message);
  }

  async health(): Promise<boolean> {
    return true;
  }

  async stop(): Promise<void> {
    this.handler = null;
  }
}

interface RedisEnvelope {
  version: number;
  origin: string;
  gameId: string;
  state: GameState;
}

function parseEnvelope(value: string): GameStreamBusMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const message = parsed as Partial<RedisEnvelope>;
  if (message.version !== MESSAGE_VERSION) return null;
  if (typeof message.origin !== "string" || message.origin.length === 0) return null;
  if (typeof message.gameId !== "string" || message.gameId.length === 0) return null;
  if (typeof message.state !== "object" || message.state === null) return null;
  if (typeof message.state.lastSeq !== "number") return null;

  return {
    origin: message.origin,
    gameId: message.gameId,
    state: message.state as GameState,
  };
}

/**
 * Redis Pub/Sub fan-out for more than one API replica.
 *
 * The local handler is called before the network publish so the replica that
 * handled the append remains instant. The subscriber also receives our own
 * message; `GameStreamService` deduplicates by `lastSeq`.
 *
 * Pub/Sub is deliberately ephemeral: a replica that misses a message while
 * Redis is unavailable recovers through the existing polling fallback. Durable
 * replay would need Redis Streams and is outside Phase 1.
 */
export class RedisGameStreamBus implements GameStreamBus {
  readonly kind = "redis" as const;

  private readonly logger = new Logger(RedisGameStreamBus.name);
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private handler: ((message: GameStreamBusMessage) => void) | null = null;
  private started = false;

  constructor(url: string) {
    const options = { url, disableOfflineQueue: true };
    this.publisher = createClient(options);
    this.subscriber = createClient(options);
    this.attachErrorLogging(this.publisher, "publisher");
    this.attachErrorLogging(this.subscriber, "subscriber");
  }

  async start(handler: (message: GameStreamBusMessage) => void): Promise<void> {
    if (this.started) {
      this.handler = handler;
      return;
    }

    this.handler = handler;
    try {
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      await this.subscriber.pSubscribe(CHANNEL_PATTERN, (value) => {
        const message = parseEnvelope(value);
        if (message) this.handler?.(message);
      });
      this.started = true;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async publish(message: GameStreamBusMessage): Promise<void> {
    this.handler?.(message);

    if (!this.publisher.isOpen) {
      this.logger.warn("redis publisher is not connected; local delivery only");
      return;
    }

    const envelope: RedisEnvelope = {
      version: MESSAGE_VERSION,
      origin: message.origin,
      gameId: message.gameId,
      state: message.state,
    };

    try {
      await withTimeout(
        this.publisher.publish(
          `${CHANNEL_PREFIX}${message.gameId}`,
          JSON.stringify(envelope),
        ),
        REDIS_COMMAND_TIMEOUT_MS,
      );
    } catch (error) {
      // The event is already committed in Postgres. A fan-out failure must not
      // turn a successful append into a 500; other replicas catch up by polling.
      this.logger.warn(
        `redis publish failed for game ${message.gameId}: ${errorMessage(error)}`,
      );
    }
  }

  async health(): Promise<boolean> {
    if (!this.publisher.isOpen) return false;
    try {
      const reply = await withTimeout(
        this.publisher.ping(),
        REDIS_COMMAND_TIMEOUT_MS,
      );
      return reply === "PONG";
    } catch (error) {
      this.logger.warn(`redis ping failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.handler = null;
    await Promise.allSettled([
      withTimeout(quit(this.subscriber), REDIS_COMMAND_TIMEOUT_MS),
      withTimeout(quit(this.publisher), REDIS_COMMAND_TIMEOUT_MS),
    ]);
  }

  private attachErrorLogging(client: RedisClientType, role: string): void {
    client.on("error", (error: unknown) => {
      this.logger.warn(`redis ${role}: ${errorMessage(error)}`);
    });
  }
}

async function quit(client: RedisClientType): Promise<void> {
  if (!client.isOpen) return;
  await client.quit();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`redis command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createGameStreamBus(
  redisUrl: string | undefined,
  requireRedis: boolean,
): GameStreamBus {
  if (redisUrl) return new RedisGameStreamBus(redisUrl);
  if (requireRedis) {
    throw new Error("REQUIRE_REDIS=1 requires REDIS_URL");
  }
  return new MemoryGameStreamBus();
}
