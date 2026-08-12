# Tickets, in execution order

Numbered by when they run, not by which lane they belong to. Spawn a wave
together; do not wait for one ticket to merge before starting its neighbours.

| #   | Ticket                | Harness     | Wave | Starts when                     |
| --- | --------------------- | ----------- | ---- | ------------------------------- |
| 01  | Schema probe          | claude-code | 1    | now                             |
| 02  | Database and ingest   | codex       | 1    | now                             |
| 03  | Wrapped card          | cursor      | 1    | now                             |
| 04  | GitHub seeder         | opencode    | 1    | now                             |
| 05  | Scoring engine        | codex       | 2    | 02 is **in flight**, not merged |
| 06  | Leaderboard           | amp         | 2    | 03 is **in flight**, not merged |
| 07  | Replay engine         | claude-code | 3    | 01 **merged**                   |
| 08  | Metrics               | claude-code | 3    | 07 merged                       |
| 09  | Terminal card         | aider       | 4    | 08 merged                       |
| 10  | Publish / claim flow  | codex       | 4    | 08 merged                       |
| 11  | Seed 30+ public repos | opencode    | 4    | 04 merged                       |

## Why the waves are shaped this way

Wave 1 is four tickets with genuinely disjoint files, so they run at once. That
is also shot 1 of the demo video — four agents working in parallel is the thing
this product measures, and peak parallelism only exists while it is happening.

Wave 2 depends on interfaces, not implementations. Scoring needs the payload
type, which already exists in `packages/shared`; the leaderboard needs a card
layout it can read from fixtures. Neither needs the other ticket's PR to land,
so waiting for a merge would waste an hour for nothing.

Wave 3 is the one real dependency chain in the build. The replay engine needs to
know which tables and columns this AO install actually has, and metrics need
replay's transition stream. Run them in sequence, on the same harness, and keep
01 small so the chain starts early.

Wave 4 is everything that turns working code into a demo.

## Harness assignment

Not cosmetic. AO records token usage only for `claude-code` and `codex`, and the
product reports cost per merged PR — so at least one of each must be running or
that metric has no data. Harness diversity is also a scored input on our own
leaderboard, which means the demo card demonstrates the metric it reports.
