/**
 * TICKET B1 — database schema (drizzle).
 *
 * Store raw counters, never computed scores: weights will change during the
 * build, and a stored score would freeze whichever version happened to be live
 * when the row was written. Scores are a view over these numbers.
 *
 * Tables to define:
 *   builders     handle, github id, avatar, connected_at, verified
 *   snapshots    one ingest payload per builder per window, counters only
 *   agent_stats  per-harness counters belonging to a snapshot
 *   seeds        public GitHub merge counts for builders who never connected
 */
export {};
