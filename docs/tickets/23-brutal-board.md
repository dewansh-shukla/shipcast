# 23 · Retheme the board

**Harness:** claude-code · **Owns:** `apps/web/app/board/page.tsx`, `apps/web/app/board/[week]/page.tsx`, `apps/web/app/board/board.css` (new)

The landing page is neo-brutalist and the board is still the dark instrument
look. Clicking from one to the other reads as an unfinished site rather than a
deliberate contrast.

Import `../brutal.css` and wrap the page in `.brutal`. Every colour, border,
shadow and face comes from those tokens — do not introduce new ones. Two other
agents are retheming the card and the claim pages from the same file at this
moment, and matching output depends on all three staying inside it.

## What the board needs beyond the tokens

A leaderboard is scanned, not read. Rank, handle and merges should be legible at
arm's length; the rest is supporting detail.

- Rank 1 deserves emphasis the others do not get — a phosphor block behind the
  row, not a trophy emoji.
- Keep the plain-language column labels and their explanations. "Nudges — times
  a session stopped and waited for a human" is better copy than the schema
  vocabulary and it stays.
- Keep the freshness column. A board where some rows say "3m ago" and others say
  "yesterday" is a board that looks alive.
- Season header and the "resets Monday" line stay prominent. The reset is the
  reason to come back.
- Interventions read in ember, merges in ink. The number that hurts should look
  like it hurts.

On narrow screens the table already sheds columns rather than shrinking. Keep
that behaviour.

The empty state matters — it will be on camera if nobody publishes. Say plainly
that nobody has published this season yet, and show the one command that
changes it.

## Done when

Both `/board` and `/board/[week]` render in the shared system, rank 1 is
unmistakable, the table still sheds columns at 360px, the empty state reads as
intentional, and no colour or font appears that is not a token in `brutal.css`.
