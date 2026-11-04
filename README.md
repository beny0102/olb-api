# olb-api

League API for **Open League Baseball**. It owns the event log for every game
and serves the game state derived from it.

**Status: pre-alpha.** A game can be scheduled, started, scored through the
API, finished, and read back as a box score and standings derived from its
event log. There is no authentication and no realtime transport yet.

## Quick start

The contract is consumed as a local package until it is published to npm, so
`olb-contract` must sit next to this repository:

```
work/
  olb-contract/
  olb-api/
```

```bash
npm install
npm run build
npm start
```

Without `DATABASE_URL` the API uses an in-memory store. It is the default so
that `npm test` and a first run need no services, and it loses everything on
restart.

With Postgres:

```bash
docker run --rm -p 5432:5432 \
  -e POSTGRES_PASSWORD=olb -e POSTGRES_DB=olb \
  postgres:16-alpine

DATABASE_URL=postgres://postgres:olb@localhost:5432/olb npm start
```

The schema is created on startup (`games` and `events` tables). The `games`
row keeps the optional `scheduled_start` and `venue` columns next to the teams.
If you reuse a volume created by an earlier build, recreate it
(`docker compose down -v`, or remove the container): the DDL uses
`CREATE TABLE IF NOT EXISTS` and does not add columns to an existing table.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, contract version, active storage |
| POST | `/games` | Schedule a game (`scheduled`, no event appended) |
| GET | `/games` | List recent games |
| POST | `/games/:id/start` | Append `game.start` and make the game live |
| POST | `/games/:id/finish` | Append `game.end` with the official score |
| GET | `/games/:id` | Game record and last sequence number |
| GET | `/games/:id/state` | Projection folded from the whole log |
| GET | `/games/:id/boxscore` | Runs, hits, errors and linescore derived from the log |
| GET | `/games/:id/events?fromSeq=N` | Event log from a sequence number |
| POST | `/games/:id/events` | Append one event |
| GET | `/standings` | W/L, runs for and against, from finished games |

Creating a game does not write to the log. An empty log already folds to
`scheduled`, so `game.start` is appended only when the scorekeeper calls
`/start`; a second start, or a start on a game that already has events,
answers `409`. Finishing uses the folded score unless `finalScore` is given;
a provided score that disagrees with the fold is also a `409` and nothing is
appended.

Appending a pitch:

```bash
curl -X POST http://localhost:3000/games/$GAME/events \
  -H 'content-type: application/json' \
  -d '{
    "type": "pitch",
    "source": "human",
    "actor": { "kind": "user", "id": "usr_01HX" },
    "payload": {
      "pitchNo": 1,
      "batter": "0192f3a2-0001-7000-8000-000000000001",
      "pitcher": "0192f3a2-0001-7000-8000-000000000002",
      "count": { "balls": 0, "strikes": 0 },
      "call": "S"
    }
  }'
```

The response is the stored event with `id`, `seq`, `occurredAt`, `recordedAt`
and `contract` filled in by the server. The client never chooses a sequence
number, an event id, or a recording time.

## How it works

```
POST /games/:id/events
        │
        ▼
  @olb/contract parseEvent      reject anything the contract does not describe
        │
        ▼
  EventStore.append(gameId)     assign seq atomically, persist
        │
        ▼
  foldEvents(events)            pure projection, no writes
```

Three properties are worth stating explicitly:

- **The log is the source of truth.** `GET /state`, `/boxscore` and
  `/standings` are recomputed from events, never stored, so a corrected or
  amended event changes history the same way for every consumer (whitepaper P4).
- **Validation happens once, at the boundary.** Events are parsed with the
  published contract before they are stored, so an invalid `call` code or a
  missing actor never reaches the log.
- **Unknown fields survive.** The contract is open; a newer scorekeeper can
  send a field this build does not know and the API stores it untouched.

`GameState` follows `gameState` in the contract's common schema, so the same
object can be wrapped in a realtime `snapshot` message without translation.

Two stores implement the same `EventStore` interface: `MemoryEventStore` for
development and tests, and `PostgresEventStore` for real use. Postgres takes a
row lock on the game (`SELECT ... FOR UPDATE`) before computing the next
sequence number, which keeps two API replicas from writing the same `seq`.

## Box score and standings

`GET /games/:id/boxscore` derives every number from the log. Runs come from the
plays that reach home (or the official `finalScore`), hits from play codes that
start with `S`, `D`, `T` or `HR`, errors from E-codes and `error` fielding
roles, and the linescore from each `inning.end.runsScored`, padded to nine
innings with `null`. Player lines are absent because there is no player
registry yet.

`GET /standings` folds every game and counts only `final` games plus `forfeit`
games (a forfeit is terminal too). Teams are grouped by their exact label, and
the table is ordered by winning percentage and then run differential.

## Not implemented yet

- Realtime gateway (WebSocket, snapshot + delta, resume from `fromSeq`)
- Authentication, roles, and per-game write authorization
- League ERP entities (leagues, seasons, teams, rosters) and stats
- Postgres integration tests in CI
- Docker image

## Development

```bash
npm run typecheck
npm test          # fold rules, lifecycle and HTTP box score/standings
```

## License

Apache-2.0. Contributions use the DCO; see the
[whitepaper](https://github.com/beny0102/olb) for governance.
