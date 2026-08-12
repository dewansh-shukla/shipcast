import type { DatabaseSync } from "node:sqlite";

/**
 * TICKET A1 — schema probe.
 *
 * AO ships schema migrations constantly: upgrading 0.10.2 to 0.12.3 ran 64 of
 * them and added nine tables. The collector must therefore discover the schema
 * at runtime rather than trusting a shape compiled in months earlier.
 *
 * Contract: never throw because a column is missing. A missing column disables
 * exactly one metric and everything else still reports.
 *
 * Done when `ao-wrapped --dump-schema` prints tables, columns and row counts,
 * and `probeSchema` reports which optional features are available.
 */

export interface TableInfo {
  name: string;
  columns: string[];
  rowCount: number;
}

export interface SchemaProbe {
  aoVersion: string;
  gooseVersion: number;
  tables: Map<string, TableInfo>;
  /** Feature flags the rest of the collector branches on. */
  has: {
    changeLog: boolean;
    prSizes: boolean;
    tokenUsage: boolean;
    conversationTurns: boolean;
    agentSwitches: boolean;
    reviewRuns: boolean;
  };
}

type FeatureFlag = keyof SchemaProbe["has"];

export interface FeatureRequirement {
  flag: FeatureFlag;
  /** Each entry is a table name, or `table.column` when a column is required. */
  requires: readonly string[];
}

/**
 * The single source of truth for what each optional metric needs. Both the
 * flags and the dump read this list, so the two cannot drift apart.
 */
export const FEATURE_REQUIREMENTS: readonly FeatureRequirement[] = [
  { flag: "changeLog", requires: ["change_log"] },
  { flag: "prSizes", requires: ["pr.additions", "pr.deletions", "pr.changed_files"] },
  { flag: "tokenUsage", requires: ["model_usage_events", "usage_bindings"] },
  { flag: "conversationTurns", requires: ["conversation_turns"] },
  { flag: "agentSwitches", requires: ["agent_switches"] },
  { flag: "reviewRuns", requires: ["review_run"] },
];

export function probeSchema(db: DatabaseSync): SchemaProbe {
  const tables = readTables(db);
  const gooseVersion = readGooseVersion(db, tables);
  return {
    aoVersion: readAoVersion(db, tables, gooseVersion),
    gooseVersion,
    tables,
    has: featureFlags(tables),
  };
}

/** True when `requirement` ("table" or "table.column") exists in this install. */
export function isPresent(tables: Map<string, TableInfo>, requirement: string): boolean {
  const [tableName, columnName] = requirement.split(".", 2);
  const table = tableName === undefined ? undefined : tables.get(tableName);
  if (table === undefined) return false;
  return columnName === undefined || table.columns.includes(columnName);
}

export function formatSchemaDump(probe: SchemaProbe): string {
  // aoVersion falls back to the migration number, so avoid printing it twice.
  const version =
    probe.aoVersion === `goose-${probe.gooseVersion}`
      ? `goose migration ${probe.gooseVersion}`
      : `ao ${probe.aoVersion} (goose migration ${probe.gooseVersion})`;
  const lines: string[] = [`AO schema — ${version}, ${probe.tables.size} tables`, ""];

  const tables = [...probe.tables.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (tables.length === 0) {
    lines.push("  (no tables — is this an AO database?)");
  }
  const nameWidth = Math.max(0, ...tables.map((t) => t.name.length));
  for (const table of tables) {
    const rows = `${table.rowCount} row${table.rowCount === 1 ? "" : "s"}`;
    lines.push(`  ${table.name.padEnd(nameWidth)}  ${rows.padStart(12)}`);
    for (const line of wrapColumns(table.columns, 88)) lines.push(`    ${line}`);
  }

  lines.push("", "Features");
  const flagWidth = Math.max(...FEATURE_REQUIREMENTS.map((f) => f.flag.length));
  for (const feature of FEATURE_REQUIREMENTS) {
    const missing = feature.requires.filter((r) => !isPresent(probe.tables, r));
    const detail =
      missing.length === 0 ? feature.requires.join(", ") : `missing ${missing.join(", ")}`;
    lines.push(
      `  [${probe.has[feature.flag] ? "x" : " "}] ${feature.flag.padEnd(flagWidth)}  ${detail}`,
    );
  }

  return lines.join("\n");
}

function featureFlags(tables: Map<string, TableInfo>): SchemaProbe["has"] {
  const has: SchemaProbe["has"] = {
    changeLog: false,
    prSizes: false,
    tokenUsage: false,
    conversationTurns: false,
    agentSwitches: false,
    reviewRuns: false,
  };
  for (const feature of FEATURE_REQUIREMENTS) {
    has[feature.flag] = feature.requires.every((r) => isPresent(tables, r));
  }
  return has;
}

function readTables(db: DatabaseSync): Map<string, TableInfo> {
  const tables = new Map<string, TableInfo>();
  for (const name of tableNames(db)) {
    tables.set(name, { name, columns: columnsOf(db, name), rowCount: rowCountOf(db, name) });
  }
  return tables;
}

function tableNames(db: DatabaseSync): string[] {
  const rows = query(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((row) => asString(row["name"])).filter((name): name is string => name !== null);
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = query(db, `PRAGMA table_info(${quoteIdent(table)})`);
  return rows.map((row) => asString(row["name"])).filter((name): name is string => name !== null);
}

function rowCountOf(db: DatabaseSync, table: string): number {
  const rows = query(db, `SELECT count(*) AS n FROM ${quoteIdent(table)}`);
  return asNumber(rows[0]?.["n"]) ?? 0;
}

function readGooseVersion(db: DatabaseSync, tables: Map<string, TableInfo>): number {
  const goose = tables.get("goose_db_version");
  if (goose === undefined || !goose.columns.includes("version_id")) return 0;
  const applied = goose.columns.includes("is_applied") ? " WHERE is_applied = 1" : "";
  const rows = query(db, `SELECT max(version_id) AS v FROM goose_db_version${applied}`);
  return asNumber(rows[0]?.["v"]) ?? 0;
}

/**
 * AO v0.12.3 stores no version string anywhere in the database, so the applied
 * migration is the only version fact available. Newer builds may add one; look
 * for it first and fall back to the migration number.
 */
function readAoVersion(
  db: DatabaseSync,
  tables: Map<string, TableInfo>,
  gooseVersion: number,
): string {
  const settings = tables.get("app_settings");
  if (settings?.columns.includes("key") && settings.columns.includes("value")) {
    const rows = query(
      db,
      "SELECT value FROM app_settings WHERE key IN ('ao_version', 'version') LIMIT 1",
    );
    const value = asString(rows[0]?.["value"]);
    if (value !== null && value !== "") return value.slice(0, 20);
  }
  return gooseVersion > 0 ? `goose-${gooseVersion}` : "unknown";
}

/**
 * Every read goes through here. A table that vanished between `sqlite_master`
 * and the count, a pragma an older SQLite rejects, a corrupt page — none of it
 * is worth losing the other twenty metrics over.
 */
function query(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  try {
    return db.prepare(sql).all();
  } catch {
    return [];
  }
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function wrapColumns(columns: string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const column of columns) {
    const next = current === "" ? column : `${current}, ${column}`;
    if (next.length > width && current !== "") {
      lines.push(`${current},`);
      current = column;
    } else {
      current = next;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
}
