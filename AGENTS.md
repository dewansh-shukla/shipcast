# House rules

AO Wrapped turns Agent Orchestrator's local telemetry into a Wrapped card and a
weighted leaderboard. Read `README.md` for what the product is and
`CHECKLIST.md` for where the build currently stands.

Several sessions run in parallel on this repo. These rules exist so those
sessions merge instead of collide.

## Stay inside your files

Your ticket names the files you own. Change those and nothing else. If your work
seems to require editing a file another ticket owns, stop and say so in the PR
description rather than editing it — a cross-ticket edit costs more in conflict
resolution than it saves.

`packages/shared` is owned by nobody and changed by no one without saying why in
the PR. Every other package imports the payload schema, weights and enums from
it. Redefining any of them locally is the one thing that reliably breaks the
build for everyone at once.

## Before you open a PR

```bash
npm test
npm run typecheck
npm run format
```

All three must pass. CI runs exactly these.

## Verified facts about AO's database

Probed against a real install running AO v0.12.3. Do not re-derive these, and do
not trust AO's published docs over them — the docs are out of date on all four.

- The pull request table is `pr`, not `pull_requests`. Comments are in
  `pr_comment`, singular.
- Timestamps are Go `time.Time` strings: `2026-07-07 06:58:31.825841 +0000 UTC`.
  SQLite cannot parse them — `julianday()` and `datetime()` return NULL, so date
  filters silently match zero rows and raise nothing. Use
  `parseAoTimestamp` from `packages/collector/src/time.ts`.
- `ao.db` is ~300 KB while `ao.db-wal` is ~4 MB. Recent history lives in the WAL,
  so a copy of `ao.db` alone is nearly empty. Use `openAoDatabase` from
  `packages/collector/src/db.ts`.
- `pr_checks.status` uses `passed`/`failed`. `pr.ci_state` uses
  `passing`/`failing`. Mixing the two yields zero results and no error.
- `change_log.payload` holds new state only, not before/after. Derive transitions
  by ordering on `seq` and diffing against last-known state per entity.

## Never

- Write to `~/.ao` or any file under it. Read-only, always. A corrupted AO
  database ends the project.
- Put repo names, branch names, PR titles, file paths, prompts, commit messages
  or diffs into anything the collector sends. The ingest schema in
  `packages/shared/src/payload.ts` is a whitelist of numbers and closed enums,
  and that is the product's central promise.
- Accept a score computed by the collector. Clients report counters; the server
  does the arithmetic.
- Add a dependency without naming, in the PR description, what it does and what
  you considered instead.

## Scope

Land the ticket, not the ticket plus improvements you noticed on the way. If you
spot something worth fixing elsewhere, note it in the PR description. Someone
else owns that file and may be editing it right now.
