import { Controller, Get, Inject } from "@nestjs/common";
import { EVENT_STORE, type EventStore } from "./store/store.js";

@Controller("health")
export class HealthController {
  constructor(@Inject(EVENT_STORE) private readonly store: EventStore) {}

  @Get()
  async check() {
    await this.store.ping();
    return {
      status: "ok",
      contract: "olb.event/1",
      storage: this.store.kind,
      time: new Date().toISOString(),
    };
  }
}
