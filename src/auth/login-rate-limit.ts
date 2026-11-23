import { HttpException, Injectable } from "@nestjs/common";

interface Bucket {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_IDENTITY = 5;
const MAX_PER_IP = 30;
const PRUNE_EVERY = 1000;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * In-process login throttle for the single-replica Phase 1 deployment.
 * Counts failed attempts only; a successful login clears both buckets.
 *
 * This is not a distributed limiter. If the API runs behind multiple
 * replicas, move the buckets to Redis before scaling out.
 */
@Injectable()
export class LoginRateLimiter {
  private readonly identities = new Map<string, Bucket>();
  private readonly addresses = new Map<string, Bucket>();
  private failures = 0;

  assertAllowed(ip: string, email: string, now = Date.now()): void {
    const identity = this.identities.get(this.identityKey(ip, email));
    if (identity && identity.resetAt > now && identity.count >= MAX_PER_IDENTITY) {
      throw this.tooMany(identity.resetAt - now);
    }
    const address = this.addresses.get(ip);
    if (address && address.resetAt > now && address.count >= MAX_PER_IP) {
      throw this.tooMany(address.resetAt - now);
    }
  }

  recordFailure(ip: string, email: string, now = Date.now()): void {
    this.increment(this.identities, this.identityKey(ip, email), now);
    this.increment(this.addresses, ip, now);
    this.failures += 1;
    // Arbitrary emails would otherwise grow the identity map forever. Pruning
    // expired buckets keeps memory proportional to the active window.
    if (this.failures % PRUNE_EVERY === 0) this.prune(now);
  }

  recordSuccess(ip: string, email: string): void {
    this.identities.delete(this.identityKey(ip, email));
    this.addresses.delete(ip);
  }

  private identityKey(ip: string, email: string): string {
    return `${ip}|${normalizeEmail(email)}`;
  }

  private increment(map: Map<string, Bucket>, key: string, now: number): void {
    const current = map.get(key);
    if (!current || current.resetAt <= now) {
      map.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return;
    }
    current.count += 1;
  }

  private prune(now: number): void {
    for (const map of [this.identities, this.addresses]) {
      for (const [key, bucket] of map) {
        if (bucket.resetAt <= now) map.delete(key);
      }
    }
  }

  private tooMany(retryAfterMs: number): HttpException {
    return new HttpException(
      {
        statusCode: 429,
        message: "too many login attempts",
        retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      },
      429,
    );
  }
}
