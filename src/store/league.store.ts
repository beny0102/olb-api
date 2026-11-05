export type SeasonStatus = "active" | "archived";
export type CompetitionKind = "league" | "division";
export type RosterStatus = "active" | "inactive";
export type GameCoverage = "full" | "summary" | "external";
export type GameDataSource = "official" | "team_report" | "import" | "external";

export interface OrganizationInput {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export type OrganizationRecord = OrganizationInput;

export interface SeasonInput {
  id: string;
  organizationId: string;
  name: string;
  year: number;
  status: SeasonStatus;
  startsOn: string | null;
  endsOn: string | null;
}

export type SeasonRecord = SeasonInput;

export interface CompetitionInput {
  id: string;
  seasonId: string;
  parentId: string | null;
  name: string;
  kind: CompetitionKind;
  level: number;
  sortOrder: number;
}

export type CompetitionRecord = CompetitionInput;

export interface TeamInput {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  abbreviation: string | null;
  createdAt: string;
}

export type TeamRecord = TeamInput;

export interface TeamSeasonInput {
  id: string;
  teamId: string;
  seasonId: string;
  competitionId: string | null;
  name: string;
  abbreviation: string | null;
}

export interface TeamSeasonRecord extends TeamSeasonInput {
  teamName: string;
  competitionName: string | null;
}

export interface PlayerInput {
  id: string;
  organizationId: string;
  firstName: string;
  lastName: string;
  createdAt: string;
}

export type PlayerRecord = PlayerInput;

export interface RosterEntryInput {
  id: string;
  teamSeasonId: string;
  playerId: string;
  jersey: string | null;
  primaryPosition: string | null;
  eligibilityStart: string | null;
  eligibilityEnd: string | null;
  status: RosterStatus;
}

export interface RosterEntryRecord extends RosterEntryInput {
  firstName: string;
  lastName: string;
}

export interface CreateLeagueGameInput {
  id: string;
  seasonId: string | null;
  competitionId: string | null;
  homeTeamSeasonId: string | null;
  awayTeamSeasonId: string | null;
  homeTeam: string;
  awayTeam: string;
  scheduledStart: string | null;
  venue: string | null;
  coverage: GameCoverage;
  dataSource: GameDataSource;
  rulesProfile: unknown;
  createdAt: string;
  lastSeq?: number;
}

export interface LeagueGameRecord {
  id: string;
  seasonId: string | null;
  competitionId: string | null;
  homeTeamSeasonId: string | null;
  awayTeamSeasonId: string | null;
  homeTeam: string;
  awayTeam: string;
  scheduledStart: string | null;
  venue: string | null;
  coverage: GameCoverage;
  dataSource: GameDataSource;
  rulesProfile: unknown;
  createdAt: string;
  lastSeq: number;
}

/**
 * A stored score for a game whose log is not in this system: `summary` games
 * have a linescore and box score, `external` games may have only the final.
 * The event log remains authoritative for `full` coverage.
 */
export interface GameSummaryInput {
  gameId: string;
  homeScore: number | null;
  awayScore: number | null;
  linescore: unknown;
  teamBox: unknown;
  source: string | null;
  updatedAt: string;
}

export type GameSummaryRecord = GameSummaryInput;

/**
 * League catalog reads and idempotent seed upserts. This is separate from
 * `EventStore`: a league row is descriptive metadata, while the event log
 * remains the only source of truth for a game's state and score.
 */
export interface LeagueStore {
  readonly kind: "memory" | "postgres";

  upsertOrganization(input: OrganizationInput): Promise<OrganizationRecord>;
  upsertSeason(input: SeasonInput): Promise<SeasonRecord>;
  upsertCompetition(input: CompetitionInput): Promise<CompetitionRecord>;
  upsertTeam(input: TeamInput): Promise<TeamRecord>;
  upsertTeamSeason(input: TeamSeasonInput): Promise<TeamSeasonRecord>;
  upsertPlayer(input: PlayerInput): Promise<PlayerRecord>;
  upsertRosterEntry(input: RosterEntryInput): Promise<RosterEntryRecord>;
  upsertGame(input: CreateLeagueGameInput): Promise<LeagueGameRecord>;
  upsertGameSummary(input: GameSummaryInput): Promise<GameSummaryRecord>;

  listOrganizations(): Promise<OrganizationRecord[]>;
  getSeason(id: string): Promise<SeasonRecord | null>;
  listSeasons(organizationId?: string): Promise<SeasonRecord[]>;
  getCompetition(id: string): Promise<CompetitionRecord | null>;
  listCompetitions(seasonId: string): Promise<CompetitionRecord[]>;
  getTeam(id: string): Promise<TeamRecord | null>;
  listTeams(competitionId: string): Promise<TeamSeasonRecord[]>;
  getTeamSeason(id: string): Promise<TeamSeasonRecord | null>;
  getPlayer(id: string): Promise<PlayerRecord | null>;
  listRoster(teamSeasonId: string): Promise<RosterEntryRecord[]>;
  /** Archives every active season of an organization except `keepId`. */
  archiveActiveSeasons(organizationId: string, keepId?: string): Promise<number>;
  listGames(seasonId: string, competitionId?: string): Promise<LeagueGameRecord[]>;
  getGame(id: string): Promise<LeagueGameRecord | null>;
  getGameSummary(gameId: string): Promise<GameSummaryRecord | null>;

  ping(): Promise<void>;
}

export const LEAGUE_STORE = Symbol("LEAGUE_STORE");
