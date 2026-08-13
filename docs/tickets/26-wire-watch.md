# 26 · Wire `watch`, `status` and `stop` into the CLI

**Harness:** claude-code · **Owns:** `packages/collector/src/index.ts`, `packages/collector/src/index.test.ts` (new)

`watch.ts` is 754 lines of tested continuous sync — SSE with `Last-Event-ID`
resumption, debounce, fingerprint comparison, Monday rollover, a PID lock — and
**nothing in the CLI can call any of it.** `runWatch`, `runStatus` and `runStop`
are exported and unreachable.

## Work

Add three subcommands. They are positional verbs, not flags, because they are
modes rather than modifiers:

```
ao-wrapped watch      start syncing; runs until stopped
ao-wrapped status     what is syncing, when it last published
ao-wrapped stop       end the running watcher
```

`allowPositionals` is currently `false`; that has to change. Keep every existing
flag working exactly as it does — a bare `ao-wrapped` still prints the card, and
`--dry-run` and `--publish` are untouched.

Pass through the options `runWatch` already accepts: `--api`, `--handle`,
`--db`. Do not reimplement anything in `watch.ts`; this ticket is wiring.

Handle `SIGINT` so Ctrl-C releases the PID lock rather than leaving a stale
watcher that makes the next `watch` refuse to start. `runWatch` already cleans
up in a `finally`; it needs the signal to reach it.

Update `USAGE` and `packages/collector/README.md` so the subcommands are
discoverable. An undocumented feature is barely better than an unreachable one.

## Done when

`ao-wrapped watch` streams and publishes against a running AO, `status` reports
the season and last publish, `stop` ends it cleanly, Ctrl-C leaves no stale
lock, and every existing flag behaves as before.
