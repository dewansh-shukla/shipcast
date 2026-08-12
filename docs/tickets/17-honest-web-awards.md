# 17 · Honest awards on the web card

**Harness:** claude-code · **Owns:** `apps/web/app/w/[handle]/card-data.ts`, `apps/web/app/w/[handle]/card-data.test.ts`

The OG image currently prints **Most Chaotic: claude-code** on a card whose
harness count is 1. An award is a comparison; with one competitor there is
nothing to compare, so the label is decoration pretending to be a finding.

The terminal card already solved this. `packages/collector/src/render.ts` prints
"not enough data yet" and one line explaining why:

> An award is a comparison and claude-code is the only harness here.
> Run a second one and these fill in.

Read that implementation and match its judgement — not by importing from the
collector, which the web app does not depend on, but by applying the same rule.

## Rule

An award needs a genuine contest. Suppress it when there is only one candidate
harness, when every candidate ties, or when the underlying counter is zero for
everyone — "Firefighter" on a card with zero CI recoveries names nobody.

Suppressed awards should read as deliberately withheld rather than broken or
missing. On the OG image, where space is tight, prefer dropping the row entirely
over printing an empty one.

## Why this matters more than it looks

This card is the artifact people share. A judge who sees a superlative that
cannot be true learns the numbers are decorative, and every other number on the
card loses its credibility at the same moment. Honest gaps are the reason the
real figures get believed.

## Done when

A single-harness payload renders no award winners on either the page or the PNG,
a multi-harness payload still crowns real ones, and tests cover the one-harness,
all-tied and zero-counter cases.
