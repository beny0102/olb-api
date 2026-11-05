import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Event } from "@olb/contract/types";
import { foldEvents, type GameStatus } from "../domain/fold.js";
import {
  LEAGUE_STORE,
  type CompetitionRecord,
  type GameSummaryRecord,
  type LeagueGameRecord,
  type LeagueStore,
  type OrganizationRecord,
  type RosterEntryRecord,
  type SeasonRecord,
  type TeamSeasonRecord,
} from "../store/league.store.js";
import { EVENT_STORE, type EventStore } from "../store/store.js";

export interface LeagueGameView extends LeagueGameRecord {
  status: GameStatus;
  score: { home: number; away: number } | null;
}

export interface SeasonOverview {
  season: SeasonRecord;
  competitions: CompetitionRecord[];
}

export interface TeamSeasonView {
  teamSeason: TeamSeasonRecord;
  roster: RosterEntryRecord[];
}

export interface StandingRow {
  teamSeasonId: string;
  team: string;
  w: number;
  l: number;
  runsFor: number;
  runsAgainst: number;
  pct: number;
  gamesPlayed: number;
}

export interface StandingGroup {
  competitionId: string;
  competitionName: string;
  teams: StandingRow[];
}

export interface LeagueGameDetail {
  game: LeagueGameView;
  summary: GameSummaryRecord | null;
}

function pct(wins: number, losses: number): number {
  const decided = wins + losses;
  if (decided === 0) return 0;
  return Math.round((wins / decided) * 1000) / 1000;
}

/**
 * Season reads over the league catalog. A `full` game is projected from its
 * event log; `summary` and `external` games read the stored score, and a game
 * with neither is still scheduled. Standings group by competition and count
 * only terminal results (`final` / `forfeit`).
 */
@Injectable()
export class LeagueService {
  constructor(
    @Inject(LEAGUE_STORE) private readonly league: LeagueStore,
    @Inject(EVENT_STORE) private readonly events: EventStore,
  ) {}

  listOrganizations(): Promise<OrganizationRecord[]> {
    return this.league.listOrganizations();
  }

  async listSeasons(organizationId?: string): Promise<SeasonRecord[]> {
    const seasons = await this.league.listSeasons(organizationId);
    return seasons.sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        b.year - a.year ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  }

  async getSeason(id: string): Promise<SeasonOverview> {
    const season = await this.requireSeason(id);
    return { season, competitions: await this.league.listCompetitions(season.id) };
  }

  async listCompetitions(seasonId: string): Promise<CompetitionRecord[]> {
    const season = await this.requireSeason(seasonId);
    return this.league.listCompetitions(season.id);
  }

  async listTeams(competitionId: string): Promise<TeamSeasonRecord[]> {
    const competition = await this.requireCompetition(competitionId);
    return this.league.listTeams(competition.id);
  }

  async getTeamSeason(id: string): Promise<TeamSeasonView> {
    const teamSeason = await this.league.getTeamSeason(id);
    if (!teamSeason) throw new NotFoundException(`team season ${id} not found`);
    return { teamSeason, roster: await this.league.listRoster(teamSeason.id) };
  }

  async listGames(seasonId: string, competitionId?: string): Promise<LeagueGameView[]> {
    const season = await this.requireSeason(seasonId);
    await this.optionalCompetition(season.id, competitionId);
    const games = await this.league.listGames(season.id, competitionId);
    return Promise.all(games.map((game) => this.gameView(game)));
  }

  async getGame(id: string): Promise<LeagueGameDetail> {
    const game = await this.league.getGame(id);
    if (!game) throw new NotFoundException(`game ${id} not found`);
    return {
      game: await this.gameView(game),
      summary: await this.league.getGameSummary(game.id),
    };
  }

