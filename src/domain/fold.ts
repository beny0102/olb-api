import type { Event, FieldingPosition, RulesProfile } from "@olb/contract/types";

export type GameStatus = "scheduled" | "live" | "final" | "suspended" | "forfeit";
export type HalfInning = "top" | "bottom";
export type TeamSide = "home" | "away";

export interface LineupSlot {
  player: string;
  position: FieldingPosition;
}

export interface LineupState {
  battingOrder: LineupSlot[];
  pitcher?: string;
  dh?: boolean;
}

export type Lineups = { home: LineupState; away: LineupState };

type Bases = GameState["bases"];
type BaseKey = keyof Bases;

/**
 * The projection served by GET /games/:id/state and by realtime snapshots.
 * It matches `gameState` in the contract's common schema.
 */
export interface GameState {
  status: GameStatus;
  inning: number;
  half: HalfInning;
  outs: number;
  count: { balls: number; strikes: number };
  bases: { first: string | null; second: string | null; third: string | null };
  score: { home: number; away: number };
  battingTeam: TeamSide;
  lastSeq: number;
  lineups: Lineups | null;
  batter: string | null;
  pitcher: string | null;
  pitchCounts: Record<string, number>;
  rules: RulesProfile | null;
}

export const initialState: GameState = {
  status: "scheduled",
  inning: 1,
  half: "top",
  outs: 0,
  count: { balls: 0, strikes: 0 },
  bases: { first: null, second: null, third: null },
  score: { home: 0, away: 0 },
  battingTeam: "away",
  lastSeq: 0,
  lineups: null,
  batter: null,
  pitcher: null,
  pitchCounts: {},
  rules: null,
};

const cleanCount = { balls: 0, strikes: 0 };
const emptyBases = { first: null, second: null, third: null } as const;

function baseKey(base: "1" | "2" | "3"): BaseKey {
  return base === "1" ? "first" : base === "2" ? "second" : "third";
}

function otherSide(side: TeamSide): TeamSide {
  return side === "home" ? "away" : "home";
}

function emptyLineup(): LineupState {
  return { battingOrder: [] };
}

/**
 * Keeps the exposed `lineups` object complete: the contract requires both
 * sides once the field is present, and a side whose lineup has not arrived
 * yet is represented by an empty batting order rather than invented players.
 */
function withLineup(
  lineups: Lineups | null,
  side: TeamSide,
  lineup: LineupState,
): Lineups {
  const next: Lineups = {
    home: lineups?.home ?? emptyLineup(),
    away: lineups?.away ?? emptyLineup(),
  };
  next[side] = lineup;
  return next;
}

function battingPointer(
  lineups: Lineups | null,
  battingTeam: TeamSide,
): { batter: string | null; pitcher: string | null } {
  if (!lineups) return { batter: null, pitcher: null };
  return {
    batter: lineups[battingTeam].battingOrder[0]?.player ?? null,
    pitcher: lineups[otherSide(battingTeam)].pitcher ?? null,
  };
}

/**
 * A walk moves only the runners that are forced. The batter always takes
 * first; a runner on third scores only when first and second are occupied.
 */
function forcedAdvance(bases: Bases, batter: string): { bases: Bases; runScored: boolean } {
  const next: Bases = { ...bases };

  if (next.first === null) {
    next.first = batter;
    return { bases: next, runScored: false };
  }
  if (next.second === null) {
    next.second = next.first;
    next.first = batter;
    return { bases: next, runScored: false };
  }
  if (next.third === null) {
    next.third = next.second;
    next.second = next.first;
    next.first = batter;
    return { bases: next, runScored: false };
  }

  // Bases loaded: the runner on third is forced home.
  next.third = next.second;
  next.second = next.first;
  next.first = batter;
  return { bases: next, runScored: true };
}

/**
 * Folds one event into the projection. Pure: returns a new object and never
 * mutates its input, so a caller can fold any prefix of the log to get the
 * state as of that sequence number.
 *
 * The contract caps `count` at 3-2, so the walk and the strikeout are decided
 * here from the fold's own counter before the counter is reset. A fourth ball
 * and a third strike therefore never leak a value the contract rejects.
 */
