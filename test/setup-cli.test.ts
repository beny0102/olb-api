import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatSetupResult,
  main,
  parseSetupArgs,
  resolveSetupConfig,
  runSetup,
  setupPayload,
} from "../src/setup/cli.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "olb-setup-cli-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const ARGS = [
  "--org-name",
  "Liga Nueva",
  "--org-slug",
  "liga-nueva",
  "--admin-name",
  "Admin",
  "--admin-email",
  "admin@liga-nueva.olb",
];

describe("setup CLI arguments", () => {
  it("parses space-separated and equals forms", () => {
    expect(parseSetupArgs(ARGS)).toEqual({
      orgName: "Liga Nueva",
      orgSlug: "liga-nueva",
      adminName: "Admin",
      adminEmail: "admin@liga-nueva.olb",
      adminPassword: undefined,
    });

    expect(
      parseSetupArgs([
        "--org-name=Liga",
        "--org-slug=liga",
        "--admin-name=Admin",
        "--admin-email=admin@liga.olb",
        "--admin-password=secret-password",
      ]),
    ).toMatchObject({ orgName: "Liga", adminPassword: "secret-password" });
  });

  it("rejects unknown, missing and incomplete arguments", () => {
    expect(() => parseSetupArgs([...ARGS, "--unknown", "x"])).toThrow(
      /unknown option/,
    );
    expect(() => parseSetupArgs(["--org-name"])).toThrow(/missing value/);
    expect(() => parseSetupArgs(["--org-name", "Liga"])).toThrow(
      /missing required option/,
    );
    expect(() => parseSetupArgs(["positional"])).toThrow(/unexpected argument/);
  });
});

describe("setup CLI configuration", () => {
  it("takes the token from the environment and the password from the flag", () => {
    const config = resolveSetupConfig(
      { ...parseSetupArgs(ARGS), adminPassword: "flag-password" },
      {
        SETUP_TOKEN: "env-token",
        OLB_API_URL: "http://api.local:3001/",
        OLB_VIEWER_URL: "http://viewer.local:3000/",
      },
      "/tmp",
    );

    expect(config.token).toBe("env-token");
    expect(config.password).toBe("flag-password");
    expect(config.apiUrl).toBe("http://api.local:3001");
    expect(config.loginUrl).toBe("http://viewer.local:3000/login");
  });

  it("falls back to SETUP_ADMIN_PASSWORD and the token file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".setup-token"), "file-token\n");

    const config = resolveSetupConfig(parseSetupArgs(ARGS), {
      SETUP_TOKEN_FILE: join(dir, ".setup-token"),
      SETUP_ADMIN_PASSWORD: "env-password",
    }, "/tmp");

    expect(config.token).toBe("file-token");
    expect(config.password).toBe("env-password");
    expect(config.apiUrl).toBe("http://127.0.0.1:3001");
    expect(config.loginUrl).toBe("http://127.0.0.1:3000/login");
  });

  it("fails when the token or password is missing", () => {
    expect(() =>
      resolveSetupConfig(parseSetupArgs(ARGS), {}, tempDir()),
    ).toThrow(/setup token not found/);

    expect(() =>
      resolveSetupConfig(parseSetupArgs(ARGS), { SETUP_TOKEN: "t" }, tempDir()),
    ).toThrow(/admin password required/);
  });
});

describe("setup CLI request", () => {
  it("calls POST /setup and prints no credentials", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(
        JSON.stringify({
          organization: { slug: "liga-nueva" },
          user: { email: "admin@liga-nueva.olb" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const config = resolveSetupConfig(
      { ...parseSetupArgs(ARGS), adminPassword: "secret-password" },
      { SETUP_TOKEN: "secret-token", OLB_API_URL: "http://api.local:3001" },
      "/tmp",
    );

    const result = await runSetup(config, fakeFetch);
    expect(result).toEqual({
      orgSlug: "liga-nueva",
      adminEmail: "admin@liga-nueva.olb",
      loginUrl: "http://127.0.0.1:3000/login",
    });
    expect(calls).toEqual([
      {
        url: "http://api.local:3001/setup",
        body: setupPayload(config),
      },
    ]);

    const output = formatSetupResult(result).join("\n");
    expect(output).toContain("liga-nueva");
    expect(output).toContain("admin@liga-nueva.olb");
    expect(output).not.toContain("secret-password");
    expect(output).not.toContain("secret-token");
  });

  it("returns a non-zero code and a safe message on API errors", async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "setup already completed" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const code = await main(ARGS, {
      env: {
        SETUP_TOKEN: "secret-token",
        SETUP_ADMIN_PASSWORD: "secret-password",
        OLB_API_URL: "http://api.local:3001",
      },
      cwd: "/tmp",
      log: (message) => logs.push(message),
      logError: (message) => errors.push(message),
      fetchImpl: fakeFetch,
    });

    expect(code).toBe(1);
    expect(logs).toEqual([]);
    expect(errors.join("\n")).toContain("HTTP 409");
    expect(errors.join("\n")).not.toContain("secret-password");
    expect(errors.join("\n")).not.toContain("secret-token");
  });

  it("returns zero and prints the login URL on success", async () => {
    const logs: string[] = [];
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          organization: { slug: "liga-nueva" },
          user: { email: "admin@liga-nueva.olb" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const code = await main(ARGS, {
      env: {
        SETUP_TOKEN: "secret-token",
        SETUP_ADMIN_PASSWORD: "secret-password",
      },
      cwd: "/tmp",
      log: (message) => logs.push(message),
      logError: () => undefined,
      fetchImpl: fakeFetch,
    });

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("http://127.0.0.1:3000/login");
    expect(logs.join("\n")).not.toContain("secret-password");
    expect(logs.join("\n")).not.toContain("secret-token");
  });
});
