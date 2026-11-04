/**
 * Reproducible demo seed.
 *
 * Runs against a live API (`API_URL`, default http://localhost:3001) and
 * appends a complete nine-inning game through the public contract endpoints.
 * Every identity the seed controls is fixed, so a second run finds the game by
 * id and exits 0 without appending anything.
 *
 * Deliberately dependency-free: Node 24's global fetch is the only client.
 */

const API_URL = (process.env.API_URL ?? "http://localhost:3001").replace(/\/$/, "");

const SEEDED_GAME_ID = "0192f3a2-0100-7000-8000-000000000001";
const SCHEDULED_GAME_ID = "0192f3a2-0100-7000-8000-000000000002";
const STARTED_AT = "2026-04-11T23:40:00.000Z";
const SCHEDULED_START = "2027-04-10T23:00:00.000Z";
const VENUE = "Estadio Centenario";

const ACTOR = { kind: "service" as const, id: "olb-seed-demo" };
const POSITIONS = ["8", "4", "9", "3", "5", "6", "7", "2", "1"] as const;

/** Runs per inning. Both sides must add up to the final score. */
const AWAY_RUNS: readonly number[] = [1, 0, 0, 1, 0, 0, 1, 0, 0];
const HOME_RUNS: readonly number[] = [0, 2, 0, 0, 2, 0, 0, 1, 0];

interface Roster {
  readonly name: string;
  readonly players: readonly string[];
}

interface GameRecord {
  id: string;
  lastSeq: number;
}

interface FinishResponse {
  lastSeq: number;
  state: { score: { home: number; away: number } };
}

interface Draft {
  type: string;
  source: "human";
  actor: { kind: "service"; id: string };
  payload: Record<string, unknown>;
}

type TeamSide = "home" | "away";

/** Fixed UUIDv7 player identities, nine per club. */
function players(prefix: string): string[] {
  return Array.from(
    { length: 9 },
    (_, index) => `0192f3a2-${prefix}-7000-8000-${String(index + 1).padStart(12, "0")}`,
  );
}

const AWAY: Roster = { name: "Marlins", players: players("0200") };
const HOME: Roster = { name: "Tiburones", players: players("0300") };

function roster(side: TeamSide): Roster {
  return side === "away" ? AWAY : HOME;
}

