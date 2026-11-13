# olb-api

League API for **Open League Baseball**. It owns the event log for every game
and serves the game state derived from it.

**Status: pre-alpha.** A game can be scheduled, started, scored through the
API, finished, and read back as a box score and standings derived from its
event log. League operators can log in and manage the catalog through scoped
admin endpoints. Game state can also be followed over SSE, and season leaders
are folded from full-game logs. The legacy event/proposal writes are still open
until scorer login lands in D2.

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

The schema is created on startup (`games`, `events`, `proposals` and the league
catalog tables). The `games` row keeps the optional `scheduled_start` and
`venue` columns next to the teams.
If you reuse a volume created by an earlier build, recreate it
(`docker compose down -v`, or remove the container): the DDL uses
`CREATE TABLE IF NOT EXISTS` and does not add columns to an existing table.

## Deployment package

`deploy/` runs the whole stack with Docker Compose against the Postgres event
store. The build context is the workspace root, because `@olb/contract` is a
`file:../olb-contract` dependency. The package publishes alternate ports so it
can run beside the manual `:3000/:3001/:3002` deployment without touching it:
web `3200`, API `3201`, scorer `3202` and Postgres `55451` (all localhost).

```bash
cp deploy/.env.example deploy/.env

# Build and start Postgres, API, web and scorer.
docker compose -f deploy/docker-compose.yml up -d --build

# Idempotent league catalog, demo users and memberships.
docker compose -f deploy/docker-compose.yml run --rm api \
  node dist/scripts/seed-league.js

# Optional: append the reproducible nine-inning game through the public API.
docker compose -f deploy/docker-compose.yml run --rm \
  -e API_URL=http://api:3001 api node dist/scripts/seed-demo.js
```

| URL | What it is |
| --- | --- |
| <http://localhost:3200> | League portal |
| <http://localhost:3200/stats> | Standings and season leaders |
| <http://localhost:3201/health> | Liveness, contract version and storage kind |
| <http://localhost:3202> | Offline-first scorer |

