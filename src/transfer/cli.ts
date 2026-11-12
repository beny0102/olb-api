import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LeagueImportCounts, LeagueImportResult } from "./import.js";

export const LEAGUE_EXPORT_USAGE =
  "usage: npm run league:export -- --out <file> [--season <id>]";
export const LEAGUE_IMPORT_USAGE =
  "usage: npm run league:import -- --file <file> [--dry-run] [--org <slug>]";

export interface ExportArguments {
  out: string;
  season?: string;
}

export interface ImportArguments {
  file: string;
  dryRun: boolean;
  org?: string;
}

export interface TransferAuth {
  apiUrl: string;
  token: string;
}

type FlagKind = "value" | "boolean";

function parseFlags(
  argv: readonly string[],
  allowed: ReadonlyMap<string, FlagKind>,
  usage: string,
): Map<string, string | true> {
  const values = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith("--")) {
      throw new Error(`unexpected argument: ${raw}\n${usage}`);
    }

    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    const kind = allowed.get(flag);
    if (!kind) {
      throw new Error(`unknown option: ${flag}\n${usage}`);
    }

    if (kind === "boolean") {
      if (equals === -1) {
        values.set(flag, true);
        continue;
      }
      const value = raw.slice(equals + 1);
      if (value !== "true" && value !== "false") {
        throw new Error(`${flag} must be true or false\n${usage}`);
      }
      values.set(flag, value === "true" ? true : "false");
      continue;
    }

    const value = equals === -1 ? argv[(index += 1)] : raw.slice(equals + 1);
    if (value === undefined || value.length === 0) {
      throw new Error(`missing value for ${flag}\n${usage}`);
    }
    values.set(flag, value);
  }

  return values;
}

function requiredValue(
  values: ReadonlyMap<string, string | true>,
  flag: string,
  usage: string,
): string {
  const value = values.get(flag);
  if (value === undefined) {
    throw new Error(`missing required option: ${flag}\n${usage}`);
  }
  if (value === true) {
    throw new Error(`missing value for ${flag}\n${usage}`);
  }
  return value;
}

function optionalValue(
  values: ReadonlyMap<string, string | true>,
  flag: string,
): string | undefined {
  const value = values.get(flag);
  return value === true ? undefined : value;
}

export function parseExportArgs(argv: readonly string[]): ExportArguments {
  const values = parseFlags(
    argv,
    new Map<string, FlagKind>([
      ["--out", "value"],
      ["--season", "value"],
    ]),
    LEAGUE_EXPORT_USAGE,
  );
  return {
    out: requiredValue(values, "--out", LEAGUE_EXPORT_USAGE),
    season: optionalValue(values, "--season"),
  };
}

export function parseImportArgs(argv: readonly string[]): ImportArguments {
  const values = parseFlags(
    argv,
    new Map<string, FlagKind>([
      ["--file", "value"],
      ["--dry-run", "boolean"],
      ["--org", "value"],
    ]),
    LEAGUE_IMPORT_USAGE,
  );
  return {
    file: requiredValue(values, "--file", LEAGUE_IMPORT_USAGE),
    dryRun: values.get("--dry-run") === true,
    org: optionalValue(values, "--org"),
  };
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) return "";
    return text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    return "";
  }
}

/**
 * Uses `OLB_TOKEN` when present; otherwise logs in with `OLB_EMAIL` and
 * `OLB_PASSWORD`. The token is only ever sent in the authorization header.
 */
export async function resolveTransferAuth(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<TransferAuth> {
  const apiUrl = (env.OLB_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
  const token = env.OLB_TOKEN?.trim();
  if (token) return { apiUrl, token };

  const email = env.OLB_EMAIL?.trim();
  const password = env.OLB_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "credentials required: set OLB_TOKEN, or OLB_EMAIL and OLB_PASSWORD",
    );
  }

  const response = await fetchImpl(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(
      `POST /auth/login failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("login response did not include a token");
  }
  return { apiUrl, token: body.token };
}

export async function requestExport(
  auth: TransferAuth,
  season: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(`${auth.apiUrl}/admin/export`);
  if (season !== undefined) url.searchParams.set("seasonId", season);

  const response = await fetchImpl(url.toString(), {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(
      `GET /admin/export failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response.text();
}

export async function requestImport(
  auth: TransferAuth,
  bundle: unknown,
  dryRun: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<LeagueImportResult> {
  const url = new URL(`${auth.apiUrl}/admin/import`);
  if (dryRun) url.searchParams.set("dryRun", "true");

  const response = await fetchImpl(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(bundle),
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(
      `POST /admin/import failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return (await response.json()) as LeagueImportResult;
}

function formatCounts(label: string, counts: LeagueImportCounts): string {
  const parts = [
    `seasons ${counts.seasons}`,
    `competitions ${counts.competitions}`,
    `teams ${counts.teams}`,
    `teamSeasons ${counts.teamSeasons}`,
    `players ${counts.players}`,
    `rosterEntries ${counts.rosterEntries}`,
    `games ${counts.games}`,
  ];
  return `${label}: ${parts.join(", ")}`;
}

export function formatImportResult(result: LeagueImportResult): string[] {
  return [
    result.dryRun ? "Import dry run (nothing written)." : "Import applied.",
    formatCounts("created", result.created),
    formatCounts("updated", result.updated),
    formatCounts("unchanged", result.unchanged),
    ...result.warnings.map((warning) => `warning: ${warning}`),
    ...result.conflicts.map(
      (conflict) => `conflict ${conflict.entity} ${conflict.id}: ${conflict.message}`,
    ),
  ];
}

export interface ExportCliOptions {
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

export interface ImportCliOptions extends ExportCliOptions {
  readFile?: (path: string) => string;
}

/** Entry point for `npm run league:export`; returns the process exit code. */
export async function leagueExportMain(
  argv: readonly string[],
  options: ExportCliOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;

  try {
    const args = parseExportArgs(argv);
    const auth = await resolveTransferAuth(options.env ?? process.env, options.fetchImpl);
    const text = await requestExport(auth, args.season, options.fetchImpl);
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    log(`Exported league bundle to ${args.out}.`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`league export failed: ${message}`);
    return 1;
  }
}

/** Entry point for `npm run league:import`; conflicts return exit code 1. */
export async function leagueImportMain(
  argv: readonly string[],
  options: ImportCliOptions = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  try {
    const args = parseImportArgs(argv);
    const text = read(args.file);
    let bundle: unknown;
    try {
      bundle = JSON.parse(text);
    } catch {
      throw new Error(`${args.file} is not valid JSON`);
    }

    if (args.org !== undefined) {
      const slug =
        typeof bundle === "object" && bundle !== null
          ? (bundle as { organization?: { slug?: unknown } }).organization?.slug
          : undefined;
      if (slug !== args.org) {
        throw new Error(
          `bundle organization ${String(slug)} does not match --org ${args.org}`,
        );
      }
    }

    const auth = await resolveTransferAuth(options.env ?? process.env, options.fetchImpl);
    const result = await requestImport(auth, bundle, args.dryRun, options.fetchImpl);
    for (const line of formatImportResult(result)) log(line);
    return result.conflicts.length > 0 ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`league import failed: ${message}`);
    return 1;
  }
}