function playerAt(side: TeamSide, position: string): string {
  const index = POSITIONS.indexOf(position as (typeof POSITIONS)[number]);
  const player = roster(side).players[index];
  if (player === undefined) throw new Error(`${side} has no player at position ${position}`);
  return player;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function readGame(id: string): Promise<GameRecord | null> {
  const response = await fetch(`${API_URL}/games/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET /games/${id} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as GameRecord;
}

class Seeder {
  private pitchNo = 0;
  private events = 0;
  private readonly batterIndex: Record<TeamSide, number> = { away: 0, home: 0 };

  async append(draft: Draft): Promise<void> {
    await post(`/games/${SEEDED_GAME_ID}/events`, draft);
    this.events += 1;
  }

  nextBatter(side: TeamSide): string {
    const index = this.batterIndex[side] % 9;
    this.batterIndex[side] += 1;
    const player = roster(side).players[index];
    if (player === undefined) throw new Error(`${side} batting order is empty`);
    return player;
  }

  pitch(batter: string, pitcher: string, call: string, balls: number, strikes: number): Draft {
    this.pitchNo += 1;
    return {
      type: "pitch",
      source: "human",
      actor: ACTOR,
      payload: {
        pitchNo: this.pitchNo,
        batter,
        pitcher,
        count: { balls, strikes },
        call,
        pitchType: call === "X" ? "FF" : "SL",
      },
    };
  }

  async plateAppearance(side: TeamSide, kind: "home_run" | "groundout" | "flyout" | "strikeout") {
    const fielding: TeamSide = side === "away" ? "home" : "away";
    const batter = this.nextBatter(side);
    const pitcher = playerAt(fielding, "1");

    if (kind === "strikeout") {
      await this.append(this.pitch(batter, pitcher, "C", 0, 0));
      await this.append(this.pitch(batter, pitcher, "S", 0, 1));
      await this.append(this.pitch(batter, pitcher, "S", 0, 2));
      return;
    }

    const first = this.events % 2 === 0 ? "B" : "C";
    await this.append(this.pitch(batter, pitcher, first, 0, 0));
    await this.append(this.pitch(batter, pitcher, "X", first === "B" ? 1 : 0, first === "C" ? 1 : 0));

    if (kind === "home_run") {
      await this.append({
        type: "ball_in_play",
        source: "human",
        actor: ACTOR,
        payload: {
          batter,
          code: "HR/F",
          description: "jonrón al jardín izquierdo",
          runsBattedIn: 1,
        },
      });
      return;
    }

    if (kind === "groundout") {
      await this.append({
        type: "ball_in_play",
        source: "human",
        actor: ACTOR,
        payload: {
          batter,
          code: "63",
          description: "rodado al campocorto, out en primera",
          fielders: [
            { player: playerAt(fielding, "6"), position: "6", role: "assist" },
            { player: playerAt(fielding, "3"), position: "3", role: "putout" },
          ],
          runsBattedIn: 0,
        },
      });
      return;
    }

    await this.append({
      type: "ball_in_play",
      source: "human",
      actor: ACTOR,
      payload: {
        batter,
        code: "8",
        description: "elevado al jardín central",
        fielders: [{ player: playerAt(fielding, "8"), position: "8", role: "putout" }],
        runsBattedIn: 0,
      },
    });
  }

  async halfInning(inning: number, half: "top" | "bottom", runs: number): Promise<void> {
    const side: TeamSide = half === "top" ? "away" : "home";

    for (let run = 0; run < runs; run += 1) {
      await this.plateAppearance(side, "home_run");
    }

    const outs: Array<"groundout" | "flyout" | "strikeout"> = ["groundout", "flyout", "strikeout"];
    const offset = (inning + (half === "bottom" ? 1 : 0)) % outs.length;
    for (let out = 0; out < 3; out += 1) {
      const kind = outs[(offset + out) % outs.length];
      if (kind === undefined) throw new Error("missing out kind");
      await this.plateAppearance(side, kind);
    }

    await this.append({
      type: "inning.end",
      source: "human",
      actor: ACTOR,
      payload: { inning, half, runsScored: runs, outs: 3 },
    });
  }

  async seedFinalGame(): Promise<void> {
    await post("/games", {
      id: SEEDED_GAME_ID,
      homeTeam: HOME.name,
      awayTeam: AWAY.name,
      venue: VENUE,
      scheduledStart: STARTED_AT,
    });
    await post(`/games/${SEEDED_GAME_ID}/start`, {
      venue: VENUE,
      fieldCondition: "dry",
      startedAt: STARTED_AT,
    });

    await this.append({
      type: "lineup.set",
      source: "human",
      actor: ACTOR,
      payload: {
        team: "away",
        battingOrder: AWAY.players.map((player, index) => ({
          player,
          position: POSITIONS[index],
        })),
        pitcher: playerAt("away", "1"),
      },
    });
    await this.append({
      type: "lineup.set",
      source: "human",
      actor: ACTOR,
      payload: {
        team: "home",
        battingOrder: HOME.players.map((player, index) => ({
          player,
          position: POSITIONS[index],
        })),
        pitcher: playerAt("home", "1"),
      },
    });

    for (let inning = 1; inning <= 9; inning += 1) {
      await this.halfInning(inning, "top", AWAY_RUNS[inning - 1] ?? 0);
      await this.halfInning(inning, "bottom", HOME_RUNS[inning - 1] ?? 0);
    }

    // The official score is whatever the log folded, so the seed states it
    // explicitly and the API's conflict check proves the two agree.
    const state = await post<FinishResponse>(`/games/${SEEDED_GAME_ID}/finish`, {
      reason: "completed",
      finalScore: {
        home: HOME_RUNS.reduce((total, runs) => total + runs, 0),
        away: AWAY_RUNS.reduce((total, runs) => total + runs, 0),
      },
    });

    console.log(
      `seeded nine-inning game ${SEEDED_GAME_ID}: ` +
        `${AWAY.name} ${state.state.score.away} @ ${HOME.name} ${state.state.score.home} ` +
        `(${this.events} events appended, lastSeq ${state.lastSeq})`,
    );
  }
}

async function seedScheduledGame(): Promise<void> {
  const existing = await readGame(SCHEDULED_GAME_ID);
  if (existing) {
    console.log(`already seeded scheduled game ${SCHEDULED_GAME_ID}; nothing to do`);
    return;
  }

  await post("/games", {
    id: SCHEDULED_GAME_ID,
    homeTeam: HOME.name,
    awayTeam: AWAY.name,
    venue: VENUE,
    scheduledStart: SCHEDULED_START,
  });
  console.log(
    `seeded scheduled game ${SCHEDULED_GAME_ID}: ${HOME.name} vs ${AWAY.name} at ${VENUE}`,
  );
}

async function main(): Promise<void> {
  console.log(`demo seed against ${API_URL}`);

  const existing = await readGame(SEEDED_GAME_ID);
  if (existing) {
    if (existing.lastSeq <= 0) {
      throw new Error(
        `game ${SEEDED_GAME_ID} exists but has no events; remove it before seeding again`,
      );
    }
    console.log(
      `already seeded game ${SEEDED_GAME_ID} (lastSeq ${existing.lastSeq}); nothing to do`,
    );
    await seedScheduledGame();
    return;
  }

  await new Seeder().seedFinalGame();
  await seedScheduledGame();
}

main().catch((error: unknown) => {
  console.error(`seed-demo failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
