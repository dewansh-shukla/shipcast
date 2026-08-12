# 21 · The landing page

**Harness:** claude-code · **Owns:** `apps/web/app/page.tsx`, `apps/web/app/landing.css` (new)

`/` is still the scaffold placeholder — an `<h1>` and one sentence on unstyled
white. It is the first thing a judge sees.

## The thesis

People already flex on LinkedIn about how much AI ships for them. Nobody can
check any of it. AO Wrapped is the same flex with receipts: the numbers come off
your own disk, and every merge is joined to the agent session that produced it.

That contrast is the page. Do not open with a big number and three stat cards —
that is the template answer and it wastes the actual idea.

## Signature element — build the page around this

A side-by-side, as the hero: a LinkedIn post next to a Wrapped card.

```
┌────────────────────────────┐   ┌────────────────────────────┐
│ what you posted            │   │ what your disk says        │
│                            │   │                            │
│ "Thrilled to share that    │   │  16  merges                │
│  I've been leveraging AI   │   │  11  tasks                 │
│  to 10x my velocity 🚀"    │   │  14  nudges                │
│                            │   │   5  agents at once        │
│ 847 likes · unverifiable   │   │ read from ~/.ao · yours    │
└────────────────────────────┘   └────────────────────────────┘
```

Left is limp and vague. Right is specific and slightly unflattering — _14
nudges_ is the joke and the honesty at once. Use the real numbers from the
`dewansh-shukla` snapshot so the page is never lying about its own example.

## Visual direction

Neo-brutalist: thick black rules, hard offset shadows, flat saturated blocks,
zero border-radius, oversized type, visible structure.

**Do not build the default neo-brutal page** — black on safety-yellow with a
hard shadow is now its own template and appears regardless of subject. This one
inherits the product's palette so the front door and the instrument read as one
family:

```
paper     #F4F2ED   ground — warm, not white
ink       #0E1116   rules, shadows, body
phosphor  #FFB454   primary blocks
signal    #5FD4C4   secondary blocks, the "verified" side
ember     #E0685A   the LinkedIn side, warnings
ash       #7E8794   captions
```

Shadows are solid `ink`, offset 6–8px, never blurred. Borders 3px `ink`. The
card and board keep their dark instrument look — this is a deliberate contrast,
loud outside and precise inside, held together by the shared accents.

Type: a heavy grotesque for display (`"Arial Black", "Helvetica Neue", Impact`
is available everywhere and correct for this direction), `ui-monospace` for all
numbers and commands. No third face. Set numbers in `tabular-nums`.

## Sections

1. **Hero** — the side-by-side above, then the command as the primary action:
   `npx ao-wrapped --publish --api https://ao-wrapped.vercel.app`
   Make it click-to-copy. This is the page's single job.
2. **What it reads** — three blocks: your AO database, never your code, only
   numbers. State that `--dry-run` prints the exact JSON first.
3. **The scoring argument** — merges earn points, nudges subtract them. One
   sentence, one small table. Autonomy over volume.
4. **This week's board** — top few rows, live, linking to `/board`. Name the
   season and that it resets Monday.
5. **Footer** — repo link, one line on what the collector never sends.

## Copy

Funny, but every joke has to be true. The humour comes from specificity, not
from jokes bolted onto neutral copy. Some that work:

- "Your agents needed you 14 times this week. That's not a flex. That's the point."
- "4 sessions died. No points deducted. We're not monsters."
- "No 🚀. No 'humbled to announce'. Just counters."
- On the empty board: "Nobody has published this season yet. Be the first, it's one command."

**No meme images.** Sourced meme JPEGs age badly, muddy the load, and carry
licensing questions we cannot answer today. The voice carries the humour; the
design stays sharp.

Sentence case. Active voice. No exclamation marks outside the LinkedIn parody,
where they are the joke.

## Quality floor

Responsive to 360px — the side-by-side stacks, it does not shrink to
illegibility. Visible keyboard focus on the copy button and every link.
`prefers-reduced-motion` respected. Real `<button>` and `<a>` elements.

Server component reading the board through the existing data function; do not
add a client-side fetch.

## Scope

`/` only. Do not restyle the card, the board or the claim pages — they are
finished and other work may touch them.

## Done when

`/` presents the contrast, the command is copyable, live board rows render, it
holds together at 360px, and nothing else in the app changed.
