import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

/** Where a generated setup token lives when `SETUP_TOKEN_FILE` is unset. */
export const DEFAULT_SETUP_TOKEN_FILE = "deploy/.setup-token";

export type SetupTokenSource = "env" | "file" | "generated" | "ephemeral";

export interface SetupTokenState {
  /** The secret itself. Never log, return or serialize this value. */
  token: string;
  source: SetupTokenSource;
  /** Absolute path of the token file, or `null` for env/test tokens. */
  filePath: string | null;
}

export const SETUP_TOKEN_STATE = Symbol("SETUP_TOKEN_STATE");

export function hashSecret(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/**
 * Constant-time comparison. Both values are hashed first so differing
 * lengths do not leak through `timingSafeEqual`'s length check.
 */
export function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(hashSecret(left), hashSecret(right));
}

export function setupTokenFilePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(env.SETUP_TOKEN_FILE ?? DEFAULT_SETUP_TOKEN_FILE);
}

function readTokenFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const token = readFileSync(path, "utf8").trim();
  return token.length > 0 ? token : null;
}

function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  // An existing file keeps its old mode; enforce 0600 explicitly.
  chmodSync(path, 0o600);
}

/**
 * Resolves the one-time setup token. Precedence: `SETUP_TOKEN`, then the token
 * file, then a newly generated token. The generated file is written 0600 and
 * only its path is logged.
 *
 * Under `NODE_ENV=test` a missing token is generated in memory without
 * touching the working tree, so test suites never create `deploy/.setup-token`.
 */
export function loadSetupTokenState(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.log,
): SetupTokenState {
  const envToken = env.SETUP_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env", filePath: null };
  }

  const filePath = setupTokenFilePath(env);
  const fileToken = readTokenFile(filePath);
  if (fileToken) {
    return { token: fileToken, source: "file", filePath };
  }

  const token = randomBytes(32).toString("hex");
  if (env.NODE_ENV === "test") {
    return { token, source: "ephemeral", filePath: null };
  }

  writeTokenFile(filePath, token);
  log(`setup token written to ${filePath}`);
  return { token, source: "generated", filePath };
}

/** Removes the token file after a successful setup. Env tokens stay env. */
export function removeSetupTokenFile(
  state: SetupTokenState,
  log: (message: string) => void = console.log,
): void {
  if (state.filePath === null || state.source === "env") return;
  try {
    rmSync(state.filePath, { force: true });
  } catch (error) {
    log(`setup token file could not be removed: ${state.filePath}`);
    void error;
  }
}
