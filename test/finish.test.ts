import { describe, expect, it } from "vitest";
import { initialState, type GameState } from "../src/domain/fold.js";
import { canComplete, canShorten, finishError } from "../src/domain/finish.js";

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    ...initialState,
    ...overrides,
    score: { ...initialState.score, ...overrides.score },
  };
}

describe("canComplete", () => {
  it("accepts nine full innings with a winner", () => {
    expect(canComplete(state({ inning: 10, half: "top", score: { home: 3, away: 2 } }))).toBe(
      true,
    );
  });

  it("accepts 8.5 innings when the home team is ahead", () => {
    expect(canComplete(state({ inning: 9, half: "bottom", score: { home: 2, away: 1 } }))).toBe(
      true,
    );
  });

  it("accepts a walk-off in the bottom of the ninth", () => {
    expect(canComplete(state({ inning: 9, half: "bottom", score: { home: 4, away: 3 } }))).toBe(
      true,
    );
  });

  it("rejects a tie after nine innings", () => {
    expect(canComplete(state({ inning: 10, half: "top", score: { home: 2, away: 2 } }))).toBe(
      false,
    );
  });

  it("rejects a first-inning 0-0", () => {
    expect(canComplete(state({ inning: 1, half: "top", score: { home: 0, away: 0 } }))).toBe(
      false,
    );
  });
});

describe("canShorten", () => {
  it("accepts five full innings", () => {
    expect(canShorten(state({ inning: 6, half: "top", score: { home: 1, away: 1 } }))).toBe(
      true,
    );
  });

  it("accepts 4.5 innings when the home team is ahead", () => {
    expect(canShorten(state({ inning: 5, half: "bottom", score: { home: 2, away: 0 } }))).toBe(
      true,
    );
  });

  it("rejects 4.5 innings when the home team is not ahead", () => {
    expect(canShorten(state({ inning: 5, half: "bottom", score: { home: 0, away: 0 } }))).toBe(
      false,
    );
    expect(canShorten(state({ inning: 5, half: "bottom", score: { home: 0, away: 1 } }))).toBe(
      false,
    );
  });

  it("rejects the first inning", () => {
    expect(canShorten(state({ inning: 1, half: "top", score: { home: 0, away: 0 } }))).toBe(
      false,
    );
  });
});

describe("finishError", () => {
  it("returns null when the reason can end the game", () => {
    expect(
      finishError(state({ inning: 10, half: "top", score: { home: 3, away: 2 } }), "completed"),
    ).toBeNull();
    expect(
      finishError(state({ inning: 6, half: "top", score: { home: 1, away: 1 } }), "shortened"),
    ).toBeNull();
  });

  it("explains why completed or shortened cannot end the game yet", () => {
    expect(finishError(state({ inning: 1 }), "completed")).toMatch(/nine innings/);
    expect(finishError(state({ inning: 1 }), "shortened")).toMatch(/five innings/);
  });

  it("leaves the other end reasons alone", () => {
    expect(finishError(state({ inning: 1 }), "forfeit")).toBeNull();
    expect(finishError(state({ inning: 1 }), "suspended")).toBeNull();
    expect(finishError(state({ inning: 1 }), "rain")).toBeNull();
  });
});
