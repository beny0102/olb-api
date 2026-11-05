import { Injectable } from "@nestjs/common";
import type {
  CompetitionInput,
  CompetitionRecord,
  CreateLeagueGameInput,
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareJersey(a: RosterEntryRecord, b: RosterEntryRecord): number {
  const left = a.jersey === null ? Number.POSITIVE_INFINITY : Number(a.jersey);
  const right = b.jersey === null ? Number.POSITIVE_INFINITY : Number(b.jersey);
  return left - right || compareText(a.lastName, b.lastName) || compareText(a.id, b.id);
}

/**
 * In-memory league catalog for development and the default test path. Upserts
 * respect the same natural keys as the Postgres unique constraints so seeding
 * twice is a no-op in both stores.
 */
@Injectable()
export class MemoryLeagueStore implements LeagueStore {
  readonly kind = "memory" as const;

  private readonly organizations = new Map<string, OrganizationRecord>();
  private readonly seasons = new Map<string, SeasonRecord>();
  private readonly competitions = new Map<string, CompetitionRecord>();
  private readonly teams = new Map<string, TeamRecord>();
  private readonly teamSeasons = new Map<string, TeamSeasonInput>();
  private readonly players = new Map<string, PlayerRecord>();
  private readonly rosterEntries = new Map<string, RosterEntryInput>();
  private readonly games = new Map<string, LeagueGameRecord>();

  async upsertOrganization(input: OrganizationInput): Promise<OrganizationRecord> {
    const existing = [...this.organizations.values()].find((row) => row.slug === input.slug);
    const record: OrganizationRecord = { ...input, id: existing?.id ?? input.id };
    this.organizations.set(record.id, record);
    return { ...record };
  }

  async upsertSeason(input: SeasonInput): Promise<SeasonRecord> {
    const existing = [...this.seasons.values()].find(
      (row) => row.organizationId === input.organizationId && row.year === input.year,
    );
    const record: SeasonRecord = { ...input, id: existing?.id ?? input.id };
    this.seasons.set(record.id, record);
    return { ...record };
  }

  async upsertCompetition(input: CompetitionInput): Promise<CompetitionRecord> {
    const record: CompetitionRecord = { ...input };
    this.competitions.set(record.id, record);
    return { ...record };
  }

  async upsertTeam(input: TeamInput): Promise<TeamRecord> {
    const existing = [...this.teams.values()].find((row) => row.slug === input.slug);
    const record: TeamRecord = { ...input, id: existing?.id ?? input.id };
    this.teams.set(record.id, record);
    return { ...record };
  }

  async upsertTeamSeason(input: TeamSeasonInput): Promise<TeamSeasonRecord> {
    const existing = [...this.teamSeasons.values()].find(
      (row) => row.teamId === input.teamId && row.seasonId === input.seasonId,
    );
    const record: TeamSeasonInput = { ...input, id: existing?.id ?? input.id };
    this.teamSeasons.set(record.id, record);
    return this.enrichTeamSeason(record);
  }

  async upsertPlayer(input: PlayerInput): Promise<PlayerRecord> {
    const record: PlayerRecord = { ...input };
    this.players.set(record.id, record);
    return { ...record };
  }

  async upsertRosterEntry(input: RosterEntryInput): Promise<RosterEntryRecord> {
    const existing = [...this.rosterEntries.values()].find(
      (row) =>
        row.teamSeasonId === input.teamSeasonId &&
        row.playerId === input.playerId &&
        row.eligibilityStart === input.eligibilityStart,
    );
    const record: RosterEntryInput = { ...input, id: existing?.id ?? input.id };
    this.rosterEntries.set(record.id, record);
    return this.enrichRosterEntry(record);
  }

  async upsertGame(input: CreateLeagueGameInput): Promise<LeagueGameRecord> {
    const record: LeagueGameRecord = { ...input, lastSeq: input.lastSeq ?? -1 };
    this.games.set(record.id, record);
    return this.enrichGame(record);
  }

  async listOrganizations(): Promise<OrganizationRecord[]> {
    return [...this.organizations.values()]
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
      .map((record) => ({ ...record }));
  }

  async getSeason(id: string): Promise<SeasonRecord | null> {
    const record = this.seasons.get(id);
    return record ? { ...record } : null;
  }

  async listSeasons(organizationId?: string): Promise<SeasonRecord[]> {
    return [...this.seasons.values()]
      .filter((row) => organizationId === undefined || row.organizationId === organizationId)
      .sort((a, b) => b.year - a.year || compareText(a.name, b.name) || compareText(a.id, b.id))
      .map((record) => ({ ...record }));
  }

  async listCompetitions(seasonId: string): Promise<CompetitionRecord[]> {
    return [...this.competitions.values()]
      .filter((row) => row.seasonId === seasonId)
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || compareText(a.name, b.name) || compareText(a.id, b.id),
      )
      .map((record) => ({ ...record }));
  }

  async listTeams(competitionId: string): Promise<TeamSeasonRecord[]> {
    return [...this.teamSeasons.values()]
      .filter((row) => row.competitionId === competitionId)
      .map((row) => this.enrichTeamSeason(row))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  }

  async getTeamSeason(id: string): Promise<TeamSeasonRecord | null> {
    const record = this.teamSeasons.get(id);
    return record ? this.enrichTeamSeason(record) : null;
  }

  async listRoster(teamSeasonId: string): Promise<RosterEntryRecord[]> {
    return [...this.rosterEntries.values()]
      .filter((row) => row.teamSeasonId === teamSeasonId)
      .map((row) => this.enrichRosterEntry(row))
      .sort(compareJersey);
  }

  async listGames(seasonId: string, competitionId?: string): Promise<LeagueGameRecord[]> {
    return [...this.games.values()]
      .filter(
        (row) =>
          row.seasonId === seasonId &&
          (competitionId === undefined || row.competitionId === competitionId),
      )
      .sort(
        (a, b) =>
          compareText(a.scheduledStart ?? "", b.scheduledStart ?? "") ||
          compareText(a.id, b.id),
      )
      .map((record) => this.enrichGame(record));
  }

  async ping(): Promise<void> {
    return;
  }

  private enrichTeamSeason(record: TeamSeasonInput): TeamSeasonRecord {
    const team = this.teams.get(record.teamId);
    const competition =
      record.competitionId === null ? undefined : this.competitions.get(record.competitionId);
    return {
      ...record,
      teamName: team?.name ?? record.name,
      competitionName: competition?.name ?? null,
    };
  }

  private enrichRosterEntry(record: RosterEntryInput): RosterEntryRecord {
    const player = this.players.get(record.playerId);
    return {
      ...record,
      firstName: player?.firstName ?? "",
      lastName: player?.lastName ?? "",
    };
  }

  private enrichGame(record: LeagueGameRecord): LeagueGameRecord {
    const homeSeason =
      record.homeTeamSeasonId === null ? undefined : this.teamSeasons.get(record.homeTeamSeasonId);
    const awaySeason =
      record.awayTeamSeasonId === null ? undefined : this.teamSeasons.get(record.awayTeamSeasonId);
    const homeTeam = homeSeason
      ? (this.teams.get(homeSeason.teamId)?.name ?? record.homeTeam)
      : record.homeTeam;
    const awayTeam = awaySeason
      ? (this.teams.get(awaySeason.teamId)?.name ?? record.awayTeam)
      : record.awayTeam;

    return { ...record, homeTeam, awayTeam };
  }
}
