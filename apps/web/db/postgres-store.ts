import { createHash } from "node:crypto";
import type { IngestPayload } from "@ao-wrapped/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { assertDatabaseReachable, getDb, redact } from "./client.ts";
import { agentStats, builders, deviceTokens, snapshots } from "./schema.ts";
import type { AgentStatsRow, BuilderRow, SnapshotRow } from "./schema.ts";
import {
  UndatedWindowError,
  UnknownBuilderError,
  weekKeyForWindow,
  type IngestStore,
  type PublishedSnapshot,
  type StoredSnapshot,
} from "./store.ts";

/**
 * TICKET 16 — `IngestStore` against Postgres.
 *
 * The in-memory store stays exactly as it is and remains what the test suite
 * runs against, so a contributor without a database can still run everything.
 * This is the same interface, backed by drizzle, selected by `getIngestStore()`
 * when `DATABASE_URL` is set.
 *
 * The upsert semantics are the point. Continuous sync (ticket 14) republishes
 * the same builder and week over and over, so a write that accumulates instead
 * of replacing would inflate a builder's counters every time their collector
 * ticked. `(builder_id, week_key)` is unique in the schema and every write goes
 * through `ON CONFLICT`, which is what makes that safe.
 *
 * This module imports `store.ts` for the interface and its errors while
 * `store.ts` imports this one to select between them. The cycle is safe because
 * neither module touches the other at import time — every reference is inside a
 * function or method body, by which point both have finished initialising.
 */

/**
 * Any drizzle Postgres handle, rather than the `postgres.js` one specifically.
 *
 * Production passes the pooled Neon client from `client.ts`. The tests pass a
 * PGlite handle — real Postgres, in process, no network — so the upsert
 * behaviour below is exercised against an actual database rather than a mock
 * that would only prove the mock agrees with itself.
 */
export type IngestDatabase = PgDatabase<PgQueryResultHKT, typeof import("./schema.ts")>;

/** Columns a re-publish overwrites: everything the payload carries. */
function overwritableColumns(row: typeof snapshots.$inferInsert) {
  const { id: _id, builderId: _builderId, weekKey: _weekKey, ...rest } = row;
  return rest;
}

export class PostgresIngestStore implements IngestStore {
  private readonly db: IngestDatabase;

  /**
   * True when `db` is the shared client from `client.ts` rather than a handle
   * handed in by a caller. Only then is there a `DATABASE_URL` to health-check
   * — an injected handle is already open, and probing the environment for one
   * it does not use would fail for a database that is working perfectly.
   */
  private readonly ownsDefaultClient: boolean;

  constructor(db?: IngestDatabase) {
    this.ownsDefaultClient = db === undefined;
    this.db = db ?? getDb();
  }

  /**
   * Every query goes through here so that a database that will not answer
   * produces one clear, credential-free error instead of a driver stack trace
   * on its way into a response body.
   */
  private async query<T>(run: (db: IngestDatabase) => Promise<T>): Promise<T> {
    if (this.ownsDefaultClient) await assertDatabaseReachable();

    try {
      return await run(this.db);
    } catch (cause) {
      /**
       * Domain errors are answers, not failures — the route turns them into
       * status codes and they carry no credentials. Only driver errors get
       * flattened, because those are the ones that arrive with a connection
       * string somewhere in them.
       */
      if (cause instanceof UnknownBuilderError || cause instanceof UndatedWindowError) throw cause;
      throw new Error(redact(cause instanceof Error ? cause.message : "database query failed"));
    }
  }

  /**
   * Register a device token against a builder. Ticket 10's claim flow calls
   * this once, when approval mints the token.
   *
   * Only the hash is written. Re-issuing the same token is a no-op rather than
   * an error, so a retried approval does not fail on the unique constraint.
   */
  async issueToken(builderId: string, token: string): Promise<void> {
    await this.query(async (db) => {
      await db
        .insert(deviceTokens)
        .values({ builderId, tokenHash: hashToken(token) })
        .onConflictDoNothing({ target: deviceTokens.tokenHash });
    });
  }

