# 15 · Weekly seasons

**Harness:** claude-code · **Owns:** `apps/web/db/schema.ts`, `apps/web/db/store.ts`, `apps/web/app/api/ingest/route.ts`

Depends on ticket 12. Coordinate: 12 adds a read path to the same store.

The leaderboard runs in weekly seasons and resets every Monday. A season is
explainable in one sentence; a rolling window with a half-life is not. It also
keeps the top of the board contested, which is the only reason anyone returns.

`weekWindowFor`, `weekKeyFor` and `weekWindowFromKey` already exist in
`@ao-wrapped/shared` (`week.ts`), tested, ISO-8601, UTC, Monday start. Use them —
do not compute week boundaries anywhere else.

## Work

Key snapshots by `weekKey` alongside `builderId`, and make that pair unique. A
republish inside the same week replaces; a republish after the rollover creates
the next season's row and leaves the previous one intact.

Derive `weekKey` **server-side** from the payload's window rather than trusting a
client-supplied key. A collector reporting `2026-W01` while sending this week's
numbers must not be able to write into a closed season.

Reject a payload whose window spans more than one week, with a 400 naming the
field. Weeks are the unit; a two-week payload has no home.

Past seasons stay readable. The board defaults to the current week and takes an
optional key, so `/board` and `/board/2026-W32` both work and a reset feels like
a new season rather than deleted history.

## Done when

Ingest stores against a server-derived week key, republishing within a week
replaces while republishing after rollover does not, a cross-week payload is
rejected, past seasons remain queryable, and tests cover the Monday boundary
specifically.
