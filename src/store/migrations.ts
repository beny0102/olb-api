import type pg from "pg";

export interface Migration {
  version: string;
  sql: string;
}

/**
 * Versioned DDL. Migrations are append-only: never edit one that has shipped,
 * add a new version instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: "001_league_domain",
    sql: `
CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY,
  home_team text NOT NULL,
  away_team text NOT NULL,
  scheduled_start timestamptz,
  venue text,
  created_at timestamptz NOT NULL,
  seq integer NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS events (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (game_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_unique ON events ((body->>'id'));

CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  author text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS proposals_game_status ON proposals (game_id, status);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS seasons (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  year integer NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'archived')),
  starts_on date,
  ends_on date,
  UNIQUE (organization_id, year)
);

CREATE TABLE IF NOT EXISTS competitions (
  id uuid PRIMARY KEY,
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES competitions(id) ON DELETE SET NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('league', 'division')),
  level integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  abbreviation text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_seasons (
  id uuid PRIMARY KEY,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  season_id uuid NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  competition_id uuid REFERENCES competitions(id) ON DELETE SET NULL,
  name text NOT NULL,
  abbreviation text,
  UNIQUE (team_id, season_id),
  UNIQUE (season_id, name)
);

CREATE TABLE IF NOT EXISTS players (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roster_entries (
  id uuid PRIMARY KEY,
  team_season_id uuid NOT NULL REFERENCES team_seasons(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  jersey text,
  primary_position text,
  eligibility_start date,
  eligibility_end date,
  status text NOT NULL CHECK (status IN ('active', 'inactive')),
  UNIQUE (team_season_id, player_id, eligibility_start)
);

CREATE TABLE IF NOT EXISTS game_summaries (
  game_id uuid PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  home_score integer,
  away_score integer,
  linescore jsonb,
  team_box jsonb,
  source text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS season_id uuid REFERENCES seasons(id),
  ADD COLUMN IF NOT EXISTS competition_id uuid REFERENCES competitions(id),
  ADD COLUMN IF NOT EXISTS home_team_season_id uuid REFERENCES team_seasons(id),
  ADD COLUMN IF NOT EXISTS away_team_season_id uuid REFERENCES team_seasons(id),
  ADD COLUMN IF NOT EXISTS coverage text NOT NULL DEFAULT 'full'
    CHECK (coverage IN ('full', 'summary', 'external')),
  ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'official'
    CHECK (data_source IN ('official', 'team_report', 'import', 'external')),
  ADD COLUMN IF NOT EXISTS rules_profile jsonb;

CREATE INDEX IF NOT EXISTS seasons_org_status ON seasons (organization_id, status);
CREATE INDEX IF NOT EXISTS competitions_season ON competitions (season_id);
CREATE INDEX IF NOT EXISTS team_seasons_season ON team_seasons (season_id);
CREATE INDEX IF NOT EXISTS roster_entries_team ON roster_entries (team_season_id);
CREATE INDEX IF NOT EXISTS games_season ON games (season_id);
CREATE INDEX IF NOT EXISTS games_competition ON games (competition_id);
CREATE INDEX IF NOT EXISTS games_home_team ON games (home_team_season_id);
CREATE INDEX IF NOT EXISTS games_away_team ON games (away_team_season_id);
`,
  },
  {
    version: "002_auth",
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('organization', 'competition', 'team_season')),
  scope_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN (
    'org_admin', 'competition_admin', 'team_admin', 'scorer', 'verifier', 'viewer'
  )),
  created_at timestamptz NOT NULL,
  UNIQUE (user_id, scope_type, scope_id, role)
);

CREATE INDEX IF NOT EXISTS sessions_token_hash ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS memberships_user ON memberships (user_id);
CREATE INDEX IF NOT EXISTS memberships_scope ON memberships (scope_type, scope_id);
`,
  },
];

/**
 * Applies every pending migration in its own transaction. The public
 * `schema_migrations` table is the ledger; a failed migration rolls back the
 * DDL and leaves no version row behind.
 */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM schema_migrations`,
  );
  const applied = new Set(rows.map((row) => row.version));
  const appliedNow: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(migration.sql);
      await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [
        migration.version,
      ]);
      await client.query("COMMIT");
      appliedNow.push(migration.version);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  return appliedNow;
}
