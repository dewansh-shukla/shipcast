import { weekWindowFor, type IngestPayload, type WeekWindow } from "@ao-wrapped/shared";
import { openAoDatabase, resolveDbPath } from "./db.ts";
import { computeMetrics } from "./metrics.ts";
import { probeSchema } from "./probe.ts";
import { replay } from "./replay.ts";
import {
  DEFAULT_API_BASE,
  PublishError,
  credentialsPath,
  normalizeBase,
  publish,
  readCredentials,
} from "./publish.ts";
import {
  claimWatcher,
  hasChanged,
  readState,
  recordPublish,
  releaseWatcher,
  statePath,
  updateState,
  watcherAlive,
  type WatchState,
  type WatcherInfo,
} from "./state.ts";

/**
 * TICKET 14 — continuous sync.
 *
 * A one-shot publish makes the board a snapshot graveyard: stale within hours,
 * and ranking people by how recently they ran a command rather than how well
 * they orchestrate. `watch` keeps it live.
 *
 * AO already exposes the mechanism. `GET /api/v1/events` is a Server-Sent
 * Events stream of `change_log` rows whose `id:` is the sequence number, so
 * reconnecting with `Last-Event-ID` replays exactly what was missed — verified
 * against a live AO v0.12.3: resuming from id 3 delivered 3310 events starting
 * at 4. A laptop that slept for six hours catches up correctly on wake.
 *
 * Two design choices worth stating, because both are load-bearing:
 *
 * **The stream is a trigger, not a source.** Every publish recomputes the whole
 * week from AO telemetry through the same `replay` → `computeMetrics` path a
 * one-shot run uses. There is no second implementation of transition derivation
 * here, and no incremental counter that could drift out of step with the
 * one-shot card.
 *
 * **Every publish is the whole week, never a delta.** Snapshots upsert by
 * builder and week, so a full replacement is idempotent by construction: a
 * replayed event, a restarted daemon or a double publish all converge on the
 * same row. Deltas would make the server reconcile partial state.
 */

/** AO's event stream. Loopback only — this is a local daemon talking to a local one. */
export const DEFAULT_EVENTS_URL = "http://127.0.0.1:3001/api/v1/events";

/**
 * Quiet period before publishing. Last night produced 53 `session_updated`
 * events; this is what turns them into roughly one publish.
 */
export const DEFAULT_DEBOUNCE_MS = 30_000;

/**
 * The longest a change may sit unpublished, however busy the stream is.
 *
 * A trailing debounce alone starves on an active machine. Measured against a
 * live AO with three agents running: events arrive with gaps of one to six
 * seconds, so a 30-second quiet period never happens and the board would go
 * stale precisely while there was the most to say. This bounds the wait without
 * giving up the collapsing — a burst inside two minutes is still one publish.
 */
export const DEFAULT_MAX_WAIT_MS = 120_000;

/** How often to ask whether the week key changed under a long-running process. */
const ROLLOVER_CHECK_MS = 60_000;

const INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** After a failed publish, try again on this timer rather than on the next event. */
const RETRY_AFTER_FAILURE_MS = 60_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WatchOptions {
  api?: string;
  handle?: string;
  dbPath?: string;
  eventsUrl?: string;
  debounceMs?: number;
  /** Upper bound on how long a pending change waits. See DEFAULT_MAX_WAIT_MS. */
  maxWaitMs?: number;
  rolloverCheckMs?: number;
  maxBackoffMs?: number;
  statePath?: string;
  credentialsFile?: string;
  fetch?: FetchLike;
  write?: (text: string) => void;
  now?: () => Date;
  /** Stops the watcher. `stop` uses SIGTERM; tests use this. */
  signal?: AbortSignal;
  /** Builds the payload for a window. Defaults to reading AO telemetry. */
  snapshotFor?: (window: WeekWindow, handle: string) => IngestPayload;
  /** Injected so tests never touch the network. */
  publishImpl?: (payload: IngestPayload, api: string) => Promise<string>;
}

export interface SseEvent {
  id: string | null;
  event: string;
  data: string;
}

