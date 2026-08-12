# 08 · Metrics

**Harness:** claude-code · **Owns:** `packages/collector/src/metrics.ts`, `packages/collector/src/metrics.test.ts`

Implement `computeMetrics()`: a pure function from `MetricsInput` to
`IngestPayload`. No database access, no network, no clock reads — everything it
needs is an argument, which is what makes it testable without a real AO install.

**Ticket 07 is implementing `replay()` in a parallel session.** Do not wait for
it and do not edit `replay.ts`. The `Transition` interface it exports is a
frozen contract; build against it and construct `Transition[]` arrays by hand in
your tests.

## Derivations

| Field             | How                                                                       |
| ----------------- | ------------------------------------------------------------------------- |
| `tasks`           | Distinct sessions appearing in the window                                 |
| `merges`          | PR state transitions into `merged`                                        |
| `ciRecoveries`    | Per `(pr, check)`: a `failed` edge followed by a `passed` edge            |
| `interventions`   | Transitions **into** `waiting_input` or `blocked`                         |
| `peakParallelism` | Walk the stream keeping a running count of sessions in `active`; take max |
| `harnesses`       | Distinct harnesses seen                                                   |
| `outcomes`        | Per session, classify once — see precedence below                         |
| `graveyard`       | Sessions ending with no merge; cause from the last PR-related transition  |

Outcome precedence per session, highest first: `conflict_resolved`,
`ci_recovered`, `review_resolved`, `clean`, `opened_unmerged`, `died`. A session
gets exactly one outcome — a merge that survived both a conflict and a CI
failure counts as `conflict_resolved` only, never both.

`sizeMix` and `topRepoShare` need PR diff sizes, which the current `Transition`
does not carry. Emit zeroed values and a `TODO` naming the follow-up; do not
change the interface to get them.

## Constraints

The result must satisfy `IngestPayloadSchema`. Validate against it in a test —
if it fails, that is a bug here, never a reason to relax the schema.

Nothing derived from repo names, branch names, PR titles or paths may appear in
the output. The payload is a whitelist of numbers and closed enums and that is
the product's central promise.

## Done when

Tests cover each metric with hand-built transitions, including: two overlapping
sessions producing `peakParallelism` 2, a `failed → passed` pair producing one
recovery and not two, a session with both a conflict and a CI recovery
classified once, and a full payload passing `IngestPayloadSchema.parse`.
