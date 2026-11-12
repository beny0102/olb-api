import { Injectable } from "@nestjs/common";
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

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareJersey(a: RosterEntryRecord, b: RosterEntryRecord): number {
  const left = a.jersey === null ? Number.POSITIVE_INFINITY : Number(a.jersey);
  const right = b.jersey === null ? Number.POSITIVE_INFINITY : Number(b.jersey);
  return left - right || compareText(a.lastName, b.lastName) || compareText(a.id, b.id);
}

function sameRosterFields(existing: RosterEntryInput, row: RosterImportRowInput): boolean {
  return (
    existing.jersey === row.jersey &&
    existing.primaryPosition === row.primaryPosition &&
    existing.eligibilityEnd === row.eligibilityEnd &&
    existing.status === row.status
  );
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
  private readonly gameSummaries = new Map<string, GameSummaryRecord>();

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

  async upsertGameSummary(input: GameSummaryInput): Promise<GameSummaryRecord> {
    const record: GameSummaryRecord = { ...input };
    this.gameSummaries.set(record.gameId, record);
    return { ...record };
  }

  async updateOrganization(input: OrganizationInput): Promise<OrganizationRecord | null> {
    if (!this.organizations.has(input.id)) return null;
    const record: OrganizationRecord = { ...input };
    this.organizations.set(record.id, record);
    return { ...record };
  }

  async updateSeason(input: SeasonInput): Promise<SeasonRecord | null> {
    if (!this.seasons.has(input.id)) return null;
    const record: SeasonRecord = { ...input };
    this.seasons.set(record.id, record);
    return { ...record };
  }

  async updateCompetition(input: CompetitionInput): Promise<CompetitionRecord | null> {
    if (!this.competitions.has(input.id)) return null;
    const record: CompetitionRecord = { ...input };
    this.competitions.set(record.id, record);
    return { ...record };
  }

  async updateTeam(input: TeamInput): Promise<TeamRecord | null> {
    if (!this.teams.has(input.id)) return null;
    const record: TeamRecord = { ...input };
    this.teams.set(record.id, record);
    return { ...record };
  }

  async updateTeamSeason(input: TeamSeasonInput): Promise<TeamSeasonRecord | null> {
    if (!this.teamSeasons.has(input.id)) return null;
    const record: TeamSeasonInput = { ...input };
    this.teamSeasons.set(record.id, record);
    return this.enrichTeamSeason(record);
  }

  async updatePlayer(input: PlayerInput): Promise<PlayerRecord | null> {
    if (!this.players.has(input.id)) return null;
    const record: PlayerRecord = { ...input };
    this.players.set(record.id, record);
    return { ...record };
  }

  async updateRosterEntry(input: RosterEntryInput): Promise<RosterEntryRecord | null> {
    if (!this.rosterEntries.has(input.id)) return null;
    const record: RosterEntryInput = { ...input };
    this.rosterEntries.set(record.id, record);
    return this.enrichRosterEntry(record);
  }

  async updateGame(input: CreateLeagueGameInput): Promise<LeagueGameRecord | null> {
    const existing = this.games.get(input.id);
    if (!existing) return null;
    const record: LeagueGameRecord = {
      ...input,
      lastSeq: input.lastSeq ?? existing.lastSeq,
    };
    this.games.set(record.id, record);
    return this.enrichGame(record);
  }

  async deleteSeason(id: string): Promise<boolean> {
    return this.seasons.delete(id);
  }

  async deleteCompetition(id: string): Promise<boolean> {
    return this.competitions.delete(id);
  }

  async deleteTeam(id: string): Promise<boolean> {
    return this.teams.delete(id);
  }

  async deleteTeamSeason(id: string): Promise<boolean> {
    return this.teamSeasons.delete(id);
  }

  async deletePlayer(id: string): Promise<boolean> {
    return this.players.delete(id);
  }

  async deleteRosterEntry(id: string): Promise<boolean> {
    return this.rosterEntries.delete(id);
  }

  async deleteGame(id: string): Promise<boolean> {
    this.gameSummaries.delete(id);
    return this.games.delete(id);
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

  async getCompetition(id: string): Promise<CompetitionRecord | null> {
    const record = this.competitions.get(id);
    return record ? { ...record } : null;
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

  async getTeam(id: string): Promise<TeamRecord | null> {
    const record = this.teams.get(id);
    return record ? { ...record } : null;
  }

  async getTeamBySlug(slug: string): Promise<TeamRecord | null> {
    const record = [...this.teams.values()].find((row) => row.slug === slug);
    return record ? { ...record } : null;
  }

  async listTeams(competitionId: string): Promise<TeamSeasonRecord[]> {
    return [...this.teamSeasons.values()]
      .filter((row) => row.competitionId === competitionId)
      .map((row) => this.enrichTeamSeason(row))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  }

  async listTeamSeasonsBySeason(seasonId: string): Promise<TeamSeasonRecord[]> {
    return [...this.teamSeasons.values()]
      .filter((row) => row.seasonId === seasonId)
      .map((row) => this.enrichTeamSeason(row))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  }

  async listTeamSeasonsByTeam(teamId: string): Promise<TeamSeasonRecord[]> {
    return [...this.teamSeasons.values()]
      .filter((row) => row.teamId === teamId)
      .map((row) => this.enrichTeamSeason(row))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
  }

  async getTeamSeason(id: string): Promise<TeamSeasonRecord | null> {
    const record = this.teamSeasons.get(id);
    return record ? this.enrichTeamSeason(record) : null;
  }

  async getPlayer(id: string): Promise<PlayerRecord | null> {
    const record = this.players.get(id);
    return record ? { ...record } : null;
  }

  async findPlayerByName(
    organizationId: string,
    firstName: string,
    lastName: string,
  ): Promise<PlayerRecord | null> {
    const first = firstName.toLowerCase();
    const last = lastName.toLowerCase();
    const record = [...this.players.values()].find(
      (row) =>
        row.organizationId === organizationId &&
        row.firstName.toLowerCase() === first &&
        row.lastName.toLowerCase() === last,
    );
    return record ? { ...record } : null;
  }

  async listRoster(teamSeasonId: string): Promise<RosterEntryRecord[]> {
    return [...this.rosterEntries.values()]
      .filter((row) => row.teamSeasonId === teamSeasonId)
      .map((row) => this.enrichRosterEntry(row))
      .sort(compareJersey);
  }

  async listRosterByPlayer(playerId: string): Promise<RosterEntryRecord[]> {
    return [...this.rosterEntries.values()]
      .filter((row) => row.playerId === playerId)
      .map((row) => this.enrichRosterEntry(row))
      .sort(compareJersey);
  }

  async getRosterEntry(id: string): Promise<RosterEntryRecord | null> {
    const record = this.rosterEntries.get(id);
    return record ? this.enrichRosterEntry(record) : null;
  }

  async deleteRosterEntriesByPlayer(playerId: string): Promise<number> {
    let deleted = 0;
    for (const [id, entry] of this.rosterEntries) {
      if (entry.playerId === playerId) {
        this.rosterEntries.delete(id);
        deleted += 1;
      }
    }
    return deleted;
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

  async listGamesByTeamSeason(teamSeasonId: string): Promise<LeagueGameRecord[]> {
    return [...this.games.values()]
      .filter(
        (row) =>
          row.homeTeamSeasonId === teamSeasonId || row.awayTeamSeasonId === teamSeasonId,
      )
      .sort(
        (a, b) =>
          compareText(a.scheduledStart ?? "", b.scheduledStart ?? "") ||
          compareText(a.id, b.id),
      )
      .map((record) => this.enrichGame(record));
  }

  async getGameSummary(gameId: string): Promise<GameSummaryRecord | null> {
    const record = this.gameSummaries.get(gameId);
    return record ? { ...record } : null;
  }

  async getGame(id: string): Promise<LeagueGameRecord | null> {
    const record = this.games.get(id);
    return record ? this.enrichGame(record) : null;
  }

  async importRoster(input: RosterImportInput): Promise<RosterImportResult> {
    const result: RosterImportResult = {
      dryRun: input.dryRun,
      created: { players: 0, rosterEntries: 0 },
      updated: { rosterEntries: 0 },
      unchanged: 0,
      rows: [],
    };

    for (const row of input.rows) {
      const player = await this.findPlayerByName(
        input.organizationId,
        row.firstName,
        row.lastName,
      );
      const newPlayer: PlayerRecord = player ?? {
        id: uuidv7(),
        organizationId: input.organizationId,
        firstName: row.firstName,
        lastName: row.lastName,
        createdAt: new Date().toISOString(),
      };
      const playerCreated = player === null;

      const existing = [...this.rosterEntries.values()].find(
        (entry) =>
          entry.teamSeasonId === input.teamSeasonId &&
          entry.playerId === newPlayer.id &&
          entry.eligibilityStart === row.eligibilityStart,
      );

      let action: RosterImportAction;
      let rosterEntryId: string | null = existing?.id ?? null;

      if (existing) {
        const changed = !sameRosterFields(existing, row);
        if (changed) {
          result.updated.rosterEntries += 1;
          if (!input.dryRun) {
            this.rosterEntries.set(existing.id, {
              ...existing,
              jersey: row.jersey,
              primaryPosition: row.primaryPosition,
              eligibilityEnd: row.eligibilityEnd,
              status: row.status,
            });
          }
          action = "update_roster_entry";
        } else {
          result.unchanged += 1;
          action = "unchanged";
        }
      } else {
        if (playerCreated) result.created.players += 1;
        result.created.rosterEntries += 1;
        if (playerCreated && !input.dryRun) this.players.set(newPlayer.id, newPlayer);

        const entry: RosterEntryInput = {
          id: uuidv7(),
          teamSeasonId: input.teamSeasonId,
          playerId: newPlayer.id,
          jersey: row.jersey,
          primaryPosition: row.primaryPosition,
          eligibilityStart: row.eligibilityStart,
          eligibilityEnd: row.eligibilityEnd,
          status: row.status,
        };
        if (!input.dryRun) this.rosterEntries.set(entry.id, entry);
        rosterEntryId = input.dryRun ? null : entry.id;
        action = playerCreated ? "create_player" : "create_roster_entry";
      }

      result.rows.push({
        ...row,
        action,
        playerId: player === null && input.dryRun ? null : newPlayer.id,
        rosterEntryId,
      });
    }

    return result;
  }

  async archiveActiveSeasons(organizationId: string, keepId?: string): Promise<number> {
    let archived = 0;
    for (const record of this.seasons.values()) {
      if (
        record.organizationId === organizationId &&
        record.status === "active" &&
        record.id !== keepId
      ) {
        record.status = "archived";
        archived += 1;
      }
    }
    return archived;
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
