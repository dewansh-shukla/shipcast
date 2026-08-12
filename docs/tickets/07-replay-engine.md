# 07 · Replay engine

**Harness:** claude-code · **Owns:** `packages/collector/src/replay.ts`, `packages/collector/src/replay.test.ts`

Implement `replay()`. It reads `change_log` and returns an ordered
`Transition[]`.

**The `Transition` interface is frozen.** Ticket 08 is being written against it
right now, in a parallel session. If you become convinced it needs to change,
say so in your PR description and leave it alone — a change here breaks the
other session's work in flight.

## What the table gives you

`change_log` has `seq`, `project_id`, `session_id`, `event_type`, a JSON
`payload`, and `created_at`. Eight event types exist; these four carry the
signal:

| Event               | Payload shape (verified)                                             |
| ------------------- | -------------------------------------------------------------------- |
| `session_created`   | `{"id","activity","isTerminated",...}`                               |
| `session_updated`   | `{"id":"frontend-1","activity":"active","isTerminated":false,...}`   |
| `pr_updated`        | PR state including `ci_state` and `mergeability`                     |
| `pr_check_recorded` | `{"pr":"<url>","name":"<check>","commit":"<sha>","status":"queued"}` |

## The part that is easy to get wrong

The payload holds **new state only**, not before/after. A transition is
therefore something you compute, not something you read: order rows by `seq`,
keep a map of last-known state per entity, and emit an edge only when the value
actually changes. First sighting of an entity is not a transition.

Entity keys differ per kind — sessions key on session id, CI checks key on
`(pr url, check name)`, PR state and mergeability key on pr url.

Every timestamp goes through `parseAoTimestamp`. `created_at` is a Go
`time.Time` string that SQLite cannot parse.

Join `sessions.harness` onto each transition so downstream code does not have to
re-query. Sessions that no longer exist get harness `unknown` rather than being
dropped.

## Done when

`replay()` returns transitions against the real `~/.ao/data/ao.db`, and tests
cover, using a fixture database built in a temp dir:

- an `idle → active` session activity edge
- a CI check going `failed` then `passed` on a later commit hash
- mergeability going `conflicting → mergeable`
- a repeated identical payload producing **no** transition
- an unparseable timestamp being skipped rather than throwing

There are ~1385 real rows in `change_log` on this machine, so sanity-check
against them before you finish: the count should be plausible, ordered by `seq`,
and free of duplicate edges.
