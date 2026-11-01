import { describe, expect, it } from "vitest";
import type { Event } from "@olb/contract/types";
import { foldEvents } from "../src/domain/fold.js";

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
