import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedAuth, SEED_AUTH_EMAILS } from "../src/auth/auth-seed.js";
import { SEED_TEAM_SEASON_IDS } from "../src/scripts/league-seed.js";
import { PostgresAuthStore } from "../src/auth/postgres-auth.store.js";
import { seedLeague } from "../src/scripts/league-seed.js";
import { runMigrations } from "../src/store/migrations.js";
import { PostgresLeagueStore } from "../src/store/postgres-league.store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `olb_migrations_${process.pid}`;

interface CountsRow {
  organizations: number;
  seasons: number;
  competitions: number;
  teams: number;
  players: number;
  roster_entries: number;
  games: number;
  users: number;
  sessions: number;
  memberships: number;
  migration_rows: number;
}

describe.skipIf(!databaseUrl)("migrations and seed (postgres)", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    pool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.end();
    }
  });

  it("runs migrations twice, then seeds twice without duplicates", async () => {
    expect(await runMigrations(pool)).toEqual([
      "001_league_domain",
      "002_auth",
      "003_player_privacy",
    ]);
    expect(await runMigrations(pool)).toEqual([]);

    const { rows: versions } = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(versions.map((row) => row.version)).toEqual([
      "001_league_domain",
      "002_auth",
      "003_player_privacy",
    ]);

    const authTables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('users', 'sessions', 'memberships')
        ORDER BY table_name`,
    );
    expect(authTables.rows.map((row) => row.table_name)).toEqual([
      "memberships",
      "sessions",
      "users",
    ]);

    const privacy = await pool.query<{ column_name: string; table_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'players' AND column_name = 'name_public')
            OR (table_name = 'player_consents' AND column_name IN ('guardian_name', 'revoked_at')))
        ORDER BY table_name, column_name`,
    );
    expect(privacy.rows).toEqual([
      { table_name: "player_consents", column_name: "guardian_name" },
      { table_name: "player_consents", column_name: "revoked_at" },
      { table_name: "players", column_name: "name_public" },
    ]);

    const store = new PostgresLeagueStore(pool);
    const authStore = new PostgresAuthStore(pool);
    await seedLeague(store);
    await seedAuth(authStore);
    await seedLeague(store);
    await seedAuth(authStore);

    const { rows } = await pool.query<CountsRow>(
      `SELECT
         (SELECT count(*) FROM organizations)::int AS organizations,
         (SELECT count(*) FROM seasons)::int AS seasons,
         (SELECT count(*) FROM competitions)::int AS competitions,
         (SELECT count(*) FROM teams)::int AS teams,
         (SELECT count(*) FROM players)::int AS players,
         (SELECT count(*) FROM roster_entries)::int AS roster_entries,
         (SELECT count(*) FROM games)::int AS games,
         (SELECT count(*) FROM users)::int AS users,
         (SELECT count(*) FROM sessions)::int AS sessions,
         (SELECT count(*) FROM memberships)::int AS memberships,
         (SELECT count(*) FROM schema_migrations)::int AS migration_rows`,
    );

    expect(rows[0]).toEqual({
      organizations: 1,
      seasons: 1,
      competitions: 2,
      teams: 4,
      players: 72,
      roster_entries: 72,
      games: 8,
      users: 4,
      sessions: 0,
      // Tiburones has two roles: team_admin and scorer.
      memberships: 5,
      migration_rows: 3,
    });

    for (const email of SEED_AUTH_EMAILS) {
      const user = await authStore.getUserByEmail(email);
      expect(user).not.toBeNull();
    }

    const organizations = await store.listOrganizations();
    const seasons = await store.listSeasons(organizations[0]!.id);
    expect(seasons).toHaveLength(1);

    const competitions = await store.listCompetitions(seasons[0]!.id);
    expect(competitions).toHaveLength(2);

    const teams = (
      await Promise.all(competitions.map((row) => store.listTeams(row.id)))
    ).flat();
    expect(teams).toHaveLength(4);
    expect(await store.listGames(seasons[0]!.id)).toHaveLength(8);

    const teamSeasonId = SEED_TEAM_SEASON_IDS[0]!;
    const [hidden] = await store.listRoster(teamSeasonId);
    expect(hidden).toMatchObject({
      namePublic: false,
      displayName: "#2",
      firstName: "Alejandro",
      lastName: "Aguilar",
    });

    await store.createNameConsent({
      id: "0192f3d0-0000-7000-8000-000000009999",
      playerId: hidden!.playerId,
      scope: "public_name",
      guardianName: "Marta Sosa",
      relationship: "madre",
      grantedAt: new Date().toISOString(),
      revokedAt: null,
      recordedBy: null,
    });
    const [published] = await store.listRoster(teamSeasonId);
    expect(published).toMatchObject({
      namePublic: true,
      displayName: "Alejandro Aguilar",
    });

    expect(
      await store.revokeNameConsents(hidden!.playerId, new Date().toISOString()),
    ).toBe(1);
    const [revoked] = await store.listRoster(teamSeasonId);
    expect(revoked).toMatchObject({
      namePublic: false,
      displayName: "#2",
    });
  });
});
