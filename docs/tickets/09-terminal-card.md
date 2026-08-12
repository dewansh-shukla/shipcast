# 09 · Terminal card

**Harness:** claude-code · **Owns:** `packages/collector/src/render.ts`, `packages/collector/src/render.test.ts`

Implement `renderCard()` and `renderPersonalities()`. `computeMetrics` now
returns a real payload, so `ao-wrapped` with no flags should print a complete
Wrapped card to stdout — no network, no account, no server.

This is the moment the product becomes real for a first-time user, and it is
demo shot 5. Someone who never runs `--publish` should still feel they got the
whole thing.

## Requirements

Plain text, boxed, roughly 60 columns so it survives a screen recording. Colour
via ANSI, disabled when `NO_COLOR` is set or stdout is not a TTY.

Sections: totals, per-agent breakdown, personalities, graveyard.

Personalities are deterministic rules over the payload — no model call. Rules
are in the plan: Most Productive (most merges), Most Reliable (best merges÷tasks,
min 3 tasks), Most Chaotic (highest died rate), Firefighter (most recoveries),
Workhorse, Speed Demon, Drama Queen (most interventions per task).

**Award nothing you cannot support.** With one harness and no CI, most
categories have no meaningful winner — print the section with an honest "not
enough data yet" rather than crowning a single agent in every category. A card
that admits what it does not know reads as trustworthy; one that awards seven
titles to the only harness present reads as broken.

Zero states matter more than usual here. Our own first real card has
`ciRecoveries: 0`, `turns: 0` and an empty graveyard.

## Done when

`npm run collector` prints a card against the real `~/.ao/data/ao.db`, tests
cover the all-zeros payload and a populated one, and the output is stable enough
to snapshot-test.
