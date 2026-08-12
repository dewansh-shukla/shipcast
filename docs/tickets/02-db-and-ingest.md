# 02 · Database and ingest

**Harness:** codex · **Owns:** `apps/web/db/schema.ts`, `apps/web/app/api/ingest/route.ts`

Define drizzle tables for:

- `builders` — handle, github id, avatar, connected_at, verified
- `snapshots` — one payload per builder per window, counters only
- `agent_stats` — per-harness counters belonging to a snapshot
- `seeds` — public GitHub merge counts for builders who never connected

Store raw counters, never a computed score. Weights will change during this
build, and a stored score freezes whichever version happened to be live when the
row was written. Scores are a view over these numbers.

The route already validates with `IngestPayloadSchema`. Add bearer-token auth and
persistence. Keep validation strict: an unknown key is a 400 naming the field.

**Scope note.** There is no provisioned database yet and no `DATABASE_URL`. Put
persistence behind a small interface with an in-memory implementation and test
against that. Wiring real Postgres is a follow-up and must not block this PR.
Generate drizzle migration files but do not apply them.

**Done when** the schema compiles, the route stores a valid payload through the
interface, and tests cover a valid payload, an unknown key rejected with the
field named, and a missing or bad token rejected with 401.
