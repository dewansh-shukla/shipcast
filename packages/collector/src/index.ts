#!/usr/bin/env node
/**
 * Node prints an ExperimentalWarning for `node:sqlite` on first use. It lands in
 * the middle of the card and, to someone deciding whether to trust a CLI reading
 * their machine, "experimental" reads as "unfinished" — when the experimental
 * thing is Node's API surface, not our use of it, which is a read-only open.
 *
 * Only that one warning is swallowed. Anything else Node has to say still gets
 * through, because silencing the channel wholesale is how real warnings go
 * unnoticed.
 */
process.on("warning", (warning) => {
  const isSqliteExperiment =
    warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message);
  if (!isSqliteExperiment) console.warn(`${warning.name}: ${warning.message}`);
});

import { parseArgs } from "node:util";
import { openAoDatabase, resolveDbPath } from "./db.ts";
import { formatSchemaDump, probeSchema } from "./probe.ts";
import { computeMetrics } from "./metrics.ts";
import { replay } from "./replay.ts";
import { renderCard } from "./render.ts";
import { credentialsPath, dryRun, publish, readCredentials } from "./publish.ts";
import { runStatus, runStop, runWatch } from "./watch.ts";
import { weekWindowFor } from "@ao-wrapped/shared";

const USAGE = `
ao-wrapped — what your AI workforce actually accomplished

  ao-wrapped                    print your Wrapped card (local, offline)
  ao-wrapped --dump-schema      print the AO schema this install exposes
  ao-wrapped --dry-run          print the exact JSON that publishing would send
  ao-wrapped --publish          send derived numbers to the board (opt-in)

Continuous sync
  ao-wrapped watch              keep the board current; runs until stopped
  ao-wrapped status             what is syncing, and when it last published
  ao-wrapped stop               end the running watcher

Options
  --handle <name>               your GitHub handle
  --from <YYYY-MM-DD>           window start (default: Monday of this week)
  --to <YYYY-MM-DD>             window end (default: Sunday of this week)
  --db <path>                   override the AO telemetry location
  --api <url>                   board API base URL

Nothing leaves your machine unless you pass --publish. Code, diffs, PR titles,
repo names and branch names are never read into the payload at all.
`;

/**
 * Verbs, not flags. `watch` is a mode the process stays in rather than a
 * modifier on printing a card, and a flag that never returns reads as a bug.
 */
const COMMANDS = ["watch", "status", "stop"] as const;
type Command = (typeof COMMANDS)[number];

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

const { values, positionals } = parseArgs({
  options: {
    "dump-schema": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    publish: { type: "boolean", default: false },
    handle: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    db: { type: "string" },
    api: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  // Positionals carry the subcommands. Every flag keeps working exactly as it
  // did: a bare `ao-wrapped` still prints the card.
  allowPositionals: true,
});

/**
 * The board runs in weekly seasons and rejects a payload spanning more than one,
 * so the default window is this week rather than a rolling month. A default that
 * cannot be published is not a default.
 */
function defaultWindow(): { from: Date; to: Date } {
  const week = weekWindowFor(new Date());
  return {
    from: new Date(`${week.from}T00:00:00.000Z`),
    to: new Date(`${week.to}T23:59:59.999Z`),
  };
}

/**
 * A card printed for "anonymous" and then published under the token's real
 * handle is confusing, and the card is the thing people screenshot. Prefer the
 * handle this machine already claimed.
 */
function defaultHandle(apiBase: string): string {
  try {
    return readCredentials(credentialsPath()).boards[apiBase]?.handle ?? "anonymous";
  } catch {
    return "anonymous";
  }
}

async function main(): Promise<number> {
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  /**
   * Split deliberately. `status` reports on a watcher that may be syncing to a
   * board this invocation never named, so it is told the base only when the
   * user actually chose one — otherwise it answers from the watcher's own
   * record instead of asserting the default board.
   */
  const chosenApi = values.api ?? process.env.AO_WRAPPED_API;
  const apiBase = chosenApi ?? "https://ao-wrapped.vercel.app";

  const [verb, ...extra] = positionals;
  if (verb !== undefined) {
    if (!isCommand(verb)) {
      process.stderr.write(`ao-wrapped: unknown command "${verb}"\n${USAGE}`);
      return 1;
    }
    if (extra.length > 0) {
      process.stderr.write(`ao-wrapped: ${verb} takes no arguments (got "${extra[0]}")\n`);
      return 1;
    }
    // Dispatched before the telemetry is opened: `status` and `stop` answer
    // from the watcher's own state file, and refusing to say whether a watcher
    // is running because AO is not installed here would be nonsense.
    return runCommand(verb, { apiBase, chosenApi });
  }

  const fallbackWindow = defaultWindow();

  const { db } = openAoDatabase(values.db ?? resolveDbPath());
  const probe = probeSchema(db);

  if (values["dump-schema"]) {
    process.stdout.write(formatSchemaDump(probe) + "\n");
    return 0;
  }

  const payload = computeMetrics({
    probe,
    transitions: replay(db),
    handle: values.handle ?? defaultHandle(apiBase),
    window: {
      from: values.from ? new Date(values.from) : fallbackWindow.from,
      to: values.to ? new Date(values.to) : fallbackWindow.to,
    },
  });

  if (values["dry-run"]) {
    process.stdout.write(dryRun(payload) + "\n");
    return 0;
  }

  process.stdout.write(renderCard(payload) + "\n");

  if (values.publish) {
    const url = await publish(payload, apiBase);
    process.stdout.write(`\nPublished: ${url}\n`);
  }

  return 0;
}

/**
 * `watch.ts` owns all three behaviours — SSE resumption, the debounce, the
 * Monday rollover, the PID lock. This is wiring and nothing else.
 *
 * `runWatch` installs its own SIGINT and SIGTERM handlers and releases the lock
 * in a `finally`, so Ctrl-C leaves no stale watcher for the next `watch` to trip
 * over. Nothing here may exit the process ahead of it.
 */
async function runCommand(
  command: Command,
  api: { apiBase: string; chosenApi: string | undefined },
): Promise<number> {
  switch (command) {
    case "watch":
      return runWatch({ api: api.apiBase, handle: values.handle, dbPath: values.db });
    case "status":
      return runStatus({ api: api.chosenApi });
    case "stop":
      return runStop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ao-wrapped: ${message}\n`);
    process.exit(1);
  });