The API applies pending migrations on startup; `seed-league` is safe to run
twice. Demo credentials are listed under [Authentication and scopes](#authentication-and-scopes)
and must be replaced before any deployment that is not local.

```bash
# Stop the stack. The named volume is project-scoped, so this only removes
# the deploy package's Postgres data, never the manual olb-postgres volume.
docker compose -f deploy/docker-compose.yml down -v
```

### Backups and restore

```bash
./deploy/backup.sh                       # deploy/backups/olb-YYYYmmdd-HHMMSS.dump
RETENTION_DAYS=14 ./deploy/backup.sh     # keep 14 days instead of 7
BACKUP_CONTAINER=olb-postgres ./deploy/backup.sh   # dump the manual deployment

# Restore into a scratch database. `olb` itself requires --force.
./deploy/restore.sh deploy/backups/olb-20261105-030000.dump --db olb_restore_test
RESTORE_CONTAINER=olb-postgres \
  ./deploy/restore.sh deploy/backups/olb-20261105-030000.dump --db olb_restore_test

# Remove the drill database when the comparison is done.
docker exec olb-postgres dropdb -U postgres olb_restore_test
```

`backup.sh` writes a custom-format archive (`pg_dump -Fc`), never a plain SQL
file, and prunes by file age (`RETENTION_DAYS`, default 7). A nightly cron job:

```cron
0 3 * * * cd /home/benyp/work/olb/olb-api && ./deploy/backup.sh >> /var/log/olb-backup.log 2>&1
```

The same thing as a systemd timer (`/etc/systemd/system/olb-backup.service`
plus `olb-backup.timer`, `OnCalendar=*-*-* 03:00:00`) is preferable on a host
that already uses systemd. Whatever the scheduler, copy the dumps off-host:

```bash
rsync -a --delete deploy/backups/ backup-host:/srv/olb-backups/
```

A backup is not verified until it has been restored. Run the drill above after
changing the schema, and compare the table counts and one game state before
dropping the scratch database.

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
| GET | `/games/:id/stream` | SSE: initial `snapshot`, then `state` after each append |
| POST | `/games/:id/events` | Append one event |
| POST | `/games/:id/proposals` | Propose a play (two-person mode) |
| GET | `/games/:id/proposals?status=open\|accepted\|rejected\|all` | List proposals, default `open` |
| POST | `/games/:id/proposals/:pid/resolve` | Accept or reject a proposal |
| GET | `/standings` | W/L, runs for and against, from finished games |

Creating a game does not write to the log. The id is generated by default; a caller may pass a
UUIDv7 `id` so that a seed or replay is reproducible, and an existing id answers `409`. An empty
log already folds to `scheduled`, so `game.start` is appended only when the scorekeeper calls
`/start`; a second start, or a start on a game that already has events,
answers `409`. Finishing uses the folded score unless `finalScore` is given;
a provided score that disagrees with the fold is also a `409` and nothing is
appended.

## League domain

The catalog is stored in Postgres next to the event log: organizations, seasons,
competitions (leagues or divisions), teams, team seasons, players, roster entries
and games. With `DATABASE_URL` set, the API runs the migrations on startup;
without it the in-memory store is seeded on demand.

```bash
export DATABASE_URL=postgres://postgres:olb@localhost:5432/olb
npm run db:migrate     # apply pending migrations (also runs on API startup)
npm run seed:league    # idempotent Liga Metropolitana seed
npm run seed:full      # completed nine-inning game through the running API
```

The seed creates one organization, one active season, two divisions, four teams
with 18-player rosters and eight scheduled games. It is fictional and safe to
run twice: every row is upserted by its natural key.

`seed:full` runs against a live API (`API_URL`, default
`http://127.0.0.1:3001`) after `seed:league`. It logs in as
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`, creates a Tiburones-Faros game with
`full` coverage and appends a deterministic nine-inning log (final 5-3), so
`/seasons/:id/games`, `/seasons/:id/stats` and `/seasons/:id/leaders` show a
played game with non-empty batting and pitching leaders. The marker venue
`Estadio Metropolitano · seed full` makes it idempotent: a final game prints
`already seeded` and a partial log resumes by event id without duplicating a
play. It does not change `seed:league` or its scheduled games.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/organizations` | List organizations |
| GET | `/seasons?organizationId=` | Seasons, active first then year descending |
| GET | `/seasons/:id` | Season with its competitions |
| GET | `/seasons/:id/competitions` | Competitions of a season |
| GET | `/competitions/:id/teams` | Team seasons in a competition |
| GET | `/team-seasons/:id` | Team season with its roster |
| GET | `/seasons/:id/games?competitionId=` | Games with status and score |
| GET | `/seasons/:id/standings?competitionId=` | Standings grouped by competition |
| GET | `/seasons/:id/leaders?competitionId=` | Batting and pitching leaders from full-game logs |
| GET | `/seasons/:id/stats?competitionId=` | Standings groups plus batting and pitching leaders |

Game status and score are derived, never stored by hand. A `full` game is
projected from its event log. A `summary` or `external` game reads the
`game_summaries` row instead, and a game with neither stays `scheduled` with a
`null` score. Standings count only `final` and `forfeit` games: a tie counts as
a game played but adds no win or loss, and rows are ordered by winning
percentage, wins, runs against and name.

Season leaders fold the applied events of `full` games. Summary and external
games still count in the standings but cannot contribute player lines because
they have no play-by-play. Batting exposes PA, AB, H, HR, RBI, R, BB, SO, HBP
and AVG (three decimals, `null` when AB is zero); pitching exposes pitches, SO,
BB and appearances. Unsupported fields such as ERA are not invented. An unknown
season, competition, team season or competition filter answers `404`.


## Authentication and scopes

Authentication is a Bearer token issued by `POST /auth/login` and kept as a
SHA-256 hash in the `sessions` table. A session lasts seven days; logout revokes
it. Email is matched case-insensitively. Passwords are stored with `scrypt`
(`scrypt$<saltHex>$<hashHex>`), never in clear text, and no auth response
includes the password hash.

```bash
curl -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"admin@liga-metropolitana.olb","password":"olb-demo-admin"}'
```

Use the returned `token` on guarded endpoints:

```bash
curl http://localhost:3000/auth/me -H "Authorization: Bearer $TOKEN"
curl -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer $TOKEN"
```

`POST /auth/logout` is idempotent: repeating it with the same token still
answers `200`. Missing, malformed, expired or revoked tokens answer `401`.

`npm run seed:league` also seeds demo identities. **These credentials are
demo-only and must be replaced before any real deployment.**

| Email | Password | Scope |
| --- | --- | --- |
| `admin@liga-metropolitana.olb` | `olb-demo-admin` | `org_admin` on the organization |
| `norte@liga-metropolitana.olb` | `olb-demo-norte` | `competition_admin` on Zona Norte |
| `tiburones@liga-metropolitana.olb` | `olb-demo-tiburones` | `team_admin` and `scorer` on the Tiburones team season |
| `verificador@liga-metropolitana.olb` | `olb-demo-verificador` | `verifier` on Zona Norte |

The seed is idempotent and creates four users and five memberships (Tiburones
holds two roles). Override the demo passwords with `SEED_ADMIN_PASSWORD`,
`SEED_NORTE_PASSWORD`, `SEED_TIBURONES_PASSWORD` and `SEED_VERIFIER_PASSWORD`
before seeding.

### Bootstrap (setup)

A fresh deployment has no users. `GET /setup/status` reports
`{ "required": true }` until the first user exists.

| Method | Path | Guard |
| --- | --- | --- |
| GET | `/setup/status` | public |
| POST | `/setup` | setup token and no users; `409` afterwards |

`POST /setup` creates the organization, its first `active` user and an
`organization` / `org_admin` membership in one call, then removes the token
file:

```bash
curl -X POST http://localhost:3001/setup \
  -H 'content-type: application/json' \
  -d '{
    "token": "...",
    "organization": { "name": "Liga Metropolitana", "slug": "liga-metropolitana" },
    "admin": { "name": "Admin", "email": "admin@liga.olb", "password": "at-least-10-chars" }
  }'
```

The token comes from `SETUP_TOKEN`, or from `deploy/.setup-token` (mode
`0600`) when the env var is unset. On boot, if neither exists, the API
generates 32 random bytes, writes the file and logs only its path. The token is
never returned or logged, comparison is constant time, `/setup` allows five
attempts per minute per IP, and a wrong token answers `401`. If the admin
cannot be created after the organization row, the organization is deleted
again, so no orphan is left behind. After a successful setup the endpoint
answers `409` even with the right token.

The CLI uses the same public endpoint:

```bash
export SETUP_TOKEN="$(cat deploy/.setup-token)"
npm run setup -- \
  --org-name "Liga Metropolitana" \
  --org-slug liga-metropolitana \
  --admin-name "Admin" \
  --admin-email admin@liga.olb
```

The password comes from `--admin-password` or `SETUP_ADMIN_PASSWORD`; it is
never printed. `OLB_API_URL` defaults to `http://127.0.0.1:3001`; the command
prints the organization slug, the admin email and the login URL
(`OLB_LOGIN_URL`, or `OLB_VIEWER_URL` + `/login`, default
`http://127.0.0.1:3000/login`), and exits non-zero on error.

### Users and memberships

All routes below require an `org_admin` membership. Only users holding a
membership in the caller's organization are visible; another organization's
user answers `404`, never `403`. Emails are unique case-insensitively (stored
normalized, `409` on duplicates), passwords need at least 10 characters, and a
password change revokes that user's sessions. An admin cannot disable their own
account or remove their own last `org_admin` membership (`409`).

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/admin/users` | users with a membership in the organization |
| POST | `/admin/users` | `{email,name,password,memberships?}` → `{user,memberships}` |
| PATCH | `/admin/users/:id` | `{name?,email?,status?}` (`active`/`disabled`) |
| POST | `/admin/users/:id/password` | `{password}`; revokes that user's sessions |
| GET | `/admin/memberships` | optional `?userId=` filter |
| POST | `/admin/memberships` | `{userId,scopeType,scopeId,role}` |
| DELETE | `/admin/memberships/:id` | revoke one membership |

`scopeType` is `organization`, `competition` or `team_season`; `role` is
`org_admin`, `competition_admin`, `team_admin`, `scorer`, `verifier` or
`viewer`. A membership scope must belong to the caller's organization
(competition → season → organization, team season → season → organization);
a cross-organization scope answers `404`. A user created without memberships
can still receive one later.

### Admin writes

Reads stay public. Every admin write requires a Bearer token and a membership
that covers the target row. A missing token answers `401`; a token without the
needed scope answers `403`; an invalid body answers `400`; an unknown reference
answers `404`.

| Method | Path | Required scope |
| --- | --- | --- |
| POST | `/admin/seasons` | `org_admin` of `organizationId` |
| POST | `/admin/competitions` | `org_admin` of the season's organization, or `competition_admin` of a competition in that season |
| POST | `/admin/teams` | `org_admin` of `organizationId` |
| POST | `/admin/team-seasons` | `org_admin` of the season's organization, or `competition_admin` of `competitionId` |
| POST | `/admin/players` | `org_admin` of `organizationId` |
| POST | `/admin/roster-entries` | `team_admin`/`scorer` of the team season, or a competition/organization admin above it |
| POST | `/admin/games` | `competition_admin` of the competition, or `team_admin`/`scorer` of either team season |

Seasons have one active row per organization: creating an active season
archives the others. Admin-created ids are server-generated UUIDv7 values; the
client cannot set or reuse one. Creating a game writes a `scheduled` catalog
row with `lastSeq = -1` and appends no events. The event log remains the only
source of truth for a `full` game's state and score.

```bash
curl -X POST http://localhost:3000/admin/games \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "seasonId": "...",
    "competitionId": "...",
    "homeTeamSeasonId": "...",
    "awayTeamSeasonId": "...",
    "scheduledStart": "2027-04-10T18:00:00.000Z",
    "venue": "Parque Central"
  }'
