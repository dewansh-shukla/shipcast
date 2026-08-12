import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Opening AO's database without corrupting it.
 *
 * Two things matter here. First: ao.db is small (~300 KB) while ao.db-wal is
 * large (~4 MB) — the recent history lives almost entirely in the write-ahead
 * log, so copying ao.db alone yields a nearly empty database. Second: the AO
 * daemon holds this file open, so we never write to it under any circumstance.
 *
 * Preferred path is a read-only handle in place. If SQLite refuses (it may want
 * to create shared-memory for the WAL), fall back to copying all three files to
 * a temp directory and reading the copy.
 */

export interface OpenResult {
  db: DatabaseSync;
  path: string;
  copied: boolean;
}

export function resolveDataDir(): string {
  return process.env.AO_DATA_DIR?.trim() || join(homedir(), ".ao", "data");
}

export function resolveDbPath(): string {
  return join(resolveDataDir(), "ao.db");
}

export function openAoDatabase(dbPath = resolveDbPath()): OpenResult {
  if (!existsSync(dbPath)) {
    throw new Error(
      `No AO telemetry at ${dbPath}. Is Agent Orchestrator installed? ` +
        `Set AO_DATA_DIR if it lives somewhere else.`,
    );
  }

  try {
    return { db: new DatabaseSync(dbPath, { readOnly: true }), path: dbPath, copied: false };
  } catch {
    const snapshot = snapshotDatabase(dbPath);
    return { db: new DatabaseSync(snapshot, { readOnly: true }), path: snapshot, copied: true };
  }
}

/** Copies db + wal + shm together. Copying any subset loses recent history. */
export function snapshotDatabase(dbPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ao-wrapped-"));
  const target = join(dir, "ao.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${target}${suffix}`);
  }
  return target;
}
