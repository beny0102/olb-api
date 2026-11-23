import { Controller, Get, Inject } from "@nestjs/common";
import { GameStreamService } from "./games/game-stream.service.js";
import { EVENT_STORE, type EventStore } from "./store/store.js";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(EVENT_STORE) private readonly store: EventStore,
    @Inject(GameStreamService) private readonly stream: GameStreamService,
  ) {}

  @Get()
  async check() {
    await this.store.ping();
    const realtimeOk = await this.stream.health();
    return {
      status: "ok",
      contract: "olb.event/1",
      storage: this.store.kind,
      realtime: {
        mode: this.stream.kind,
        connected: realtimeOk,
      },
      time: new Date().toISOString(),
    };
  }
}
