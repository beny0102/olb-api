import { afterEach, describe, expect, it } from "vitest";
import { initialState, type GameState } from "../src/domain/fold.js";
import { MemoryGameStreamBus } from "../src/games/game-stream.bus.js";
import { GameStreamService } from "../src/games/game-stream.service.js";

function state(lastSeq: number): GameState {
  return { ...initialState, status: "live", lastSeq };
}

describe("GameStreamService", () => {
  const services: GameStreamService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.onModuleDestroy()));
  });

  async function setup(): Promise<{
    service: GameStreamService;
    received: GameState[];
  }> {
    const service = new GameStreamService(new MemoryGameStreamBus());
    services.push(service);
    await service.onModuleInit();
    const received: GameState[] = [];
    service.watch("game-1").subscribe((update) => received.push(update.state));
    return { service, received };
  }

  it("delivers monotonically increasing states and drops duplicates", async () => {
    const { service, received } = await setup();

    await service.publish("game-1", state(2));
    await service.publish("game-1", state(1));
    await service.publish("game-1", state(2));
    await service.publish("game-1", state(3));

    expect(received.map((entry) => entry.lastSeq)).toEqual([2, 3]);
  });

  it("uses the snapshot cursor to suppress already-covered states", async () => {
    const { service, received } = await setup();

    service.observe("game-1", 5);
    await service.publish("game-1", state(4));
    await service.publish("game-1", state(5));
    await service.publish("game-1", state(6));

    expect(received.map((entry) => entry.lastSeq)).toEqual([6]);
  });

  it("reports the bus mode and health", async () => {
    const { service } = await setup();

    expect(service.kind).toBe("memory");
    await expect(service.health()).resolves.toBe(true);
  });
});
