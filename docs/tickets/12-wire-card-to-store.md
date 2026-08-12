# 12 · Wire the card to real data, delete the fabricated fallback

**Harness:** claude-code · **Owns:** `apps/web/app/w/[handle]/card-data.ts`, `apps/web/db/store.ts`

Two jobs. The second is urgent.

## 1 · Read from the store

`getWrappedCard()` returns from a hardcoded `FIXTURES` array, so a published
payload never appears on the card. Read the latest snapshot for the handle from
`IngestStore` instead, and map it to `ConnectedCard`.

Add whatever read method the store is missing. Keep the in-memory implementation
working — there is still no `DATABASE_URL`.

## 2 · Delete `seededMergeCount`

```js
function seededMergeCount(handle: string): number {
  let hash = 7;
  for (const char of handle) hash = (hash * 31 + char.codePointAt(0)!) % 100_003;
  return 4 + (hash % 45);
}
```

This hashes a username into a merge count and the surrounding comment labels it
public GitHub data. It is fabricated output presented as measurement, and it has
to go — a stub throws or returns nothing; this invents a plausible number, which
is worse than either.

Replace the seeded state with an honest **not on the board yet** card: name the
handle, explain that only builders who connected the collector are ranked, and
show the one command that would put them there. An unknown handle is not an
error and must not 404 — it is the product's best conversion moment.

Delete the `SeededCard` merge count, the fixtures that depend on it, and any
copy claiming the board is seeded from GitHub.

## Context

We removed GitHub as a ranking source deliberately: a merged PR looks identical
whether an agent or a human wrote it, so it cannot measure AI work. Only
collector-reported data ranks. See the README section "Why we do not use GitHub
as a source".

## Done when

A published payload appears on `/w/<handle>` and in the OG image, an unknown
handle renders the not-yet state, `seededMergeCount` no longer exists anywhere in
the tree, and tests cover both states.
