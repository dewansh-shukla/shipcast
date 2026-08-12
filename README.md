# AO Wrapped

**Spotify Wrapped for your AI coding workforce** — plus a weighted leaderboard that ranks who
actually orchestrates best, not who merged most.

Built for [The Orchestra](https://aoagents.dev/), the Agent Orchestrator hackathon, August 12–13 2026.

---

## What it does

Your AI agents plan, code, fix CI, resolve conflicts and open PRs all day. An enormous amount of
work happens and almost none of it is visible — there is no artifact at the end of the day that
says what your agents actually did.

AO Wrapped produces two things:

- **A Wrapped card** — per-builder, shareable, generated from your own machine.
- **A leaderboard** — everyone who connected the collector, ranked by an Orchestrator Score that
  weights autonomy over volume.

Both are built from one source: the local collector reading AO's own telemetry.

## What it measures

AI work outcomes, never developer activity. No lines of code, no keystrokes, no hours — those
measure the wrong worker.

| Metric            | Source                     | Derivation                                                         |
| ----------------- | -------------------------- | ------------------------------------------------------------------ |
| Tasks             | `sessions`                 | Rows created in the window                                         |
| Merges            | `pr`                       | `pr_state = 'merged'`, joined to the session by `pr.session_id`    |
| CI recoveries     | `change_log` → `pr_checks` | `failed` then `passed` on a later `commit_hash` for the same check |
| Interventions     | `change_log` → `sessions`  | Transitions **into** `waiting_input` or `blocked`                  |
| Peak parallelism  | `change_log` → `sessions`  | Running count of `active` sessions across the `seq` stream, max    |
| Harness diversity | `sessions.harness`         | `COUNT(DISTINCT harness)` — AO ships 23 worker adapters            |
| Diff size         | `pr`                       | `additions + deletions`, bucketed locally                          |
| Tokens & cost     | `model_usage_events`       | Per `model_id`; only `claude-code` and `codex` are metered by AO   |
| Turns             | `conversation_turns`       | Per session; `interrupted` / `failed` are reliability signal       |
| Harness swaps     | `agent_switches`           | `from_harness → target_harness` mid-session                        |
| Graveyard         | `sessions` + `pr`          | Terminated with no merged PR; cause from the last `pr` row         |

### Why `change_log` matters

AO's architecture is explicit that _display status is never stored — it is computed at read time
from durable facts_. So AO knows a session is `ci_failed` right now, but never records that an
agent **recovered** from a CI failure.

`change_log` does. It is an ordered event log with an autoincrementing `seq` and a JSON payload.
Replay it and you reconstruct history AO itself does not keep — which is where CI recoveries, peak
parallelism and interventions come from.

The payload carries **new state only**, not before/after, so transitions are derived by holding
last-known state per entity and emitting an edge on every change.

## Privacy

The collector reads AO's local telemetry and sends **only derived numbers**. Code, diffs, PR titles,
repo names, branch names, file paths and prompts are never read into the payload at all.

The ingest schema is a whitelist: every field is a number, a date, or a value from a closed enum,
and `.strict()` means an unknown key is a `400` rather than a silently-stored surprise. See
[`packages/shared/src/payload.ts`](packages/shared/src/payload.ts).

Run `ao-wrapped --dry-run` to print the exact JSON that publishing would send. Nothing leaves the
machine without `--publish`.

## Scoring

```
session_pts = max(0, base(outcome) - 4 * interventions) * sizeFactor
score       = sum(session_pts) * parallelismFactor * diversityFactor * decay
```

| Outcome                  | Points | Why that number                                |
| ------------------------ | -----: | ---------------------------------------------- |
| Merge after conflict     |     20 | Hardest autonomous loop; most agents die here  |
| Merge after CI recovery  |     18 | The exact loop AO exists to close              |
| Merge after review round |     16 | Agent read human feedback and acted            |
| Clean merge, first pass  |     10 | The baseline unit                              |
| PR opened, unmerged      |      3 | Work happened and is inspectable               |
| Session died, no PR      |      0 | No penalty — punishing failure punishes trying |
| Human intervention       |     −4 | Charged to that session only                   |

Weights live in [`packages/shared/src/weights.ts`](packages/shared/src/weights.ts). Scoring is
authoritative **server-side** — the collector runs on a machine the user controls, so a score it
computes is a claim, not a fact.

## Layout

```
packages/shared      payload schema, scoring weights, enums — the contract
packages/collector   npx CLI: reads AO telemetry read-only, aggregates locally
apps/web             leaderboard, ingest API, scoring engine, OG card renderer
scripts/             seed-github.ts — merge-count verification
```

GitHub is used only to verify self-reported merge counts against publicly visible ones.

## Known gaps

Measured against a real AO v0.12.3 install on 2026-08-13:

| Gap                                  | Cause                                                               |
| ------------------------------------ | ------------------------------------------------------------------- |
| `graveyard` empty while `died` > 0   | Sessions are counted as dead but no entry is emitted. Bug.          |
| `medianMinutes` reads ~558           | Measures wall-clock including overnight idle, not work. Misleading. |
| `turns` always 0                     | `conversation_turns` is unpopulated for TUI-mode sessions.          |
| `sizeMix`, `repos`, `topRepoShare` 0 | `Transition` does not carry PR diff sizes yet. Documented TODO.     |
| `ciRecoveries` 0                     | GitHub Actions is billing-locked on this account, so no checks ran. |

## Development

```bash
npm install
npm test            # vitest
npm run typecheck
npm run format
npm run collector -- --help
```

## Verified against

AO **v0.12.3** (goose schema 85). Upgrading from 0.10.2 ran 64 migrations and added nine tables,
so the collector probes the schema at runtime rather than trusting a compiled-in shape. Re-run
`ao-wrapped --dump-schema` after any AO update.

## License

Apache-2.0
