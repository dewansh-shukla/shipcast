import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  DEATH_CAUSES,
  HARNESSES,
  type DeathCause,
  type Harness,
  type Outcome,
  type SizeBucket,
} from "@ao-wrapped/shared";

/**
 * TICKET B1 — database schema (drizzle).
 *
 * Store raw counters, never computed scores: weights will change during the
 * build, and a stored score would freeze whichever version happened to be live
 * when the row was written. Scores are a view over these numbers.
 *
 * Nothing here can carry a repo name, a branch name, a PR title, a file path, a
 * prompt or a diff. Every column is a number, a date, a GitHub handle, or a
 * value from a closed enum — the same whitelist the ingest payload enforces.
 */

/** Mirrors `HARNESSES`; keeps the closed enum closed at the database level. */
export const harnessEnum = pgEnum("harness", HARNESSES);

/** Mirrors `DEATH_CAUSES`. Why a session ended without a merge. */
export const deathCauseEnum = pgEnum("death_cause", DEATH_CAUSES);

/** A builder who connected the collector and claimed a device token. */
export const builders = pgTable(
  "builders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** GitHub login. Unique, case-insensitively, via `handle_lower`. */
    handle: text("handle").notNull(),
    /** GitHub's numeric user id, kept as text so it never overflows. */
    githubId: text("github_id"),
    avatarUrl: text("avatar_url"),
    connectedAt: timestamp("connected_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    /**
     * True once self-reported merges have been reconciled against
     * GitHub-visible merges. Unverified builders still rank; the card says so.
     */
    verified: boolean("verified").notNull().default(false),
  },
  (table) => [
    uniqueIndex("builders_handle_lower_idx").on(sql`lower(${table.handle})`),
    unique("builders_github_id_key").on(table.githubId),
  ],
);

/**
 * One ingest payload per builder per season. Counters only — no score column
 * exists here on purpose, and adding one is the bug this table is shaped to
 * prevent.
 */
export const snapshots = pgTable(
  "snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    builderId: uuid("builder_id")
      .notNull()
      .references(() => builders.id, { onDelete: "cascade" }),

    /** `IngestPayload.schema` — the payload contract version, currently 1. */
    payloadVersion: integer("payload_version").notNull(),
    aoVersion: text("ao_version").notNull(),
    collectorVersion: text("collector_version").notNull(),

    /**
     * ISO week the payload belongs to, e.g. `2026-W33`. Derived server-side by
     * `weekKeyForWindow` from the window below, never read off the payload:
     * a collector that could name its own season could write into a closed one.
     *
     * Text rather than a date because it is an identity, not a range — the
     * board addresses a season by this exact string (`/board/2026-W33`), and
     * the keys sort lexically into chronological order within and across years.
     */
    weekKey: text("week_key").notNull(),

    /**
     * The window the collector actually measured, kept because the card states
     * it. Descriptive only — `weekKey` is what rows are keyed and queried by.
     */
    windowFrom: date("window_from", { mode: "string" }).notNull(),
    windowTo: date("window_to", { mode: "string" }).notNull(),

    tasks: integer("tasks").notNull(),
    merges: integer("merges").notNull(),
    ciRecoveries: integer("ci_recoveries").notNull(),
    interventions: integer("interventions").notNull(),
    peakParallelism: integer("peak_parallelism").notNull(),
    harnesses: integer("harnesses").notNull(),
    turns: integer("turns").notNull(),
    repos: integer("repos").notNull(),

    /** Share of merges from the single busiest repo. Feeds the concentration cap. */
    topRepoShare: doublePrecision("top_repo_share").notNull(),

    /** Counts keyed by `Outcome`. Closed enum keys, integer values. */
    outcomes: jsonb("outcomes").$type<Partial<Record<Outcome, number>>>().notNull(),
    /** Counts keyed by `SizeBucket`. */
    sizeMix: jsonb("size_mix").$type<Partial<Record<SizeBucket, number>>>().notNull(),
    /** One entry per dead session: harness plus cause, both closed enums. */
    graveyard: jsonb("graveyard").$type<Array<{ harness: Harness; cause: DeathCause }>>().notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * One payload per builder per season. A republish inside the same week
     * replaces the row; the first republish after Monday's rollover carries a
     * new key and so inserts, leaving the closed season untouched.
     */
    unique("snapshots_builder_week_key").on(table.builderId, table.weekKey),
    /** The board reads one season at a time, current or past. */
    index("snapshots_week_idx").on(table.weekKey),
  ],
);

/** Per-harness counters belonging to a snapshot. */
export const agentStats = pgTable(
  "agent_stats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => snapshots.id, { onDelete: "cascade" }),
    harness: harnessEnum("harness").notNull(),

    tasks: integer("tasks").notNull(),
    merges: integer("merges").notNull(),
    recoveries: integer("recoveries").notNull(),
    interventions: integer("interventions").notNull(),
    died: integer("died").notNull(),
    turns: integer("turns").notNull(),
    medianMinutes: doublePrecision("median_minutes").notNull(),

    /** Null for harnesses AO does not meter — see TOKEN_METERED_HARNESSES. */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
  },
  (table) => [unique("agent_stats_snapshot_harness_key").on(table.snapshotId, table.harness)],
);

/**
 * Public GitHub merge counts for builders who never connected the collector.
 * Keyed by handle rather than by builder id: a seed exists precisely because
 * there is no builder row yet.
 */
export const seeds = pgTable(
  "seeds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    handle: text("handle").notNull(),
    githubId: text("github_id"),
    avatarUrl: text("avatar_url"),

    /** Merged pull requests visible on public GitHub inside the window. */
    publicMerges: integer("public_merges").notNull().default(0),
    /** Distinct public repositories those merges landed in. */
    publicRepos: integer("public_repos").notNull().default(0),

    windowFrom: date("window_from", { mode: "string" }).notNull(),
    windowTo: date("window_to", { mode: "string" }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [unique("seeds_handle_window_key").on(table.handle, table.windowFrom, table.windowTo)],
);

export const buildersRelations = relations(builders, ({ many }) => ({
  snapshots: many(snapshots),
}));

export const snapshotsRelations = relations(snapshots, ({ one, many }) => ({
  builder: one(builders, { fields: [snapshots.builderId], references: [builders.id] }),
  agents: many(agentStats),
}));

export const agentStatsRelations = relations(agentStats, ({ one }) => ({
  snapshot: one(snapshots, { fields: [agentStats.snapshotId], references: [snapshots.id] }),
}));

export type BuilderRow = typeof builders.$inferSelect;
export type NewBuilderRow = typeof builders.$inferInsert;
export type SnapshotRow = typeof snapshots.$inferSelect;
export type NewSnapshotRow = typeof snapshots.$inferInsert;
export type AgentStatsRow = typeof agentStats.$inferSelect;
export type NewAgentStatsRow = typeof agentStats.$inferInsert;
export type SeedRow = typeof seeds.$inferSelect;
export type NewSeedRow = typeof seeds.$inferInsert;
