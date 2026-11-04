import type { GameState } from "./fold.js";

export interface StandingsGame {
  homeTeam: string;
  awayTeam: string;
  state: GameState;
}

export interface StandingsTeam {
  team: string;
  w: number;
  l: number;
  runsFor: number;
  runsAgainst: number;
  pct: number;
}

export interface Standings {
  games: number;
  teams: StandingsTeam[];
}

function pct(wins: number, losses: number): number {
  const played = wins + losses;
  if (played === 0) return 0;
  return Math.round((wins / played) * 1000) / 1000;
}

/**
 * Standings derived from finished games only. A forfeit is a terminal result
 * like a completed game, so it is included and its final score decides the
 * winner. Labels are compared exactly: there is no team registry yet, so
 * "Tiburones" and "tiburones" are different teams.
 */
export function computeStandings(games: readonly StandingsGame[]): Standings {
  const table = new Map<string, StandingsTeam>();
  let counted = 0;

  for (const game of games) {
    if (game.state.status !== "final" && game.state.status !== "forfeit") continue;
    counted += 1;

    const home = entry(table, game.homeTeam);
    const away = entry(table, game.awayTeam);
    const homeRuns = game.state.score.home;
    const awayRuns = game.state.score.away;

    home.runsFor += homeRuns;
    home.runsAgainst += awayRuns;
    away.runsFor += awayRuns;
    away.runsAgainst += homeRuns;

    if (homeRuns > awayRuns) {
      home.w += 1;
      away.l += 1;
    } else if (awayRuns > homeRuns) {
      away.w += 1;
      home.l += 1;
    }
  }

  const teams = [...table.values()]
    .map((team) => ({ ...team, pct: pct(team.w, team.l) }))
    .sort(
      (a, b) =>
        b.pct - a.pct ||
        b.runsFor - b.runsAgainst - (a.runsFor - a.runsAgainst) ||
        a.team.localeCompare(b.team),
    );

  return { games: counted, teams };
}

function entry(table: Map<string, StandingsTeam>, team: string): StandingsTeam {
  let row = table.get(team);
  if (!row) {
    row = { team, w: 0, l: 0, runsFor: 0, runsAgainst: 0, pct: 0 };
    table.set(team, row);
  }
  return row;
}