export function applyEvent(state: GameState, event: Event): GameState {
  const base: GameState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case "game.start":
      return {
        ...base,
        status: "live",
        inning: 1,
        half: "top",
        outs: 0,
        count: { ...cleanCount },
        bases: { ...emptyBases },
        score: { home: 0, away: 0 },
        battingTeam: "away",
        lineups: null,
        batter: null,
        pitcher: null,
        pitchCounts: {},
        rules: event.payload.rules ?? null,
      };

    case "pitch": {
      const { call, batter, pitcher } = event.payload;
      const count = { ...state.count };
      const side = state.battingTeam;
      const pitchBase: GameState = {
        ...base,
        pitchCounts: {
          ...state.pitchCounts,
          [pitcher]: (state.pitchCounts[pitcher] ?? 0) + 1,
        },
      };

      // B, P and I are balls; a fourth one is a walk, not a stored count of 4.
      if (call === "B" || call === "P" || call === "I") {
        count.balls += 1;
        if (count.balls >= 4) {
          const advance = forcedAdvance(state.bases, batter);
          return {
            ...pitchBase,
            count: { ...cleanCount },
            bases: advance.bases,
            score: advance.runScored
              ? { ...state.score, [side]: state.score[side] + 1 }
              : state.score,
          };
        }
        return { ...pitchBase, count };
      }

      // H is a hit by pitch: the batter is awarded first base and only the
      // runners it forces advance, exactly as on a walk. The plate appearance
      // ends and the count resets.
      if (call === "H") {
        const advance = forcedAdvance(state.bases, batter);
        return {
          ...pitchBase,
          count: { ...cleanCount },
          bases: advance.bases,
          score: advance.runScored
            ? { ...state.score, [side]: state.score[side] + 1 }
            : state.score,
        };
      }

      // C, S and Q are strikes; a third one is a strikeout.
      if (call === "C" || call === "S" || call === "Q") {
        count.strikes += 1;
        if (count.strikes >= 3) {
          return {
            ...pitchBase,
            outs: Math.min(state.outs + 1, 2),
            count: { ...cleanCount },
          };
        }
        return { ...pitchBase, count };
      }

      // A foul never produces a third strike.
      if (call === "F") {
        return {
          ...pitchBase,
          count: { balls: count.balls, strikes: Math.min(count.strikes + 1, 2) },
        };
      }

      // A foul tip with two strikes is a strikeout; otherwise it is a strike.
      if (call === "T") {
        if (state.count.strikes >= 2) {
          return {
            ...pitchBase,
            outs: Math.min(state.outs + 1, 2),
            count: { ...cleanCount },
          };
        }
        return { ...pitchBase, count: { balls: count.balls, strikes: count.strikes + 1 } };
      }

      // X announces a ball in play; the following `ball_in_play` resets the
      // count, so X itself only advances the sequence number.
      return pitchBase;
    }

    case "ball_in_play": {
      const { fielders, runnersAdvanced, runsBattedIn } = event.payload;
      const side = state.battingTeam;
      const bases: Bases = { ...state.bases };
      const putouts = (fielders ?? []).filter((fielder) => fielder.role === "putout").length;
      let score = state.score;

      if (runnersAdvanced && runnersAdvanced.length > 0) {
        // Collect first, then move in two phases: a later clear must not wipe a
        // runner an earlier entry already placed on that base.
        const moves = runnersAdvanced;
        for (const advance of moves) {
          if (advance.from !== "B") bases[baseKey(advance.from)] = null;
        }
        let runs = 0;
        for (const advance of moves) {
          if (advance.to === "H") {
            runs += 1;
          } else if (advance.to !== "B") {
            bases[baseKey(advance.to)] = advance.player;
          }
        }
        if (runs > 0) score = { ...score, [side]: score[side] + runs };
      } else if (runsBattedIn > 0) {
        // No baserunning detail: the official runs batted in is the only
        // number the log actually states, so it is the one used.
        score = { ...score, [side]: score[side] + runsBattedIn };
      }

      // The batter is kept in the payload for the scorekeeper; without a
      // runnersAdvanced entry there is nothing in the log that places him on
      // a base, so no base is invented for him.
      return {
        ...base,
        outs: Math.min(state.outs + putouts, 2),
        count: { ...cleanCount },
        bases,
        score,
      };
    }

    case "runner": {
      const { player, from, to, kind, out } = event.payload;
      const bases: Bases = { ...state.bases };
      const side = state.battingTeam;
      let score = state.score;
      let outs = state.outs;

      // An automatic extra-inning runner is placed directly on a base. There
      // is no runner leaving another base, no pitch and no plate appearance.
      if (kind === "placed") {
        if (to !== "H") bases[baseKey(to)] = player;
        return { ...base, bases };
      }

      if (from !== "bench") bases[baseKey(from)] = null;
      if (out) {
        outs = Math.min(outs + 1, 2);
      } else if (to === "H") {
        score = { ...score, [side]: score[side] + 1 };
      } else {
        bases[baseKey(to)] = player;
      }

      return { ...base, bases, outs, score };
    }

    case "inning.end": {
      // The human ends the half. Three outs alone never advance it.
      const half: HalfInning = state.half === "top" ? "bottom" : "top";
      const inning = state.half === "bottom" ? state.inning + 1 : state.inning;
      const battingTeam = otherSide(state.battingTeam);
      return {
        ...base,
        inning,
        half,
        outs: 0,
        count: { ...cleanCount },
        bases: { ...emptyBases },
        battingTeam,
        ...battingPointer(state.lineups, battingTeam),
      };
    }

    case "game.end": {
      const reason = event.payload.reason;
      const status: GameStatus =
        reason === "completed" || reason === "shortened"
          ? "final"
          : reason === "forfeit"
            ? "forfeit"
            : "suspended";
      return { ...base, status, score: { ...event.payload.finalScore } };
    }

    case "lineup.set": {
      const { team, battingOrder, pitcher, dh } = event.payload;
      const lineup: LineupState = {
        battingOrder: battingOrder.map((slot) => ({
          player: slot.player,
          position: slot.position,
        })),
      };
      if (pitcher !== undefined) lineup.pitcher = pitcher;
      if (dh !== undefined) lineup.dh = dh;

      const lineups = withLineup(state.lineups, team, lineup);
      return { ...base, lineups, ...battingPointer(lineups, state.battingTeam) };
    }

    case "substitution": {
      const { team, playerIn, playerOut, position, battingSlot } = event.payload;
      const current = state.lineups?.[team];
      // Without a batting order there is nothing to replace. The event stays
      // in the log for audit, but the fold does not invent a lineup slot.
      if (!current) return base;

      const found = current.battingOrder.findIndex((slot) => slot.player === playerOut);
      const index = found >= 0 ? found : battingSlot - 1;
      if (index < 0 || index >= current.battingOrder.length) return base;

      const battingOrder = current.battingOrder.map((slot, slotIndex) =>
        slotIndex === index ? { player: playerIn, position } : slot,
      );
      const lineup: LineupState = { ...current, battingOrder };
      if (position === "1") lineup.pitcher = playerIn;

      const lineups = withLineup(state.lineups, team, lineup);
      const batter = state.batter === playerOut ? playerIn : state.batter;
      const pitcher =
        position === "1" && team === otherSide(state.battingTeam)
          ? playerIn
          : state.pitcher;

      return { ...base, lineups, batter, pitcher };
    }

    case "interference": {
      const side = state.battingTeam;
      const advance = forcedAdvance(state.bases, event.payload.batter);
      return {
        ...base,
        count: { ...cleanCount },
        bases: advance.bases,
        score: advance.runScored
          ? { ...state.score, [side]: state.score[side] + 1 }
          : state.score,
      };
    }

    case "game.suspend":
      return { ...base, status: "suspended" };

    case "game.resume":
      return { ...base, status: "live" };

    case "ejection":
      // Audit only: the person left the game, but the projection has no
      // person registry to remove them from.
      return base;

    case "discrepancy":
    case "amendment":
    case "note":
      return base;

    default:
      // A newer producer can send an event type this build does not know.
      // The contract requires skipping it, not failing the stream.
      return base;
  }
}

