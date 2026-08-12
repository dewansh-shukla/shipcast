# 25 · Retheme the claim pages

**Harness:** claude-code · **Owns:** `apps/web/app/claim/page.tsx`, `apps/web/app/claim/[code]/page.tsx`, `apps/web/app/claim/claim.css` (new), `apps/web/app/not-found.tsx`

The claim pages are where a stranger arrives from their terminal, mid-flow, and
they still carry the dark instrument look. Bring them into the shared system.

Import `../brutal.css` and wrap each page in `.brutal`. Take every colour,
border, shadow and face from those tokens. Two other agents are retheming the
board and the card from the same file right now.

## What these pages are actually doing

Someone ran a command, is half-committed, and is deciding whether to trust us.
The design job is confidence, not decoration.

- The code itself is the hero. It is what they are checking against their
  terminal, so set it large in mono with real spacing between the groups.
- The approve action is the single primary control on the page. One button, one
  obvious colour, nothing competing with it.
- Keep the "what approving sends" section and its two lists intact. **SENT**:
  counters. **NEVER SENT**: code, diffs, prompts, commit messages, repo names,
  branch names, file paths. That section is the reason someone clicks approve,
  and it should read as plainly as it does today.
- The "no such code" state is a real state, not an error page — codes expire in
  ten minutes and people are slow. Say what happened and how to get a new one.
  It should not feel like a crash.

`not-found.tsx` comes along so a mistyped URL does not drop someone onto an
unstyled Next default in the middle of a flow.

## Do not touch behaviour

Everything under `apps/web/app/api/claim` is another ticket's work and was
recently rewritten to persist codes in Postgres. Styling only.

## Done when

Both claim pages and the 404 render in the shared system, the code is legible at
a glance, the privacy section is intact, the expired-code state reads as
recoverable, and no colour or font appears that is not a token in `brutal.css`.
