import type { IngestPayload } from "@ao-wrapped/shared";
import type { AgentStatsRow, BuilderRow, SnapshotRow } from "./schema.ts";

/**
 * TICKET B1 — persistence boundary.
 *
 * There is no provisioned database yet and no `DATABASE_URL`, so ingest talks
 * to this interface rather than to drizzle directly. The in-memory
 * implementation below is what the tests run against; a Postgres
 * implementation is a follow-up that swaps in behind the same three methods.
 *
 * The row types come from `./schema.ts` on purpose: if the payload ever grows a
 * field the tables cannot hold, this file stops compiling.
 */

export interface StoredSnapshot {
  snapshot: SnapshotRow;
  agents: AgentStatsRow[];
  /** True when this replaced an earlier snapshot for the same builder and window. */
  replaced: boolean;
}

/** What a published handle resolves to on the read side. */
export interface PublishedSnapshot {
  builder: BuilderRow;
  snapshot: SnapshotRow;
  agents: AgentStatsRow[];
}

export interface IngestStore {
  /**
   * Resolve a bearer token to the builder it was issued to, or null.
   *
   * Tokens are issued by the device-claim flow (ticket 10), which owns their
   * durable storage. Hashing at rest is that implementation's concern — this
   * signature takes the presented token and hides the comparison.
   */
  builderForToken(token: string): Promise<BuilderRow | null>;

  /** Upsert one window's counters for a builder. Never stores a score. */
  saveSnapshot(builderId: string, payload: IngestPayload): Promise<StoredSnapshot>;

  /**
   * The snapshot `/w/<handle>` should render, or null when nobody has published
   * under that handle. Case-insensitive, because `builders.handle` is unique on
   * `lower(handle)` — at most one builder can ever match.
   *
   * Null is not an error condition. A handle with no snapshot is a builder who
   * has not run the collector, and the card says exactly that.
   */
  latestSnapshotForHandle(handle: string): Promise<PublishedSnapshot | null>;
}

/** Thrown when `saveSnapshot` is handed a builder id that does not exist. */
export class UnknownBuilderError extends Error {
  constructor(builderId: string) {
    super(`no builder with id ${builderId}`);
    this.name = "UnknownBuilderError";
  }
}

function windowKey(builderId: string, from: string, to: string): string {
  return `${builderId} ${from} ${to}`;
}

/**
 * Newest window first — a builder who backfills an older window later should
 * not push their current card off the page. Ties break on arrival time and then
 * on id, so two windows ending on the same day never swap between requests.
 */
function byNewestWindow(a: SnapshotRow, b: SnapshotRow): number {
  return (
    b.windowTo.localeCompare(a.windowTo) ||
    b.windowFrom.localeCompare(a.windowFrom) ||
    b.receivedAt.getTime() - a.receivedAt.getTime() ||
    b.id.localeCompare(a.id)
  );
}

export class InMemoryIngestStore implements IngestStore {
  private readonly builders = new Map<string, BuilderRow>();
  private readonly tokens = new Map<string, string>();
  private readonly snapshots = new Map<string, SnapshotRow>();
  private readonly agents = new Map<string, AgentStatsRow[]>();
  private nextId = 1;

  private mintId(prefix: string): string {
    return `${prefix}-${String(this.nextId++).padStart(4, "0")}`;
  }

  /** Test and seed helper. Returns the created builder row. */
  addBuilder(init: Partial<BuilderRow> & Pick<BuilderRow, "handle">): BuilderRow {
    const row: BuilderRow = {
      id: init.id ?? this.mintId("builder"),
      handle: init.handle,
      githubId: init.githubId ?? null,
      avatarUrl: init.avatarUrl ?? null,
      connectedAt: init.connectedAt ?? new Date(0),
      verified: init.verified ?? false,
    };
    this.builders.set(row.id, row);
    return row;
  }

  /** Test and seed helper standing in for the device-claim flow. */
  issueToken(builderId: string, token: string): void {
    this.tokens.set(token, builderId);
  }

  async builderForToken(token: string): Promise<BuilderRow | null> {
    const builderId = this.tokens.get(token);
    if (builderId === undefined) return null;
    return this.builders.get(builderId) ?? null;
  }

  async saveSnapshot(builderId: string, payload: IngestPayload): Promise<StoredSnapshot> {
    if (!this.builders.has(builderId)) throw new UnknownBuilderError(builderId);

    const key = windowKey(builderId, payload.window.from, payload.window.to);
    const previous = this.snapshots.get(key);
    if (previous) this.agents.delete(previous.id);

    const snapshot: SnapshotRow = {
      id: previous?.id ?? this.mintId("snapshot"),
      builderId,
      payloadVersion: payload.schema,
      aoVersion: payload.aoVersion,
      collectorVersion: payload.collectorVersion,
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

    const agents: AgentStatsRow[] = payload.agents.map((agent) => ({
      id: this.mintId("agent"),
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
    }));

    this.snapshots.set(key, snapshot);
    this.agents.set(snapshot.id, agents);

    return { snapshot, agents, replaced: previous !== undefined };
  }

  async latestSnapshotForHandle(handle: string): Promise<PublishedSnapshot | null> {
    const wanted = handle.toLowerCase();
    const builder = [...this.builders.values()].find((row) => row.handle.toLowerCase() === wanted);
    if (builder === undefined) return null;

    const [snapshot] = [...this.snapshots.values()]
      .filter((row) => row.builderId === builder.id)
      .sort(byNewestWindow);
    if (snapshot === undefined) return null;

    return { builder, snapshot, agents: this.agents.get(snapshot.id) ?? [] };
  }

  /** Read-side helper for tests and, later, for the board's fixtures. */
  snapshotsFor(builderId: string): StoredSnapshot[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.builderId === builderId)
      .map((snapshot) => ({
        snapshot,
        agents: this.agents.get(snapshot.id) ?? [],
        replaced: false,
      }));
  }
}

let active: IngestStore | null = null;

/**
 * The store the route uses. In-memory until `DATABASE_URL` exists and a
 * drizzle-backed implementation is wired in front of it.
 */
export function getIngestStore(): IngestStore {
  active ??= new InMemoryIngestStore();
  return active;
}

/** Swap the active store. Pass null to drop back to a fresh in-memory one. */
export function setIngestStore(store: IngestStore | null): void {
  active = store;
}
