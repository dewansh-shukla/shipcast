# 16 · Postgres store

**Harness:** claude-code · **Owns:** `apps/web/db/postgres-store.ts`, `apps/web/db/postgres-store.test.ts`, `apps/web/db/client.ts`

Depends on ticket 15. Coordinate: 15 is adding week keying to the same schema.

`getIngestStore()` returns an in-memory store. Every published payload lives in
process memory, so on serverless it evaporates between invocations and a redeploy
wipes it regardless. Continuous sync (ticket 14) writes constantly into that void.
This ticket makes the data survive.

Neon Postgres is provisioned; tables exist from `db:push`. `DATABASE_URL` is a
**pooled** connection — serverless opens and drops connections constantly, and
without the pooler you exhaust Postgres connections under any real traffic.

## Work

Implement `IngestStore` against drizzle in `postgres-store.ts`. Do not modify the
interface — the in-memory implementation stays and remains what the tests use, so
a contributor without a database can still run the suite.

`client.ts` owns a module-level `postgres()` client. On serverless, creating a
client per request is the classic way to exhaust a pool even with pooling on;
create it once per module instance.

Wire selection in `getIngestStore()`: Postgres when `DATABASE_URL` is set, memory
otherwise. `setIngestStore()` keeps working so tests can still inject.

Preserve the upsert semantics the in-memory store already has — republishing the
same builder and week replaces rather than accumulates. That property is what
makes continuous sync safe, so a golden test for it is not optional.

## Requirements

Never log the connection string, and never include it in an error surfaced to a
response. A stack trace with credentials in it is a leak.

Fail loudly at startup if `DATABASE_URL` is set but unreachable, rather than
silently falling back to memory. Silent fallback means the board looks fine in
development and loses every write in production.

## Done when

A payload published through `/api/ingest` survives a server restart, appears on
`/w/<handle>`, republishing within a week replaces rather than duplicates, and the
in-memory path still works with `DATABASE_URL` unset.