  /**
   * Find or create the builder for a GitHub identity.
   *
   * `builders_handle_lower_idx` makes the handle unique case-insensitively, so
   * a second claim by the same person must return the first row rather than
   * fail — otherwise their weeks land under two ids and only one is ever
   * ranked.
   */
  async upsertBuilder(init: {
    handle: string;
    githubId?: string | null;
    avatarUrl?: string | null;
  }): Promise<BuilderRow> {
    return this.query(async (db) => {
      const existing = await this.findBuilderByHandle(db, init.handle);
      if (existing) return existing;

      const [row] = await db
        .insert(builders)
        .values({
          handle: init.handle,
          githubId: init.githubId ?? null,
          avatarUrl: init.avatarUrl ?? null,
        })
        .onConflictDoNothing()
        .returning();

      /** Lost the insert race: the winner's row is the one that counts. */
      if (row === undefined) {
        const raced = await this.findBuilderByHandle(db, init.handle);
        if (raced === undefined) throw new Error("builder vanished between insert and select");
        return raced;
      }
      return row;
    });
  }

  private async findBuilderByHandle(
    db: IngestDatabase,
    handle: string,
  ): Promise<BuilderRow | undefined> {
    const [row] = await db
      .select()
      .from(builders)
      .where(sql`lower(${builders.handle}) = lower(${handle})`)
      .limit(1);
    return row;
  }

  /**
   * The builder a presented token belongs to.
   *
   * The comparison is on the hash, so the plaintext token exists only for the
   * length of this call and never in a column, a log or a query plan.
   */
  async builderForToken(token: string): Promise<BuilderRow | null> {
    return this.query(async (db) => {
      const [row] = await db
        .select({ builder: builders })
        .from(deviceTokens)
        .innerJoin(builders, eq(builders.id, deviceTokens.builderId))
        .where(eq(deviceTokens.tokenHash, hashToken(token)))
        .limit(1);
      return row?.builder ?? null;
    });
  }

  async saveSnapshot(builderId: string, payload: IngestPayload): Promise<StoredSnapshot> {
    /**
     * Same derivation as the in-memory store, from the same helper. Ingest
     * rejects a window straddling a Monday with a 400 before it reaches here.
     */
    const weekKey = weekKeyForWindow(payload.window) ?? weekKeyForDay(payload.window.from);
    if (weekKey === null) throw new UndatedWindowError(payload.window.from);

    const values: typeof snapshots.$inferInsert = {
      builderId,
      payloadVersion: payload.schema,
      aoVersion: payload.aoVersion,
      collectorVersion: payload.collectorVersion,
      weekKey,
      windowFrom: payload.window.from,
      windowTo: payload.window.to,
      tasks: payload.totals.tasks,
      merges: payload.totals.merges,
      ciRecoveries: payload.totals.ciRecoveries,
      interventions: payload.totals.interventions,
      peakParallelism: payload.totals.peakParallelism,
      harnesses: payload.totals.harnesses,
      turns: payload.totals.turns,
      repos: payload.totals.repos,
      topRepoShare: payload.topRepoShare,
      outcomes: { ...payload.outcomes },
      sizeMix: { ...payload.sizeMix },
      graveyard: payload.graveyard.map((entry) => ({ ...entry })),
      receivedAt: new Date(),
    };

    return this.query((db) =>
      /**
       * One transaction, because a republish deletes the previous per-harness
       * rows before writing the new ones. Committing the delete without the
       * insert would leave a snapshot whose agents had silently vanished.
       *
       * PgBouncer's transaction mode pins a connection for the transaction's
       * duration, so this is safe over the pooled endpoint.
       */
      db.transaction(async (tx) => {
        const [builder] = await tx
          .select({ id: builders.id })
          .from(builders)
          .where(eq(builders.id, builderId))
          .limit(1);
        if (builder === undefined) throw new UnknownBuilderError(builderId);

        const [previous] = await tx
          .select({ id: snapshots.id })
          .from(snapshots)
          .where(and(eq(snapshots.builderId, builderId), eq(snapshots.weekKey, weekKey)))
          .limit(1);

        const [snapshot] = await tx
          .insert(snapshots)
          .values(values)
          .onConflictDoUpdate({
            target: [snapshots.builderId, snapshots.weekKey],
            set: overwritableColumns(values),
          })
          .returning();
        if (snapshot === undefined) throw new Error("snapshot upsert returned no row");

        /** Replace the roster wholesale; a harness can drop out of a week. */
        if (previous !== undefined) {
          await tx.delete(agentStats).where(eq(agentStats.snapshotId, snapshot.id));
        }

        const agents =
          payload.agents.length === 0
            ? []
            : await tx
                .insert(agentStats)
                .values(
                  payload.agents.map((agent) => ({
                    snapshotId: snapshot.id,
                    harness: agent.harness,
                    tasks: agent.tasks,
                    merges: agent.merges,
                    recoveries: agent.recoveries,
                    interventions: agent.interventions,
                    died: agent.died,
                    turns: agent.turns,
                    medianMinutes: agent.medianMinutes,
                    inputTokens: agent.inputTokens ?? null,
                    outputTokens: agent.outputTokens ?? null,
                    cacheReadTokens: agent.cacheReadTokens ?? null,
                  })),
                )
                .returning();

        return { snapshot, agents, replaced: previous !== undefined };
      }),
    );
  }