/**
 * The events a projection actually applies. A revision supersedes the event
 * named by `revisionOf`, and a void amendment (`replacement: null`) removes
 * the event at `targetSeq`. Both replaced events stay in the log: the
 * correction is append-only, only the fold skips the originals.
 *
 * A chain A <- B <- C leaves only C, because both A and B are superseded.
 */
export function appliedEvents(events: readonly Event[]): Event[] {
  const superseded = new Set<string>();
  const voidTargets = new Set<number>();

  for (const event of events) {
    if (typeof event.revisionOf === "string") superseded.add(event.revisionOf);
    if (event.type === "amendment" && event.payload.replacement === null) {
      voidTargets.add(event.payload.targetSeq);
    }
  }

  return events.filter(
    (event) => !superseded.has(event.id) && !voidTargets.has(event.seq),
  );
}

export function foldEvents(events: readonly Event[], from: GameState = initialState): GameState {
  const state = appliedEvents(events).reduce(applyEvent, from);
  // A skipped event was still consumed by the log, so the projection's cursor
  // must include it; otherwise a resume from `lastSeq` would replay it.
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), from.lastSeq);
  return { ...state, lastSeq };
}

export interface PlayerBattingLine {
  playerId: string;
  name: string;
  jersey: string | null;
  position: string | null;
  pa: number;
  ab: number;
  r: number;
  h: number;
  doubles: number;
  triples: number;
  hr: number;
  rbi: number;
  bb: number;
  so: number;
  hbp: number;
  avg: number | null;
}

