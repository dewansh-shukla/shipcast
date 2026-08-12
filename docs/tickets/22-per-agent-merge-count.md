# 22 · Per-agent merges counts the wrong thing

**Harness:** claude-code · **Owns:** `packages/collector/src/metrics.ts`, `packages/collector/src/metrics.test.ts`

The payload contradicts itself. From a real run just now:

```json
"totals":  { "tasks": 11, "merges": 19 },
"agents": [{ "harness": "claude-code", "tasks": 11, "merges": 10 }]
```

One harness, and its merge count does not match the total it is the whole of.

`totals.merges` counts merged pull requests — 19 is correct, confirmed against
the database. `agents[].merges` counts **sessions that merged at least one
thing**, which is 10, because several sessions shipped more than one PR:

```
shipcast-8   3 merges
shipcast-9   4 merges
shipcast-10  4 merges
shipcast-11  2 merges
```

Both numbers appear on the card — the headline says 19, the per-agent table says
10 — so the artifact people share disagrees with itself in public.

## Work

Make `agents[].merges` count merged pull requests attributed to that harness, so
the per-agent column sums to `totals.merges`. Add a test asserting exactly that
invariant; it is the property that failed here and it should be impossible to
break again quietly.

Check the sibling fields for the same confusion — `recoveries` and `died` may
also be counting sessions where the interesting word is events, or the reverse.
Say in the PR description what each one counts now.

Leave `outcomes` alone. Those are deliberately per-session — one session gets
exactly one outcome — so `clean: 10` plus `died: 1` summing to 11 sessions is
correct by design, not a bug.

Leave `tasks` alone; sessions are the right unit there.

## Done when

The per-agent merge column sums to `totals.merges`, a test enforces that
invariant, and the card no longer shows two different numbers for the same
thing.
