import type pg from "pg";
import { uuidv7 } from "../domain/uuid7.js";
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
  RosterImportAction,
  RosterImportInput,
  RosterImportResult,
  RosterImportRowInput,
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

function sameRosterFields(existing: RosterEntryRecord, row: RosterImportRowInput): boolean {
  return (
    existing.jersey === row.jersey &&
    existing.primaryPosition === row.primaryPosition &&
    existing.eligibilityEnd === row.eligibilityEnd &&
    existing.status === row.status
  );
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

  async updateOrganization(input: OrganizationInput): Promise<OrganizationRecord | null> {
    const { rows } = await this.pool.query<OrganizationRow>(
      `UPDATE organizations SET name = $2, slug = $3 WHERE id = $1
       RETURNING id, name, slug, created_at`,
      [input.id, input.name, input.slug],
    );
    return rows[0] ? toOrganization(rows[0]) : null;
  }

  async updateSeason(input: SeasonInput): Promise<SeasonRecord | null> {
    const { rows } = await this.pool.query<SeasonRow>(
      `UPDATE seasons SET name = $2, year = $3, status = $4,
                          starts_on = $5, ends_on = $6
        WHERE id = $1
       RETURNING id, organization_id, name, year, status,
                 starts_on::text AS starts_on, ends_on::text AS ends_on`,
      [input.id, input.name, input.year, input.status, input.startsOn, input.endsOn],
    );
    return rows[0] ? toSeason(rows[0]) : null;
  }

  async updateCompetition(input: CompetitionInput): Promise<CompetitionRecord | null> {
    const { rows } = await this.pool.query<CompetitionRow>(
      `UPDATE competitions SET parent_id = $2, name = $3, kind = $4,
                               level = $5, sort_order = $6
        WHERE id = $1
       RETURNING id, season_id, parent_id, name, kind, level, sort_order`,
      [
        input.id,
        input.parentId,
        input.name,
        input.kind,
        input.level,
        input.sortOrder,
      ],
    );
    return rows[0] ? toCompetition(rows[0]) : null;
  }

  async updateTeam(input: TeamInput): Promise<TeamRecord | null> {
    const { rows } = await this.pool.query<TeamRow>(
      `UPDATE teams SET name = $2, slug = $3, abbreviation = $4 WHERE id = $1
       RETURNING id, organization_id, name, slug, abbreviation, created_at`,
      [input.id, input.name, input.slug, input.abbreviation],
    );
    return rows[0] ? toTeam(rows[0]) : null;
  }

  async updateTeamSeason(input: TeamSeasonInput): Promise<TeamSeasonRecord | null> {
    const { rows } = await this.pool.query<TeamSeasonRow>(
      `WITH updated AS (
         UPDATE team_seasons
            SET competition_id = $2, name = $3, abbreviation = $4
          WHERE id = $1
          RETURNING *
       )
       SELECT u.id, u.team_id, u.season_id, u.competition_id, u.name, u.abbreviation,
              t.name AS team_name, c.name AS competition_name
         FROM updated u
         JOIN teams t ON t.id = u.team_id
         LEFT JOIN competitions c ON c.id = u.competition_id`,
      [input.id, input.competitionId, input.name, input.abbreviation],
    );
    return rows[0] ? toTeamSeason(rows[0]) : null;
  }

  async updatePlayer(input: PlayerInput): Promise<PlayerRecord | null> {
    const { rows } = await this.pool.query<PlayerRow>(
      `UPDATE players SET first_name = $2, last_name = $3 WHERE id = $1
       RETURNING id, organization_id, first_name, last_name, created_at`,
      [input.id, input.firstName, input.lastName],
    );
    return rows[0] ? toPlayer(rows[0]) : null;
  }

  async updateRosterEntry(input: RosterEntryInput): Promise<RosterEntryRecord | null> {
    const { rows } = await this.pool.query<RosterEntryRow>(
      `WITH updated AS (
         UPDATE roster_entries
            SET jersey = $2, primary_position = $3, eligibility_start = $4,
                eligibility_end = $5, status = $6
          WHERE id = $1
          RETURNING *
       )
       SELECT u.id, u.team_season_id, u.player_id, u.jersey, u.primary_position,
              u.eligibility_start::text AS eligibility_start,
              u.eligibility_end::text AS eligibility_end,
              u.status, p.first_name, p.last_name
         FROM updated u
         JOIN players p ON p.id = u.player_id`,
      [
        input.id,
        input.jersey,
        input.primaryPosition,
        input.eligibilityStart,
        input.eligibilityEnd,
        input.status,
      ],
    );
    return rows[0] ? toRosterEntry(rows[0]) : null;
  }

  async updateGame(input: CreateLeagueGameInput): Promise<LeagueGameRecord | null> {
    const { rows } = await this.pool.query<GameRow>(
      `WITH updated AS (
         UPDATE games
            SET home_team = $2, away_team = $3, scheduled_start = $4, venue = $5,
                season_id = $6, competition_id = $7,
                home_team_season_id = $8, away_team_season_id = $9,
                coverage = $10, data_source = $11, rules_profile = $12
          WHERE id = $1
          RETURNING *
       )
       SELECT u.id, u.season_id, u.competition_id, u.home_team_season_id,
              u.away_team_season_id,
              COALESCE(ht.name, u.home_team) AS home_team,
              COALESCE(awt.name, u.away_team) AS away_team,
              u.scheduled_start, u.venue, u.coverage, u.data_source, u.rules_profile,
              u.created_at, u.seq
         FROM updated u
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
        input.seasonId,
        input.competitionId,
        input.homeTeamSeasonId,
        input.awayTeamSeasonId,
        input.coverage,
        input.dataSource,
        input.rulesProfile,
      ],
    );
    return rows[0] ? toGame(rows[0]) : null;
  }

  async deleteOrganization(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteSeason(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM seasons WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteCompetition(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM competitions WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteTeam(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM teams WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteTeamSeason(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM team_seasons WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deletePlayer(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM players WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteRosterEntry(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM roster_entries WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
  }

  async deleteGame(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`DELETE FROM games WHERE id = $1`, [id]);
    return (rowCount ?? 0) > 0;
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

  async getTeamBySlug(slug: string): Promise<TeamRecord | null> {
    const { rows } = await this.pool.query<TeamRow>(
      `SELECT id, organization_id, name, slug, abbreviation, created_at
         FROM teams WHERE slug = $1`,
      [slug],
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

  async listTeamsByOrganization(organizationId: string): Promise<TeamRecord[]> {
    const { rows } = await this.pool.query<TeamRow>(
      `SELECT id, organization_id, name, slug, abbreviation, created_at
         FROM teams
        WHERE organization_id = $1
        ORDER BY name ASC, id ASC`,
      [organizationId],
    );
    return rows.map(toTeam);
  }

  async listTeamSeasonsBySeason(seasonId: string): Promise<TeamSeasonRecord[]> {
    const { rows } = await this.pool.query<TeamSeasonRow>(
      `${TEAM_SEASON_SELECT}
        WHERE ts.season_id = $1
        ORDER BY ts.name ASC, ts.id ASC`,
      [seasonId],
    );
    return rows.map(toTeamSeason);
  }

  async listTeamSeasonsByTeam(teamId: string): Promise<TeamSeasonRecord[]> {
    const { rows } = await this.pool.query<TeamSeasonRow>(
      `${TEAM_SEASON_SELECT}
        WHERE ts.team_id = $1
        ORDER BY ts.name ASC, ts.id ASC`,
      [teamId],
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

  async findPlayerByName(
    organizationId: string,
    firstName: string,
    lastName: string,
  ): Promise<PlayerRecord | null> {
    const { rows } = await this.pool.query<PlayerRow>(
      `SELECT id, organization_id, first_name, last_name, created_at
         FROM players
        WHERE organization_id = $1
          AND lower(first_name) = lower($2)
          AND lower(last_name) = lower($3)
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
      [organizationId, firstName, lastName],
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

  async listRosterByPlayer(playerId: string): Promise<RosterEntryRecord[]> {
    const { rows } = await this.pool.query<RosterEntryRow>(
      `SELECT re.id, re.team_season_id, re.player_id, re.jersey, re.primary_position,
              re.eligibility_start::text AS eligibility_start,
              re.eligibility_end::text AS eligibility_end,
              re.status, p.first_name, p.last_name
         FROM roster_entries re
         JOIN players p ON p.id = re.player_id
        WHERE re.player_id = $1
        ORDER BY re.team_season_id ASC, re.id ASC`,
      [playerId],
    );
    return rows.map(toRosterEntry);
  }

  async getRosterEntry(id: string): Promise<RosterEntryRecord | null> {
    const { rows } = await this.pool.query<RosterEntryRow>(
      `SELECT re.id, re.team_season_id, re.player_id, re.jersey, re.primary_position,
              re.eligibility_start::text AS eligibility_start,
              re.eligibility_end::text AS eligibility_end,
              re.status, p.first_name, p.last_name
         FROM roster_entries re
         JOIN players p ON p.id = re.player_id
        WHERE re.id = $1`,
      [id],
    );
    return rows[0] ? toRosterEntry(rows[0]) : null;
  }

  async deleteRosterEntriesByPlayer(playerId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM roster_entries WHERE player_id = $1`,
      [playerId],
    );
    return rowCount ?? 0;
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

  async listGamesByTeamSeason(teamSeasonId: string): Promise<LeagueGameRecord[]> {
    const { rows } = await this.pool.query<GameRow>(
      `${GAME_SELECT}
        WHERE g.home_team_season_id = $1 OR g.away_team_season_id = $1
        ORDER BY g.scheduled_start ASC NULLS LAST, g.id ASC`,
      [teamSeasonId],
    );
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

  async importRoster(input: RosterImportInput): Promise<RosterImportResult> {
    const result: RosterImportResult = {
      dryRun: input.dryRun,
      created: { players: 0, rosterEntries: 0 },
      updated: { rosterEntries: 0 },
      unchanged: 0,
      rows: [],
    };
    const client = await this.pool.connect();

    try {
      if (!input.dryRun) await client.query("BEGIN");
      const now = new Date().toISOString();

      for (const row of input.rows) {
        const { rows: playerRows } = await client.query<PlayerRow>(
          `SELECT id, organization_id, first_name, last_name, created_at
             FROM players
            WHERE organization_id = $1
              AND lower(first_name) = lower($2)
              AND lower(last_name) = lower($3)
            ORDER BY created_at ASC, id ASC
            LIMIT 1`,
          [input.organizationId, row.firstName, row.lastName],
        );
        let player = playerRows[0] ? toPlayer(playerRows[0]) : null;
        const playerCreated = player === null;

        if (!player) {
          const id = uuidv7();
          if (input.dryRun) {
            player = {
              id,
              organizationId: input.organizationId,
              firstName: row.firstName,
              lastName: row.lastName,
              createdAt: now,
            };
          } else {
            const { rows: inserted } = await client.query<PlayerRow>(
              `INSERT INTO players (id, organization_id, first_name, last_name, created_at)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, organization_id, first_name, last_name, created_at`,
              [id, input.organizationId, row.firstName, row.lastName, now],
            );
            player = toPlayer(inserted[0]!);
          }
        }

        const { rows: entryRows } = await client.query<RosterEntryRow>(
          `SELECT re.id, re.team_season_id, re.player_id, re.jersey, re.primary_position,
                  re.eligibility_start::text AS eligibility_start,
                  re.eligibility_end::text AS eligibility_end,
                  re.status, p.first_name, p.last_name
             FROM roster_entries re
             JOIN players p ON p.id = re.player_id
            WHERE re.team_season_id = $1
              AND re.player_id = $2
              AND re.eligibility_start IS NOT DISTINCT FROM $3::date
            LIMIT 1`,
          [input.teamSeasonId, player.id, row.eligibilityStart],
        );
        const existing = entryRows[0] ? toRosterEntry(entryRows[0]) : null;
        let action: RosterImportAction;
        let rosterEntryId = existing?.id ?? null;

        if (existing) {
          const changed = !sameRosterFields(existing, row);
          if (changed) {
            result.updated.rosterEntries += 1;
            if (!input.dryRun) {
              await client.query(
                `UPDATE roster_entries
                    SET jersey = $2, primary_position = $3,
                        eligibility_end = $4, status = $5
                  WHERE id = $1`,
                [
                  existing.id,
                  row.jersey,
                  row.primaryPosition,
                  row.eligibilityEnd,
                  row.status,
                ],
              );
            }
            action = "update_roster_entry";
          } else {
            result.unchanged += 1;
            action = "unchanged";
          }
        } else {
          if (playerCreated) result.created.players += 1;
          result.created.rosterEntries += 1;
          if (!input.dryRun) {
            const id = uuidv7();
            await client.query(
              `INSERT INTO roster_entries
                 (id, team_season_id, player_id, jersey, primary_position,
                  eligibility_start, eligibility_end, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                id,
                input.teamSeasonId,
                player.id,
                row.jersey,
                row.primaryPosition,
                row.eligibilityStart,
                row.eligibilityEnd,
                row.status,
              ],
            );
            rosterEntryId = id;
          }
          action = playerCreated ? "create_player" : "create_roster_entry";
        }

        result.rows.push({
          ...row,
          action,
          playerId: playerCreated && input.dryRun ? null : player.id,
          rosterEntryId,
        });
      }

      if (!input.dryRun) await client.query("COMMIT");
      return result;
    } catch (error) {
      if (!input.dryRun) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  async transaction<T>(fn: (store: LeagueStore) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const scoped = new PostgresLeagueStore(client as unknown as pg.Pool);
      const result = await fn(scoped);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
