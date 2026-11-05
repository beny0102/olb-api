import { Module } from "@nestjs/common";
import type pg from "pg";
import { HealthController } from "./health.controller.js";
import { GamesController } from "./games/games.controller.js";
import { GamesService } from "./games/games.service.js";
import { ProposalsController } from "./games/proposals.controller.js";
import { ProposalsService } from "./games/proposals.service.js";
import { StandingsController } from "./games/standings.controller.js";
import { LEAGUE_STORE, type LeagueStore } from "./store/league.store.js";
import { MemoryLeagueStore } from "./store/memory-league.store.js";
import { MemoryEventStore } from "./store/memory.store.js";
import { runMigrations } from "./store/migrations.js";
import { createPool, PG_POOL } from "./store/pg.js";
import { PostgresLeagueStore } from "./store/postgres-league.store.js";
import { PostgresEventStore } from "./store/postgres.store.js";
import { EVENT_STORE, type EventStore } from "./store/store.js";

@Module({
  controllers: [HealthController, GamesController, ProposalsController, StandingsController],
  providers: [
    GamesService,
    ProposalsService,
    {
      provide: PG_POOL,
      useFactory: async (): Promise<pg.Pool | null> => {
        const url = process.env.DATABASE_URL;
        if (!url) return null;

        const pool = createPool(url);
        await runMigrations(pool);
        return pool;
      },
    },
    {
      provide: EVENT_STORE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null): EventStore =>
        pool ? new PostgresEventStore(pool) : new MemoryEventStore(),
    },
    {
      provide: LEAGUE_STORE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null): LeagueStore =>
        pool ? new PostgresLeagueStore(pool) : new MemoryLeagueStore(),
    },
  ],
})
export class AppModule {}
