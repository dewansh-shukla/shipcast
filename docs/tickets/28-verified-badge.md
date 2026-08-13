# 28 · Verify against public GitHub, and show it

**Harness:** claude-code · **Owns:** `apps/web/lib/verify.ts` (new), `apps/web/lib/verify.test.ts` (new), `apps/web/app/board/board-data.ts`, `apps/web/app/board/page.tsx`

`scripts/seed-github.ts` already fetches merged pull requests per author from
public GitHub, with pagination, rate-limit handling and recorded fixtures. It
was built to seed the board, demoted when we removed GitHub as a ranking source,
and has been unused since. This is the job it is actually right for.

## What verification means here

Compare a builder's self-reported merges for a season against merged pull
requests publicly visible for that GitHub handle in the same window.

It is an **upper-bound check, not proof**. Private repositories are a legitimate
reason for self-reported to exceed public, so a mismatch is not an accusation.
Equally, GitHub cannot tell an agent's pull request from a person's, which is
why it can never be a ranking input — only a corroboration of scale.

Rules:

- public ≥ reported → `verified`
- reported exceeds public by more than `LIMITS.privateMergeAllowance` → not
  verified, and store the gap
- no GitHub data yet → `unchecked`, which is not the same as unverified and
  should not look like a failure

## Requirements

Verification runs out of band, not in the ingest request path — a publish must
never wait on GitHub. A route or a script that walks the current season is fine;
say which you chose and why in the PR description.

Cache per handle and season. The rate limit is 5000 points an hour and one query
costs 1, but a board that re-verifies on every page load will still find the
ceiling eventually.

`GITHUB_TOKEN` is optional. Without it, every row is `unchecked` and the board
renders exactly as it does today.

## On the board

A quiet mark next to verified handles, in signal, from `brutal.css`. Not a badge
that shouts — an unverified row is the normal case for anyone working in private
repositories and must not read as suspicion.

Explain it in one line under the table, in the same voice as the existing
column glossary. Something close to: "verified means public GitHub activity is
consistent with what was reported. Private work will not show up here."

## Done when

Verified rows are marked, unchecked rows look ordinary, the board works with no
`GITHUB_TOKEN` set, verification never blocks a publish, and tests cover the
three states.
