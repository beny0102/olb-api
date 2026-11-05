import { Inject, Injectable } from "@nestjs/common";
import type { Event } from "@olb/contract/types";
import {
  appliedEvents,
  applyEvent,
  initialState,
  type GameState,
} from "../domain/fold.js";
import type {
  CompetitionRecord,
  RosterEntryRecord,
  TeamSeasonRecord,
} from "../store/league.store.js";
import { EVENT_STORE, type EventStore } from "../store/store.js";
import { LeagueService, type StandingGroup } from "./league.service.js";

export interface PlayerIdentity {
  playerId: string;
  player: string;
  teamSeasonId: string;
  team: string;
  jersey: string | null;
  position: string | null;
}

export interface BattingLeader extends PlayerIdentity {
  pa: number;
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  r: number;
  bb: number;
  so: number;
  hbp: number;
  /** Batting average rounded to three decimals, or null when AB is zero. */
  avg: number | null;
}

export interface PitchingLeader extends PlayerIdentity {
  pitches: number;
  so: number;
  bb: number;
  /** Games in which this pitcher threw at least one pitch. */
  appearances: number;
}

export interface SeasonLeaders {
  seasonId: string;
  batting: BattingLeader[];
  pitching: PitchingLeader[];
}

export interface SeasonStats extends SeasonLeaders {
  groups: StandingGroup[];
}

interface BattingTotals {
  pa: number;
  ab: number;
  h: number;
  hr: number;
  rbi: number;
  r: number;
  bb: number;
  so: number;
  hbp: number;
}

interface PitchingTotals {
  pitches: number;
  so: number;
  bb: number;
  games: Set<string>;
}

/**
 * A play code is a hit only when it starts with `S`, `D`, `T` or `HR` and the
 * next character is not a letter. That keeps sacrifices such as `SAC` and
 * `SF` out of the hit and at-bat counts.
 */
function isHit(code: string): boolean {
  return /^(?:HR|[SDT](?![A-Z]))/i.test(code);
}

function isSacrifice(code: string): boolean {
  return /^(?:SAC|SF|SH)/i.test(code);
}

function isWalk(call: string, count: { balls: number; strikes: number }): boolean {
  return (call === "B" || call === "P" || call === "I") && count.balls >= 3;
}

function isStrikeout(call: string, count: { balls: number; strikes: number }): boolean {
  return (
    (call === "C" || call === "S" || call === "Q" || call === "T") && count.strikes >= 2
  );
}

function average(hits: number, atBats: number): number | null {
  if (atBats === 0) return null;
  return Math.round((hits / atBats) * 1000) / 1000;
}

function playerName(entry: RosterEntryRecord): string {
  return `${entry.firstName} ${entry.lastName}`.trim();
}

/**
 * Season leaders are derived from the applied events of `full` games only.
 * Summary and external games have no play-by-play, so they still count in the
 * standings but cannot contribute a batting or pitching line.
 */
@Injectable()
export class StatsService {
  constructor(
    @Inject(LeagueService) private readonly league: LeagueService,
    @Inject(EVENT_STORE) private readonly events: EventStore,
  ) {}

  async getSeasonStats(seasonId: string, competitionId?: string): Promise<SeasonStats> {
    const [groups, leaders] = await Promise.all([
      this.league.getStandings(seasonId, competitionId),
      this.getLeaders(seasonId, competitionId),
    ]);
    return { seasonId, groups, batting: leaders.batting, pitching: leaders.pitching };
  }

  async getLeaders(seasonId: string, competitionId?: string): Promise<SeasonLeaders> {
    // listGames validates the season and the optional competition, including
    // that the competition belongs to the season in the path.
    const games = await this.league.listGames(seasonId, competitionId);
    const overview = await this.league.getSeason(seasonId);
    const competitions = competitionId
      ? overview.competitions.filter((competition) => competition.id === competitionId)
      : overview.competitions;
    const refs = await this.playerIndex(competitions);

    const batting = new Map<string, BattingTotals>();
    const pitching = new Map<string, PitchingTotals>();

    for (const game of games) {
      if (game.coverage !== "full") continue;
      const events = await this.events.listEvents(game.id, 0);
      this.addGame(game.id, events, refs, batting, pitching);
    }

    const battingLeaders = [...batting.entries()]
      .map(([playerId, totals]): BattingLeader => {
        const ref = refs.get(playerId)!;
        return {
          ...ref,
          ...totals,
          avg: average(totals.h, totals.ab),
        };
      })
      .sort(
        (a, b) =>
          (b.avg ?? -1) - (a.avg ?? -1) ||
          b.h - a.h ||
          b.hr - a.hr ||
          b.rbi - a.rbi ||
          a.player.localeCompare(b.player) ||
          a.playerId.localeCompare(b.playerId),
      );

    const pitchingLeaders = [...pitching.entries()]
      .map(([playerId, totals]): PitchingLeader => {
        const ref = refs.get(playerId)!;
        return {
          ...ref,
          pitches: totals.pitches,
          so: totals.so,
          bb: totals.bb,
          appearances: totals.games.size,
        };
      })
      .sort(
        (a, b) =>
          b.so - a.so ||
          b.pitches - a.pitches ||
          a.bb - b.bb ||
          a.player.localeCompare(b.player) ||
          a.playerId.localeCompare(b.playerId),
      );

    return { seasonId, batting: battingLeaders, pitching: pitchingLeaders };
  }

