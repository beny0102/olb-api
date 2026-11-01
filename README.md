# olb-api

League API for **Open League Baseball**. It owns the event log for every game
and serves the game state derived from it.

**Status: pre-alpha.** A game can be created, events can be appended, and the
projection is served over HTTP. There is no authentication and no realtime
transport yet.

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

The schema is created on startup (`games` and `events` tables).

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness, contract version, active storage |
| POST | `/games` | Create a game and append `game.start` at seq 0 |
| GET | `/games` | List recent games |
| GET | `/games/:id` | Game record and last sequence number |
| GET | `/games/:id/state` | Projection folded from the whole log |
| GET | `/games/:id/events?fromSeq=N` | Event log from a sequence number |
| POST | `/games/:id/events` | Append one event |

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

- **The log is the source of truth.** `GET /state` is recomputed from events,
  never stored, so a corrected or amended event changes history the same way
  for every consumer (whitepaper P4).
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

## Not implemented yet

- Realtime gateway (WebSocket, snapshot + delta, resume from `fromSeq`)
- Authentication, roles, and per-game write authorization
- League ERP entities (leagues, seasons, teams, rosters) and stats
- Postgres integration tests in CI
- Docker image

## Development

```bash
npm run typecheck
npm test          # 15 tests: fold rules and HTTP behaviour
```

## License

Apache-2.0. Contributions use the DCO; see the
[whitepaper](https://github.com/beny0102/olb) for governance.
