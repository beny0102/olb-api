import type { Event } from "@olb/contract/types";
import pg from "pg";
import { GameNotFoundError } from "./errors.js";
import type { CreateGameInput, EventStore, GameRecord } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY,
  home_team text NOT NULL,
  away_team text NOT NULL,
  scheduled_start timestamptz,
  venue text,
  created_at timestamptz NOT NULL,
  seq integer NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS events (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  body jsonb NOT NULL,
  PRIMARY KEY (game_id, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS events_event_id_unique ON events ((body->>'id'));
`;

interface GameRow {
  id: string;
  home_team: string;
  away_team: string;
  scheduled_start: Date | null;
  venue: string | null;
  created_at: Date;
  seq: number;
}

function toRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    scheduledStart: row.scheduled_start ? row.scheduled_start.toISOString() : null,
    venue: row.venue,
    createdAt: row.created_at.toISOString(),
    lastSeq: row.seq,
  };
}

/**
 * Postgres store. One writer per game is enforced by `SELECT ... FOR UPDATE`
 * on the games row, which is also the only place the next sequence number is
 * computed. Two API replicas can therefore append to the same game safely.
 */
export class PostgresEventStore implements EventStore {
  readonly kind = "postgres" as const;

  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 10,
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
  }

  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async createGame(input: CreateGameInput): Promise<GameRecord> {
    const { rows } = await this.pool.query<GameRow>(
      `INSERT INTO games (id, home_team, away_team, scheduled_start, venue, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, home_team, away_team, scheduled_start, venue, created_at, seq`,
      [
        input.id,
        input.homeTeam,
        input.awayTeam,
        input.scheduledStart,
        input.venue,
        input.createdAt,
      ],
    );
    return toRecord(rows[0]!);
  }

  async getGame(id: string): Promise<GameRecord | null> {
    const { rows } = await this.pool.query<GameRow>(
      `SELECT id, home_team, away_team, scheduled_start, venue, created_at, seq
         FROM games WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async listGames(): Promise<GameRecord[]> {
    const { rows } = await this.pool.query<GameRow>(
      `SELECT id, home_team, away_team, scheduled_start, venue, created_at, seq
         FROM games ORDER BY created_at DESC LIMIT 100`,
    );
    return rows.map(toRecord);
  }

  async append(gameId: string, build: (seq: number) => Event): Promise<Event> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ seq: number }>(
        `SELECT seq FROM games WHERE id = $1 FOR UPDATE`,
        [gameId],
      );
      const row = rows[0];
      if (!row) throw new GameNotFoundError(gameId);

      const seq = row.seq + 1;
      const event = build(seq);

      await client.query(`INSERT INTO events (game_id, seq, body) VALUES ($1, $2, $3)`, [
        gameId,
        seq,
        event,
      ]);
      await client.query(`UPDATE games SET seq = $2 WHERE id = $1`, [gameId, seq]);
      await client.query("COMMIT");
      return event;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listEvents(gameId: string, fromSeq: number): Promise<Event[]> {
    const { rows } = await this.pool.query<{ body: Event }>(
      `SELECT body FROM events WHERE game_id = $1 AND seq >= $2 ORDER BY seq ASC`,
      [gameId, fromSeq],
    );
    return rows.map((row) => row.body);
  }

  async findEventById(id: string): Promise<Event | null> {
    const { rows } = await this.pool.query<{ body: Event }>(
      `SELECT body FROM events WHERE body->>'id' = $1 LIMIT 1`,
      [id],
    );
    return rows[0]?.body ?? null;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