```

### League bundle export/import

An organization admin can move league configuration between deployments with
the `olb.league/1` bundle. The bundle carries seasons, competitions, teams,
team seasons with their rosters, and scheduled games only. Users, memberships,
events, proposals, summaries and games with events or a final score are never
exported.

| Method | Path | Required scope | Result |
| --- | --- | --- | --- |
| GET | `/admin/export?seasonId=` | `org_admin` of the season's organization; all seasons when the user administers one organization | `application/json` attachment |
| POST | `/admin/import?dryRun=true` | `org_admin` of the target organization | `200` dry-run diff, `201` applied |

The export body is the bundle itself:

```json
{
  "format": "olb.league/1",
  "exportedAt": "2026-11-11T18:00:00.000Z",
  "organization": { "slug": "liga-metropolitana", "name": "Liga Metropolitana" },
  "seasons": [{
    "id": "...", "year": 2026, "name": "2026", "status": "active",
    "startsOn": "2026-03-01", "endsOn": "2026-11-30",
    "competitions": [{
      "id": "...", "name": "Zona Norte", "kind": "division",
      "parentId": null, "level": 1, "sortOrder": 1
    }]
  }],
  "teams": [{ "id": "...", "name": "Tiburones", "slug": "tiburones", "abbreviation": "TIB" }],
  "teamSeasons": [{
    "id": "...", "teamId": "...", "seasonId": "...", "competitionId": "...",
    "name": "Tiburones", "abbreviation": "TIB",
    "roster": [{
      "id": "...",
      "player": { "id": "...", "firstName": "Alejandro", "lastName": "Aguilar" },
      "jersey": "2", "primaryPosition": "C",
      "eligibilityStart": "2026-03-01", "eligibilityEnd": null,
      "status": "active"
    }]
  }],
  "games": [{
    "id": "...", "seasonId": "...", "competitionId": "...",
    "homeTeamSeasonId": "...", "awayTeamSeasonId": "...",
    "scheduledStart": "2026-03-14T22:00:00.000Z",
    "venue": "Estadio Metropolitano", "coverage": "full",
    "dataSource": "official", "rulesProfile": null
  }]
}
```

`POST /admin/import` takes that bundle as the request body directly (no
wrapper). The target is always the authenticated user's organization; the
bundle organization is metadata and its slug must match the target, otherwise
the request answers `409 organization_mismatch`. `dryRun` defaults to `false`;
a dry run writes nothing and returns
`{dryRun, created, updated, unchanged, conflicts, warnings}`. Counts cover
`seasons`, `competitions`, `teams`, `teamSeasons`, `players`, `rosterEntries`
and `games`.

Import matches rows by ID inside the target organization. A conflicting natural
key (team slug, season year, competition name, team-season team/season or name,
roster player/team season/eligibility start, game identity) or an ID owned by
another organization aborts with `409` and a conflict list; nothing is guessed
and nothing is written. Applying runs in one transaction in dependency order;
a second identical import reports `created: 0, updated: 0`. Rows absent from
the bundle are never deleted. A game that already has events is left unchanged
and reported as a warning.

The CLI uses the same endpoints, so the same scope rules apply:

```bash
npm run league:export -- --out league.json [--season <season-id>]
npm run league:import -- --file league.json [--dry-run] [--org <slug>]
```

Both read `OLB_API_URL` (default `http://127.0.0.1:3001`). Authentication is
`OLB_TOKEN`, or `OLB_EMAIL` plus `OLB_PASSWORD` to log in first. The token is
never printed. Import prints the created/updated/unchanged counts, warnings and
conflicts, and exits non-zero on a conflict or request error.

