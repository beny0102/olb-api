import type { GameState } from "./fold.js";

/**
 * A game can be completed after nine full innings with a winner, after 8.5
 * innings when the home team is ahead, or on a walk-off in the bottom of the
 * ninth or later.
 */
export function canComplete(state: GameState): boolean {
  const { home, away } = state.score;
  return (
    (state.inning >= 10 && home !== away) ||
    (state.half === "bottom" && state.inning >= 9 && home > away)
  );
}

/**
 * A game can be shortened after five full innings, or after 4.5 innings when
 * the home team is ahead.
 */
export function canShorten(state: GameState): boolean {
  const { home, away } = state.score;
  return (
    state.inning >= 6 || (state.inning === 5 && state.half === "bottom" && home > away)
  );
}

/** Why this reason cannot end the game at this point, or null when it can. */
export function finishError(state: GameState, reason: string): string | null {
  if (reason === "completed" && !canComplete(state)) {
    return "completed requires nine innings with a winner";
  }
  if (reason === "shortened" && !canShorten(state)) {
    return "shortened requires five innings with a winner";
  }
  return null;
}