export interface PlayerPitchingLine {
  playerId: string;
  name: string;
  jersey: string | null;
  position: string | null;
  pitches: number;
  outs: number;
  battersFaced: number;
  h: number;
  r: number;
  bb: number;
  so: number;
}

/** The public-safe identity a game's roster contributes to its box score. */
export interface BoxPlayerReference {
  playerId: string;
  name: string;
  jersey: string | null;
  position: string | null;
}

export interface TeamBoxScore {
  runs: number;
  hits: number;
  errors: number;
  linescore: (number | null)[];
  batting: PlayerBattingLine[];
  pitching: PlayerPitchingLine[];
}

export interface GameBoxScore {
  gameId: string;
  status: GameStatus;
  home: TeamBoxScore;
  away: TeamBoxScore;
}

/**
 * A play code is a hit only when it starts with `S`, `D`, `T` or `HR` and the
 * next character is not a letter. That keeps sacrifices such as `SAC` and
 * `SF` out of the hit count.
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

function isError(code: string, fielders: readonly { role: string }[]): boolean {
  return /^E/i.test(code) || fielders.some((fielder) => fielder.role === "error");
}

/**
 * Derives the box score from the same log the projection folds. Runs come
 * from the projection (which already prefers `game.end.finalScore`), hits and
 * errors from the play codes and fielding roles, and the linescore from the
 * `runsScored` each `inning.end` states. An inning that was never ended stays
 * null, because inventing a zero would hide an unfinished half.
 */
