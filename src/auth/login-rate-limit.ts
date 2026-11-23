import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { createClient, type RedisClientType } from "redis";

export const LOGIN_RATE_LIMITER = Symbol("LOGIN_RATE_LIMITER");

interface Bucket {
  count: number;
  resetAt: number;
}

export interface LoginRateLimitOptions {
  windowMs?: number;
  maxPerIdentity?: number;
  maxPerIp?: number;
}

export interface LoginRateLimiterContract {
  readonly kind: "memory" | "redis";
  start(): Promise<void>;
  assertAllowed(ip: string, email: string, now?: number): Promise<void>;
  recordFailure(ip: string, email: string, now?: number): Promise<void>;
  recordSuccess(ip: string, email: string): Promise<void>;
  health(): Promise<boolean>;
  stop(): Promise<void>;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_PER_IDENTITY = 5;
const DEFAULT_MAX_PER_IP = 30;
const PRUNE_EVERY = 1000;
const REDIS_PREFIX = "olb:login";
const REDIS_COMMAND_TIMEOUT_MS = 1_500;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tooMany(retryAfterMs: number): HttpException {
  return new HttpException(
    {
      statusCode: 429,
      message: "too many login attempts",
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    },
    429,
  );
}

/**
 * In-process login throttle for tests and the single-replica deployment.
 * Counts failed attempts only; a successful login clears both buckets.
 *
 * This is not a distributed limiter. Use `RedisLoginRateLimiter` when the API
 * runs behind multiple replicas.
 */
@Injectable()
export class LoginRateLimiter implements LoginRateLimiterContract {
  readonly kind = "memory" as const;
  private readonly identities = new Map<string, Bucket>();
  private readonly addresses = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxPerIdentity: number;
  private readonly maxPerIp: number;
  private failures = 0;

  constructor(options: LoginRateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPerIdentity = options.maxPerIdentity ?? DEFAULT_MAX_PER_IDENTITY;
    this.maxPerIp = options.maxPerIp ?? DEFAULT_MAX_PER_IP;
  }

  async start(): Promise<void> {}

  async assertAllowed(ip: string, email: string, now = Date.now()): Promise<void> {
    const identity = this.identities.get(this.identityKey(ip, email));
    if (
      identity &&
      identity.resetAt > now &&
      identity.count >= this.maxPerIdentity
    ) {
      throw tooMany(identity.resetAt - now);
    }
    const address = this.addresses.get(ip);
    if (address && address.resetAt > now && address.count >= this.maxPerIp) {
      throw tooMany(address.resetAt - now);
    }
  }

  async recordFailure(ip: string, email: string, now = Date.now()): Promise<void> {
    this.increment(this.identities, this.identityKey(ip, email), now);
    this.increment(this.addresses, ip, now);
    this.failures += 1;
    // Arbitrary emails would otherwise grow the identity map forever. Pruning
    // expired buckets keeps memory proportional to the active window.
    if (this.failures % PRUNE_EVERY === 0) this.prune(now);
  }

  async recordSuccess(ip: string, email: string): Promise<void> {
    this.identities.delete(this.identityKey(ip, email));
    this.addresses.delete(ip);
  }

  async health(): Promise<boolean> {
    return true;
  }

  async stop(): Promise<void> {}

  private identityKey(ip: string, email: string): string {
    return `${ip}|${normalizeEmail(email)}`;
  }

  private increment(map: Map<string, Bucket>, key: string, now: number): void {
    const current = map.get(key);
    if (!current || current.resetAt <= now) {
      map.set(key, { count: 1, resetAt: now + this.windowMs });
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
}

const INCREMENT_SCRIPT = `
local identity = redis.call('INCR', KEYS[1])
if identity == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local address = redis.call('INCR', KEYS[2])
if address == 1 then
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
end
return {identity, address}
`;

/**
 * Shared fixed-window throttle for multi-replica deployments. Keys contain
 * SHA-256 digests only, so raw IP addresses and emails are never stored.
 *
 * A configured Redis instance is required for correctness: if it is
 * unreachable, login is refused instead of silently bypassing the limit.
 */
@Injectable()
export class RedisLoginRateLimiter implements LoginRateLimiterContract, OnModuleDestroy {
  readonly kind = "redis" as const;
  private readonly logger = new Logger(RedisLoginRateLimiter.name);
  private readonly client: RedisClientType;
  private readonly windowMs: number;
  private readonly maxPerIdentity: number;
  private readonly maxPerIp: number;
  private started = false;

  constructor(url: string, options: LoginRateLimitOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxPerIdentity = options.maxPerIdentity ?? DEFAULT_MAX_PER_IDENTITY;
    this.maxPerIp = options.maxPerIp ?? DEFAULT_MAX_PER_IP;
    this.client = createClient({ url, disableOfflineQueue: true });
    this.client.on("error", (error: unknown) => {
      this.logger.warn(`redis login limiter: ${errorMessage(error)}`);
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.client.connect();
    this.started = true;
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  async assertAllowed(
    ip: string,
    email: string,
    _now = Date.now(),
  ): Promise<void> {
    const identityKey = this.identityKey(ip, email);
    const addressKey = this.addressKey(ip);
    const [identityValue, addressValue] = await this.withRedis(() =>
      this.client.mGet([identityKey, addressKey]),
    );

    const identity = Number(identityValue ?? 0);
    if (identity >= this.maxPerIdentity) {
      throw tooMany(await this.retryAfter(identityKey));
    }
    const address = Number(addressValue ?? 0);
    if (address >= this.maxPerIp) {
      throw tooMany(await this.retryAfter(addressKey));
    }
  }

  async recordFailure(
    ip: string,
    email: string,
    _now = Date.now(),
  ): Promise<void> {
    await this.withRedis(() =>
      this.client.eval(INCREMENT_SCRIPT, {
        keys: [this.identityKey(ip, email), this.addressKey(ip)],
        arguments: [String(this.windowMs)],
      }),
    );
  }

  async recordSuccess(ip: string, email: string): Promise<void> {
    await this.withRedis(() =>
      this.client.del([this.identityKey(ip, email), this.addressKey(ip)]),
    );
  }

  async health(): Promise<boolean> {
    if (!this.client.isOpen) return false;
    try {
      return (await this.client.ping()) === "PONG";
    } catch (error) {
      this.logger.warn(`redis ping failed: ${errorMessage(error)}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.client.isOpen) return;
    await this.client.quit();
  }

  private identityKey(ip: string, email: string): string {
    return `${REDIS_PREFIX}:identity:${digest(`${ip}|${normalizeEmail(email)}`)}`;
  }

  private addressKey(ip: string): string {
    return `${REDIS_PREFIX}:address:${digest(ip)}`;
  }

  private async retryAfter(key: string): Promise<number> {
    const ttl = await this.withRedis(() => this.client.pTTL(key));
    return ttl > 0 ? ttl : this.windowMs;
  }

  private async withRedis<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(operation(), REDIS_COMMAND_TIMEOUT_MS);
    } catch (error) {
      this.logger.error(`redis unavailable: ${errorMessage(error)}`);
      throw new ServiceUnavailableException("login temporarily unavailable");
    }
  }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLoginRateLimiter(
  redisUrl: string | undefined,
  requireRedis: boolean,
  options: LoginRateLimitOptions = {},
): LoginRateLimiterContract {
  if (redisUrl) return new RedisLoginRateLimiter(redisUrl, options);
  if (requireRedis) {
    throw new Error("REQUIRE_REDIS=1 requires REDIS_URL");
  }
  return new LoginRateLimiter(options);
}
