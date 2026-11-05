import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(await runMigrations(pool)).toEqual(["001_league_domain"]);
    expect(await runMigrations(pool)).toEqual([]);

    const { rows: versions } = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(versions.map((row) => row.version)).toEqual(["001_league_domain"]);

    const store = new PostgresLeagueStore(pool);
    await seedLeague(store);
    await seedLeague(store);

    const { rows } = await pool.query<CountsRow>(
      `SELECT
         (SELECT count(*) FROM organizations)::int AS organizations,
         (SELECT count(*) FROM seasons)::int AS seasons,
         (SELECT count(*) FROM competitions)::int AS competitions,
         (SELECT count(*) FROM teams)::int AS teams,
         (SELECT count(*) FROM players)::int AS players,
         (SELECT count(*) FROM roster_entries)::int AS roster_entries,
         (SELECT count(*) FROM games)::int AS games,
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
      migration_rows: 1,
    });

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
  });
});
