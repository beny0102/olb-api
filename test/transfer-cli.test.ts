import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatImportResult,
  leagueExportMain,
  leagueImportMain,
  parseExportArgs,
  parseImportArgs,
  requestExport,
  requestImport,
  resolveTransferAuth,
} from "../src/transfer/cli.js";
import type { LeagueImportCounts, LeagueImportResult } from "../src/transfer/import.js";

const BUNDLE = {
  format: "olb.league/1",
  exportedAt: "2026-11-11T18:00:00.000Z",
  organization: { slug: "liga-metropolitana", name: "Liga Metropolitana" },
  seasons: [],
  teams: [],
  teamSeasons: [],
  games: [],
};

const ZERO: LeagueImportCounts = {
  seasons: 0,
  competitions: 0,
  teams: 0,
  teamSeasons: 0,
  players: 0,
  rosterEntries: 0,
  games: 0,
};

function result(overrides: Partial<LeagueImportResult> = {}): LeagueImportResult {
  return {
    dryRun: false,
    created: { ...ZERO },
    updated: { ...ZERO },
    unchanged: { ...ZERO },
    conflicts: [],
    warnings: [],
    ...overrides,
  };
}

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "olb-transfer-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("argument parsing", () => {
  it("parses export flags in both forms", () => {
    expect(parseExportArgs(["--out", "league.json", "--season", "abc"])).toEqual({
      out: "league.json",
      season: "abc",
    });
    expect(parseExportArgs(["--out=league.json", "--season=abc"])).toEqual({
      out: "league.json",
      season: "abc",
    });
  });

  it("rejects missing or unknown export flags", () => {
    expect(() => parseExportArgs([])).toThrow("missing required option: --out");
    expect(() => parseExportArgs(["--out"])).toThrow("missing value for --out");
    expect(() => parseExportArgs(["--out", "x", "--nope"])).toThrow("unknown option");
    expect(() => parseExportArgs(["league.json"])).toThrow("unexpected argument");
  });

  it("parses import flags including dry-run", () => {
    expect(parseImportArgs(["--file", "league.json"])).toEqual({
      file: "league.json",
      dryRun: false,
      org: undefined,
    });
    expect(
      parseImportArgs(["--file=league.json", "--dry-run", "--org=liga-metropolitana"]),
    ).toEqual({ file: "league.json", dryRun: true, org: "liga-metropolitana" });
    expect(parseImportArgs(["--file", "x", "--dry-run=false"]).dryRun).toBe(false);
    expect(() => parseImportArgs(["--file", "x", "--dry-run=maybe"])).toThrow(
      "--dry-run must be true or false",
    );
    expect(() => parseImportArgs([])).toThrow("missing required option: --file");
  });
});

describe("authentication", () => {
  it("uses OLB_TOKEN and the default API URL without a request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await resolveTransferAuth({ OLB_TOKEN: " secret " }, fetchImpl)).toEqual({
      apiUrl: "http://127.0.0.1:3001",
      token: "secret",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("logs in with email and password and strips a trailing slash", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ token: "fresh-token" }), { status: 200 });
    }) as typeof fetch;

    const auth = await resolveTransferAuth(
      {
        OLB_API_URL: "http://example.test:3001/",
        OLB_EMAIL: "admin@example.test",
        OLB_PASSWORD: "pw",
      },
      fetchImpl,
    );

    expect(auth).toEqual({ apiUrl: "http://example.test:3001", token: "fresh-token" });
    expect(calls[0]!.url).toBe("http://example.test:3001/auth/login");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      email: "admin@example.test",
      password: "pw",
    });
  });

  it("requires credentials when no token is set", async () => {
    await expect(resolveTransferAuth({}, vi.fn<typeof fetch>())).rejects.toThrow(
      "credentials required",
    );
  });

  it("reports login failures without leaking credentials", async () => {
    const fetchImpl = (async () =>
      new Response("nope", { status: 401 })) as typeof fetch;
    await expect(
      resolveTransferAuth(
        { OLB_EMAIL: "admin@example.test", OLB_PASSWORD: "top-secret" },
        fetchImpl,
      ),
    ).rejects.toThrow("POST /auth/login failed with HTTP 401: nope");
  });
});

