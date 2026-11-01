import type { Event } from "@olb/contract/types";

export type GameStatus = "scheduled" | "live" | "final" | "suspended" | "forfeit";
export type HalfInning = "top" | "bottom";
export type TeamSide = "home" | "away";

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
};

const cleanCount = { balls: 0, strikes: 0 };
const emptyBases = { first: null, second: null, third: null } as const;

function nextBatter(state: GameState): TeamSide {
  return state.half === "top" ? "home" : "away";
}

/**
 * Folds one event into the projection. Pure: returns a new object and never
 * mutates its input, so a caller can fold any prefix of the log to get the
 * state as of that sequence number.
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
      };

    case "pitch": {
      const { call } = event.payload;
      const count = { ...state.count };

      if (call === "B") count.balls = Math.min(count.balls + 1, 3);
      else if (call === "C" || call === "S" || call === "T" || call === "F") {
        count.strikes = Math.min(count.strikes + 1, 2);
      }

      return { ...base, count };
    }

    case "ball_in_play": {
      const side = state.battingTeam;
      return {
        ...base,
        count: { ...cleanCount },
        score: { ...state.score, [side]: state.score[side] + event.payload.runsBattedIn },
      };
    }

    case "runner":
      return { ...base, outs: Math.min(state.outs + (event.payload.out ? 1 : 0), 2) };

    case "inning.end": {
      const half: HalfInning = state.half === "top" ? "bottom" : "top";
      const inning = state.half === "bottom" ? state.inning + 1 : state.inning;
      return {
        ...base,
        inning,
        half,
        outs: 0,
        count: { ...cleanCount },
        bases: { ...emptyBases },
        battingTeam: half === "top" ? "away" : "home",
      };
    }

    case "game.end": {
      const reason = event.payload.reason;
      const status: GameStatus =
        reason === "completed" ? "final" : reason === "forfeit" ? "forfeit" : "suspended";
      return { ...base, status, score: { ...event.payload.finalScore } };
    }

    case "lineup.set":
    case "substitution":
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

export function foldEvents(events: readonly Event[], from: GameState = initialState): GameState {
  return events.reduce(applyEvent, from);
}

export { nextBatter };