export function foldBoxScore(
  gameId: string,
  events: readonly Event[],
  players: ReadonlyMap<string, BoxPlayerReference> = new Map(),
): GameBoxScore {
  let state = initialState;
  const hits: Record<TeamSide, number> = { home: 0, away: 0 };
  const errors: Record<TeamSide, number> = { home: 0, away: 0 };
  const innings: Record<TeamSide, Array<{ inning: number; runs: number }>> = { home: [], away: [] };
  const batting: Record<TeamSide, Map<string, PlayerBattingLine>> = {
    home: new Map(),
    away: new Map(),
  };
  const pitching: Record<TeamSide, Map<string, PlayerPitchingLine>> = {
    home: new Map(),
    away: new Map(),
  };
  const lineupOrder: Record<TeamSide, Map<string, number>> = {
    home: new Map(),
    away: new Map(),
  };

  const identity = (playerId: string) => {
    const ref = players.get(playerId);
    return {
      playerId,
      name: ref?.name ?? "",
      jersey: ref?.jersey ?? null,
      position: ref?.position ?? null,
    };
  };

  const battingFor = (playerId: string, side: TeamSide): PlayerBattingLine => {
    let line = batting[side].get(playerId);
    if (!line) {
      line = {
        ...identity(playerId),
        pa: 0,
        ab: 0,
        r: 0,
        h: 0,
        doubles: 0,
        triples: 0,
        hr: 0,
        rbi: 0,
        bb: 0,
        so: 0,
        hbp: 0,
        avg: null,
      };
      batting[side].set(playerId, line);
    }
    return line;
  };

  const pitchingFor = (playerId: string, side: TeamSide): PlayerPitchingLine => {
    let line = pitching[side].get(playerId);
    if (!line) {
      line = {
        ...identity(playerId),
        pitches: 0,
        outs: 0,
        battersFaced: 0,
        h: 0,
        r: 0,
        bb: 0,
        so: 0,
      };
      pitching[side].set(playerId, line);
    }
    return line;
  };

  const creditForcedRun = (runner: string | null, pitcher: PlayerPitchingLine | null) => {
    if (runner === null) return;
    battingFor(runner, state.battingTeam).r += 1;
    if (pitcher) pitcher.r += 1;
  };

  for (const event of appliedEvents(events)) {
    const before = state;
    const battingSide = before.battingTeam;
    const fieldingSide = otherSide(battingSide);

    if (event.type === "lineup.set") {
      event.payload.battingOrder.forEach((slot, index) => {
        lineupOrder[event.payload.team].set(slot.player, index);
      });
    } else if (event.type === "substitution") {
      const current = before.lineups?.[event.payload.team];
      const found = current?.battingOrder.findIndex(
        (slot) => slot.player === event.payload.playerOut,
      );
      const index = found !== undefined && found >= 0 ? found : event.payload.battingSlot - 1;
      lineupOrder[event.payload.team].set(event.payload.playerIn, index);
    } else if (event.type === "pitch") {
      const { pitcher, batter, call } = event.payload;
      const pitcherLine = pitchingFor(pitcher, fieldingSide);
      pitcherLine.pitches += 1;

      const walk = isWalk(call, before.count);
      const strikeout = isStrikeout(call, before.count);
      if (walk || strikeout || call === "H") {
        const batterLine = battingFor(batter, battingSide);
        batterLine.pa += 1;
        pitcherLine.battersFaced += 1;

        if (walk) {
          batterLine.bb += 1;
          pitcherLine.bb += 1;
          if (before.bases.first && before.bases.second && before.bases.third) {
            creditForcedRun(before.bases.third, pitcherLine);
          }
        } else if (call === "H") {
          batterLine.hbp += 1;
          if (before.bases.first && before.bases.second && before.bases.third) {
            creditForcedRun(before.bases.third, pitcherLine);
          }
        } else {
          batterLine.ab += 1;
          batterLine.so += 1;
          pitcherLine.so += 1;
          pitcherLine.outs += 1;
        }
      }
    } else if (event.type === "ball_in_play") {
      const { batter, code, runsBattedIn, runnersAdvanced, fielders } = event.payload;
      const hit = isHit(code);
      const sacrifice = isSacrifice(code);
      const batterLine = battingFor(batter, battingSide);
      const pitcherLine = before.pitcher ? pitchingFor(before.pitcher, fieldingSide) : null;

      batterLine.pa += 1;
      if (!sacrifice) batterLine.ab += 1;
      if (hit) {
        batterLine.h += 1;
        if (/^D/i.test(code)) batterLine.doubles += 1;
        if (/^T/i.test(code)) batterLine.triples += 1;
        if (/^HR/i.test(code)) batterLine.hr += 1;
        if (pitcherLine) pitcherLine.h += 1;
        hits[battingSide] += 1;
      }
      batterLine.rbi += runsBattedIn;
      if (pitcherLine) {
        pitcherLine.battersFaced += 1;
        pitcherLine.outs += (fielders ?? []).filter((fielder) => fielder.role === "putout").length;
      }
      if (isError(code, fielders ?? [])) errors[fieldingSide] += 1;

      for (const advance of runnersAdvanced ?? []) {
        if (advance.to !== "H") continue;
        battingFor(advance.player, battingSide).r += 1;
        if (pitcherLine) pitcherLine.r += 1;
      }

      // A home run scores its batter even when the log only states the RBI.
      // Do not count the batter twice when an explicit advance already did.
      const batterScored = (runnersAdvanced ?? []).some(
        (advance) => advance.player === batter && advance.to === "H",
      );
      const automaticRun = /^HR/i.test(code) && !batterScored ? 1 : 0;
      if (automaticRun > 0) {
        batterLine.r += 1;
        if (pitcherLine) pitcherLine.r += 1;
      }
      if (
        pitcherLine &&
        (runnersAdvanced?.length ?? 0) === 0 &&
        runsBattedIn > automaticRun
      ) {
        pitcherLine.r += runsBattedIn - automaticRun;
      }
    } else if (event.type === "interference") {
      const { batter } = event.payload;
      const batterLine = battingFor(batter, battingSide);
      const pitcherLine = before.pitcher ? pitchingFor(before.pitcher, fieldingSide) : null;
      batterLine.pa += 1;
      if (pitcherLine) pitcherLine.battersFaced += 1;
      if (before.bases.first && before.bases.second && before.bases.third) {
        creditForcedRun(before.bases.third, pitcherLine);
      }
    } else if (event.type === "runner") {
      const { player, to, out, kind } = event.payload;
      if (kind !== "placed") {
        const pitcherLine = before.pitcher ? pitchingFor(before.pitcher, fieldingSide) : null;
        if (out) {
          if (pitcherLine) pitcherLine.outs += 1;
        } else if (to === "H") {
          battingFor(player, battingSide).r += 1;
          if (pitcherLine) pitcherLine.r += 1;
        }
      }
    } else if (event.type === "inning.end") {
      const side: TeamSide = event.payload.half === "top" ? "away" : "home";
      innings[side].push({ inning: event.payload.inning, runs: event.payload.runsScored });
    }
    state = applyEvent(state, event);
  }

  // Same cursor rule as foldEvents: a skipped event still counts as consumed.
  state = {
    ...state,
    lastSeq: events.reduce((max, event) => Math.max(max, event.seq), state.lastSeq),
  };

  const sortedBatting = (side: TeamSide): PlayerBattingLine[] =>
    [...batting[side].values()]
      .filter((line) => line.name !== "" && (line.pa > 0 || line.r > 0))
      .map((line) => ({ ...line, avg: average(line.h, line.ab) }))
      .sort(
        (a, b) =>
          (lineupOrder[side].get(a.playerId) ?? Number.MAX_SAFE_INTEGER) -
            (lineupOrder[side].get(b.playerId) ?? Number.MAX_SAFE_INTEGER) ||
          a.name.localeCompare(b.name) ||
          a.playerId.localeCompare(b.playerId),
      );

  const sortedPitching = (side: TeamSide): PlayerPitchingLine[] =>
    [...pitching[side].values()]
      .filter(
        (line) =>
          line.name !== "" &&
          (line.pitches > 0 || line.battersFaced > 0 || line.outs > 0),
      )
      .sort(
        (a, b) =>
          (lineupOrder[side].get(a.playerId) ?? Number.MAX_SAFE_INTEGER) -
            (lineupOrder[side].get(b.playerId) ?? Number.MAX_SAFE_INTEGER) ||
          a.name.localeCompare(b.name) ||
          a.playerId.localeCompare(b.playerId),
      );

  return {
    gameId,
    status: state.status,
    home: {
      runs: state.score.home,
      hits: hits.home,
      errors: errors.home,
      linescore: linescore(innings.home),
      batting: sortedBatting("home"),
      pitching: sortedPitching("home"),
    },
    away: {
      runs: state.score.away,
      hits: hits.away,
      errors: errors.away,
      linescore: linescore(innings.away),
      batting: sortedBatting("away"),
      pitching: sortedPitching("away"),
    },
  };
}

function linescore(innings: Array<{ inning: number; runs: number }>): (number | null)[] {
  const length = Math.max(9, ...innings.map((entry) => entry.inning));
  const line: (number | null)[] = Array.from({ length }, () => null);
  for (const entry of innings) line[entry.inning - 1] = entry.runs;
  return line;
}
