# AO Wrapped — build checklist

Submissions close **Aug 13, 7:00 PM**. Freeze code with three hours left.
A working demo of two-thirds of this beats a broken demo of all of it.

Tick as you go. Anything still unticked at freeze time gets cut, not rushed.

---

## Phase 0 · Bootstrap (solo, before any agent runs)

Agents branch off this. It has to be green before anyone spawns a session.

- [x] AO upgraded to v0.12.3 and schema re-probed (0.10.2 → 64 migrations, 9 new tables)
- [x] `~/.ao/data` backed up to `~/ao-backup-20260812/` (db + wal + shm)
- [x] Monorepo skeleton — npm workspaces, tsconfig, prettier, vitest
- [x] `packages/shared` — payload schema, scoring weights, enums (the contract)
- [x] `packages/collector` — stubs + Go timestamp parser with tests
- [x] `apps/web` — Next.js skeleton + stub routes
- [x] GitHub Actions CI — typecheck, test, format
- [x] README with metric-derivation table and privacy schema
- [ ] `npm install` clean, `npm test` green, `npm run typecheck` green
- [ ] Base commit pushed to `main`
- [ ] CI green on `main` (**blocking** — a red base blocks every agent)

## Phase 1 · AO setup

- [ ] Repo opened as an AO project
- [ ] Reviewer harness configured (feeds `review_run`, a whole metric axis)
- [ ] Tickets below written into the AO board **before** spawning anything
- [ ] First wave spawned: A1, B1, C2, D1 — four sessions, four different harnesses
- [ ] Screen-recording running during peak parallelism (it only exists live)

Harness diversity is a scored input. Running four adapters means your own card
demonstrates the metric it reports — spend thirty seconds picking them.

## Phase 2 · Build tickets

One session each. Files listed are owned exclusively — disjoint ownership is
what makes parallel sessions merge instead of conflict.

### Lane A · Collector

- [ ] **A1 · schema probe** — `packages/collector/src/probe.ts`
      `--dump-schema` prints tables, columns, row counts. Missing column disables
      one metric, never throws. _Blocks A2 and A3._
- [ ] **A2 · replay engine** — `packages/collector/src/replay.ts`
      `change_log` ordered by `seq` → typed transition stream. Tests cover an
      activity change, a `failed`→`passed` CI edge, a conflict resolution.
- [ ] **A3 · metrics** — `packages/collector/src/metrics.ts`
      Pure function: transitions in, `IngestPayload` out. Fixture-tested.
- [ ] **A4 · terminal card** — `packages/collector/src/render.ts`
      Full card prints offline with no account. Deterministic personalities.
- [ ] **A5 · publish** — `packages/collector/src/publish.ts`
      Device-claim flow, token stored under `~/.ao-wrapped/`. `--dry-run` works.

### Lane B · API and scoring

- [ ] **B1 · db + ingest** — `apps/web/db/schema.ts`, `apps/web/app/api/ingest/route.ts`
      Counters stored, never scores. Unknown key → 400 naming the field.
- [ ] **B2 · scoring** — `apps/web/lib/score.ts`
      Weights from `shared` produce score + breakdown. Golden test per anti-gaming rule:
      repo concentration, rubber-stamp merges, empty sessions, GitHub reconciliation.

### Lane C · Surfaces

- [ ] **C1 · leaderboard** — `apps/web/app/board/`
      Both boards render, rows expand into arithmetic, locked column on unconnected rows.
- [ ] **C2 · card** — `apps/web/app/w/[handle]/`
      OG PNG from stored counters; unfurls correctly on X and LinkedIn.

### Lane D · Data and story

- [ ] **D1 · GitHub seeder** — `scripts/seed-github.ts`
      Repo list in, merged-PR counts and diff sizes out.
- [ ] **D2 · seed 30+ real repos** — including AO maintainers and other teams
      An empty leaderboard reads as a dead product regardless of card quality.

## Phase 3 · Data generation

Your own build is the dataset. The probed install had 4 sessions and 0 merges,
so none of this exists until you make it exist.

- [ ] CI failing and being fixed by an agent, unassisted (**the headline metric**)
- [ ] At least one merge conflict resolved by an agent
- [ ] At least one review round resolved by an agent
- [ ] 4+ concurrent sessions captured on video
- [ ] 3+ distinct harnesses used
- [ ] `--fixture` seeded database committed as a demo backstop

Do not sabotage CI to manufacture failures — but do not pre-empt them either.
Real lint and type errors being fixed is both the data and the best footage.

## Phase 4 · Demo video

Rule 7 requires visible AO Kanban / orchestrator footage. Target 2:30.

- [ ] 1 · Cold open — AO board, several sessions running, PRs merging
- [ ] 2 · The board — point at a stranger's row, "they never installed anything"
- [ ] 3 · The ranking argument — rank 1 vs rank 2, fewer merges higher score
- [ ] 4 · Locked card — seeded profile, everything greyed
- [ ] 5 · Connect — `npx ao-wrapped`, full card prints locally, offline
- [ ] 6 · Privacy shot — `--dry-run`, whole JSON on one screen
- [ ] 7 · Unlock — publish, refresh, card fills in
- [ ] 8 · The mechanism — ten seconds on `change_log`
- [ ] 9 · Closer — AO Wrapped's own Wrapped, beside the AO board
- [ ] Edited, under 3 minutes, uploaded, link works in an incognito window

## Phase 5 · Submission — before 7:00 PM, Aug 13

- [ ] Public GitHub repo with README carrying metrics table and privacy schema
- [ ] Live board URL with real seeded rows
- [ ] Demo video uploaded and publicly viewable
- [ ] Discord post in `#orchestra-project-showcase` — team name, project name,
      description, repo, live link, video
- [ ] Public post on X with `#agentorchestrator`, tagging `@aoagents`
- [ ] Public post on LinkedIn tagging Agent Orchestrator
- [ ] Share card set as the post image on both
- [ ] Every teammate posted from their own account (engagement is combined)

## Cut list

If time runs out, cut in this order and say so out loud rather than shipping broken:

1. Live SSE mode
2. Rate limiting and caching
3. Mobile polish
4. `npm publish` of the collector
5. Cost-per-merge board

The card, the leaderboard and the privacy shot are the product. Everything else is garnish.
