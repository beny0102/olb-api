import { randomBytes } from "node:crypto";

/** Lowercase RFC 9562 UUIDv7; version and variant nibbles are fixed. */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True when `value` is a lowercase UUIDv7 string. */
export function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7.test(value);
}

/**
 * RFC 9562 UUIDv7: 48-bit Unix milliseconds followed by random bits.
 *
 * The contract rejects v4 identifiers on purpose, so this is the only
 * identifier generator the service is allowed to use.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Math.floor(now));

  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((timestamp >> BigInt(8 * (5 - i))) & 0xffn);
  }

  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
