import type pg from "pg";
import type {
  CompetitionInput,
  CompetitionRecord,
  CreateLeagueGameInput,
  GameSummaryInput,
  GameSummaryRecord,
  LeagueGameRecord,
  LeagueStore,
  OrganizationInput,
  OrganizationRecord,
  PlayerInput,
  PlayerRecord,
  RosterEntryInput,
  RosterEntryRecord,
  SeasonInput,
  SeasonRecord,
  TeamInput,
  TeamRecord,
  TeamSeasonInput,
  TeamSeasonRecord,
} from "./league.store.js";

interface OrganizationRow {
  id: string;
  name: string;
  slug: string;
  created_at: Date;
}

interface SeasonRow {
  id: string;
  organization_id: string;
  name: string;
  year: number;
  status: string;
  starts_on: string | null;
  ends_on: string | null;
}

interface CompetitionRow {
  id: string;
  season_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  level: number;
  sort_order: number;
}

interface TeamRow {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  abbreviation: string | null;
  created_at: Date;
}

interface TeamSeasonRow {
  id: string;
  team_id: string;
  season_id: string;
  competition_id: string | null;
  name: string;
  abbreviation: string | null;
  team_name: string;
  competition_name: string | null;
}

interface PlayerRow {
  id: string;
  organization_id: string;
  first_name: string;
  last_name: string;
  created_at: Date;
}

interface RosterEntryRow {
  id: string;
  team_season_id: string;
  player_id: string;
  jersey: string | null;
  primary_position: string | null;
  eligibility_start: string | null;
  eligibility_end: string | null;
  status: string;
  first_name: string;
  last_name: string;
}

interface GameRow {
  id: string;
  season_id: string | null;
  competition_id: string | null;
  home_team_season_id: string | null;
  away_team_season_id: string | null;
  home_team: string;
  away_team: string;
  scheduled_start: Date | null;
  venue: string | null;
  coverage: string;
  data_source: string;
  rules_profile: unknown;
  created_at: Date;
  seq: number;
}

interface GameSummaryRow {
  game_id: string;
  home_score: number | null;
  away_score: number | null;
  linescore: unknown;
  team_box: unknown;
  source: string | null;
  updated_at: Date;
}

function toOrganization(row: OrganizationRow): OrganizationRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.created_at.toISOString(),
  };
}

function toSeason(row: SeasonRow): SeasonRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    year: row.year,
    status: row.status as SeasonRecord["status"],
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  };
}

function toCompetition(row: CompetitionRow): CompetitionRecord {
  return {
    id: row.id,
    seasonId: row.season_id,
    parentId: row.parent_id,
    name: row.name,
    kind: row.kind as CompetitionRecord["kind"],
    level: row.level,
    sortOrder: row.sort_order,
  };
}

function toTeam(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    slug: row.slug,
    abbreviation: row.abbreviation,
    createdAt: row.created_at.toISOString(),
  };
}

function toTeamSeason(row: TeamSeasonRow): TeamSeasonRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    seasonId: row.season_id,
    competitionId: row.competition_id,
    name: row.name,
    abbreviation: row.abbreviation,
    teamName: row.team_name,
    competitionName: row.competition_name,
  };
}

function toPlayer(row: PlayerRow): PlayerRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    firstName: row.first_name,
    lastName: row.last_name,
    createdAt: row.created_at.toISOString(),
  };
}

function toRosterEntry(row: RosterEntryRow): RosterEntryRecord {
  return {
    id: row.id,
    teamSeasonId: row.team_season_id,
    playerId: row.player_id,
    jersey: row.jersey,
    primaryPosition: row.primary_position,
    eligibilityStart: row.eligibility_start,
    eligibilityEnd: row.eligibility_end,
    status: row.status as RosterEntryRecord["status"],
    firstName: row.first_name,
    lastName: row.last_name,
  };
}