  async latestSnapshotForHandle(
    handle: string,
    weekKey?: string,
  ): Promise<PublishedSnapshot | null> {
    return this.query(async (db) => {
      const builder = await this.findBuilderByHandle(db, handle);
      if (builder === undefined) return null;

      const [snapshot] = await db
        .select()
        .from(snapshots)
        .where(
          weekKey === undefined
            ? eq(snapshots.builderId, builder.id)
            : and(eq(snapshots.builderId, builder.id), eq(snapshots.weekKey, weekKey)),
        )
        /** Same order as the in-memory store: newest season, stable ties. */
        .orderBy(
          desc(snapshots.weekKey),
          desc(snapshots.windowTo),
          desc(snapshots.windowFrom),
          desc(snapshots.receivedAt),
          desc(snapshots.id),
        )
        .limit(1);
      if (snapshot === undefined) return null;

      return { builder, snapshot, agents: await this.agentsFor(db, [snapshot.id]) };
    });
  }

  async snapshotsForWeek(weekKey: string): Promise<PublishedSnapshot[]> {
    return this.query(async (db) => {
      const rows = await db
        .select({ builder: builders, snapshot: snapshots })
        .from(snapshots)
        .innerJoin(builders, eq(builders.id, snapshots.builderId))
        .where(eq(snapshots.weekKey, weekKey))
        /** Handle order, so a season reads the same twice. Ranking is the board's. */
        .orderBy(builders.handle);
      if (rows.length === 0) return [];

      const agents = await this.agentsFor(
        db,
        rows.map((row) => row.snapshot.id),
      );
      const bySnapshot = new Map<string, AgentStatsRow[]>();
      for (const agent of agents) {
        const bucket = bySnapshot.get(agent.snapshotId);
        if (bucket) bucket.push(agent);
        else bySnapshot.set(agent.snapshotId, [agent]);
      }

      return rows.map((row) => ({
        builder: row.builder,
        snapshot: row.snapshot,
        agents: bySnapshot.get(row.snapshot.id) ?? [],
      }));
    });
  }

  /** One round trip for every snapshot's agents, rather than one per snapshot. */
  private async agentsFor(db: IngestDatabase, snapshotIds: string[]): Promise<AgentStatsRow[]> {
    if (snapshotIds.length === 0) return [];
    return db
      .select()
      .from(agentStats)
      .where(inArray(agentStats.snapshotId, snapshotIds))
      .orderBy(agentStats.harness);
  }

  /** Read-side helper mirroring the in-memory store's, for tests and fixtures. */
  async snapshotsFor(builderId: string): Promise<StoredSnapshot[]> {
    return this.query(async (db) => {
      const rows: SnapshotRow[] = await db
        .select()
        .from(snapshots)
        .where(eq(snapshots.builderId, builderId))
        .orderBy(
          desc(snapshots.weekKey),
          desc(snapshots.windowTo),
          desc(snapshots.windowFrom),
          desc(snapshots.receivedAt),
          desc(snapshots.id),
        );

      const agents = await this.agentsFor(
        db,
        rows.map((row) => row.id),
      );
      return rows.map((snapshot) => ({
        snapshot,
        agents: agents.filter((agent) => agent.snapshotId === snapshot.id),
        replaced: false,
      }));
    });
  }
}

/**
 * A device token as it is stored: hex SHA-256, never the token.
 *
 * A plain hash rather than a password KDF is deliberate. These are 256-bit
 * random strings minted by the claim flow, so there is no low-entropy secret
 * for a slow hash to defend, and ingest checks one on every publish.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The opening week of a window, for the straddling case `weekKeyForWindow`
 * refuses. Kept in step with the in-memory store's identical fallback.
 */
function weekKeyForDay(iso: string): string | null {
  return weekKeyForWindow({ from: iso, to: iso });
}
