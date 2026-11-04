import { describe, expect, it } from "vitest";
import type { Event } from "@olb/contract/types";
import { foldEvents } from "../src/domain/fold.js";
import { computeStandings, type StandingsGame } from "../src/domain/standings.js";

const gameId = "0192f3a0-5b11-7a02-8f3c-1c9d2e3f4a51";
const batter = "0192f3a2-0001-7000-8000-000000000001";

function event(seq: number, type: string, payload: unknown): Event {
  return {
    contract: "olb.event/1",
    id: `0192f3a1-7c2e-7c3${seq.toString(16)}-9a3f-2b1d4e5f6a71`.slice(0, 36),
    gameId,
    seq,
    occurredAt: "2026-04-11T23:41:07.412Z",
    recordedAt: "2026-04-11T23:41:08.119Z",
    type,
    source: "human",
    actor: { kind: "user", id: "test" },
    payload,
  } as Event;
}

/**
 * A two-inning game whose score comes from two home runs, followed by the
 * official game.end score. Every number in the standings is therefore read
 * back from a real log, not injected into a fake state.
 */
function finalGame(
  homeTeam: string,
  awayTeam: string,
  homeRuns: number,
  awayRuns: number,
  reason = "completed",
): StandingsGame {
  const events: Event[] = [event(0, "game.start", {})];
  let seq = 1;
  const push = (type: string, payload: unknown) => {
    events.push(event(seq, type, payload));
    seq += 1;
  };

  if (awayRuns > 0) {
    push("ball_in_play", { batter, code: "HR", runsBattedIn: awayRuns });
  }
  push("inning.end", { inning: 1, half: "top", runsScored: awayRuns, outs: 3 });
  if (homeRuns > 0) {
    push("ball_in_play", { batter, code: "HR", runsBattedIn: homeRuns });
  }
  push("inning.end", { inning: 1, half: "bottom", runsScored: homeRuns, outs: 3 });
  push("game.end", { reason, finalScore: { home: homeRuns, away: awayRuns } });

  return { homeTeam, awayTeam, state: foldEvents(events) };
}

describe("computeStandings", () => {
  it("groups two finals by team and sorts by pct then run differential", () => {
    const standings = computeStandings([
      finalGame("Tiburones", "Marlins", 3, 1),
      finalGame("Tiburones", "Marlins", 2, 5),
    ]);

    expect(standings.games).toBe(2);
    expect(standings.teams).toEqual([
      { team: "Marlins", w: 1, l: 1, runsFor: 6, runsAgainst: 5, pct: 0.5 },
      { team: "Tiburones", w: 1, l: 1, runsFor: 5, runsAgainst: 6, pct: 0.5 },
    ]);
  });

  it("includes a forfeit as a terminal result and counts its loser", () => {
    const standings = computeStandings([finalGame("Tiburones", "Marlins", 0, 9, "forfeit")]);

    expect(standings.games).toBe(1);
    expect(standings.teams).toEqual([
      { team: "Marlins", w: 1, l: 0, runsFor: 9, runsAgainst: 0, pct: 1 },
      { team: "Tiburones", w: 0, l: 1, runsFor: 0, runsAgainst: 9, pct: 0 },
    ]);
  });

  it("ignores a game that has not reached a terminal status", () => {
    const live = finalGame("Tiburones", "Marlins", 3, 1);
    live.state = { ...live.state, status: "live" };

    expect(computeStandings([live])).toEqual({ games: 0, teams: [] });
  });
});