### Game writes

Legacy game writes now require a Bearer token and a scope that covers the
game. Reads (`GET /games`, `/state`, `/events`, `/boxscore`, `/stream`,
`/proposals`, `/standings`) stay public. A missing token answers `401`; an
authenticated user without the needed role answers `403`.

| Method | Path | Required scope |
| --- | --- | --- |
| POST | `/games` | any `org_admin`, `competition_admin`, `team_admin` or `scorer` membership |
| POST | `/games/:id/start` | catalog game: `org_admin` of its season's organization, `competition_admin` of its competition, or `team_admin`/`scorer` of either team season; legacy game: any scoring membership |
| POST | `/games/:id/finish` | same as `start` |
| POST | `/games/:id/events` | same as `start` |
| POST | `/games/:id/proposals` | scoring roles above, plus `verifier` of the game's competition |
| POST | `/games/:id/proposals/:pid/resolve` | scoring roles above; a `verifier` cannot resolve |

A legacy game is one with no league catalog row. It has no team or competition
identity to check, so any of `org_admin`, `competition_admin`, `team_admin` or
`scorer` may write it.

Appending a pitch:

```bash
curl -X POST http://localhost:3000/games/$GAME/events \
  -H "Authorization: Bearer $TOKEN" \
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

The client may supply `id` (a UUIDv7) and `occurredAt`. A retried POST with
the same `id` returns the stored event instead of appending a duplicate, even
when the retry carries a different payload; reusing the id in another game
answers `409`. `seq`, `recordedAt` and `contract` are always assigned by the
server, and an invalid id fails validation with `400`.

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

## Revisions and undo

The log is append-only: a correction is a new event, never a rewrite. To
replace an event, POST the replacement with the same `type` and `payload`
shape as the original and set `revisionOf` to the id of the event being
corrected:

```bash
curl -X POST http://localhost:3000/games/$GAME/events \
  -H 'content-type: application/json' \
  -d '{
    "id": "0192f3b2-0000-7000-8000-000000000001",
    "revisionOf": "0192f3b2-0000-7000-8000-000000000000",
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

