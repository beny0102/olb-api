import { describe, expect, it } from "vitest";
import type { Event } from "@olb/contract/types";
import { foldBoxScore, type BoxPlayerReference } from "../src/domain/fold.js";

const gameId = "0192f3a0-5b11-7a02-8f3c-1c9d2e3f4a60";
const player = (n: number) => `0192f3a2-0004-7000-8000-${String(n).padStart(12, "0")}`;
const homePitcher = player(109);

const positions = ["8", "4", "9", "3", "5", "6", "7", "2", "1"] as const;

function event(seq: number, type: string, payload: unknown): Event {
  return {
    contract: "olb.event/1",
    id: `0192f3a1-7c2e-7c3${seq.toString(16)}-9a3f-2b1d4e5f6a71`.slice(0, 36),
    gameId,
    seq,
    occurredAt: "2026-11-23T20:00:00.000Z",
    recordedAt: "2026-11-23T20:00:01.000Z",
    type,
    source: "human",
    actor: { kind: "user", id: "test" },
    payload,
  } as Event;
}

function lineup(seq: number, team: "home" | "away", first: number, pitcher: string): Event {
  return event(seq, "lineup.set", {
    team,
    battingOrder: Array.from({ length: 9 }, (_, index) => ({
      player: player(first + index),
      position: positions[index],
    })),
    pitcher,
  });
}

function pitch(seq: number, batter: string, call: string): Event {
  return event(seq, "pitch", {
    pitchNo: seq,
    batter,
    pitcher: homePitcher,
    count: { balls: 0, strikes: 0 },
    call,
  });
}

const references = new Map<string, BoxPlayerReference>();
for (let n = 1; n <= 9; n += 1) {
  references.set(player(n), {
    playerId: player(n),
    name: `Visitante ${n}`,
    jersey: String(n),
    position: positions[n - 1],
  });
}
for (let n = 101; n <= 109; n += 1) {
  references.set(player(n), {
    playerId: player(n),
    name: `Local ${n - 100}`,
    jersey: String(n - 100),
    position: positions[n - 101],
  });
}

const log: Event[] = [
  event(0, "game.start", {}),
  lineup(1, "away", 1, player(9)),
  lineup(2, "home", 101, homePitcher),
  pitch(3, player(1), "B"),
  pitch(4, player(1), "B"),
  pitch(5, player(1), "B"),
  pitch(6, player(1), "B"),
  event(7, "ball_in_play", {
    batter: player(2),
    code: "S8",
    runsBattedIn: 0,
    fielders: [],
    runnersAdvanced: [
      { player: player(1), from: "1", to: "3", on: "hit" },
      { player: player(2), from: "B", to: "1", on: "hit" },
    ],
  }),
  event(8, "ball_in_play", {
    batter: player(3),
    code: "HR/F",
    runsBattedIn: 3,
    fielders: [],
    runnersAdvanced: [
      { player: player(1), from: "3", to: "H", on: "hit" },
      { player: player(2), from: "1", to: "H", on: "hit" },
      { player: player(3), from: "B", to: "H", on: "hit" },
    ],
  }),
  pitch(9, player(4), "C"),
  pitch(10, player(4), "S"),
  pitch(11, player(4), "S"),
  event(12, "ball_in_play", {
    batter: player(5),
    code: "SAC5",
    runsBattedIn: 0,
    fielders: [],
  }),
  pitch(13, player(6), "H"),
  event(14, "ball_in_play", {
    batter: player(7),
    code: "E5/G",
    runsBattedIn: 0,
    fielders: [{ player: player(105), position: "5", role: "error" }],
  }),
];

describe("foldBoxScore player lines", () => {
  it("derives batting and pitching lines from the applied log", () => {
    const box = foldBoxScore(gameId, log, references);

    expect(box.away.batting).toHaveLength(7);
    expect(box.away.batting.map((line) => line.playerId)).toEqual([
      player(1),
      player(2),
      player(3),
      player(4),
      player(5),
      player(6),
      player(7),
    ]);

    expect(box.away.batting[0]).toMatchObject({
      name: "Visitante 1",
      pa: 1,
      ab: 0,
      r: 1,
      h: 0,
      bb: 1,
      avg: null,
    });
    expect(box.away.batting[1]).toMatchObject({
      pa: 1,
      ab: 1,
      r: 1,
      h: 1,
      avg: 1,
    });
    expect(box.away.batting[2]).toMatchObject({
      pa: 1,
      ab: 1,
      r: 1,
      h: 1,
      hr: 1,
      rbi: 3,
      avg: 1,
    });
    expect(box.away.batting[3]).toMatchObject({ pa: 1, ab: 1, so: 1, avg: 0 });
    expect(box.away.batting[4]).toMatchObject({ pa: 1, ab: 0, h: 0 });
    expect(box.away.batting[5]).toMatchObject({ pa: 1, ab: 0, hbp: 1 });
    expect(box.away.batting[6]).toMatchObject({ pa: 1, ab: 1, h: 0, avg: 0 });

    expect(box.home.pitching).toHaveLength(1);
    expect(box.home.pitching[0]).toMatchObject({
      name: "Local 9",
      pitches: 8,
      outs: 1,
      battersFaced: 7,
      h: 2,
      r: 3,
      bb: 1,
      so: 1,
    });
    expect(box.away).toMatchObject({ runs: 3, hits: 2 });
    expect(box.home.errors).toBe(1);
  });

  it("credits the batter on a home run without explicit runner advances", () => {
    const box = foldBoxScore(
      gameId,
      [
        event(0, "game.start", {}),
        lineup(1, "away", 1, player(9)),
        lineup(2, "home", 101, homePitcher),
        event(3, "ball_in_play", {
          batter: player(3),
          code: "HR/F",
          runsBattedIn: 1,
        }),
      ],
      references,
    );

    expect(box.away.batting.find((line) => line.playerId === player(3))).toMatchObject({
      r: 1,
      h: 1,
      hr: 1,
      rbi: 1,
    });
    expect(box.home.pitching[0]).toMatchObject({ h: 1, r: 1 });
  });

  it("omits player lines when no public roster is available", () => {
    const box = foldBoxScore(gameId, log);

    expect(box.away.batting).toEqual([]);
    expect(box.home.pitching).toEqual([]);
  });
});
