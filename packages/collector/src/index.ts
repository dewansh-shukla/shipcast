#!/usr/bin/env node
import { parseArgs } from "node:util";
import { openAoDatabase, resolveDbPath } from "./db.ts";
import { formatSchemaDump, probeSchema } from "./probe.ts";
import { computeMetrics } from "./metrics.ts";
import { replay } from "./replay.ts";
import { renderCard } from "./render.ts";
import { dryRun, publish } from "./publish.ts";

const USAGE = `
ao-wrapped — what your AI workforce actually accomplished

  ao-wrapped                    print your Wrapped card (local, offline)
  ao-wrapped --dump-schema      print the AO schema this install exposes
  ao-wrapped --dry-run          print the exact JSON that publishing would send
  ao-wrapped --publish          send derived numbers to the board (opt-in)

Options
  --handle <name>               your GitHub handle
  --from <YYYY-MM-DD>           window start (default: 30 days ago)
  --to <YYYY-MM-DD>             window end (default: today)
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

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function main(): Promise<number> {
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const { db } = openAoDatabase(values.db ?? resolveDbPath());
  const probe = probeSchema(db);

  if (values["dump-schema"]) {
    process.stdout.write(formatSchemaDump(probe) + "\n");
    return 0;
  }

  const payload = computeMetrics({
    probe,
    transitions: replay(db),
    handle: values.handle ?? "anonymous",
    window: {
      from: values.from ? new Date(values.from) : daysAgo(30),
      to: values.to ? new Date(values.to) : new Date(),
    },
  });

  if (values["dry-run"]) {
    process.stdout.write(dryRun(payload) + "\n");
    return 0;
  }

  process.stdout.write(renderCard(payload) + "\n");

  if (values.publish) {
    const url = await publish(payload, values.api ?? process.env.AO_WRAPPED_API ?? "");
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
