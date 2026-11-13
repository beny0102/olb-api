/**
 * Seed a completed nine-inning league game through the public API.
 *
 * Runs after `seed:league` against a live API (`API_URL`, default
 * http://127.0.0.1:3001). The catalog rows come from the fixed seed constants,
 * and both rosters are read first: every player id in an event belongs to the
 * seeded roster. The marker venue makes the game findable on a second run; a
 * final game exits 0 and a partially written log resumes by event id, so the
 * seed never duplicates a play.
 *
 * Deliberately dependency-free: Node's global fetch is the only client.
 */

import {
  SEED_COMPETITION_IDS,
  SEED_SEASON_ID,
  SEED_TEAM_SEASON_IDS,
} from "./league-seed.js";

const API_URL = (process.env.API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@liga-metropolitana.olb";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "olb-demo-admin";

const SEASON_ID = SEED_SEASON_ID;
const COMPETITION_ID = SEED_COMPETITION_IDS[0];
const HOME_TEAM_SEASON_ID = SEED_TEAM_SEASON_IDS[0];
const AWAY_TEAM_SEASON_ID = SEED_TEAM_SEASON_IDS[1];

const VENUE = "Estadio Metropolitano · seed full";
const SCHEDULED_START = "2026-05-02T23:00:00.000Z";
const STARTED_AT = SCHEDULED_START;
const ACTOR_ID = "olb-seed-full";

/** Runs per inning. Both sides must add up to the final score. */
const AWAY_RUNS: readonly number[] = [0, 2, 0, 0, 2, 0, 0, 1, 0];
const HOME_RUNS: readonly number[] = [1, 0, 0, 1, 0, 0, 1, 0, 0];
const FINAL_SCORE = {
  home: HOME_RUNS.reduce((total, runs) => total + runs, 0),
  away: AWAY_RUNS.reduce((total, runs) => total + runs, 0),
};

/** Fallback when a roster row has no recognised primary position. */
const FIXED_POSITIONS = ["8", "4", "9", "3", "5", "6", "7", "2", "1"] as const;

const FIELDING_POSITIONS: Record<string, string> = {
  P: "1",
  C: "2",
  "1B": "3",
  "2B": "4",
  "3B": "5",
  SS: "6",
  LF: "7",
  CF: "8",
  RF: "9",
  DH: "DH",
  PH: "PH",
  PR: "PR",
};

type TeamSide = "home" | "away";

interface LoginResult {
  token: string;
}

interface RosterEntry {
  playerId: string;
  firstName: string;
  lastName: string;
  primaryPosition: string | null;
  status: string;
}

interface TeamSeasonView {
  teamSeason: { id: string; teamName: string };
  roster: RosterEntry[];
}

interface LeagueGameView {
  id: string;
  venue: string | null;
  status: string;
  score: { home: number; away: number } | null;
}

interface GameRecord {
  id: string;
  lastSeq: number;
}

interface StoredEvent {
  id: string;
}

interface LineupSlot {
  player: string;
  position: string;
}

interface Lineup {
  readonly slots: readonly LineupSlot[];
  readonly pitcher: string;
}

interface Draft {
  id: string;
  type: string;
  source: "human";
  actor: { kind: "service"; id: string };
  payload: Record<string, unknown>;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API_URL}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function positionFor(entry: RosterEntry, index: number): string {
  const primary = entry.primaryPosition?.trim().toUpperCase();
  const mapped = primary === undefined || primary.length === 0 ? undefined : FIELDING_POSITIONS[primary];
  return mapped ?? FIXED_POSITIONS[index] ?? FIXED_POSITIONS[0]!;
}

/**
 * The first nine active roster rows bat, in roster order. The pitcher is the
 * first active player whose primary position is P, or the first batter when
 * the roster has none.
 */
function lineupFrom(roster: TeamSeasonView): Lineup {
  const active = roster.roster.filter((entry) => entry.status === "active");
  const slots = active.slice(0, 9).map((entry, index) => ({
    player: entry.playerId,
    position: positionFor(entry, index),
  }));
  if (slots.length < 9) {
    throw new Error(
      `team season ${roster.teamSeason.id} has ${slots.length} active players; nine are required`,
    );
  }

  const pitcher =
    active.find((entry) => entry.primaryPosition?.trim().toUpperCase() === "P")?.playerId ??
    slots[0]!.player;

  return { slots, pitcher };
}

function otherSide(side: TeamSide): TeamSide {
  return side === "away" ? "home" : "away";
}

function idFor(count: number): string {
  return `0192f3d1-0000-7000-8000-${String(count).padStart(12, "0")}`;
}

/** Builds the whole game in memory, so a resume compares ids before writing. */
class GameDrafts {
  private count = 0;
  private pitchNo = 0;
  private readonly batterIndex: Record<TeamSide, number> = { away: 0, home: 0 };

  constructor(
    private readonly home: Lineup,
    private readonly away: Lineup,
  ) {}

  all(): Draft[] {
    const drafts = [
      this.lineup("away", this.away),
      this.lineup("home", this.home),
    ];

    for (let inning = 1; inning <= 9; inning += 1) {
      drafts.push(...this.halfInning(inning, "top", AWAY_RUNS[inning - 1] ?? 0));
      drafts.push(...this.halfInning(inning, "bottom", HOME_RUNS[inning - 1] ?? 0));
    }

    return drafts;
  }

  private event(type: string, payload: Record<string, unknown>): Draft {
    this.count += 1;
    return {
      id: idFor(this.count),
      type,
      source: "human",
      actor: { kind: "service", id: ACTOR_ID },
      payload,
    };
  }

  private lineup(team: TeamSide, lineup: Lineup): Draft {
    return this.event("lineup.set", {
      team,
      battingOrder: lineup.slots.map((slot) => ({
        player: slot.player,
        position: slot.position,
      })),
      pitcher: lineup.pitcher,
    });
  }

  private side(side: TeamSide): Lineup {
    return side === "away" ? this.away : this.home;
  }

  private nextBatter(side: TeamSide): string {
    const lineup = this.side(side);
    const index = this.batterIndex[side] % lineup.slots.length;
    this.batterIndex[side] += 1;
    return lineup.slots[index]!.player;
  }

  private fielder(side: TeamSide, position: string): string {
    const lineup = this.side(side);
    return lineup.slots.find((slot) => slot.position === position)?.player ?? lineup.slots[0]!.player;
  }

  private pitch(
    batter: string,
    pitcher: string,
    call: string,
    balls: number,
    strikes: number,
  ): Draft {
    this.pitchNo += 1;
    return this.event("pitch", {
      pitchNo: this.pitchNo,
      batter,
      pitcher,
      count: { balls, strikes },
      call,
      pitchType: call === "X" ? "FF" : "SL",
    });
  }

  private plateAppearance(
    side: TeamSide,
    kind: "home_run" | "groundout" | "flyout" | "strikeout",
  ): Draft[] {
    const fielding = otherSide(side);
    const batter = this.nextBatter(side);
    const pitcher = this.side(fielding).pitcher;

    if (kind === "strikeout") {
      return [
        this.pitch(batter, pitcher, "C", 0, 0),
        this.pitch(batter, pitcher, "S", 0, 1),
        this.pitch(batter, pitcher, "S", 0, 2),
      ];
    }

    const first = this.count % 2 === 0 ? "B" : "C";
    const pitches = [
      this.pitch(batter, pitcher, first, 0, 0),
      this.pitch(batter, pitcher, "X", first === "B" ? 1 : 0, first === "C" ? 1 : 0),
    ];

    if (kind === "home_run") {
      return [
        ...pitches,
        this.event("ball_in_play", {
          batter,
          code: "HR/F",
          description: "jonrón al jardín izquierdo",
          runsBattedIn: 1,
        }),
      ];
    }

    if (kind === "groundout") {
      return [
        ...pitches,
        this.event("ball_in_play", {
          batter,
          code: "63",
          description: "rodado al campocorto, out en primera",
          fielders: [
            { player: this.fielder(fielding, "6"), position: "6", role: "assist" },
            { player: this.fielder(fielding, "3"), position: "3", role: "putout" },
          ],
          runsBattedIn: 0,
        }),
      ];
    }

    return [
      ...pitches,
      this.event("ball_in_play", {
        batter,
        code: "8",
        description: "elevado al jardín central",
        fielders: [
          { player: this.fielder(fielding, "8"), position: "8", role: "putout" },
        ],
        runsBattedIn: 0,
      }),
    ];
  }

  private halfInning(inning: number, half: "top" | "bottom", runs: number): Draft[] {
    const side: TeamSide = half === "top" ? "away" : "home";
    const drafts: Draft[] = [];

    for (let run = 0; run < runs; run += 1) {
      drafts.push(...this.plateAppearance(side, "home_run"));
    }

    const outs: Array<"groundout" | "flyout" | "strikeout"> = ["groundout", "flyout", "strikeout"];
    const offset = (inning + (half === "bottom" ? 1 : 0)) % outs.length;
    for (let out = 0; out < 3; out += 1) {
      const kind = outs[(offset + out) % outs.length];
      if (kind === undefined) throw new Error("missing out kind");
      drafts.push(...this.plateAppearance(side, kind));
    }

    drafts.push(
      this.event("inning.end", {
        inning,
        half,
        runsScored: runs,
        outs: 3,
      }),
    );

    return drafts;
  }
}

async function main(): Promise<void> {
  console.log(`full game seed against ${API_URL}`);

  const login = await post<LoginResult>("/auth/login", {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  if (typeof login.token !== "string" || login.token.length === 0) {
    throw new Error("login did not return a token");
  }
  const token = login.token;

  // Fail early with a useful message when the catalog seed has not run.
  await get(`/seasons/${SEASON_ID}`);

  const games = await get<LeagueGameView[]>(`/seasons/${SEASON_ID}/games`);
  const existing = games.find((game) => game.venue === VENUE);

  if (existing && existing.status === "final") {
    console.log(`already seeded full game ${existing.id}; nothing to do`);
    return;
  }

  let gameId: string;
  if (existing) {
    gameId = existing.id;
  } else {
    const created = await post<{ id: string }>(
      "/admin/games",
      {
        seasonId: SEASON_ID,
        competitionId: COMPETITION_ID,
        homeTeamSeasonId: HOME_TEAM_SEASON_ID,
        awayTeamSeasonId: AWAY_TEAM_SEASON_ID,
        scheduledStart: SCHEDULED_START,
        venue: VENUE,
        coverage: "full",
      },
      token,
    );
    gameId = created.id;
  }

  const record = await get<GameRecord>(`/games/${gameId}`);
  if (record.lastSeq === 0) {
    await post(
      `/games/${gameId}/start`,
      { venue: VENUE, fieldCondition: "dry", startedAt: STARTED_AT },
      token,
    );
  }

  const [home, away] = await Promise.all([
    get<TeamSeasonView>(`/team-seasons/${HOME_TEAM_SEASON_ID}`),
    get<TeamSeasonView>(`/team-seasons/${AWAY_TEAM_SEASON_ID}`),
  ]);

  const drafts = new GameDrafts(lineupFrom(home), lineupFrom(away)).all();
  const stored = await get<StoredEvent[]>(`/games/${gameId}/events`);
  const storedIds = new Set(stored.map((event) => event.id));

  let appended = 0;
  for (const draft of drafts) {
    if (storedIds.has(draft.id)) continue;
    await post(`/games/${gameId}/events`, draft, token);
    appended += 1;
  }

  const finished = await post<{ lastSeq: number; state: { score: { home: number; away: number } } }>(
    `/games/${gameId}/finish`,
    { reason: "completed", finalScore: FINAL_SCORE },
    token,
  );

  console.log(
    `seeded full game ${gameId}: Faros ${finished.state.score.away} @ Tiburones ` +
      `${finished.state.score.home} (${appended} events appended, ` +
      `${finished.lastSeq + 1} total events, lastSeq ${finished.lastSeq})`,
  );
}

main().catch((error: unknown) => {
  console.error(`seed-full failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
