# ao-wrapped

**Spotify Wrapped for your AI coding workforce.**

Reads the [Agent Orchestrator](https://aoagents.dev) database already sitting on
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
--handle <name>        your GitHub handle
--from <YYYY-MM-DD>    window start (default: 30 days ago)
--to <YYYY-MM-DD>      window end (default: today)
--db <path>            override the AO database location
--dump-schema          print the AO schema this install exposes
--dry-run              print the payload instead of sending it
--publish              send counters to the board (opt-in, always)
```

The AO database is opened **read-only**. Nothing is ever written back to it.

Requires Node 22.5 or newer. Apache-2.0.
Source: https://github.com/dewansh-shukla/shipcast