/**
 * Minimal SSE parser over a byte stream.
 *
 * Only what the spec requires and AO actually sends: `id`, `event`, `data`
 * (possibly multi-line), comments ignored, records separated by a blank line.
 * A partial record at end of stream is discarded rather than dispatched — a
 * dropped connection mid-record must not look like a complete event.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /**
   * A reader parked on `read()` would outlive `stop()` — cancelling is what
   * makes the pending read resolve, so "stop" means now and not "after AO's
   * next event".
   */
  const onAbort = (): void => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) return;

      buffer += decoder.decode(value, { stream: true });

      let separator = nextSeparator(buffer);
      while (separator) {
        const record = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const event = parseRecord(record);
        if (event) yield event;
        separator = nextSeparator(buffer);
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function nextSeparator(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return null;
}

function parseRecord(record: string): SseEvent | null {
  let id: string | null = null;
  let event = "message";
  const data: string[] = [];

  for (const rawLine of record.split(/\r?\n/)) {
    // A leading colon is a comment; servers send them as keep-alives.
    if (rawLine === "" || rawLine.startsWith(":")) continue;

    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const value = colon === -1 ? "" : rawLine.slice(colon + 1).replace(/^ /, "");

    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (id === null && data.length === 0) return null;
  return { id, event, data: data.join("\n") };
}

/** The sequence number an event carries, from `id:` or, failing that, its payload. */
export function seqOf(event: SseEvent): number | null {
  const fromId = Number(event.id);
  if (Number.isInteger(fromId) && fromId > 0) return fromId;

  try {
    const parsed: unknown = JSON.parse(event.data);
    const seq = (parsed as { seq?: unknown })?.seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : null;
  } catch {
    return null;
  }
}

/** `2026-08-13T09:12:03Z`, second precision — one log line should not wrap. */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

function relative(from: string | null, now: Date): string {
  if (!from) return "never";
  const ms = now.getTime() - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return "just now";

  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A week window as the two `Date`s `computeMetrics` expects, UTC-inclusive. */
function windowDates(week: WeekWindow): { from: Date; to: Date } {
  return {
    from: new Date(`${week.from}T00:00:00.000Z`),
    to: new Date(`${week.to}T23:59:59.999Z`),
  };
}

/**
 * Reads AO telemetry and derives one week's payload — the same path a
 * one-shot `ao-wrapped` run takes, deliberately.
 *
 * The handle is opened and closed per snapshot: a process that lives for days
 * must not hold a descriptor on a file AO is actively writing, and reopening is
 * also what picks up everything that landed in the WAL since the last publish.
 */
export function snapshotFromDatabase(
  dbPath: string,
  week: WeekWindow,
  handle: string,
): IngestPayload {
  const { db } = openAoDatabase(dbPath);
  try {
    return computeMetrics({
      probe: probeSchema(db),
      transitions: replay(db),
      handle,
      window: windowDates(week),
    });
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

interface Resolved {
  base: string;
  handle: string;
  eventsUrl: string;
  debounceMs: number;
  maxWaitMs: number;
  rolloverCheckMs: number;
  maxBackoffMs: number;
  state: string;
  credentials: string;
  fetch: FetchLike;
  write: (text: string) => void;
  now: () => Date;
  snapshotFor: (window: WeekWindow, handle: string) => IngestPayload;
  publishImpl: (payload: IngestPayload, api: string) => Promise<string>;
}

function resolve(options: WatchOptions): Resolved {
  const base = normalizeBase(options.api || process.env.AO_WRAPPED_API?.trim() || DEFAULT_API_BASE);
  const credentials = options.credentialsFile ?? credentialsPath();
  const dbPath = options.dbPath ?? resolveDbPath();

  return {
    base,
    handle: options.handle ?? readCredentials(credentials).boards[base]?.handle ?? "anonymous",
    eventsUrl: options.eventsUrl ?? process.env.AO_EVENTS_URL?.trim() ?? DEFAULT_EVENTS_URL,
    debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    rolloverCheckMs: options.rolloverCheckMs ?? ROLLOVER_CHECK_MS,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    state: options.statePath ?? statePath(),
    credentials,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    write: options.write ?? ((text) => void process.stdout.write(text)),
    now: options.now ?? (() => new Date()),
    snapshotFor:
      options.snapshotFor ?? ((week, handle) => snapshotFromDatabase(dbPath, week, handle)),
    publishImpl:
      options.publishImpl ??
      ((payload, api) => publish(payload, api, { credentialsFile: credentials })),
  };
}

class Watcher {
  private readonly deps: Resolved;
  private readonly controller = new AbortController();

  /** Highest seq seen on the stream but not yet folded into a publish. */
  private pendingSeq = 0;
  private pending = false;
  /** When the oldest unpublished event arrived. Anchors the max-wait bound. */
  private pendingSince: number | null = null;
  private flushing = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private rolloverTimer: ReturnType<typeof setTimeout> | null = null;
  private season: WeekWindow;
  private stopped = false;
  /** Set once a connection opens, so backoff resets on success rather than on attempt. */
  private connected = false;

  constructor(options: WatchOptions) {
    this.deps = resolve(options);
    this.season = weekWindowFor(this.deps.now());
    options.signal?.addEventListener("abort", () => this.stop(), { once: true });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.controller.abort();
  }

  private clearTimers(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer);
    this.debounceTimer = null;
    this.rolloverTimer = null;
  }

  async run(): Promise<number> {
    const { deps } = this;

    /**
     * A daemon must never open the interactive claim flow — it would print a URL
     * to a log nobody is reading and block forever. Connect once, in the
     * foreground, deliberately.
     */
    if (!readCredentials(deps.credentials).boards[deps.base]) {
      deps.write(
        `ao-wrapped watch: this machine is not connected to ${deps.base}.\n` +
          `Run ao-wrapped --publish once to approve it, then start watch.\n`,
      );
      return 1;
    }

    const info: WatcherInfo = {
      pid: process.pid,
      startedAt: deps.now().toISOString(),
      api: deps.base,
    };
    const claimed = claimWatcher(info, deps.state);
    if (!claimed.ok) {
      deps.write(
        `ao-wrapped watch: already syncing in pid ${claimed.running.pid} ` +
          `(started ${relative(claimed.running.startedAt, deps.now())}).\n` +
          `Run ao-wrapped stop first.\n`,
      );
      return 1;
    }

    this.announce();
    this.scheduleRollover();

    let backoff = INITIAL_BACKOFF_MS;
    try {
      while (!this.stopped) {
        try {
          await this.consume();
          if (this.stopped) break;
          deps.write(
            `${stamp(deps.now())} stream ended · reconnecting in ${Math.round(backoff / 1000)}s\n`,
          );
        } catch (error) {
          if (this.stopped) break;
          deps.write(
            `${stamp(deps.now())} stream lost (${describe(error)}) · retrying in ${Math.round(backoff / 1000)}s\n`,
          );
        }
        if (this.stopped) break;

        /**
         * Reconnect carries Last-Event-ID, so backing off costs latency and
         * never costs events — the replay on reconnect is exactly the gap.
         */
        await delay(backoff, this.signal);
        backoff = this.connected ? INITIAL_BACKOFF_MS : Math.min(backoff * 2, deps.maxBackoffMs);
        this.connected = false;
      }
    } finally {
      this.clearTimers();
      releaseWatcher(process.pid, deps.state);
      deps.write(`${stamp(deps.now())} stopped\n`);
    }

    return 0;
  }

  private announce(): void {
    const { deps } = this;
    const resume = readState(deps.state).lastSeq;

    deps.write(
      [
        "",
        `ao-wrapped watch · syncing to ${deps.base} as ${deps.handle}`,
        `  season ${this.season.key} (${this.season.from} → ${this.season.to})`,
        `  reading ${deps.eventsUrl}${resume > 0 ? ` from seq ${resume}` : " from the beginning"}`,
        `  publishing the whole week, at most once every ${Math.round(deps.debounceMs / 1000)}s, only when a number changes`,
        "  one line below per publish · ao-wrapped stop ends it · nothing auto-starts",
        "",
      ].join("\n"),
    );
  }

  /** Opens the stream and feeds every event into the debounce. */
  private async consume(): Promise<void> {
    const { deps } = this;
    const resumeFrom = Math.max(readState(deps.state).lastSeq, this.pendingSeq);

    const response = await deps.fetch(deps.eventsUrl, {
      headers: {
        accept: "text/event-stream",
        ...(resumeFrom > 0 ? { "last-event-id": String(resumeFrom) } : {}),
      },
      signal: this.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`AO answered ${response.status} at ${deps.eventsUrl}`);
    }

    this.connected = true;

    for await (const event of parseSse(response.body, this.signal)) {
      if (this.stopped) return;
      this.onEvent(event);
    }
  }

  private onEvent(event: SseEvent): void {
    const seq = seqOf(event);
    if (seq === null) return;

    this.pendingSeq = Math.max(this.pendingSeq, seq);
    this.pending = true;
    this.pendingSince ??= this.deps.now().getTime();
    this.scheduleFlush(this.deps.debounceMs);
  }

  /**
   * Resets the quiet period on every event, so a burst of 53 collapses into one
   * publish rather than 53 publishes — but never past the max-wait bound, so a
   * stream that is never quiet still publishes on a predictable cadence.
   */
  private scheduleFlush(afterMs: number): void {
    if (this.stopped) return;

    let wait = afterMs;
    if (this.pendingSince !== null) {
      const deadline = this.pendingSince + this.deps.maxWaitMs;
      wait = Math.max(0, Math.min(wait, deadline - this.deps.now().getTime()));
    }

    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.flush();
    }, wait);
  }

  private scheduleRollover(): void {
    if (this.stopped) return;
    this.rolloverTimer = setTimeout(() => {
      this.rolloverTimer = null;
      void this.rollover().finally(() => this.scheduleRollover());
    }, this.deps.rolloverCheckMs);
  }

  /**
   * Monday rollover, on a clock rather than on activity.
   *
   * A machine can be completely idle across midnight UTC on Sunday, so nothing
   * on the event path can be trusted to notice. This closes the old week out
   * and points at the new one; the new week publishes through the normal path
   * as soon as anything happens in it, because a row of zeros says nothing.
   *
   * Deliberately not a general flush: firing a full publish every minute would
   * undo the debounce during a long burst.
   */
  private async rollover(): Promise<void> {
    if (this.stopped || this.flushing) return;
    const current = weekWindowFor(this.deps.now());
    if (current.key === this.season.key) return;

    this.flushing = true;
    try {
      const closing = this.season;
      this.season = current;
      await this.publishWeek(closing, true);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Publishes what changed, if anything.
   *
   * Runs on the debounce and on the rollover tick, so it must be safe to call
   * when nothing happened at all — an idle machine at midnight on Sunday is
   * exactly when the week has to roll over.
   */
  private async flush(): Promise<void> {
    if (this.flushing || this.stopped) return;
    this.flushing = true;

    try {
      const current = weekWindowFor(this.deps.now());

      /**
       * Monday rollover. A process running across midnight UTC on Sunday must
       * close out the week it was writing to before it starts the next one —
       * otherwise it keeps overwriting last week's row forever. This only
       * reproduces once every seven days, which is exactly why it is handled
       * here rather than left to the next restart.
       */
      if (current.key !== this.season.key) {
        const closing = this.season;
        this.season = current;
        await this.publishWeek(closing, true);
      }

      await this.publishWeek(current, false);
    } finally {
      this.flushing = false;
    }
  }

  private async publishWeek(week: WeekWindow, closing: boolean): Promise<void> {
    const { deps } = this;
    const seqAtSnapshot = this.pendingSeq;

    let payload: IngestPayload;
    try {
      payload = deps.snapshotFor(week, deps.handle);
    } catch (error) {
      deps.write(`${stamp(deps.now())} could not read AO telemetry (${describe(error)})\n`);
      return;
    }

    const state = readState(deps.state);
    if (!hasChanged(state, deps.base, week.key, payload)) {
      // Nothing to say. Still bank the cursor: these events are accounted for,
      // and re-reading them after every reconnect would replay the whole log.
      this.bankCursor(seqAtSnapshot);
      this.settled();
      return;
    }

    try {
      const url = await deps.publishImpl(payload, deps.base);
      recordPublish(
        { base: deps.base, season: week.key, payload, lastSeq: seqAtSnapshot, at: deps.now() },
        deps.state,
      );
      this.settled();
      deps.write(`${stamp(deps.now())} ${summarize(week, payload, url, closing)}\n`);
    } catch (error) {
      /**
       * A failed publish is not a failed run — the same rule the one-shot path
       * follows. Keep the cursor where it is so the next attempt resends, and
       * retry on a timer rather than waiting for AO to happen to emit again.
       */
      deps.write(
        `${stamp(deps.now())} publish failed for ${week.key} (${describe(error)}) · retrying in ${RETRY_AFTER_FAILURE_MS / 1000}s\n`,
      );
      this.pending = true;
      // Re-anchor: the retry timer, not the original arrival, bounds the wait
      // now, or a long outage would make every retry fire instantly.
      this.pendingSince = deps.now().getTime() + RETRY_AFTER_FAILURE_MS - deps.maxWaitMs;
      this.scheduleFlush(RETRY_AFTER_FAILURE_MS);
    }
  }

  /** Nothing is owed to the board any more. */
  private settled(): void {
    this.pending = false;
    this.pendingSince = null;
  }

  private bankCursor(seq: number): void {
    if (seq <= 0) return;
    updateState((state) => void (state.lastSeq = Math.max(state.lastSeq, seq)), this.deps.state);
  }
}

function summarize(
  week: WeekWindow,
  payload: IngestPayload,
  url: string,
  closing: boolean,
): string {
  const { tasks, merges, ciRecoveries, interventions } = payload.totals;
  return (
    `published ${week.key}${closing ? " (final)" : ""} · ` +
    `${tasks} tasks · ${merges} merges · ${ciRecoveries} recoveries · ` +
    `${interventions} interventions → ${url}`
  );
}

function describe(error: unknown): string {
  if (error instanceof PublishError) return error.message.split("\n")[0]!;
  return error instanceof Error ? error.message : String(error);
}

/**
 * `ao-wrapped watch`. Runs until stopped by `ao-wrapped stop`, SIGINT or the
 * caller's abort signal. Returns the process exit code.
 */
export async function runWatch(options: WatchOptions = {}): Promise<number> {
  const watcher = new Watcher(options);

  const onSignal = (): void => watcher.stop();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    return await watcher.run();
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

/** The one-line answer to "is something of mine still shipping data?" */
export function formatStatus(state: WatchState, now: Date, base?: string): string {
  const running = watcherAlive(state.watcher);
  const board = base ?? state.watcher?.api ?? Object.keys(state.boards)[0] ?? null;
  const published = board ? state.boards[board] : undefined;

  const head = running
    ? `syncing · last published ${relative(published?.publishedAt ?? null, now)}`
    : `not running · last published ${relative(published?.publishedAt ?? null, now)}`;
  const season = published ? ` · season ${published.season}` : "";

  const lines = [`${head}${season}`];
  if (board) lines.push(`  board ${board}`);
  if (running && state.watcher) {
    lines.push(
      `  pid ${state.watcher.pid} · started ${relative(state.watcher.startedAt, now)} · ` +
        `synced through seq ${state.lastSeq}`,
    );
  } else {
    lines.push(`  ao-wrapped watch starts it · nothing starts it automatically`);
  }
  return lines.join("\n");
}

export interface StatusOptions {
  statePath?: string;
  api?: string;
  write?: (text: string) => void;
  now?: () => Date;
}

/** `ao-wrapped status`. */
export function runStatus(options: StatusOptions = {}): number {
  const path = options.statePath ?? statePath();
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const now = (options.now ?? (() => new Date()))();

  write(`${formatStatus(readState(path), now, options.api)}\n`);
  return 0;
}

export interface StopOptions {
  statePath?: string;
  write?: (text: string) => void;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * `ao-wrapped stop`. One word, and it stops.
 *
 * SIGTERM rather than a stop-file: the watcher spends most of its life blocked
 * on a socket read, and a file it only notices on the next tick would make
 * "stop" mean "stop within thirty seconds".
 */
export async function runStop(options: StopOptions = {}): Promise<number> {
  const path = options.statePath ?? statePath();
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const kill = options.kill ?? ((pid, signal) => void process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const alive = options.alive ?? ((pid: number) => watcherAlive({ pid, startedAt: "", api: "" }));

  const state = readState(path);
  const watcher = state.watcher;

  if (!watcher || !alive(watcher.pid)) {
    if (watcher) releaseWatcher(watcher.pid, path);
    write("ao-wrapped watch is not running.\n");
    return 0;
  }

  try {
    kill(watcher.pid, "SIGTERM");
  } catch (error) {
    write(`could not stop pid ${watcher.pid}: ${describe(error)}\n`);
    return 1;
  }

  // The watcher clears its own record on the way out; wait briefly so `stop`
  // does not report success while it is still shutting down.
  for (let attempt = 0; attempt < 30 && alive(watcher.pid); attempt++) {
    await sleep(100);
  }

  if (alive(watcher.pid)) {
    write(`asked pid ${watcher.pid} to stop; it has not exited yet.\n`);
    return 0;
  }

  releaseWatcher(watcher.pid, path);
  write("stopped.\n");
  return 0;
}
