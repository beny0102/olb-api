import { Module } from "@nestjs/common";
import type pg from "pg";
import { AdminController } from "./admin/admin.controller.js";
import { AdminService } from "./admin/admin.service.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard, LogoutGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { AUTH_STORE, type AuthStore } from "./auth/auth.store.js";
import { MemoryAuthStore } from "./auth/memory-auth.store.js";
import { PostgresAuthStore } from "./auth/postgres-auth.store.js";
import { ScopesService } from "./auth/scopes.js";
import { HealthController } from "./health.controller.js";
import { GamesController } from "./games/games.controller.js";
import { GamesService } from "./games/games.service.js";
import { ProposalsController } from "./games/proposals.controller.js";
import { ProposalsService } from "./games/proposals.service.js";
import { StandingsController } from "./games/standings.controller.js";
import { LeagueController } from "./league/league.controller.js";
import { LeagueService } from "./league/league.service.js";
import { LEAGUE_STORE, type LeagueStore } from "./store/league.store.js";
import { MemoryLeagueStore } from "./store/memory-league.store.js";
import { MemoryEventStore } from "./store/memory.store.js";
import { runMigrations } from "./store/migrations.js";
import { createPool, PG_POOL } from "./store/pg.js";
import { PostgresLeagueStore } from "./store/postgres-league.store.js";
import { PostgresEventStore } from "./store/postgres.store.js";
import { EVENT_STORE, type EventStore } from "./store/store.js";

@Module({
  controllers: [
    HealthController,
    GamesController,
    ProposalsController,
    StandingsController,
    LeagueController,
    AuthController,
    AdminController,
  ],
  providers: [
    GamesService,
    ProposalsService,
    LeagueService,
    AuthService,
    AuthGuard,
    LogoutGuard,
    ScopesService,
    AdminService,
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
    {
      provide: AUTH_STORE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool | null): AuthStore =>
        pool ? new PostgresAuthStore(pool) : new MemoryAuthStore(),
    },
  ],
})
export class AppModule {}
