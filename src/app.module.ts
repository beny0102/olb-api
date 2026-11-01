import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller.js";
import { GamesController } from "./games/games.controller.js";
import { GamesService } from "./games/games.service.js";
import { MemoryEventStore } from "./store/memory.store.js";
import { PostgresEventStore } from "./store/postgres.store.js";
import { EVENT_STORE, type EventStore } from "./store/store.js";

@Module({
  controllers: [HealthController, GamesController],
  providers: [
    GamesService,
    {
      provide: EVENT_STORE,
      useFactory: async (): Promise<EventStore> => {
        const url = process.env.DATABASE_URL;
        if (!url) return new MemoryEventStore();

        const store = new PostgresEventStore(url);
        await store.init();
        return store;
      },
    },
  ],
})
export class AppModule {}
