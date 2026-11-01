export class GameNotFoundError extends Error {
  constructor(readonly gameId: string) {
    super(`game not found: ${gameId}`);
    this.name = "GameNotFoundError";
  }
}
