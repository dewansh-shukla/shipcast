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

export function probeSchema(_db: DatabaseSync): SchemaProbe {
  throw new Error("TICKET A1: not implemented");
}

export function formatSchemaDump(_probe: SchemaProbe): string {
  throw new Error("TICKET A1: not implemented");
}
