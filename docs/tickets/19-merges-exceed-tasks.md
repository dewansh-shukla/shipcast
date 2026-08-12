# 19 · A close rate above 100%

**Harness:** claude-code · **Owns:** `packages/collector/src/render.ts`, `packages/collector/src/render.test.ts`, `packages/collector/src/__snapshots__/render.test.ts.snap`

The terminal card currently prints:

```
15 merges
out of 11 tasks handed to agents (136% closed)
```

`percent()` at `render.ts:589` guards `whole <= 0` but not `part > whole`, so
the ratio runs past 100 and the card states something impossible about someone's
work.

## Why the numbers are legitimately unequal

Merges are not a subset of tasks. A single session can ship several pull
requests across its life, PRs merge inside a window whose session started before
it, and a human can merge a PR an agent opened. None of that is a bug — the bug
is a phrasing that assumes one merge per task and then reports the mismatch as a
percentage.

Do not clamp to 100%. Clamping hides a real and interesting fact — that agents
sometimes deliver more than one landed change per session — behind a number that
looks tidy. Losing that would be worse than the current defect.

## Work

Change the phrasing so it stays true whichever way the numbers fall. Two shapes
work; pick whichever reads better beside the rest of the card:

- report the ratio as merges per task when merges exceed tasks
  (`15 merges from 11 tasks — 1.4 landed per session`)
- drop the percentage entirely and let the two counts speak
  (`15 merges out of 11 tasks handed to agents`)

Keep the percentage for the ordinary case where merges are at or below tasks; it
reads well there and it is the common case for anyone with fewer merges than
sessions.

Check whether `apps/web/app/w/[handle]/card-data.ts` renders the same ratio. If
it does, you do not own that file — say so in your PR description and leave it.

Update the render snapshot rather than deleting it.

## Done when

`merges > tasks` renders a true statement, `merges <= tasks` still shows a
percentage, and tests cover both directions plus the zero-task case.
