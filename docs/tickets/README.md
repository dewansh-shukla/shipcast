# Tickets, in execution order

Numbered by when they run, not by which lane they belong to. Spawn a wave
together; do not wait for one ticket to merge before starting its neighbours.

| #   | Ticket                | Harness     | Wave | Starts when                     |
| --- | --------------------- | ----------- | ---- | ------------------------------- |
| 01  | Schema probe          | claude-code | 1    | now                             |
| 02  | Database and ingest   | claude-code | 1    | now                             |
| 03  | Wrapped card          | claude-code | 1    | now                             |
| 04  | GitHub seeder         | copilot*    | 1    | now                             |
| 05  | Scoring engine        | claude-code | 2    | 02 is **in flight**, not merged |
| 06  | Leaderboard           | claude-code | 2    | 03 is **in flight**, not merged |
| 07  | Replay engine         | claude-code | 3    | 01 merged — **runs with 08**    |
| 08  | Metrics               | claude-code | 3    | 01 merged — **runs with 07**    |
| 09  | Terminal card         | claude-code | 4    | 08 merged                       |
| 10  | Publish / claim flow  | claude-code | 4    | 08 merged                       |
| 11  | Seed 30+ public repos | claude-code | 4    | 04 merged                       |

## Why the waves are shaped this way

Wave 1 is four tickets with genuinely disjoint files, so they run at once. That
is also shot 1 of the demo video — four agents working in parallel is the thing
this product measures, and peak parallelism only exists while it is happening.

Wave 2 depends on interfaces, not implementations. Scoring needs the payload
type, which already exists in `packages/shared`; the leaderboard needs a card
layout it can read from fixtures. Neither needs the other ticket's PR to land,
so waiting for a merge would waste an hour for nothing.

Wave 3 looked like a dependency chain and is not one. The `Transition` interface
already exists in `replay.ts`, so 08 can be built against that contract while 07
implements it — 08 constructs transition arrays by hand in its tests and never
needs 07's output. Running them in parallel saves a round trip we do not have.
The interface is frozen for the duration; whichever session wants it changed
says so in its PR rather than changing it.

Wave 4 is everything that turns working code into a demo.

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
