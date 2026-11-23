import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { LoginRateLimiter } from "../src/auth/login-rate-limit.js";

describe("login rate limiter", () => {
  it("blocks the sixth failed attempt in the window", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.assertAllowed("127.0.0.1", "player@example.test", now);
      limiter.recordFailure("127.0.0.1", "player@example.test", now);
    }

    expect(() =>
      limiter.assertAllowed("127.0.0.1", "player@example.test", now + 1),
    ).toThrow(HttpException);
  });

  it("opens a fresh bucket after the window", () => {
    const limiter = new LoginRateLimiter();
    const now = 1_000_000;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.recordFailure("127.0.0.1", "player@example.test", now);
    }

    expect(() =>
      limiter.assertAllowed("127.0.0.1", "player@example.test", now + 15 * 60 * 1000),
    ).not.toThrow();
  });

  it("clears the identity and address buckets on success", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure("127.0.0.1", "player@example.test");
    }
    limiter.recordSuccess("127.0.0.1", "player@example.test");

    expect(() =>
      limiter.assertAllowed("127.0.0.1", "player@example.test"),
    ).not.toThrow();
  });

  it("limits a single address across different emails", () => {
    const limiter = new LoginRateLimiter();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      limiter.recordFailure("127.0.0.1", `player${attempt}@example.test`);
    }

    expect(() =>
      limiter.assertAllowed("127.0.0.1", "another@example.test"),
    ).toThrow(HttpException);
  });
});
