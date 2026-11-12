import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_SETUP_TOKEN_FILE } from "./setup-token.js";

export const SETUP_USAGE =
  "usage: npm run setup -- --org-name <name> --org-slug <slug> " +
  "--admin-name <name> --admin-email <email> [--admin-password <password>]";

export interface SetupArguments {
  orgName: string;
  orgSlug: string;
  adminName: string;
  adminEmail: string;
  adminPassword?: string;
}

export interface SetupCliConfig extends SetupArguments {
  token: string;
  password: string;
  apiUrl: string;
  loginUrl: string;
}

export interface SetupCliResult {
  orgSlug: string;
  adminEmail: string;
  loginUrl: string;
}

const FLAGS = new Set([
  "--org-name",
  "--org-slug",
  "--admin-name",
  "--admin-email",
  "--admin-password",
]);

/** Parses `--flag value` and `--flag=value`; throws on unknown/missing flags. */
export function parseSetupArgs(argv: readonly string[]): SetupArguments {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index]!;
    if (!raw.startsWith("--")) {
      throw new Error(`unexpected argument: ${raw}\n${SETUP_USAGE}`);
    }

    const equals = raw.indexOf("=");
    const flag = equals === -1 ? raw : raw.slice(0, equals);
    if (!FLAGS.has(flag)) {
      throw new Error(`unknown option: ${flag}\n${SETUP_USAGE}`);
    }

    const value =
      equals === -1 ? argv[(index += 1)] : raw.slice(equals + 1);
    if (value === undefined || value.length === 0) {
      throw new Error(`missing value for ${flag}\n${SETUP_USAGE}`);
    }
    values.set(flag, value);
  }

  const required = (flag: string): string => {
    const value = values.get(flag);
    if (value === undefined) {
      throw new Error(`missing required option: ${flag}\n${SETUP_USAGE}`);
    }
    return value;
  };

  return {
    orgName: required("--org-name"),
    orgSlug: required("--org-slug"),
    adminName: required("--admin-name"),
    adminEmail: required("--admin-email"),
    adminPassword: values.get("--admin-password"),
  };
}

function readTokenFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const token = readFileSync(path, "utf8").trim();
  return token.length > 0 ? token : null;
}

/**
 * The token comes from `SETUP_TOKEN` or the token file; the password from
 * `--admin-password` or `SETUP_ADMIN_PASSWORD`. Both are only used to build
 * the request body, never printed.
 */
export function resolveSetupConfig(
  args: SetupArguments,
  env: NodeJS.ProcessEnv,
  cwd: string,
): SetupCliConfig {
  const envToken = env.SETUP_TOKEN?.trim();
  const tokenPath = resolve(cwd, env.SETUP_TOKEN_FILE ?? DEFAULT_SETUP_TOKEN_FILE);
  const token = envToken || readTokenFile(tokenPath);
  if (!token) {
    throw new Error(
      `setup token not found in SETUP_TOKEN or ${tokenPath}; run the API once to generate it`,
    );
  }

  const password = args.adminPassword ?? env.SETUP_ADMIN_PASSWORD;
  if (!password) {
    throw new Error(
      "admin password required via --admin-password or SETUP_ADMIN_PASSWORD",
    );
  }

  const apiUrl = (env.OLB_API_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, "");
  const viewerUrl = (env.OLB_VIEWER_URL ?? "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );
  const loginUrl = env.OLB_LOGIN_URL ?? `${viewerUrl}/login`;

  return { ...args, token, password, apiUrl, loginUrl };
}

export function setupPayload(config: SetupCliConfig): Record<string, unknown> {
  return {
    token: config.token,
    organization: { name: config.orgName, slug: config.orgSlug },
    admin: {
      name: config.adminName,
      email: config.adminEmail,
      password: config.password,
    },
  };
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) return "";
    return text.length > 300 ? `${text.slice(0, 300)}…` : text;
  } catch {
    return "";
  }
}

/** Calls the public `POST /setup` endpoint; it never touches SQL. */
export async function runSetup(
  config: SetupCliConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SetupCliResult> {
  const response = await fetchImpl(`${config.apiUrl}/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(setupPayload(config)),
  });

  if (!response.ok) {
    const detail = await errorDetail(response);
    throw new Error(
      `POST /setup failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }

  const body = (await response.json()) as {
    organization?: { slug?: string };
    user?: { email?: string };
  };
  return {
    orgSlug: body.organization?.slug ?? config.orgSlug,
    adminEmail: body.user?.email ?? config.adminEmail,
    loginUrl: config.loginUrl,
  };
}

export function formatSetupResult(result: SetupCliResult): string[] {
  return [
    "Setup complete.",
    `Organization: ${result.orgSlug}`,
    `Admin: ${result.adminEmail}`,
    `Login: ${result.loginUrl}`,
  ];
}

/** Entry point shared by the npm script; returns the process exit code. */
export async function main(
  argv: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    log?: (message: string) => void;
    logError?: (message: string) => void;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const logError = options.logError ?? console.error;

  try {
    const args = parseSetupArgs(argv);
    const config = resolveSetupConfig(
      args,
      options.env ?? process.env,
      options.cwd ?? process.cwd(),
    );
    const result = await runSetup(config, options.fetchImpl ?? fetch);
    for (const line of formatSetupResult(result)) log(line);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logError(`setup failed: ${message}`);
    return 1;
  }
}
