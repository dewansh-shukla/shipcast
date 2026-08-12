# Tickets, in execution order

Numbered by when they run, not by which lane they belong to. Spawn a wave
together; do not wait for one ticket to merge before starting its neighbours.

| #   | Ticket               | Harness     | Status     | Notes                           |
| --- | -------------------- | ----------- | ---------- | ------------------------------- |
| 01  | Schema probe         | claude-code | **merged** | adapts to any AO version        |
| 02  | Database and ingest  | claude-code | **merged** | in-memory store, strict zod     |
| 03  | Wrapped card         | claude-code | **merged** | page + OG image render          |
| 04  | GitHub seeder        | claude-code | **merged** | demoted to verification only    |
| 07  | Replay engine        | claude-code | **merged** | change_log → transitions        |
| 08  | Metrics              | claude-code | **merged** | real payload from real data     |
| 09  | Terminal card        | claude-code | next       | demo shot 5                     |
| 10  | Publish / claim flow | claude-code | next       | the only way onto the board     |
| 12  | Wire card to store   | claude-code | next       | deletes fabricated fallback     |
| 13  | Fix metric defects   | claude-code | after 09   | graveyard, medianMinutes, sizes |
| 05  | Scoring engine       | claude-code | if time    | leaderboard arithmetic          |
| 06  | Leaderboard page     | claude-code | if time    | demo shots 2 and 3              |

Tickets 09, 10 and 12 are independent and run together. 05 and 06 are the first
things to cut if the clock runs out — the card and the publish flow are the
product; the ranked board is the upside.

## Why the waves are shaped this way

Wave 1 was four tickets with genuinely disjoint files, so they ran at once. That
is also shot 1 of the demo video — four agents working in parallel is the thing
this product measures, and peak parallelism only exists while it is happening.

Wave 3 looked like a dependency chain and was not one. The `Transition` interface
already existed in `replay.ts`, so 08 was built against that contract while 07
implemented it. Running them in parallel saved a round trip we did not have.

## Why GitHub stopped being a seeding source

The original design seeded the board from public GitHub merge counts so people
would appear without installing anything. Two problems killed it.

The people it found were AO's **community contributors** — humans who hand-wrote
pull requests improving the orchestrator. Ranking them on AI workforce output
credits their own work to agents.

More fundamentally: from outside, a merged PR looks identical whether an agent
opened it or a person typed it. A product measuring AI work outcomes cannot use
an instrument that is blind to the distinction. AO can see it — `pr.session_id`
joins every PR to the session that produced it.

So the collector is the only ranking input, and GitHub keeps one job:
verification against forged payloads.

## Harness assignment

We have a Claude Code subscription and nothing else, so effectively everything
runs on `claude-code`. That is a smaller loss than it looks:

- **Token and cost metrics still work.** AO meters `claude-code` and `codex`, and
  we have one of the two. Cost per merged PR is intact.
- **Parallelism still works.** Four concurrent sessions is what the demo is
  about, and the harness they share does not change that number.
- **Harness diversity is still implemented**, it is simply not exercised by our
  own run. Our card will honestly report one harness, which is what a real solo
  user looks like. Do not fabricate a second one to make the card denser.

`*` Ticket 04 is marked `copilot` as an optional experiment — the account already
has Copilot Free, and one extra harness would make our own diversity number 2
instead of 1. Ticket 04 is the lightest of the four, so it is the cheapest place
to try. If Copilot Free's limits bite, switch it to `claude-code` and move on.
Do not spend more than ten minutes on this.