describe("requests", () => {
  it("requests an export with the season and bearer token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{"format":"olb.league/1"}', { status: 200 });
    }) as typeof fetch;

    const text = await requestExport(
      { apiUrl: "http://api.test", token: "tok" },
      "season-1",
      fetchImpl,
    );

    expect(text).toBe('{"format":"olb.league/1"}');
    expect(calls[0]!.url).toBe("http://api.test/admin/export?seasonId=season-1");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("posts the bundle directly for import", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(result()), { status: 201 });
    }) as typeof fetch;

    const parsed = await requestImport(
      { apiUrl: "http://api.test", token: "tok" },
      BUNDLE,
      true,
      fetchImpl,
    );

    expect(parsed.dryRun).toBe(false);
    expect(calls[0]!.url).toBe("http://api.test/admin/import?dryRun=true");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual(BUNDLE);
  });

  it("throws with the HTTP status and detail", async () => {
    const fetchImpl = (async () =>
      new Response("bad bundle", { status: 400 })) as typeof fetch;
    await expect(
      requestImport({ apiUrl: "http://api.test", token: "tok" }, BUNDLE, false, fetchImpl),
    ).rejects.toThrow("POST /admin/import failed with HTTP 400: bad bundle");
  });
});

describe("CLI entry points", () => {
  it("writes an export file without printing the token", async () => {
    const dir = tempDir();
    const out = join(dir, "nested", "league.json");
    const logs: string[] = [];
    const errors: string[] = [];
    const fetchImpl = (async () =>
      new Response('{"format":"olb.league/1"}', { status: 200 })) as typeof fetch;

    const code = await leagueExportMain(["--out", out], {
      env: { OLB_TOKEN: "secret-token" },
      log: (message) => logs.push(message),
      logError: (message) => errors.push(message),
      fetchImpl,
    });

    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe('{"format":"olb.league/1"}\n');
    expect(logs.join("\n")).not.toContain("secret-token");
    expect(logs.join("\n")).toContain(out);
    expect(errors).toEqual([]);
  });

  it("prints an import diff and returns 0", async () => {
    const dir = tempDir();
    const file = join(dir, "league.json");
    const logs: string[] = [];
    const calls: string[] = [];
    const created = { ...ZERO, seasons: 1, games: 1 };
    const fetchImpl = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(result({ created })), { status: 201 });
    }) as typeof fetch;

    const code = await leagueImportMain(["--file", file, "--org", "liga-metropolitana"], {
      env: { OLB_TOKEN: "secret-token" },
      log: (message) => logs.push(message),
      logError: (message) => logs.push(message),
      fetchImpl,
      readFile: () => JSON.stringify(BUNDLE),
    });

    expect(code).toBe(0);
    expect(calls[0]).toContain("/admin/import");
    expect(logs.join("\n")).toContain("created: seasons 1");
    expect(logs.join("\n")).toContain("Import applied.");
    expect(logs.join("\n")).not.toContain("secret-token");
  });

  it("returns 1 and prints conflicts", () => {
    const lines = formatImportResult(
      result({
        conflicts: [
          { entity: "team", id: "id-1", key: "slug:tiburones", message: "already exists" },
        ],
      }),
    );
    expect(lines.join("\n")).toContain("conflict team id-1: already exists");
  });

  it("returns 1 on a non-ok response or a client-side org mismatch", async () => {
    const errors: string[] = [];
    const failingFetch = (async () =>
      new Response("boom", { status: 500 })) as typeof fetch;

    const failed = await leagueExportMain(["--out", join(tempDir(), "x.json")], {
      env: { OLB_TOKEN: "tok" },
      log: () => undefined,
      logError: (message) => errors.push(message),
      fetchImpl: failingFetch,
    });
    expect(failed).toBe(1);
    expect(errors.join("\n")).toContain("HTTP 500");

    const mismatch = await leagueImportMain(["--file", "x.json", "--org", "otra"], {
      env: { OLB_TOKEN: "tok" },
      log: () => undefined,
      logError: (message) => errors.push(message),
      fetchImpl: failingFetch,
      readFile: () => JSON.stringify(BUNDLE),
    });
    expect(mismatch).toBe(1);
    expect(errors.join("\n")).toContain("does not match --org otra");
  });
});