function toGame(row: GameRow): LeagueGameRecord {
  return {
    id: row.id,
    seasonId: row.season_id,
    competitionId: row.competition_id,
    homeTeamSeasonId: row.home_team_season_id,
    awayTeamSeasonId: row.away_team_season_id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    scheduledStart: row.scheduled_start ? row.scheduled_start.toISOString() : null,
    venue: row.venue,
    coverage: row.coverage as LeagueGameRecord["coverage"],
    dataSource: row.data_source as LeagueGameRecord["dataSource"],
    rulesProfile: row.rules_profile,
    createdAt: row.created_at.toISOString(),
    lastSeq: row.seq,
  };
}

function toGameSummary(row: GameSummaryRow): GameSummaryRecord {
  return {
    gameId: row.game_id,
    homeScore: row.home_score,
    awayScore: row.away_score,
    linescore: row.linescore,
    teamBox: row.team_box,
    source: row.source,
    updatedAt: row.updated_at.toISOString(),
  };
}

const TEAM_SEASON_SELECT = `
  SELECT ts.id, ts.team_id, ts.season_id, ts.competition_id, ts.name, ts.abbreviation,
         t.name AS team_name, c.name AS competition_name
    FROM team_seasons ts
    JOIN teams t ON t.id = ts.team_id
    LEFT JOIN competitions c ON c.id = ts.competition_id
`;

const GAME_SELECT = `
  SELECT g.id, g.season_id, g.competition_id, g.home_team_season_id, g.away_team_season_id,
         COALESCE(ht.name, g.home_team) AS home_team,
         COALESCE(awt.name, g.away_team) AS away_team,
         g.scheduled_start, g.venue, g.coverage, g.data_source, g.rules_profile,
         g.created_at, g.seq
    FROM games g
    LEFT JOIN team_seasons hts ON hts.id = g.home_team_season_id
    LEFT JOIN teams ht ON ht.id = hts.team_id
    LEFT JOIN team_seasons ats ON ats.id = g.away_team_season_id
    LEFT JOIN teams awt ON awt.id = ats.team_id
`;

