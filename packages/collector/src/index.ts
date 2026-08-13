#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openAoDatabase, resolveDbPath } from "./db.ts";
import { formatSchemaDump, probeSchema } from "./probe.ts";
import { computeMetrics } from "./metrics.ts";
import { replay } from "./replay.ts";
import { renderCard } from "./render.ts";
import { credentialsPath, dryRun, publish, readCredentials } from "./publish.ts";
import { weekWindowFor } from "@ao-wrapped/shared";

const USAGE = `
ao-wrapped — what your AI workforce actually accomplished

  ao-wrapped                    print your Wrapped card (local, offline)
  ao-wrapped --dump-schema      print the AO schema this install exposes
  ao-wrapped --dry-run          print the exact JSON that publishing would send
  ao-wrapped --publish          send derived numbers to the board (opt-in)

Options
  --handle <name>               your GitHub handle
  --from <YYYY-MM-DD>           window start (default: Monday of this week)
  --to <YYYY-MM-DD>             window end (default: Sunday of this week)
  --db <path>                   override the AO telemetry location
  --api <url>                   board API base URL

Nothing leaves your machine unless you pass --publish. Code, diffs, PR titles,
repo names and branch names are never read into the payload at all.
`;

const { values } = parseArgs({
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
  allowPositionals: false,
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

  const apiBase = values.api ?? process.env.AO_WRAPPED_API ?? "https://ao-wrapped.vercel.app";
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

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ao-wrapped: ${message}\n`);
    process.exit(1);
  });
