import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module.js";
import { MemoryAuthStore } from "../src/auth/memory-auth.store.js";
import { AUTH_STORE, type AuthStore, type UserRecord } from "../src/auth/auth.store.js";
import { GameNotFoundFilter } from "../src/filters/game-not-found.filter.js";
import {
  loadSetupTokenState,
  removeSetupTokenFile,
  SETUP_TOKEN_STATE,
} from "../src/setup/setup-token.js";
import { LEAGUE_STORE, type LeagueStore } from "../src/store/league.store.js";
import type { SetupTokenState } from "../src/setup/setup-token.js";

const TOKEN = "setup-test-token-4f6c1d2a9b8e7f60";
const VALID_BODY = {
  token: TOKEN,
  organization: { name: "Liga Nueva", slug: "liga-nueva" },
  admin: {
    name: "Admin Nueva",
    email: "Admin@Liga-Nueva.OLB",
    password: "super-secret-123",
  },
};

let openApps: INestApplication[] = [];
let tempDirs: string[] = [];

async function createApp(options: {
  setupToken?: string;
  setupTokenFile?: string;
  overrideAuthStore?: AuthStore;
} = {}): Promise<INestApplication> {
  delete process.env.DATABASE_URL;
  if (options.setupToken === undefined) delete process.env.SETUP_TOKEN;
  else process.env.SETUP_TOKEN = options.setupToken;
  if (options.setupTokenFile === undefined) delete process.env.SETUP_TOKEN_FILE;
  else process.env.SETUP_TOKEN_FILE = options.setupTokenFile;

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.overrideAuthStore) {
    builder = builder.overrideProvider(AUTH_STORE).useValue(options.overrideAuthStore);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GameNotFoundFilter());
  await app.init();
  openApps.push(app);
  return app;
}

function postSetup(app: INestApplication, body: unknown) {
  return request(app.getHttpServer()).post("/setup").send(body);
}

afterEach(async () => {
  await Promise.all(openApps.map((app) => app.close()));
  openApps = [];
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe("setup token resolution", () => {
  it("generates a 0600 token file, reloads it and removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "olb-setup-token-"));
    tempDirs.push(dir);
    const file = join(dir, "nested", ".setup-token");
    const env = { SETUP_TOKEN_FILE: file, NODE_ENV: "production" } as NodeJS.ProcessEnv;

    const generated = loadSetupTokenState(env, () => undefined);
    expect(generated.source).toBe("generated");
    expect(generated.token).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const reloaded = loadSetupTokenState(env, () => undefined);
    expect(reloaded.source).toBe("file");
    expect(reloaded.token).toBe(generated.token);

    removeSetupTokenFile(reloaded, () => undefined);
    expect(existsSync(file)).toBe(false);
  });

  it("prefers SETUP_TOKEN over the token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "olb-setup-token-"));
    tempDirs.push(dir);
    const file = join(dir, ".setup-token");
    writeFileSync(file, "file-token\n", { mode: 0o600 });
    chmodSync(file, 0o600);

    const state = loadSetupTokenState({
      SETUP_TOKEN: "env-token",
      SETUP_TOKEN_FILE: file,
    });
    expect(state).toEqual({ token: "env-token", source: "env", filePath: null });
  });
});

describe("setup HTTP flow", () => {
  let app: INestApplication;

  it("reports required, creates the organization and admin, then answers 409", async () => {
    app = await createApp({ setupToken: TOKEN });

    const before = await request(app.getHttpServer()).get("/setup/status").expect(200);
    expect(before.body).toEqual({ required: true });

    const created = await postSetup(app, VALID_BODY).expect(201);
    expect(created.body.organization).toMatchObject({
      name: "Liga Nueva",
      slug: "liga-nueva",
    });
    expect(created.body.user).toMatchObject({
      email: "admin@liga-nueva.olb",
      name: "Admin Nueva",
      status: "active",
    });
    expect(created.body.user).not.toHaveProperty("passwordHash");
    expect(created.body.membership).toMatchObject({
      scopeType: "organization",
      role: "org_admin",
      scopeId: created.body.organization.id,
    });
    expect(JSON.stringify(created.body)).not.toContain(TOKEN);
    expect(JSON.stringify(created.body)).not.toContain("super-secret-123");
    expect(JSON.stringify(created.body)).not.toContain("scrypt$");

    const after = await request(app.getHttpServer()).get("/setup/status").expect(200);
    expect(after.body).toEqual({ required: false });

    const second = await postSetup(app, VALID_BODY).expect(409);
    expect(JSON.stringify(second.body)).not.toContain(TOKEN);

    const auth = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "admin@liga-nueva.olb", password: "super-secret-123" })
      .expect(200);
    expect(auth.body.user).toMatchObject({ email: "admin@liga-nueva.olb" });
  });

  it("answers 401 for a wrong token and leaves setup open", async () => {
    app = await createApp({ setupToken: TOKEN });

    const response = await postSetup(app, { ...VALID_BODY, token: "nope" }).expect(401);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);

    const status = await request(app.getHttpServer()).get("/setup/status").expect(200);
    expect(status.body).toEqual({ required: true });
  });

  it("validates the request body", async () => {
    app = await createApp({ setupToken: TOKEN });

    const cases: unknown[] = [
      { ...VALID_BODY, organization: undefined },
      { ...VALID_BODY, organization: { name: "Liga" } },
      { ...VALID_BODY, admin: { ...VALID_BODY.admin, password: "short" } },
      { ...VALID_BODY, organization: { name: "Liga", slug: "Liga Nueva" } },
    ];

    for (const body of cases) {
      await postSetup(app, body).expect(400);
    }
  });

  it("rate-limits setup attempts per IP", async () => {
    app = await createApp({ setupToken: TOKEN });

    const wrong = { ...VALID_BODY, token: "wrong" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await postSetup(app, wrong).expect(401);
    }
    await postSetup(app, wrong).expect(429);
  });

  it("removes the token file after a successful setup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "olb-setup-file-"));
    tempDirs.push(dir);
    const file = join(dir, ".setup-token");
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });

    app = await createApp({ setupTokenFile: file });
    const state = app.get<SetupTokenState>(SETUP_TOKEN_STATE);
    expect(state.source).toBe("file");

    await postSetup(app, VALID_BODY).expect(201);
    expect(existsSync(file)).toBe(false);
  });

  it("compensates the organization when user creation fails", async () => {
    class FailingAuthStore extends MemoryAuthStore {
      override async createUser(_input: UserRecord): Promise<UserRecord> {
        throw new Error("simulated user failure");
      }
    }

    app = await createApp({
      setupToken: TOKEN,
      overrideAuthStore: new FailingAuthStore(),
    });
    const league = app.get<LeagueStore>(LEAGUE_STORE);

    await postSetup(app, VALID_BODY).expect(500);

    expect(await league.listOrganizations()).toEqual([]);
    const status = await request(app.getHttpServer()).get("/setup/status").expect(200);
    expect(status.body).toEqual({ required: true });
  });
});
