import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IngestPayload } from "@ao-wrapped/shared";

/**
 * TICKET 14 — durable watch state.
 *
 * `watch` is a long-running process that survives sleep, crashes and restarts,
 * so the two facts it cannot afford to lose live on disk next to the token:
 *
 * - `lastSeq`, the highest `change_log` sequence already accounted for. It goes
 *   back to AO as `Last-Event-ID`, which is what makes a reconnect replay
 *   exactly the missed events rather than everything or nothing.
 * - the fingerprint of the last payload published to each board, so a burst of
 *   events that changes no counter results in no publish at all.
 *
 * `lastSeq` advances only after a successful publish. A crash between the two
 * therefore replays events that were already seen — which is harmless, because
 * every publish sends the whole week and the server upserts by builder and
 * week. Replaying cannot double-count something that is replaced wholesale.
 */

export interface BoardPublishState {
  /** ISO week key of the payload last accepted by this board, e.g. `2026-W33`. */
  season: string;
  /** When that publish succeeded. */
  publishedAt: string;
  /** Hash of the published payload; the "did anything actually change" check. */
  fingerprint: string;
}

export interface WatcherInfo {
  pid: number;
  startedAt: string;
  /** Board this watcher publishes to. Shown by `status`. */
  api: string;
}

export interface WatchState {
  version: 1;
  /**
   * Highest `change_log` seq already folded into a successful publish. Zero
   * means "never synced", which correctly asks AO for the whole log.
   */
  lastSeq: number;
  /** Publish memory per board, keyed by normalized API base. */
  boards: Record<string, BoardPublishState>;
  /** The watcher currently running on this machine, if any. */
  watcher: WatcherInfo | null;
}

const EMPTY_STATE: WatchState = { version: 1, lastSeq: 0, boards: {}, watcher: null };

/** `~/.ao-wrapped/state.json`, or under `$AO_WRAPPED_HOME` when set. */
export function statePath(): string {
  const home = process.env.AO_WRAPPED_HOME?.trim() || homedir();
  return join(home, ".ao-wrapped", "state.json");
}

function empty(): WatchState {
  return { ...EMPTY_STATE, boards: {}, watcher: null };
}

/**
 * A state file we cannot read is treated as "never synced" rather than fatal.
 * The cost of being wrong is one redundant full-week publish, which the server
 * upserts; the cost of refusing to start is a daemon that never runs again.
 */
export function readState(path = statePath()): WatchState {
  if (!existsSync(path)) return empty();

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return empty();

    const raw = parsed as Partial<WatchState>;
    const state = empty();

    if (typeof raw.lastSeq === "number" && Number.isFinite(raw.lastSeq) && raw.lastSeq > 0) {
      state.lastSeq = Math.floor(raw.lastSeq);
    }

    if (typeof raw.boards === "object" && raw.boards !== null) {
      for (const [base, value] of Object.entries(raw.boards)) {
        const board = value as Partial<BoardPublishState>;
        if (typeof board?.season === "string" && typeof board?.fingerprint === "string") {
          state.boards[base] = {
            season: board.season,
            fingerprint: board.fingerprint,
            publishedAt:
              typeof board.publishedAt === "string" ? board.publishedAt : new Date(0).toISOString(),
          };
        }
      }
    }

    const watcher = raw.watcher as Partial<WatcherInfo> | null | undefined;
    if (watcher && typeof watcher.pid === "number" && typeof watcher.api === "string") {
      state.watcher = {
        pid: watcher.pid,
        api: watcher.api,
        startedAt:
          typeof watcher.startedAt === "string" ? watcher.startedAt : new Date(0).toISOString(),
      };
    }

    return state;
  } catch {
    return empty();
  }
}

/**
 * Written 0600 inside a 0700 directory. Nothing here is a secret, but it sits
 * beside credentials.json and inherits the same directory, so it inherits the
 * same discipline rather than relaxing the directory's mode.
 */
export function writeState(state: WatchState, path = statePath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

  try {
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
  } catch {
    /* filesystems without POSIX modes are not an error */
  }
}

/** Read, mutate, write. The only safe way to touch one field of the file. */
export function updateState(mutate: (state: WatchState) => void, path = statePath()): WatchState {
  const state = readState(path);
  mutate(state);
  writeState(state, path);
  return state;
}

/**
 * A stable hash of everything a board would store.
 *
 * Keys are sorted recursively so that two payloads carrying the same numbers
 * hash identically regardless of property order — otherwise a rebuilt payload
 * would look "changed" every single time and the debounce would publish 53
 * times an hour, which is the exact failure this exists to prevent.
 */
export function fingerprintPayload(payload: IngestPayload): string {
  return createHash("sha256").update(canonical(payload)).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * True when a payload would tell `base` something it does not already know.
 *
 * A different season always counts as new even if the counters happen to match:
 * the first Monday publish of a fresh week writes a different row, and an
 * all-zero week that looks exactly like the last all-zero week still has to
 * create it.
 */
export function hasChanged(
  state: WatchState,
  base: string,
  season: string,
  payload: IngestPayload,
): boolean {
  const board = state.boards[base];
  if (!board) return true;
  if (board.season !== season) return true;
  return board.fingerprint !== fingerprintPayload(payload);
}

export interface PublishRecord {
  base: string;
  season: string;
  payload: IngestPayload;
  lastSeq: number;
  at: Date;
}

/** Persist everything one successful publish teaches us, in a single write. */
export function recordPublish(record: PublishRecord, path = statePath()): WatchState {
  return updateState((state) => {
    state.boards[record.base] = {
      season: record.season,
      publishedAt: record.at.toISOString(),
      fingerprint: fingerprintPayload(record.payload),
    };
    // Never move the cursor backwards: a rollover publish for the closing week
    // can complete after events from the new week have already been counted.
    state.lastSeq = Math.max(state.lastSeq, record.lastSeq);
  }, path);
}

/** Does the recorded watcher process still exist? */
export function watcherAlive(watcher: WatcherInfo | null): boolean {
  if (!watcher) return false;
  try {
    // Signal 0 performs the permission and existence check without delivering.
    process.kill(watcher.pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type ClaimResult = { ok: true; state: WatchState } | { ok: false; running: WatcherInfo };

/**
 * Register this process as the watcher.
 *
 * Two watchers would publish the same week over each other and double the
 * traffic while halving the clarity of the log, so a live one wins and the
 * second process is told to stop instead of racing it. A recorded watcher whose
 * process is gone — killed, crashed, rebooted — is stale and gets replaced.
 */
export function claimWatcher(info: WatcherInfo, path = statePath()): ClaimResult {
  const current = readState(path);
  if (current.watcher && current.watcher.pid !== info.pid && watcherAlive(current.watcher)) {
    return { ok: false, running: current.watcher };
  }
  return { ok: true, state: updateState((state) => void (state.watcher = info), path) };
}

/** Clear the watcher record. Only clears our own, so a race cannot orphan one. */
export function releaseWatcher(pid: number, path = statePath()): void {
  updateState((state) => {
    if (state.watcher?.pid === pid) state.watcher = null;
  }, path);
}
