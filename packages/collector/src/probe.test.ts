import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_REQUIREMENTS, formatSchemaDump, probeSchema } from "./probe.ts";

/**
 * Fixtures are built here rather than read from ~/.ao: the developer's real
 * database is read-only by house rule, and its shape changes every AO release.
 */

const temporaries: string[] = [];

const SCHEMA: Record<string, string[]> = {
  goose_db_version: ["id INTEGER PRIMARY KEY", "version_id INTEGER", "is_applied INTEGER"],
  change_log: ["seq INTEGER PRIMARY KEY", "event_type TEXT", "payload TEXT"],
  sessions: ["id TEXT PRIMARY KEY", "harness TEXT"],
  pr: [
    "url TEXT PRIMARY KEY",
    "pr_state TEXT",
    "ci_state TEXT",
    "additions INTEGER",
    "deletions INTEGER",
    "changed_files INTEGER",
  ],
  model_usage_events: ["id TEXT PRIMARY KEY", "input_tokens INTEGER"],
  usage_bindings: ["id TEXT PRIMARY KEY", "harness TEXT"],
  conversation_turns: ["id TEXT PRIMARY KEY", "state TEXT"],
  agent_switches: ["id TEXT PRIMARY KEY", "target_harness TEXT"],
  review_run: ["id TEXT PRIMARY KEY", "verdict TEXT"],
};

const ALL_TABLES = Object.keys(SCHEMA);

/** A miniature AO database. `omit` drops tables; `dropColumns` drops columns. */
function fixtureDb(
  options: { omit?: string[]; dropColumns?: Record<string, string[]> } = {},
): DatabaseSync {
  const omit = new Set(options.omit ?? []);
  const dropColumns = options.dropColumns ?? {};

  const dir = mkdtempSync(join(tmpdir(), "ao-wrapped-probe-"));
  temporaries.push(dir);
  const db = new DatabaseSync(join(dir, "ao.db"));

  for (const [table, columns] of Object.entries(SCHEMA)) {
    if (omit.has(table)) continue;
    const dropped = new Set(dropColumns[table] ?? []);
    const kept = columns.filter((column) => !dropped.has(column.split(" ")[0] ?? ""));
    db.exec(`CREATE TABLE ${table} (${kept.join(", ")})`);
  }

  if (!omit.has("goose_db_version")) {
    db.exec("INSERT INTO goose_db_version (version_id, is_applied) VALUES (84, 1), (85, 1)");
  }
  if (!omit.has("sessions")) {
    db.exec("INSERT INTO sessions (id, harness) VALUES ('a', 'claude-code'), ('b', 'codex')");
  }
  return db;
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("probeSchema", () => {
  it("reports tables, their columns and their row counts", () => {
    const probe = probeSchema(fixtureDb());

    expect(probe.tables.get("sessions")).toEqual({
      name: "sessions",
      columns: ["id", "harness"],
      rowCount: 2,
    });
    expect(probe.tables.get("change_log")?.rowCount).toBe(0);
    expect(probe.tables.get("pr")?.columns).toContain("changed_files");
  });

  it("reads the applied goose migration version", () => {
    const probe = probeSchema(fixtureDb());
    expect(probe.gooseVersion).toBe(85);
    expect(probe.aoVersion).toBe("goose-85");
  });

  it("enables every feature when the whole schema is present", () => {
    expect(probeSchema(fixtureDb()).has).toEqual({
      changeLog: true,
      prSizes: true,
      tokenUsage: true,
      conversationTurns: true,
      agentSwitches: true,
      reviewRuns: true,
    });
  });

  it("disables exactly one feature when an optional table is missing", () => {
    const probe = probeSchema(fixtureDb({ omit: ["review_run"] }));

    expect(probe.has.reviewRuns).toBe(false);
    expect(probe.has).toMatchObject({
      changeLog: true,
      prSizes: true,
      tokenUsage: true,
      conversationTurns: true,
      agentSwitches: true,
    });
    expect(probe.tables.has("review_run")).toBe(false);
    expect(probe.gooseVersion).toBe(85);
  });

  it("disables exactly one feature when an optional column is missing", () => {
    const probe = probeSchema(fixtureDb({ dropColumns: { pr: ["changed_files"] } }));

    expect(probe.has.prSizes).toBe(false);
    expect(probe.has.changeLog).toBe(true);
    expect(probe.tables.get("pr")?.columns).toEqual([
      "url",
      "pr_state",
      "ci_state",
      "additions",
      "deletions",
    ]);
  });

  it("disables tokenUsage when either of its two tables is missing", () => {
    expect(probeSchema(fixtureDb({ omit: ["usage_bindings"] })).has.tokenUsage).toBe(false);
    expect(probeSchema(fixtureDb({ omit: ["model_usage_events"] })).has.tokenUsage).toBe(false);
  });

  it("survives a database with no AO tables at all", () => {
    const probe = probeSchema(fixtureDb({ omit: ALL_TABLES }));

    expect(probe.tables.size).toBe(0);
    expect(probe.gooseVersion).toBe(0);
    expect(probe.aoVersion).toBe("unknown");
    expect(Object.values(probe.has).every((flag) => flag === false)).toBe(true);
  });

  it("ignores SQLite's internal tables", () => {
    const db = fixtureDb();
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)");
    db.exec("INSERT INTO t DEFAULT VALUES");

    expect(probeSchema(db).tables.has("sqlite_sequence")).toBe(false);
  });
});

describe("formatSchemaDump", () => {
  it("prints tables, row counts, columns and every feature flag", () => {
    const dump = formatSchemaDump(probeSchema(fixtureDb()));

    expect(dump).toContain("goose migration 85");
    expect(dump).toMatch(/sessions\s+2 rows/);
    expect(dump).toContain("url, pr_state, ci_state, additions, deletions, changed_files");
    for (const feature of FEATURE_REQUIREMENTS) expect(dump).toContain(feature.flag);
    expect(dump).toContain("[x] reviewRuns");
  });

  it("names what is missing behind a disabled flag", () => {
    const dump = formatSchemaDump(probeSchema(fixtureDb({ dropColumns: { pr: ["deletions"] } })));

    expect(dump).toContain("[ ] prSizes");
    expect(dump).toContain("missing pr.deletions");
  });

  it("says so plainly when the database is empty", () => {
    const dump = formatSchemaDump(probeSchema(fixtureDb({ omit: ALL_TABLES })));
    expect(dump).toContain("0 tables");
    expect(dump).toContain("no tables");
  });
});
