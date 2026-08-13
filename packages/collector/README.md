# ao-wrapped

**Spotify Wrapped for your AI coding workforce.**

Reads the [Agent Orchestrator](https://aoagents.dev) telemetry already sitting on
your disk and prints what your agents actually did — merges, CI recoveries, how
often they needed you, how many ran at once.

```bash
npx ao-wrapped
```

That prints your card. No account, no signup, no network.

## Publishing to the board

```bash
npx ao-wrapped --publish --api https://ao-wrapped.vercel.app
```

You approve a code in the browser with GitHub, and your counters join the weekly
board at [ao-wrapped.vercel.app/board](https://ao-wrapped.vercel.app/board). The
board resets every Monday.

## Keeping the board current

One publish is a snapshot. `watch` keeps it live: it follows AO's event stream
and republishes the week whenever a number actually changes, at most once every
30 seconds.

```bash
npx ao-wrapped watch      # runs until stopped
npx ao-wrapped status     # what is syncing, and when it last published
npx ao-wrapped stop       # end it
```

`watch` runs in the foreground and Ctrl-C ends it cleanly. Nothing starts it
automatically, and it publishes only to a board this machine has already been
approved for — run `--publish` once first. It rolls over on Monday on its own,
publishing a final snapshot of the closing week before opening the next.

## What leaves your machine

Only numbers. Every field in the payload is a count, a date, or one of a fixed
set of words — code, diffs, prompts, commit messages, repo names, branch names
and file paths are never read into it in the first place.

See for yourself before anything is sent:

```bash
npx ao-wrapped --dry-run
```

That prints the exact JSON publishing would send, and exits.

## Options

```
ao-wrapped             print your card
ao-wrapped watch       keep the board current; runs until stopped
ao-wrapped status      what is syncing, and when it last published
ao-wrapped stop        end the running watcher

--handle <name>        your GitHub handle
--from <YYYY-MM-DD>    window start (default: Monday of this week)
--to <YYYY-MM-DD>      window end (default: Sunday of this week)
--db <path>            override the AO telemetry location
--api <url>            board API base URL
--dump-schema          print the AO schema this install exposes
--dry-run              print the payload instead of sending it
--publish              send counters to the board (opt-in, always)
```

`watch` accepts `--api`, `--handle` and `--db`; `status` accepts `--api`.

AO's telemetry is opened **read-only**. Nothing is ever written back to it.

Requires Node 22.5 or newer. Apache-2.0.
Source: https://github.com/dewansh-shukla/shipcast