  private async playerIndex(
    competitions: readonly CompetitionRecord[],
  ): Promise<Map<string, PlayerIdentity>> {
    const refs = new Map<string, PlayerIdentity>();

    for (const competition of competitions) {
      for (const teamSeason of await this.league.listTeams(competition.id)) {
        const { roster } = await this.league.getTeamSeason(teamSeason.id);
        for (const entry of roster) {
          if (refs.has(entry.playerId)) continue;
          refs.set(entry.playerId, identity(entry, teamSeason));
        }
      }
    }

    return refs;
  }

  private addGame(
    gameId: string,
    events: readonly Event[],
    refs: Map<string, PlayerIdentity>,
    batting: Map<string, BattingTotals>,
    pitching: Map<string, PitchingTotals>,
  ): void {
    let state: GameState = initialState;

    for (const event of appliedEvents(events)) {
      const before = state;

      if (event.type === "pitch") {
        const { pitcher, batter, call } = event.payload;
        const pitcherRef = refs.get(pitcher);
        const batterRef = refs.get(batter);
        const walk = isWalk(call, before.count);
        const strikeout = isStrikeout(call, before.count);

        if (pitcherRef) {
          const totals = pitchingFor(pitching, pitcherRef);
          totals.pitches += 1;
          totals.games.add(gameId);
          if (walk) totals.bb += 1;
          if (strikeout) totals.so += 1;
        }

        if (batterRef) {
          const totals = battingFor(batting, batterRef);
          if (walk) {
            totals.pa += 1;
            totals.bb += 1;
          } else if (strikeout) {
            totals.pa += 1;
            totals.ab += 1;
            totals.so += 1;
          } else if (call === "H") {
            totals.pa += 1;
            totals.hbp += 1;
          }
        }
      } else if (event.type === "ball_in_play") {
        const { batter, code, runsBattedIn, runnersAdvanced } = event.payload;
        const batterRef = refs.get(batter);
        const sacrifice = isSacrifice(code);
        const hit = !sacrifice && isHit(code);

        if (batterRef) {
          const totals = battingFor(batting, batterRef);
          totals.pa += 1;
          if (!sacrifice) totals.ab += 1;
          if (hit) totals.h += 1;
          if (/^HR/i.test(code)) totals.hr += 1;
          totals.rbi += runsBattedIn;
        }

        for (const advance of runnersAdvanced ?? []) {
          if (advance.to !== "H") continue;
          const runner = refs.get(advance.player);
          if (runner) battingFor(batting, runner).r += 1;
        }
      }

      state = applyEvent(state, event);
    }
  }
}

function identity(entry: RosterEntryRecord, teamSeason: TeamSeasonRecord): PlayerIdentity {
  return {
    playerId: entry.playerId,
    player: playerName(entry),
    teamSeasonId: teamSeason.id,
    team: teamSeason.teamName,
    jersey: entry.jersey,
    position: entry.primaryPosition,
  };
}

function battingFor(
  totals: Map<string, BattingTotals>,
  ref: PlayerIdentity,
): BattingTotals {
  let row = totals.get(ref.playerId);
  if (!row) {
    row = { pa: 0, ab: 0, h: 0, hr: 0, rbi: 0, r: 0, bb: 0, so: 0, hbp: 0 };
    totals.set(ref.playerId, row);
  }
  return row;
}

function pitchingFor(
  totals: Map<string, PitchingTotals>,
  ref: PlayerIdentity,
): PitchingTotals {
  let row = totals.get(ref.playerId);
  if (!row) {
    row = { pitches: 0, so: 0, bb: 0, games: new Set() };
    totals.set(ref.playerId, row);
  }
  return row;
}
