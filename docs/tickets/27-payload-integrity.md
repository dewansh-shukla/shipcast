# 27 · Reject payloads that contradict themselves

**Harness:** claude-code · **Owns:** `apps/web/app/api/ingest/integrity.ts` (new), `apps/web/app/api/ingest/integrity.test.ts` (new), `apps/web/app/api/ingest/route.ts`

The collector runs on the user's machine, so the numbers it sends are a claim,
not a measurement. We cannot prevent forgery — the process, the telemetry it
reads and the JSON it sends are all under the sender's control, and any check
that runs there can be removed. The goal is to make forgery detectable and
pointless, not impossible.

This ticket is the cheapest layer: a payload has to be internally coherent.

## Invariants

The schema is deliberately redundant. Enforce it server-side, after zod:

- `sum(agents[].merges)` equals `totals.merges`
- `sum(agents[].tasks)` equals `totals.tasks`
- `sum(agents[].interventions)` equals `totals.interventions`
- `sum(outcomes)` equals `totals.tasks` — one outcome per session
- `graveyard.length` is at most `outcomes.died`
- `totals.harnesses` equals `agents.length`
- `totals.peakParallelism` is at most `totals.tasks`
- every count is at most its enclosing total

Someone inflating one number by hand breaks a relationship they did not know was
checked. We found a genuine bug this way yesterday: per-agent merges counted
sessions while the total counted pull requests.

## Plausibility

Separate from coherence — a payload can be perfectly consistent and still absurd:

- merges per hour of the window has a ceiling; pick one you can defend and say
  what it is in the rejection message
- `peakParallelism` above ~64 means 64 agent processes on one machine
- publishing more than once every 30 seconds is not a human workflow; rate limit
  per token

## Requirements

Reject with 422 and name the invariant that failed, in the same plain voice the
rest of the API uses. "sum of per-agent merges (23) does not equal totals.merges
(400)" tells an honest client with a bug exactly what to fix, and tells a forger
that the shape is checked.

Log rejections with the handle so patterns are visible. Do not log the payload.

**These are not security.** A forger who reads this file will satisfy every
invariant. State that in the module comment so nobody mistakes it for a defence
— it raises the effort and catches the careless, and that is the whole claim.

## Done when

An incoherent payload is rejected with the failing invariant named, a coherent
one still stores, the rate limit works per token, and tests cover each invariant
independently.
