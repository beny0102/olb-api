import { describe, expect, it } from "vitest";
import type { Event } from "@olb/contract/types";
import { foldBoxScore, foldEvents } from "../src/domain/fold.js";

const gameId = "0192f3a0-5b11-7a02-8f3c-1c9d2e3f4a50";
const batter = "0192f3a2-0001-7000-8000-000000000001";
const pitcher = "0192f3a2-0001-7000-8000-000000000002";

function id(n: number): string {
  return `0192f3a3-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

function event(seq: number, type: string, payload: unknown, extra: Record<string, unknown> = {}): Event {
  return {
    contract: "olb.event/1",
    id: id(seq),
    gameId,
    seq,
    occurredAt: "2026-04-11T23:41:07.412Z",
    recordedAt: "2026-04-11T23:41:08.119Z",
    type,
    source: "human",
    actor: { kind: "user", id: "test" },
    payload,
    ...extra,
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
const revision = (seq: number, call: string, target: string) =>
  event(
    seq,
    "pitch",
    {
      pitchNo: seq,
      batter,
      pitcher,
      count: { balls: 0, strikes: 0 },
      call,
    },
    { revisionOf: target },
  );
const amendment = (seq: number, targetSeq: number, replacement: unknown = null) =>
  event(seq, "amendment", { targetSeq, reason: "other", replacement });

describe("applied events", () => {
  it("applies a revision instead of the original pitch", () => {
    const state = foldEvents([start(), pitch(1, "B"), revision(2, "S", id(1))]);

    expect(state.count).toEqual({ balls: 0, strikes: 1 });
  });

  it("removes the target of a void amendment and leaves a clean count", () => {
    const state = foldEvents([start(), pitch(1, "B"), amendment(2, 1)]);

    expect(state.count).toEqual({ balls: 0, strikes: 0 });
  });

  it("applies only the latest revision of a chain", () => {
    const state = foldEvents([
      start(),
      pitch(1, "B"),
      revision(2, "S", id(1)),
      revision(3, "B", id(2)),
    ]);

    expect(state.count).toEqual({ balls: 1, strikes: 0 });
  });

  it("drops the original hit and run from the box score", () => {
    const original = event(1, "ball_in_play", {
      batter,
      code: "S8",
      runsBattedIn: 1,
    });
    const corrected = event(
      2,
      "ball_in_play",
      {
        batter,
        code: "E5",
        runsBattedIn: 0,
        fielders: [{ player: pitcher, role: "error" }],
      },
      { revisionOf: id(1) },
    );

    const box = foldBoxScore(gameId, [start(), original, corrected]);

    expect(box.away.runs).toBe(0);
    expect(box.away.hits).toBe(0);
    expect(box.away.errors).toBe(0);
    // The error belongs to the fielding side, which is home while away bats.
    expect(box.home.errors).toBe(1);
  });

  it("counts a skipped event as consumed by lastSeq", () => {
    const state = foldEvents([start(), pitch(1, "B"), revision(2, "S", id(1))]);

    expect(state.lastSeq).toBe(2);
  });
});