/** Postgres league store. Uses the shared pool and upserts by primary key. */
export class PostgresLeagueStore implements LeagueStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: pg.Pool) {}

  async upsertOrganization(input: OrganizationInput): Promise<OrganizationRecord> {
    const { rows } = await this.pool.query<OrganizationRow>(
      `INSERT INTO organizations (id, name, slug, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug
       RETURNING id, name, slug, created_at`,
      [input.id, input.name, input.slug, input.createdAt],
    );
    return toOrganization(rows[0]!);
  }

  async upsertSeason(input: SeasonInput): Promise<SeasonRecord> {
    const { rows } = await this.pool.query<SeasonRow>(
      `INSERT INTO seasons
         (id, organization_id, name, year, status, starts_on, ends_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         name = EXCLUDED.name,
         year = EXCLUDED.year,
         status = EXCLUDED.status,
         starts_on = EXCLUDED.starts_on,
         ends_on = EXCLUDED.ends_on
       RETURNING id, organization_id, name, year, status,
                 starts_on::text AS starts_on, ends_on::text AS ends_on`,
      [
        input.id,
        input.organizationId,
        input.name,
        input.year,
        input.status,
        input.startsOn,
        input.endsOn,
      ],
    );
    return toSeason(rows[0]!);
  }

  async upsertCompetition(input: CompetitionInput): Promise<CompetitionRecord> {
    const { rows } = await this.pool.query<CompetitionRow>(
      `INSERT INTO competitions
         (id, season_id, parent_id, name, kind, level, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         season_id = EXCLUDED.season_id,
         parent_id = EXCLUDED.parent_id,
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         level = EXCLUDED.level,
         sort_order = EXCLUDED.sort_order
       RETURNING id, season_id, parent_id, name, kind, level, sort_order`,
      [
        input.id,
        input.seasonId,
        input.parentId,
        input.name,
        input.kind,
        input.level,
        input.sortOrder,
      ],
    );
    return toCompetition(rows[0]!);
  }

  async upsertTeam(input: TeamInput): Promise<TeamRecord> {
    const { rows } = await this.pool.query<TeamRow>(
      `INSERT INTO teams (id, organization_id, name, slug, abbreviation, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         abbreviation = EXCLUDED.abbreviation
       RETURNING id, organization_id, name, slug, abbreviation, created_at`,
      [
        input.id,
        input.organizationId,
        input.name,
        input.slug,
        input.abbreviation,
        input.createdAt,
      ],
    );
    return toTeam(rows[0]!);
  }

  async upsertTeamSeason(input: TeamSeasonInput): Promise<TeamSeasonRecord> {
    const { rows } = await this.pool.query<TeamSeasonRow>(
      `WITH upsert AS (
         INSERT INTO team_seasons (id, team_id, season_id, competition_id, name, abbreviation)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           team_id = EXCLUDED.team_id,
           season_id = EXCLUDED.season_id,
           competition_id = EXCLUDED.competition_id,
           name = EXCLUDED.name,
           abbreviation = EXCLUDED.abbreviation
         RETURNING *
       )
       SELECT u.id, u.team_id, u.season_id, u.competition_id, u.name, u.abbreviation,
              t.name AS team_name, c.name AS competition_name
         FROM upsert u
         JOIN teams t ON t.id = u.team_id
         LEFT JOIN competitions c ON c.id = u.competition_id`,
      [
        input.id,
        input.teamId,
        input.seasonId,
        input.competitionId,
        input.name,
        input.abbreviation,
      ],
    );
    return toTeamSeason(rows[0]!);
  }

  async upsertPlayer(input: PlayerInput): Promise<PlayerRecord> {
    const { rows } = await this.pool.query<PlayerRow>(
      `INSERT INTO players (id, organization_id, first_name, last_name, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         organization_id = EXCLUDED.organization_id,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name
       RETURNING id, organization_id, first_name, last_name, created_at`,
      [input.id, input.organizationId, input.firstName, input.lastName, input.createdAt],
    );
    return toPlayer(rows[0]!);
  }

  async upsertRosterEntry(input: RosterEntryInput): Promise<RosterEntryRecord> {
    const { rows } = await this.pool.query<RosterEntryRow>(
      `WITH upsert AS (
         INSERT INTO roster_entries
           (id, team_season_id, player_id, jersey, primary_position,
            eligibility_start, eligibility_end, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           team_season_id = EXCLUDED.team_season_id,
           player_id = EXCLUDED.player_id,
           jersey = EXCLUDED.jersey,
           primary_position = EXCLUDED.primary_position,
           eligibility_start = EXCLUDED.eligibility_start,
           eligibility_end = EXCLUDED.eligibility_end,
           status = EXCLUDED.status
         RETURNING *
       )
       SELECT u.id, u.team_season_id, u.player_id, u.jersey, u.primary_position,
              u.eligibility_start::text AS eligibility_start,
              u.eligibility_end::text AS eligibility_end,
              u.status, p.first_name, p.last_name
         FROM upsert u
         JOIN players p ON p.id = u.player_id`,
      [
        input.id,
        input.teamSeasonId,
        input.playerId,
        input.jersey,
        input.primaryPosition,
        input.eligibilityStart,
        input.eligibilityEnd,
        input.status,
      ],
    );
    return toRosterEntry(rows[0]!);
  }

  async upsertGame(input: CreateLeagueGameInput): Promise<LeagueGameRecord> {
    const { rows } = await this.pool.query<GameRow>(
      `WITH upsert AS (
         INSERT INTO games
           (id, home_team, away_team, scheduled_start, venue, created_at, seq,
            season_id, competition_id, home_team_season_id, away_team_season_id,
            coverage, data_source, rules_profile)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET
           home_team = EXCLUDED.home_team,
           away_team = EXCLUDED.away_team,
           scheduled_start = EXCLUDED.scheduled_start,
           venue = EXCLUDED.venue,
           season_id = EXCLUDED.season_id,
           competition_id = EXCLUDED.competition_id,
           home_team_season_id = EXCLUDED.home_team_season_id,
           away_team_season_id = EXCLUDED.away_team_season_id,
           coverage = EXCLUDED.coverage,
           data_source = EXCLUDED.data_source,
           rules_profile = EXCLUDED.rules_profile
         RETURNING *
       )
       SELECT u.id, u.season_id, u.competition_id, u.home_team_season_id,
              u.away_team_season_id,
              COALESCE(ht.name, u.home_team) AS home_team,
              COALESCE(awt.name, u.away_team) AS away_team,
              u.scheduled_start, u.venue, u.coverage, u.data_source, u.rules_profile,
              u.created_at, u.seq
         FROM upsert u
         LEFT JOIN team_seasons hts ON hts.id = u.home_team_season_id
         LEFT JOIN teams ht ON ht.id = hts.team_id
         LEFT JOIN team_seasons ats ON ats.id = u.away_team_season_id
         LEFT JOIN teams awt ON awt.id = ats.team_id`,
      [
        input.id,
        input.homeTeam,
        input.awayTeam,
        input.scheduledStart,
        input.venue,
        input.createdAt,
        input.lastSeq ?? -1,
        input.seasonId,
        input.competitionId,
        input.homeTeamSeasonId,
        input.awayTeamSeasonId,
        input.coverage,
        input.dataSource,
        input.rulesProfile,
      ],
    );
    return toGame(rows[0]!);
  }

  async upsertGameSummary(input: GameSummaryInput): Promise<GameSummaryRecord> {
    const { rows } = await this.pool.query<GameSummaryRow>(
      `INSERT INTO game_summaries
         (game_id, home_score, away_score, linescore, team_box, source, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (game_id) DO UPDATE SET
         home_score = EXCLUDED.home_score,
         away_score = EXCLUDED.away_score,
         linescore = EXCLUDED.linescore,
         team_box = EXCLUDED.team_box,
         source = EXCLUDED.source,
         updated_at = EXCLUDED.updated_at
       RETURNING game_id, home_score, away_score, linescore, team_box, source, updated_at`,
      [
        input.gameId,
        input.homeScore,
        input.awayScore,
        input.linescore,
        input.teamBox,
        input.source,
        input.updatedAt,
      ],
    );
    return toGameSummary(rows[0]!);
  }

  async listOrganizations(): Promise<OrganizationRecord[]> {
    const { rows } = await this.pool.query<OrganizationRow>(
      `SELECT id, name, slug, created_at FROM organizations ORDER BY name ASC, id ASC`,
    );
    return rows.map(toOrganization);
  }

  async getSeason(id: string): Promise<SeasonRecord | null> {
    const { rows } = await this.pool.query<SeasonRow>(
      `SELECT id, organization_id, name, year, status,
              starts_on::text AS starts_on, ends_on::text AS ends_on
         FROM seasons WHERE id = $1`,
      [id],
    );
    return rows[0] ? toSeason(rows[0]) : null;
  }

  async listSeasons(organizationId?: string): Promise<SeasonRecord[]> {
    const params: unknown[] = [];
    let query = `SELECT id, organization_id, name, year, status,
                        starts_on::text AS starts_on, ends_on::text AS ends_on
                   FROM seasons`;
    if (organizationId !== undefined) {
      params.push(organizationId);
      query += ` WHERE organization_id = $1`;
    }
    query += ` ORDER BY year DESC, name ASC, id ASC`;

    const { rows } = await this.pool.query<SeasonRow>(query, params);
    return rows.map(toSeason);
  }

  async getCompetition(id: string): Promise<CompetitionRecord | null> {
    const { rows } = await this.pool.query<CompetitionRow>(
      `SELECT id, season_id, parent_id, name, kind, level, sort_order
         FROM competitions WHERE id = $1`,
      [id],
    );
    return rows[0] ? toCompetition(rows[0]) : null;
  }

  async listCompetitions(seasonId: string): Promise<CompetitionRecord[]> {
    const { rows } = await this.pool.query<CompetitionRow>(
      `SELECT id, season_id, parent_id, name, kind, level, sort_order
         FROM competitions WHERE season_id = $1
        ORDER BY sort_order ASC, name ASC, id ASC`,
      [seasonId],
    );
    return rows.map(toCompetition);
  }

  async getTeam(id: string): Promise<TeamRecord | null> {
    const { rows } = await this.pool.query<TeamRow>(
      `SELECT id, organization_id, name, slug, abbreviation, created_at
         FROM teams WHERE id = $1`,
      [id],
    );
    return rows[0] ? toTeam(rows[0]) : null;
  }

  async listTeams(competitionId: string): Promise<TeamSeasonRecord[]> {
    const { rows } = await this.pool.query<TeamSeasonRow>(
      `${TEAM_SEASON_SELECT}
        WHERE ts.competition_id = $1
        ORDER BY ts.name ASC, ts.id ASC`,
      [competitionId],
    );
    return rows.map(toTeamSeason);
  }

  async getTeamSeason(id: string): Promise<TeamSeasonRecord | null> {
    const { rows } = await this.pool.query<TeamSeasonRow>(
      `${TEAM_SEASON_SELECT} WHERE ts.id = $1`,
      [id],
    );
    return rows[0] ? toTeamSeason(rows[0]) : null;
  }

  async getPlayer(id: string): Promise<PlayerRecord | null> {
    const { rows } = await this.pool.query<PlayerRow>(
      `SELECT id, organization_id, first_name, last_name, created_at
         FROM players WHERE id = $1`,
      [id],
    );
    return rows[0] ? toPlayer(rows[0]) : null;
  }

  async listRoster(teamSeasonId: string): Promise<RosterEntryRecord[]> {
    const { rows } = await this.pool.query<RosterEntryRow>(
      `SELECT re.id, re.team_season_id, re.player_id, re.jersey, re.primary_position,
              re.eligibility_start::text AS eligibility_start,
              re.eligibility_end::text AS eligibility_end,
              re.status, p.first_name, p.last_name
         FROM roster_entries re
         JOIN players p ON p.id = re.player_id
        WHERE re.team_season_id = $1
        ORDER BY NULLIF(regexp_replace(coalesce(re.jersey, ''), '[^0-9]', '', 'g'), '')::int
                 NULLS LAST,
                 p.last_name ASC, re.id ASC`,
      [teamSeasonId],
    );
    return rows.map(toRosterEntry);
  }

  async listGames(seasonId: string, competitionId?: string): Promise<LeagueGameRecord[]> {
    const params: unknown[] = [seasonId];
    let query = `${GAME_SELECT} WHERE g.season_id = $1`;
    if (competitionId !== undefined) {
      params.push(competitionId);
      query += ` AND g.competition_id = $2`;
    }
    query += ` ORDER BY g.scheduled_start ASC NULLS LAST, g.id ASC`;

    const { rows } = await this.pool.query<GameRow>(query, params);
    return rows.map(toGame);
  }

  async getGameSummary(gameId: string): Promise<GameSummaryRecord | null> {
    const { rows } = await this.pool.query<GameSummaryRow>(
      `SELECT game_id, home_score, away_score, linescore, team_box, source, updated_at
         FROM game_summaries WHERE game_id = $1`,
      [gameId],
    );
    return rows[0] ? toGameSummary(rows[0]) : null;
  }

  async getGame(id: string): Promise<LeagueGameRecord | null> {
    const { rows } = await this.pool.query<GameRow>(`${GAME_SELECT} WHERE g.id = $1`, [id]);
    return rows[0] ? toGame(rows[0]) : null;
  }

  async archiveActiveSeasons(organizationId: string, keepId?: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE seasons SET status = 'archived'
        WHERE organization_id = $1
          AND status = 'active'
          AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [organizationId, keepId ?? null],
    );
    return rowCount ?? 0;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
