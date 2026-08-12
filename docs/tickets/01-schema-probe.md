# 01 · Schema probe

**Harness:** claude-code · **Owns:** `packages/collector/src/probe.ts`

Fill in `probeSchema()` and `formatSchemaDump()`. The stubs carry the intended
types; keep those signatures.

`probeSchema` reads `sqlite_master` and `PRAGMA table_info` to report every
table, its columns and row count, plus the goose migration version. It then sets
the `has` feature flags by checking whether the tables and columns each metric
needs are actually present.

The contract that matters: a missing table or column disables exactly one
feature flag and nothing else. It must never throw. AO ships migrations
constantly — upgrading 0.10.2 to 0.12.3 on this machine ran 64 of them and added
nine tables — so the install we demo on may not be the install we developed
against.

Feature flags map to these tables:

| Flag                | Requires                                           |
| ------------------- | -------------------------------------------------- |
| `changeLog`         | `change_log`                                       |
| `prSizes`           | `pr.additions`, `pr.deletions`, `pr.changed_files` |
| `tokenUsage`        | `model_usage_events` + `usage_bindings`            |
| `conversationTurns` | `conversation_turns`                               |
| `agentSwitches`     | `agent_switches`                                   |
| `reviewRuns`        | `review_run`                                       |

**Done when** `npm run collector -- --dump-schema` prints a real dump against
`~/.ao/data/ao.db`, and tests cover a database missing an optional table.

Tests must not depend on the developer's real AO database — build a small
fixture database in a temp dir with `node:sqlite`.

This blocks 07 and 08. Prefer landing a correct probe quickly over a
comprehensive one.
