# 14 · Continuous sync (`ao-wrapped watch`)

**Harness:** claude-code · **Owns:** `packages/collector/src/watch.ts`, `packages/collector/src/watch.test.ts`, `packages/collector/src/state.ts`

Depends on ticket 10 for a stored token. Do not start until 10 has merged.

A one-shot publish makes the leaderboard a snapshot graveyard: stale within
hours, and ranking people by how recently they ran a command rather than how
well they orchestrate. `watch` makes the board live.

## The mechanism AO already provides

`GET http://127.0.0.1:3001/api/v1/events` is a Server-Sent Events stream of
`change_log` rows — the same shape `replay.ts` already consumes:

```
id: 1
event: session_created
data: {"seq":1,"projectId":"frontend","sessionId":"frontend-1",
       "payload":{"id":"frontend-1","activity":"idle","isTerminated":false},
       "createdAt":"2026-07-07T06:58:31.825841Z"}
```

The `id:` field is the sequence number, so the stream supports `Last-Event-ID`.
Reconnecting with the last seq you processed replays exactly what you missed —
no polling, no gaps, no duplicates. A laptop that slept for six hours catches up
correctly on wake.

## Flow

1. Read `lastSeq` from `~/.ao-wrapped/state.json` (new; `state.ts` owns it).
2. Open the stream with `Last-Event-ID: <lastSeq>`.
3. Feed each event through the existing reducer. Reuse `replay.ts` — do not
   write a second implementation of transition derivation.
4. Debounce 30 seconds, then recompute the **current week** — `weekWindowFor(now)`
   from `@ao-wrapped/shared` — and publish only if the totals differ from the
   last published payload.
5. Persist `lastSeq` after each successful publish.
6. On disconnect, reconnect with backoff, carrying `Last-Event-ID`.

Publish the whole week every time, never a delta. Snapshots upsert by builder
and week key, so a full replacement is idempotent by construction and can never
drift; deltas would make the server reconcile partial state.

**Handle the Monday rollover.** A `watch` process running across midnight UTC on
Sunday must notice the week key changed, publish a final payload for the closing
week, and start a fresh one. Do not let a long-running process keep writing to
last week's row — that is the defect most likely to survive to production,
because it only reproduces once every seven days.

Last night produced 53 `session_updated` events. That must result in roughly one
publish, not 53 — the debounce and the changed-check are both load-bearing.

## Visibility is a feature, not polish

A background process shipping data about the user indefinitely has to be
conspicuous in a local-first product:

- `ao-wrapped status` — "syncing · last published 3m ago · season 2026-W33"
- `ao-wrapped stop` — stops immediately, one word
- Never auto-start. The user types `watch` deliberately, every time.
- Log each publish to stdout as one line, so a running terminal shows exactly
  what left the machine and when.

## Done when

`ao-wrapped watch` publishes on real AO activity against a locally running web
app, survives a killed and restarted daemon without double-counting, and tests
cover: resumption from a stored seq, debounce collapsing a burst into one
publish, no publish when numbers are unchanged, and reconnect after a dropped
stream.
