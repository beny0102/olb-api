import { BadRequestException } from "@nestjs/common";

export const MAX_NAME = 120;
export const MAX_SLUG = 80;
export const MAX_ABBREVIATION = 16;
export const MAX_VENUE = 200;
export const MAX_JERSEY = 8;
export const MAX_POSITION = 16;

export const SEASON_STATUSES = ["active", "archived"] as const;
export const COMPETITION_KINDS = ["league", "division"] as const;
export const ROSTER_STATUSES = ["active", "inactive"] as const;
export const COVERAGES = ["full", "summary", "external"] as const;
export const DATA_SOURCES = ["official", "team_report", "import", "external"] as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function assertObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function assertKnownFields(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new BadRequestException(`unknown field: ${unknown}`);
}

export function hasField(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maxLength) {
    throw new BadRequestException(
      `${key} must be a non-empty string of at most ${maxLength} characters`,
    );
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new BadRequestException(`${key} must be a string of at most ${maxLength} characters`);
  }
  return value.trim();
}

export function isUuidV7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

export function requiredUuid(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (!isUuidV7(value)) {
    throw new BadRequestException(`${key} must be a lowercase UUIDv7`);
  }
  return value;
}

export function optionalUuid(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  if (!isUuidV7(value)) {
    throw new BadRequestException(`${key} must be a lowercase UUIDv7`);
  }
  return value;
}

export function requiredInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number {
  const value = body[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestException(`${key} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestException(`${key} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

export function requiredEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = body[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new BadRequestException(`${key} must be one of: ${values.join(", ")}`);
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = body[key];
  if (value === undefined || value === null) return fallback;
  return requiredEnum(body, key, values);
}

export function optionalBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = body[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new BadRequestException(`${key} must be a boolean`);
  }
  return value;
}

export function optionalDate(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  return parseDate(value, key);
}

export function optionalTimestamp(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  return parseTimestamp(value, key);
}

export function patchString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  return requiredString(body, key, maxLength);
}

export function patchNullableString(
  body: Record<string, unknown>,
  key: string,
  maxLength = MAX_NAME,
): string | null | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  return optionalString(body, key, maxLength);
}

export function patchUuid(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  return requiredUuid(body, key);
}

export function patchNullableUuid(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  return optionalUuid(body, key);
}

export function patchInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  return requiredInteger(body, key, min, max);
}

export function patchEnum<T extends string>(
  body: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  return requiredEnum(body, key, values);
}

export function patchNullableDate(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  if (body[key] === null) return null;
  return parseDate(body[key], key);
}

export function patchNullableTimestamp(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!hasField(body, key) || body[key] === undefined) return undefined;
  if (body[key] === null) return null;
  return parseTimestamp(body[key], key);
}

export function assertArray(
  body: Record<string, unknown>,
  key: string,
): unknown[] {
  const value = body[key];
  if (!Array.isArray(value)) {
    throw new BadRequestException(`${key} must be an array`);
  }
  return value;
}

function parseDate(value: unknown, key: string): string {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new BadRequestException(`${key} must be a date in YYYY-MM-DD form`);
  }
  return value;
}

function parseTimestamp(value: unknown, key: string): string {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new BadRequestException(`${key} must be an ISO-8601 timestamp`);
  }
  return new Date(Date.parse(value)).toISOString();
}
