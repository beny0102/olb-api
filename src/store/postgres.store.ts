import type { Event } from "@olb/contract/types";
import pg from "pg";
import { uuidv7 } from "../domain/uuid7.js";
import { GameNotFoundError } from "./errors.js";
import type {
  CreateGameInput,
  CreateProposalInput,
  EventStore,
  GameRecord,
  ProposalPayload,
  ProposalRecord,
  ProposalStatus,
} from "./store.js";

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

interface ProposalRow {
  id: string;
  game_id: string;
  created_at: Date;
  author: string;
  status: string;
  payload: ProposalPayload;
}

function toProposal(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    gameId: row.game_id,
    createdAt: row.created_at.toISOString(),
    author: row.author,
    status: row.status as ProposalStatus,
    payload: row.payload,
  };
}

/**
 * Postgres store. One writer per game is enforced by `SELECT ... FOR UPDATE`
 * on the games row, which is also the only place the next sequence number is
 * computed. Two API replicas can therefore append to the same game safely.
 *
 * The pool and the schema are owned by the application: migrations run once
 * at startup, never from this store.
 */
export class PostgresEventStore implements EventStore {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: pg.Pool) {}

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

  async createProposal(input: CreateProposalInput): Promise<ProposalRecord> {
    const record: ProposalRecord = {
      id: uuidv7(),
      gameId: input.gameId,
      createdAt: new Date().toISOString(),
      author: input.author,
      status: "open",
      payload: input.payload,
    };
    const { rows } = await this.pool.query<ProposalRow>(
      `INSERT INTO proposals (id, game_id, created_at, author, status, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, game_id, created_at, author, status, payload`,
      [
        record.id,
        record.gameId,
        record.createdAt,
        record.author,
        record.status,
        record.payload,
      ],
    );
    return toProposal(rows[0]!);
  }

  async listProposals(gameId: string, status?: ProposalStatus): Promise<ProposalRecord[]> {
    const params: unknown[] = [gameId];
    let query = `SELECT id, game_id, created_at, author, status, payload
                   FROM proposals WHERE game_id = $1`;
    if (status !== undefined) {
      params.push(status);
      query += ` AND status = $2`;
    }
    query += ` ORDER BY created_at ASC, id ASC`;

    const { rows } = await this.pool.query<ProposalRow>(query, params);
    return rows.map(toProposal);
  }

  async getProposal(id: string): Promise<ProposalRecord | null> {
    const { rows } = await this.pool.query<ProposalRow>(
      `SELECT id, game_id, created_at, author, status, payload
         FROM proposals WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async resolveProposal(id: string, status: ProposalStatus): Promise<ProposalRecord | null> {
    const { rows } = await this.pool.query<ProposalRow>(
      `UPDATE proposals SET status = $2 WHERE id = $1
       RETURNING id, game_id, created_at, author, status, payload`,
      [id, status],
    );
    return rows[0] ? toProposal(rows[0]) : null;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }
}