  async getStandings(seasonId: string, competitionId?: string): Promise<StandingGroup[]> {
    const season = await this.requireSeason(seasonId);
    const selected = await this.optionalCompetition(season.id, competitionId);
    const competitions = selected
      ? [selected]
      : await this.league.listCompetitions(season.id);
    const games = await this.league.listGames(season.id, selected?.id);
    const views = await Promise.all(games.map((game) => this.gameView(game)));

    const groups: StandingGroup[] = [];
    for (const competition of competitions) {
      const table = new Map<string, StandingRow>();
      for (const teamSeason of await this.league.listTeams(competition.id)) {
        table.set(teamSeason.id, standing(teamSeason.id, teamSeason.teamName));
      }

      for (const game of views) {
        if (game.competitionId !== competition.id) continue;
        if (game.status !== "final" && game.status !== "forfeit") continue;
        if (game.score === null) continue;
        if (game.homeTeamSeasonId === null || game.awayTeamSeasonId === null) continue;

        const home = rowFor(table, game.homeTeamSeasonId, game.homeTeam);
        const away = rowFor(table, game.awayTeamSeasonId, game.awayTeam);
        home.gamesPlayed += 1;
        away.gamesPlayed += 1;
        home.runsFor += game.score.home;
        home.runsAgainst += game.score.away;
        away.runsFor += game.score.away;
        away.runsAgainst += game.score.home;

        if (game.score.home > game.score.away) {
          home.w += 1;
          away.l += 1;
        } else if (game.score.away > game.score.home) {
          away.w += 1;
          home.l += 1;
        }
      }

      const teams = [...table.values()]
        .map((row) => ({ ...row, pct: pct(row.w, row.l) }))
        .sort(
          (a, b) =>
            b.pct - a.pct ||
            b.w - a.w ||
            a.runsAgainst - b.runsAgainst ||
            a.team.localeCompare(b.team) ||
            a.teamSeasonId.localeCompare(b.teamSeasonId),
        );

      groups.push({
        competitionId: competition.id,
        competitionName: competition.name,
        teams,
      });
    }

    return groups;
  }

  /**
   * One row per game: `full` coverage prefers the log, `summary` / `external`
   * prefer the stored score, and a game with neither remains scheduled.
   */
  private async gameView(game: LeagueGameRecord): Promise<LeagueGameView> {
    const events = await this.events.listEvents(game.id, 0);
    if (game.coverage === "full" && events.length > 0) {
      return this.foldedView(game, events);
    }

    const summary = await this.league.getGameSummary(game.id);
    if (summary && summary.homeScore !== null && summary.awayScore !== null) {
      return {
        ...game,
        status: "final",
        score: { home: summary.homeScore, away: summary.awayScore },
      };
    }

    if (events.length > 0) return this.foldedView(game, events);
    return { ...game, status: "scheduled", score: null };
  }

  private foldedView(game: LeagueGameRecord, events: readonly Event[]): LeagueGameView {
    const state = foldEvents(events);
    return {
      ...game,
      status: state.status,
      score: { home: state.score.home, away: state.score.away },
    };
  }

  private async requireSeason(id: string): Promise<SeasonRecord> {
    const season = await this.league.getSeason(id);
    if (!season) throw new NotFoundException(`season ${id} not found`);
    return season;
  }

  private async requireCompetition(id: string): Promise<CompetitionRecord> {
    const competition = await this.league.getCompetition(id);
    if (!competition) throw new NotFoundException(`competition ${id} not found`);
    return competition;
  }

  /** A competition filter must exist and belong to the season in the path. */
  private async optionalCompetition(
    seasonId: string,
    competitionId?: string,
  ): Promise<CompetitionRecord | undefined> {
    if (competitionId === undefined) return undefined;
    const competition = await this.requireCompetition(competitionId);
    if (competition.seasonId !== seasonId) {
      throw new NotFoundException(`competition ${competitionId} not found in season ${seasonId}`);
    }
    return competition;
  }
}

function standing(teamSeasonId: string, team: string): StandingRow {
  return { teamSeasonId, team, w: 0, l: 0, runsFor: 0, runsAgainst: 0, pct: 0, gamesPlayed: 0 };
}

function rowFor(table: Map<string, StandingRow>, id: string, team: string): StandingRow {
  let row = table.get(id);
  if (!row) {
    row = standing(id, team);
    table.set(id, row);
  }
  return row;
}
