# 24 · Retheme the Wrapped card and its share image

**Harness:** claude-code · **Owns:** `apps/web/app/w/[handle]/page.tsx`, `apps/web/app/w/[handle]/card.png/route.tsx`, `apps/web/app/w/[handle]/card.css` (new)

The card page and the OG image are the dark instrument look; the rest of the
site is now neo-brutalist. Bring them across.

Import `../../brutal.css` and wrap the page in `.brutal`. Take every colour,
border, shadow and face from those tokens. Two other agents are retheming the
board and the claim pages from the same file right now — staying inside it is
what makes the three match.

## The share image is the hard part and the important part

`card.png` is what unfurls on X and LinkedIn. It is the artifact this whole
product exists to produce, and it is rendered by satori through `ImageResponse`,
which supports a deliberately small slice of CSS.

Neo-brutalism suits satori — flat fills, solid borders, no gradients — but
verify rather than assume. Two known limits: satori has no CSS variables, so
tokens must be inlined as literals in that file, and it needs explicit `display:
flex` on containers. **Fetch the PNG and look at it before you call this done.**
A broken share image is worse than an ugly one.

Keep the 1200×630 dimensions. Keep the palette identical to the page so the
shared image and the page a viewer lands on are obviously the same artifact.

## Honesty rules that must survive the retheme

These are behaviour, not styling, and they have tests:

- An award with only one candidate harness is not printed at all. An award is a
  comparison; with one competitor there is nothing to compare.
- A metric with no data source renders as `—` with a reason, never as `0`.
- The graveyard shows a count without inventing causes it does not have.

If a layout change makes any of those harder to express, keep the honesty and
change the layout.

## Done when

`/w/<handle>` renders in the shared system, `card.png` returns a valid 1200×630
image you have actually viewed, the two are visibly the same artifact, and every
suppression rule above still holds.
