# 04 · Public GitHub seeder

**Harness:** opencode · **Owns:** `scripts/seed-github.ts`

Given a list of repositories and a date window, fetch merged pull requests via
the GitHub GraphQL API and emit per-author counts: merges, plus additions and
deletions so diff size can be bucketed with `bucketForLines` from
`@ao-wrapped/shared`.

This is what puts people on the board without them installing anything, so it has
to work on repos whose owners have never heard of us. Public data only, no
authentication beyond a read-only token from `GITHUB_TOKEN`.

Output JSON to stdout matching a type you define and export, so ticket 02 can consume it
later. Do not write to a database — that boundary is not yours.

Requirements:

- Handle pagination; some repos have hundreds of merged PRs in a window
- Respect rate limits, and report remaining quota to stderr
- Skip and report repos that 404 rather than aborting the run
- Run without `GITHUB_TOKEN` in test, using recorded fixtures

**Done when** this prints real counts:

```bash
node --experimental-strip-types scripts/seed-github.ts \
  --repos Untrivial-ai/agent-orchestrator --from 2026-08-01 --to 2026-08-13
```

and tests cover pagination and a missing repo.
