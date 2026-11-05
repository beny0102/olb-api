# AGENTS.md — olb-api

## Source of truth

The event log is the source of truth. `GET /state`, `/boxscore` and `/standings`
are recomputed from events, never stored. A correction is a new event
(`revisionOf` / `amendment`); the log is append-only.

Events are parsed with `parseEvent` from the published `@olb/contract` before
they are stored. The contract is open: unknown fields survive, unknown event
types are ignored.

## Data rules

- No derived number is stored by hand: runs, hits, errors, linescore and
  standings come from the fold.
- UUIDv7 only; the contract rejects v4 identifiers.
- A client-supplied event `id` makes retries idempotent; reusing it in another
  game answers `409`.
- Proposals are an inbox, not game data. Accepting one never appends an event.

## Commands

```sh
npm install
npm run typecheck
npm test
npm run build
```

API port is 3001 (web 3000, scorer 3002).

## Language

Code, identifiers, file and directory names, route segments, API paths, schema fields and
commit messages are English. Product/UI copy and user-facing documentation are Spanish.
Routes are English, kebab-case nouns: `/games/[id]/score`, `/teams/[slug]`,
`/games/[id]/verify`, `/new`. Never `/juego/[id]/anotar`, `/equipos/[slug]` or `/nuevo`.
Do not add Spanish redirects for old routes; update the links.