The projection applies the revision and skips the replaced event. A chain
`A <- B <- C` applies only `C`, because both `A` and `B` are superseded.

To void an event without a replacement, append an `amendment` with
`payload.replacement: null` and `payload.targetSeq` set to the sequence number
to remove. The target is skipped by the projection, and the amendment itself
is a no-op in the fold:

```json
{
  "type": "amendment",
  "source": "human",
  "actor": { "kind": "user", "id": "usr_01HX" },
  "payload": { "targetSeq": 3, "reason": "other", "replacement": null }
}
```

Skipped events still count as consumed: `lastSeq` reflects the highest
sequence number in the log, so a client resuming from `fromSeq` never replays
a corrected or voided event.

Two stores implement the same `EventStore` interface: `MemoryEventStore` for
development and tests, and `PostgresEventStore` for real use. Postgres takes a
row lock on the game (`SELECT ... FOR UPDATE`) before computing the next
sequence number, which keeps two API replicas from writing the same `seq`.

## Proposals

Two-person mode lets a non-authoritative spotter suggest a play without writing
game data. A proposal lives in its own `proposals` table, never in
`GameState` and never in the event log:

```bash
curl -X POST http://localhost:3000/games/$GAME/proposals \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "author": "Verificador",
    "payload": { "kind": "pitch", "call": "S" }
  }'
```

`author` defaults to `"Verificador"` and is limited to 60 characters. The
payload is either `{ "kind": "pitch", "call": "B"|"C"|"S"|"F"|"T" }` or
`{ "kind": "outcome", "code": "out"|"1B"|"2B"|"3B"|"HR"|"E"|"FC" }`; anything
else answers `400`, and an unknown game answers `404`.

`GET /games/:id/proposals?status=open|accepted|rejected|all` returns proposals
ordered by creation time, `open` by default. Resolve one with
`POST /games/:id/proposals/:pid/resolve` and
`{ "status": "accepted"|"rejected" }`; resolving an already resolved proposal
returns it unchanged, so a retry is safe.

A proposal is an inbox, not game data. Accepting one does not append an event:
only the authoritative writer appends the accepted play, and `GET /state` and
`GET /events` never include proposals.

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

- Realtime resume from an event cursor (the SSE stream starts with a snapshot;
  clients still reconcile through `/games/:id/events?fromSeq=`)
- Web and scorer login/admin interfaces
- Advanced statistics such as ERA, fielding and situational splits
- Postgres integration tests in CI

## Development

```bash
npm run typecheck
npm test          # fold rules, lifecycle, HTTP reads, auth/scopes and admin writes
```

## License

Apache-2.0. Contributions use the DCO; see the
[whitepaper](https://github.com/beny0102/olb) for governance.
