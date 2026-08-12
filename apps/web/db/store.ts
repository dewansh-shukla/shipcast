import { weekKeyFor, type IngestPayload } from "@ao-wrapped/shared";
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
 *
 * TICKET 15 — weekly seasons. Snapshots are keyed by `(builderId, weekKey)`,
 * not by the reported window, so the board resets every Monday and every past
 * season stays exactly where it was.
 */

/** The ISO week a `YYYY-MM-DD` day falls in, or null if it is not a date. */
function weekKeyForDay(iso: string): string | null {
  const parsed = Date.parse(`${iso}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : weekKeyFor(new Date(parsed));
}

/**
 * The season a reported window belongs to — `2026-W33` — or null when the
 * window straddles a Monday and therefore belongs to no single season.
 *
 * Derived here and only here. The payload has no week field and must never grow
 * one: a collector that could name its own season could send this week's
 * numbers under last week's key and rewrite a board that has already closed.
 *
 * Week arithmetic comes from `@ao-wrapped/shared` (`week.ts`) rather than being
 * repeated locally, so ingest, the board and the card can never disagree about
 * where Monday is.
 */
export function weekKeyForWindow(window: { from: string; to: string }): string | null {
  const from = weekKeyForDay(window.from);
  return from !== null && from === weekKeyForDay(window.to) ? from : null;
}

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

  /**
   * Upsert one season's counters for a builder. Never stores a score.
   *
   * The season is derived from the payload's window, so a second publish in the
   * same week replaces and the first publish after Monday inserts. A window
   * that straddles a rollover has no season; ingest rejects those with a 400
   * before they reach here, and this falls back to the week the window opens in
   * rather than throwing, because a persistence port is not where a request
   * gets its status code.
   */
  saveSnapshot(builderId: string, payload: IngestPayload): Promise<StoredSnapshot>;

  /**
   * The snapshot `/w/<handle>` should render, or null when nobody has published
   * under that handle. Case-insensitive, because `builders.handle` is unique on
   * `lower(handle)` — at most one builder can ever match.
   *
   * Null is not an error condition. A handle with no snapshot is a builder who
   * has not run the collector, and the card says exactly that.
   *
   * With a `weekKey` this answers for that season alone and returns null when
   * the builder sat that week out — past seasons stay readable rather than
   * being overwritten by whatever they published since.
   */
  latestSnapshotForHandle(handle: string, weekKey?: string): Promise<PublishedSnapshot | null>;

  /**
   * Every builder's snapshot for one season — what the board ranks. Callers
   * pass `weekKeyFor(new Date())` for the live board and any past key for a
   * closed one; a key nobody published in is an empty season, not an error.
   */
  snapshotsForWeek(weekKey: string): Promise<PublishedSnapshot[]>;
}

/** Thrown when `saveSnapshot` is handed a builder id that does not exist. */
export class UnknownBuilderError extends Error {
  constructor(builderId: string) {
    super(`no builder with id ${builderId}`);
    this.name = "UnknownBuilderError";
  }
}

/**
 * Thrown when a window carries a date no season can be derived from. The
 * payload schema already rejects those, so reaching this means validation was
 * bypassed — louder than filing the row under a `NaN` season nobody can query.
 */
export class UndatedWindowError extends Error {
  constructor(from: string) {
    super(`window.from is not a date: ${from}`);
    this.name = "UndatedWindowError";
  }
}

function seasonKey(builderId: string, weekKey: string): string {
  return `${builderId} ${weekKey}`;
}

/**
 * Newest season first — a builder who backfills an older week later should not
 * push their current card off the page. Week keys sort lexically into
 * chronological order, within a year and across one, which is why they are
 * compared as strings. Ties break on the reported window, then arrival time,
 * then id, so two rows never swap between requests.
 */
function byNewestSeason(a: SnapshotRow, b: SnapshotRow): number {
  return (
    b.weekKey.localeCompare(a.weekKey) ||
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

    /**
     * A straddling window has no season of its own. Ingest rejects those with a
     * 400 before they reach here — a persistence port is not where a request
     * gets its status code — so anything arriving straddled is filed under the
     * week it opens in rather than refused.
     */
    const weekKey = weekKeyForWindow(payload.window) ?? weekKeyForDay(payload.window.from);
    if (weekKey === null) throw new UndatedWindowError(payload.window.from);

    const key = seasonKey(builderId, weekKey);
    const previous = this.snapshots.get(key);
    if (previous) this.agents.delete(previous.id);

    const snapshot: SnapshotRow = {
      id: previous?.id ?? this.mintId("snapshot"),
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

  async latestSnapshotForHandle(
    handle: string,
    weekKey?: string,
  ): Promise<PublishedSnapshot | null> {
    const wanted = handle.toLowerCase();
    const builder = [...this.builders.values()].find((row) => row.handle.toLowerCase() === wanted);
    if (builder === undefined) return null;

    const [snapshot] = [...this.snapshots.values()]
      .filter((row) => row.builderId === builder.id)
      .filter((row) => weekKey === undefined || row.weekKey === weekKey)
      .sort(byNewestSeason);
    if (snapshot === undefined) return null;

    return { builder, snapshot, agents: this.agents.get(snapshot.id) ?? [] };
  }

  async snapshotsForWeek(weekKey: string): Promise<PublishedSnapshot[]> {
    const published: PublishedSnapshot[] = [];

    for (const snapshot of this.snapshots.values()) {
      if (snapshot.weekKey !== weekKey) continue;
      const builder = this.builders.get(snapshot.builderId);
      /** A snapshot outliving its builder is a cascade-delete bug, not a row. */
      if (builder === undefined) continue;
      published.push({ builder, snapshot, agents: this.agents.get(snapshot.id) ?? [] });
    }

    /** Handle order, so a season reads the same twice. Ranking is the board's. */
    return published.sort((a, b) => a.builder.handle.localeCompare(b.builder.handle));
  }

  /** Read-side helper for tests and, later, for the board's fixtures. */
  snapshotsFor(builderId: string): StoredSnapshot[] {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.builderId === builderId)
      .sort(byNewestSeason)
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
