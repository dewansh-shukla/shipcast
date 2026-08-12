# C2 · The Wrapped card

**Harness:** cursor · **Owns:** `apps/web/app/w/[handle]/page.tsx`, `apps/web/app/w/[handle]/card.png/route.tsx` (new)

The page renders a builder's card from stored counters. The PNG route renders the
same card as an image using `ImageResponse` from `next/og` — that ships with
Next 16, so no new dependency is needed.

Wire `openGraph` and `twitter` metadata on the page to the PNG. If that unfurl
does not work the share loop never starts, so treat it as the acceptance
criterion rather than a detail.

Two states:

- **connected** — full card: totals, per-agent stats, personalities, graveyard
- **seeded** — merges only, everything else visibly locked

The locked state is doing real work: the gap between the two is what makes
connecting the collector worth doing. Make it read as deliberately withheld
rather than broken or empty.

Read data through a typed function that currently returns fixture data. B1 owns
the database and is working in parallel — do not import from `apps/web/db`.

Card content, for layout purposes: tasks, merges, CI recoveries, peak
parallelism, top agent by merges, most chaotic agent, harness count.

**Done when** both states render, the PNG route returns a valid image, and the
metadata validates in a card-preview tool.
