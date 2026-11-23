import { HttpException } from "@nestjs/common";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initialState, type GameState } from "../src/domain/fold.js";
import {
  RedisGameStreamBus,
  type GameStreamBusMessage,
} from "../src/games/game-stream.bus.js";
import { RedisLoginRateLimiter } from "../src/auth/login-rate-limit.js";

const redisUrl = process.env.TEST_REDIS_URL;

function state(lastSeq: number): GameState {
  return { ...initialState, status: "live", lastSeq };
}

describe.skipIf(!redisUrl)("redis realtime and login limits", () => {
  let observer: ReturnType<typeof createClient>;

  beforeAll(async () => {
    observer = createClient({ url: redisUrl! });
    await observer.connect();
  });

  afterAll(async () => {
    if (observer?.isOpen) {
      const keys = await observer.keys("olb:login:*");
      if (keys.length > 0) await observer.del(keys);
      await observer.quit();
    }
  });

  it("fans out a game state between two bus instances", async () => {
    const publisher = new RedisGameStreamBus(redisUrl!);
    const subscriber = new RedisGameStreamBus(redisUrl!);
    let resolve!: (message: GameStreamBusMessage) => void;
    const received = new Promise<GameStreamBusMessage>((res) => {
      resolve = res;
    });
    const timer = setTimeout(() => {
      resolve({
        origin: "timeout",
        gameId: "timeout",
        state: state(-1),
      });
    }, 3000);

    try {
      await subscriber.start((message) => {
        clearTimeout(timer);
        resolve(message);
      });
      await publisher.start(() => undefined);
      const gameId = `0192f3ff-0000-7000-8000-${String(Date.now()).slice(-12)}`;

      await publisher.publish({
        origin: "test-a",
        gameId,
        state: state(4),
      });

      const message = await received;
      expect(message.origin).toBe("test-a");
      expect(message.gameId).toBe(gameId);
      expect(message.state.lastSeq).toBe(4);
    } finally {
      clearTimeout(timer);
      await subscriber.stop();
      await publisher.stop();
    }
  });

  it("shares the failed-login budget across two limiters", async () => {
    const first = new RedisLoginRateLimiter(redisUrl!, {
      windowMs: 60_000,
      maxPerIdentity: 2,
      maxPerIp: 100,
    });
    const second = new RedisLoginRateLimiter(redisUrl!, {
      windowMs: 60_000,
      maxPerIdentity: 2,
      maxPerIp: 100,
    });
    const ip = `198.51.100.${Date.now() % 200}`;
    const email = `redis-${Date.now()}@example.test`;

    try {
      await first.start();
      await second.start();

      await first.recordFailure(ip, email);
      await first.recordFailure(ip, email);

      let blocked: unknown;
      try {
        await second.assertAllowed(ip, email);
      } catch (error) {
        blocked = error;
      }
      expect(blocked).toBeInstanceOf(HttpException);
      expect((blocked as HttpException).getStatus()).toBe(429);

      const keys = await observer.keys("olb:login:*");
      expect(keys.every((key) => !key.includes(email) && !key.includes(ip))).toBe(true);

      await second.recordSuccess(ip, email);
      await expect(second.assertAllowed(ip, email)).resolves.toBeUndefined();
    } finally {
      await first.stop().catch(() => undefined);
      await second.stop().catch(() => undefined);
    }
  });
});
