# 06 · The leaderboard page

**Harness:** claude-code · **Owns:** `apps/web/app/board/page.tsx`, `apps/web/app/board/[week]/page.tsx`, `apps/web/app/board/board-data.ts`, `apps/web/app/board/board-data.test.ts`

`/board` does not exist. Everything else works end to end — collector, claim,
ingest, Postgres, card — but there is no page that shows more than one person,
which is the entire premise of a leaderboard.

## What it shows

Builders who published in a season, ranked. Default to the current week from
`weekWindowFor(new Date())`; `/board/2026-W32` shows a past season. Both read
from the store — no fixtures, no invented rows.

Per row: handle, merges, tasks, CI recoveries, peak parallelism, interventions,
harness count, and when they last published. Link each to `/w/<handle>`.

**Freshness is a column, not a detail.** With continuous sync (`ao-wrapped
watch`) some builders update every few minutes and others published once and
walked away. Show "3m ago" against "yesterday" so the board reads as alive.

Name the season and when it resets — "2026-W33 · resets Monday" — so a visitor
understands the ranking is a week, not all of history.

## Ranking

Rank on merges descending, then fewer interventions, then handle. **Do not build
a weighted score** — ticket 05 owns that and may not land. A simple, explainable
ranking that ships beats a sophisticated one that does not, and the column set
above already tells the real story.

## Empty states carry weight

The board will genuinely be near-empty at first. An empty board must not look
broken: say plainly that nobody has published this season yet and show the one
command that changes it. That state will be on camera, so write it as copy, not
as a placeholder.

## Constraints

Server components reading through the existing store interface. Do not import
`postgres` or drizzle directly — `getIngestStore()` already resolves the right
implementation, and bypassing it breaks the in-memory path the tests use.

Add whatever read method the store lacks; you own no store files, so put it
behind a function in `board-data.ts` and say in the PR description what the
store needs.

## Done when

`/board` lists every builder who published this week ranked by merges, a past
season key renders that week, the empty state reads as intentional, and tests
cover ranking, the week default and the empty case.
