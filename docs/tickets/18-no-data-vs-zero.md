# 18 · Distinguish "no data" from "zero"

**Harness:** claude-code · **Owns:** `packages/collector/src/metrics.ts`, `packages/collector/src/metrics.test.ts`, `packages/shared/src/payload.ts`

A card reading `CI recoveries 0` makes a claim it cannot support. It reads
identically whether the agents recovered from nothing, or whether no CI ever ran
and there was nothing to recover from. Those are opposite facts sharing a glyph.

We hit this for real: GitHub Actions is billing-locked on the account building
this, so `pr_checks` has no rows at all. The honest reading is "not measured
here", and the card currently says "your agents fixed nothing".

The same ambiguity affects `turns`, which is 0 because `conversation_turns` is
unpopulated for TUI-mode sessions, not because agents took no turns.

## Work

Add an `observed` set to the payload — the metrics for which this AO install
actually had a data source. A metric is observed when its underlying table had
rows in the window, not merely when the table exists: an empty `pr_checks` means
CI recovery was not measurable, whatever the schema says.

`probeSchema` already reports row counts, so the input is available. Keep the
counters exactly as they are; this adds context beside them, it does not change
any number.

Extend `IngestPayloadSchema` accordingly — closed enum of metric names, no free
strings, same whitelist discipline as everything else in that file.

Then have the terminal card render an unobserved metric as `—` with a short
reason, rather than `0`. The renderer already does this kind of honest reporting
for awards; follow that precedent.

## Why this is worth doing at all

Every number on this card is a claim about someone's work. A zero that means
"unmeasured" is the one kind of dishonesty that looks like precision, and it is
the failure mode a careful reader will catch first — the moment they do, every
other number becomes suspect too.

## Done when

An install with no CI rows reports CI recovery as unobserved rather than zero,
an install with CI rows and no recoveries still reports a true zero, the payload
still validates strictly, and the terminal card shows the difference.
