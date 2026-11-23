import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../src/auth/login-rate-limit.js";

describe("login rate limiter", () => {
  it("blocks the sixth failed attempt in the window", async () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.assertAllowed("127.0.0.1", "player@example.test", now);
      await limiter.recordFailure("127.0.0.1", "player@example.test", now);
    }

    await expect(
      limiter.assertAllowed("127.0.0.1", "player@example.test", now + 1),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it("opens a fresh bucket after the window", async () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await limiter.recordFailure("127.0.0.1", "player@example.test", now);
    }

    await expect(
      limiter.assertAllowed(
        "127.0.0.1",
        "player@example.test",
        now + 15 * 60 * 1000,
      ),
    ).resolves.toBeUndefined();
  });

  it("clears the identity and address buckets on success", async () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await limiter.recordFailure("127.0.0.1", "player@example.test");
    }
    await limiter.recordSuccess("127.0.0.1", "player@example.test");

    await expect(
      limiter.assertAllowed("127.0.0.1", "player@example.test"),
    ).resolves.toBeUndefined();
  });

  it("limits a single address across different emails", async () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await limiter.recordFailure("127.0.0.1", `player${attempt}@example.test`);
    }

    await expect(
      limiter.assertAllowed("127.0.0.1", "another@example.test"),
    ).rejects.toBeInstanceOf(HttpException);
  });
});
