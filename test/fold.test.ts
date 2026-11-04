import { describe, expect, it } from "vitest";
import type { Event } from "@olb/contract/types";
import { foldBoxScore, foldEvents } from "../src/domain/fold.js";

const gameId = "0192f3a0-5b11-7a02-8f3c-1c9d2e3f4a50";
const batter = "0192f3a2-0001-7000-8000-000000000001";
const pitcher = "0192f3a2-0001-7000-8000-000000000002";

function event(seq: number, type: string, payload: unknown): Event {
  return {
    contract: "olb.event/1",
    id: `0192f3a1-7c2e-7c3${seq.toString(16)}-9a3f-2b1d4e5f6a70`.slice(0, 36),
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

const start = (seq = 0) => event(seq, "game.start", {});
const pitch = (seq: number, call: string) =>
  event(seq, "pitch", {
    pitchNo: seq,
    batter,
    pitcher,
    count: { balls: 0, strikes: 0 },
    call,
  });

describe("foldEvents", () => {
  it("returns a scheduled projection for an empty log", () => {
    const state = foldEvents([]);
    expect(state.status).toBe("scheduled");
    expect(state.lastSeq).toBe(0);
  });

  it("starts the game with the visitors batting", () => {
    const state = foldEvents([start()]);
    expect(state).toMatchObject({
      status: "live",
      inning: 1,
      half: "top",
      outs: 0,
      battingTeam: "away",
      lastSeq: 0,
    });
  });

  it("counts balls and strikes with caps", () => {
    const state = foldEvents([start(), pitch(1, "B"), pitch(2, "S"), pitch(3, "F"), pitch(4, "F")]);
    expect(state.count).toEqual({ balls: 1, strikes: 2 });
    expect(state.lastSeq).toBe(4);
  });

  it("does not change the count on a ball in play and credits runs", () => {
    const state = foldEvents([
      start(),
      pitch(1, "B"),
      event(2, "ball_in_play", {
        batter,
        code: "D7/L",
        runsBattedIn: 2,
      }),
    ]);
    expect(state.count).toEqual({ balls: 0, strikes: 0 });
    expect(state.score).toEqual({ home: 0, away: 2 });
  });

  it("advances the half inning and the inning number", () => {
    const afterTop = foldEvents([
      start(),
      event(1, "inning.end", { inning: 1, half: "top", runsScored: 0, outs: 3 }),
    ]);
    expect(afterTop).toMatchObject({ inning: 1, half: "bottom", battingTeam: "home", outs: 0 });

    const afterBottom = foldEvents([
      start(),
      event(1, "inning.end", { inning: 1, half: "top", runsScored: 0, outs: 3 }),
      event(2, "inning.end", { inning: 1, half: "bottom", runsScored: 0, outs: 3 }),
    ]);
    expect(afterBottom).toMatchObject({ inning: 2, half: "top", battingTeam: "away" });
  });

  it("records three outs through runner events", () => {
    const out = (seq: number) =>
      event(seq, "runner", {
        player: "0192f3a2-0002-7000-8000-000000000011",
        from: "1",
        to: "2",
        kind: "caught_stealing",
        out: true,
      });

    const state = foldEvents([start(), out(1), out(2), out(3), out(4)]);
    expect(state.outs).toBe(2);
  });

  it("finishes the game and takes the official score", () => {
    const state = foldEvents([
      start(),
      event(1, "game.end", { reason: "completed", finalScore: { home: 3, away: 5 } }),
    ]);
    expect(state.status).toBe("final");
    expect(state.score).toEqual({ home: 3, away: 5 });
  });

  it("skips an event type it does not know", () => {
    const future = event(1, "pitch_clock", {}) as unknown as Event;
    const state = foldEvents([start(), future]);
    expect(state.lastSeq).toBe(1);
    expect(state.status).toBe("live");
  });
});

const runner = (seq: number, payload: Record<string, unknown>) => event(seq, "runner", payload);
const player = (n: number) => `0192f3a2-0003-7000-8000-${String(n).padStart(12, "0")}`;

describe("walk and strikeout rules", () => {
  it("walks the batter on a fourth ball, resetting the count", () => {
    const state = foldEvents([
      start(),
      pitch(1, "B"),
      pitch(2, "B"),
      pitch(3, "B"),
      pitch(4, "B"),
    ]);

    expect(state.bases.first).toBe(batter);
    expect(state.count).toEqual({ balls: 0, strikes: 0 });
    expect(state.outs).toBe(0);
  });

  it("forces the chain home when the bases are loaded", () => {
    const first = player(11);
    const second = player(12);
    const third = player(13);
    const state = foldEvents([
      start(),
      runner(1, { player: third, from: "1", to: "3", kind: "steal", out: false }),
      runner(2, { player: second, from: "1", to: "2", kind: "steal", out: false }),
      runner(3, { player: first, from: "1", to: "1", kind: "steal", out: false }),
      pitch(4, "B"),
      pitch(5, "B"),
      pitch(6, "B"),
      pitch(7, "B"),
    ]);

    expect(state.bases).toEqual({ first: batter, second: first, third: second });
    expect(state.score).toEqual({ home: 0, away: 1 });
    expect(state.count).toEqual({ balls: 0, strikes: 0 });
    expect(state.outs).toBe(0);
  });

  it("strikes out the batter on a third strike", () => {
    const state = foldEvents([start(), pitch(1, "S"), pitch(2, "C"), pitch(3, "Q")]);

    expect(state.outs).toBe(1);
    expect(state.count).toEqual({ balls: 0, strikes: 0 });
    expect(state.bases).toEqual({ first: null, second: null, third: null });
  });

  it("does not strike out on a foul with two strikes", () => {
    const state = foldEvents([start(), pitch(1, "S"), pitch(2, "C"), pitch(3, "F")]);

    expect(state.outs).toBe(0);
    expect(state.count).toEqual({ balls: 0, strikes: 2 });
  });

  it("does strike out on a foul tip with two strikes", () => {
    const state = foldEvents([start(), pitch(1, "S"), pitch(2, "C"), pitch(3, "T")]);

    expect(state.outs).toBe(1);
    expect(state.count).toEqual({ balls: 0, strikes: 0 });
  });
});

describe("batted ball and baserunning rules", () => {
  it("records both outs of a double play", () => {
    const state = foldEvents([
      start(),
      event(1, "ball_in_play", {
        batter,
        code: "6(1)3/GDP",
        runsBattedIn: 0,
        fielders: [
          { player: player(21), role: "putout" },
          { player: player(22), role: "putout" },
          { player: player(23), role: "assist" },
        ],
      }),
    ]);

    expect(state.outs).toBe(2);
  });

  it("clears the base when a runner is thrown out", () => {
    const state = foldEvents([
      start(),
      runner(1, { player: player(31), from: "1", to: "1", kind: "steal", out: false }),
      runner(2, { player: player(31), from: "1", to: "2", kind: "caught_stealing", out: true }),
    ]);

    expect(state.bases.first).toBeNull();
    expect(state.outs).toBe(1);
  });

  it("moves a runner on a steal without an out", () => {
    const state = foldEvents([
      start(),
      runner(1, { player: player(32), from: "1", to: "1", kind: "steal", out: false }),
      runner(2, { player: player(32), from: "1", to: "2", kind: "steal", out: false }),
    ]);

    expect(state.bases).toEqual({ first: null, second: player(32), third: null });
    expect(state.outs).toBe(0);
  });

  it("scores a runner that reaches home", () => {
    const state = foldEvents([
      start(),
      runner(1, { player: player(33), from: "1", to: "3", kind: "steal", out: false }),
      runner(2, { player: player(33), from: "3", to: "H", kind: "wild_pitch", out: false }),
    ]);

    expect(state.score).toEqual({ home: 0, away: 1 });
    expect(state.bases.third).toBeNull();
  });
});

describe("inning boundaries", () => {
  it("flips the half and clears the bases on inning.end", () => {
    const state = foldEvents([
      start(),
      runner(1, { player: player(41), from: "1", to: "1", kind: "steal", out: false }),
      event(2, "inning.end", { inning: 1, half: "top", runsScored: 0, outs: 3 }),
    ]);

    expect(state).toMatchObject({ inning: 1, half: "bottom", battingTeam: "home", outs: 0 });
    expect(state.bases).toEqual({ first: null, second: null, third: null });
  });

  it("does not advance the half from three outs alone", () => {
    const state = foldEvents([
      start(),
      runner(1, { player: player(42), from: "1", to: "2", kind: "caught_stealing", out: true }),
      runner(2, { player: player(43), from: "2", to: "3", kind: "caught_stealing", out: true }),
      runner(3, { player: player(44), from: "3", to: "H", kind: "caught_stealing", out: true }),
    ]);

    expect(state.half).toBe("top");
    expect(state.inning).toBe(1);
    // The projection caps outs at two, the contract's maximum.
    expect(state.outs).toBe(2);
  });
});

describe("a nine-inning box score", () => {
  const log: Event[] = [start(0)];
  let seq = 1;

  const push = (type: string, payload: unknown) => {
    log.push(event(seq, type, payload));
    seq += 1;
  };
  const scoreRun = () =>
    push("ball_in_play", {
      batter: player(51),
      code: "S8",
      runsBattedIn: 1,
      runnersAdvanced: [{ player: player(51), from: "B", to: "H" }],
    });
  const hit = () => push("ball_in_play", { batter: player(52), code: "S7", runsBattedIn: 0 });
  const error = () =>
    push("ball_in_play", {
      batter: player(53),
      code: "E5",
      runsBattedIn: 0,
      fielders: [{ player: player(54), role: "error" }],
    });
  const half = (inning: number, side: "top" | "bottom", runsScored: number) =>
    push("inning.end", { inning, half: side, runsScored, outs: 3 });

  scoreRun();
  hit();
  half(1, "top", 1);
  half(1, "bottom", 0);
  hit();
  half(2, "top", 0);
  scoreRun();
  half(2, "bottom", 1);
  error();
  half(3, "top", 0);
  hit();
  half(3, "bottom", 0);
  half(4, "top", 0);
  scoreRun();
  scoreRun();
  half(4, "bottom", 2);
  scoreRun();
  half(5, "top", 1);
  hit();
  half(5, "bottom", 0);
  hit();
  half(6, "top", 0);
  scoreRun();
  half(6, "bottom", 1);
  half(7, "top", 0);
  hit();
  half(7, "bottom", 0);
  hit();
  half(8, "top", 0);
  hit();
  half(8, "bottom", 0);
  half(9, "top", 0);
  half(9, "bottom", 0);
  push("game.end", { reason: "completed", finalScore: { home: 4, away: 2 } });

  it("reaches a final state with the official score", () => {
    const state = foldEvents(log);

    expect(state.status).toBe("final");
    expect(state.score).toEqual({ home: 4, away: 2 });
  });

  it("derives matching totals and a nine-entry linescore", () => {
    const box = foldBoxScore(gameId, log);

    expect(box.home).toEqual({
      runs: 4,
      hits: 8,
      errors: 1,
      linescore: [0, 1, 0, 2, 0, 1, 0, 0, 0],
    });
    expect(box.away).toEqual({
      runs: 2,
      hits: 6,
      errors: 0,
      linescore: [1, 0, 0, 0, 1, 0, 0, 0, 0],
    });
  });
});

describe("foldBoxScore padding", () => {
  it("pads an unfinished game to nine innings with nulls", () => {
    const box = foldBoxScore(gameId, [
      start(),
      event(1, "inning.end", { inning: 1, half: "top", runsScored: 2, outs: 3 }),
    ]);

    expect(box.away.linescore).toEqual([2, null, null, null, null, null, null, null, null]);
    expect(box.home.linescore).toEqual([null, null, null, null, null, null, null, null, null]);
  });
});
