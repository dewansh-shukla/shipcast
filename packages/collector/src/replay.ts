import type { DatabaseSync } from "node:sqlite";
import { normalizeHarness, type Harness } from "@ao-wrapped/shared";
import { parseAoTimestamp } from "./time.ts";

/**
 * TICKET A2 — replay engine.
 *
 * AO computes display status at read time and never stores it, so a snapshot
 * query cannot tell you that an agent recovered from a CI failure or how many
 * sessions were running at once. `change_log` can: it is an ordered event log
 * with an autoincrementing `seq` and a JSON payload.
 *
 * Important: the payload holds NEW STATE ONLY, not before/after —
 *   {"id":"frontend-1","activity":"active","isTerminated":false}
 * so transitions must be derived here by holding last-known state per entity
 * and emitting an edge whenever it changes.
 *
 * Every timestamp read here must go through parseAoTimestamp (see time.ts).
 *
 * Done when the event log becomes a typed transition stream and the tests cover
 * an activity change, a CI failed->passed edge, and a conflict resolution.
 */

export type AoEventType =
  | "session_created"
  | "session_updated"
  | "pr_created"
  | "pr_updated"
  | "pr_check_recorded"
  | "pr_session_changed"
  | "pr_review_thread_added"
  | "pr_review_thread_resolved";

export type ActivityState = "active" | "idle" | "waiting_input" | "blocked" | "exited";

export interface Transition {
  seq: number;
  at: Date;
  sessionId: string | null;
  harness: Harness;
  kind: "activity" | "ci_check" | "pr_state" | "mergeability" | "review_thread";
  from: string | null;
  to: string;
}

/** Columns without which the log carries no derivable signal. */
const REQUIRED_COLUMNS = ["seq", "event_type", "payload", "created_at"] as const;

/** Joins the parts of a composite entity key. NUL cannot occur in a url or a check name. */
const KEY_SEPARATOR = "\u0000";

interface ChangeRow {
  seq: number;
  sessionId: string | null;
  eventType: string;
  payload: string;
  createdAt: string;
}

/**
 * Reads `change_log` in `seq` order and returns the edges it implies.
 *
 * Only changes are emitted. The first time an entity is seen its value is
 * recorded and nothing is returned — AO logs a full snapshot on creation, and
 * calling that a transition would invent an edge out of nowhere.
 *
 * Never throws on a database missing the table, missing a column, or holding a
 * row this build cannot read. An unreadable row costs exactly the edges it
 * carried; every other row still reports.
 */
export function replay(db: DatabaseSync): Transition[] {
  const harnessOf = harnessLookup(db);
  const transitions: Transition[] = [];
  const lastKnown = new Map<string, string>();

  /**
   * Records a new value for one entity, emitting an edge only when it differs
   * from the last value seen for that same entity.
   */
  const record = (
    row: ChangeRow,
    at: Date,
    kind: Transition["kind"],
    key: string,
    value: unknown,
    sessionId: string | null,
  ): void => {
    const to = asString(value);
    // An absent field is not a change to the empty string: AO omits fields it
    // has nothing to say about, and older rows carry fewer keys than newer ones.
    if (to === null || to === "" || key === "") return;

    const entity = `${kind}${KEY_SEPARATOR}${key}`;
    const from = lastKnown.get(entity) ?? null;
    lastKnown.set(entity, to);
    if (from === null || from === to) return;

    const harness = harnessOf(sessionId);
    transitions.push({ seq: row.seq, at, sessionId, harness, kind, from, to });
  };

  for (const row of readChangeLog(db)) {
    // A timestamp we cannot parse would poison every window filter downstream,
    // and Go's format is the one SQLite silently fails on. Drop the row rather
    // than emit an edge carrying a bogus date — because the row's value is not
    // recorded either, a later row still reports the change against the last
    // value we could date.
    const at = parseAoTimestamp(row.createdAt);
    if (at === null) continue;

    const payload = parsePayload(row.payload);
    if (payload === null) continue;

    switch (row.eventType) {
      case "session_created":
      case "session_updated": {
        // Sessions key on session id.
        const sessionId = asString(payload["id"]) ?? row.sessionId;
        if (sessionId === null) break;
        record(row, at, "activity", sessionId, payload["activity"], sessionId);
        break;
      }

      case "pr_created":
      case "pr_updated": {
        // PR state, mergeability and review state all key on the pr url.
        const url = asString(payload["url"]);
        if (url === null) break;
        const sessionId = asString(payload["session"]) ?? row.sessionId;
        record(row, at, "pr_state", url, payload["state"], sessionId);
        record(row, at, "mergeability", url, payload["mergeability"], sessionId);
        record(row, at, "review_thread", url, payload["review"], sessionId);
        // payload.ci is deliberately not emitted as a ci_check. It reads
        // passing/failing where pr_check_recorded reads passed/failed, and the
        // per-check events carry the same signal at a granularity that can
        // actually tell a recovery from an unrelated check going green.
        break;
      }

      case "pr_check_recorded": {
        // CI checks key on (pr url, check name): one PR runs many checks, and a
        // check name repeats across commits as the same logical check.
        const url = asString(payload["pr"]);
        const name = asString(payload["name"]);
        if (url === null || name === null) break;
        const key = `${url}${KEY_SEPARATOR}${name}`;
        record(row, at, "ci_check", key, payload["status"], row.sessionId);
        break;
      }

      // pr_session_changed carries no state this stream models. The two
      // review-thread events exist in AO's enum but have never been written on
      // any install probed so far, so their payload shape is unverified and
      // guessing at it would put unchecked strings into the stream. Review
      // state is read from the `review` field above instead.
      default:
        break;
    }
  }

  return transitions;
}

/**
 * Session id to harness, resolved once. Sessions AO has since deleted are still
 * all over `change_log`; they report `unknown` rather than dropping out, since
 * the transition happened whether or not the session survived to be queried.
 */
function harnessLookup(db: DatabaseSync): (sessionId: string | null) => Harness {
  const harnesses = new Map<string, Harness>();
  for (const row of query(db, "SELECT id, harness FROM sessions")) {
    const id = asString(row["id"]);
    if (id === null) continue;
    harnesses.set(id, normalizeHarness(asString(row["harness"]) ?? ""));
  }
  return (sessionId) => (sessionId === null ? "unknown" : (harnesses.get(sessionId) ?? "unknown"));
}

function readChangeLog(db: DatabaseSync): ChangeRow[] {
  const columns = new Set(
    query(db, "PRAGMA table_info(change_log)")
      .map((row) => asString(row["name"]))
      .filter((name): name is string => name !== null),
  );
  if (!REQUIRED_COLUMNS.every((column) => columns.has(column))) return [];

  // session_id is optional: every event kind read here also names its session
  // inside the payload, except checks, which inherit the PR's session anyway.
  const sessionId = columns.has("session_id") ? "session_id" : "NULL AS session_id";
  const rows = query(
    db,
    `SELECT seq, ${sessionId}, event_type, payload, created_at FROM change_log ORDER BY seq`,
  );

  const parsed: ChangeRow[] = [];
  for (const row of rows) {
    const seq = asNumber(row["seq"]);
    const eventType = asString(row["event_type"]);
    const payload = asString(row["payload"]);
    const createdAt = asString(row["created_at"]);
    if (seq === null || eventType === null || payload === null || createdAt === null) continue;
    parsed.push({ seq, sessionId: asString(row["session_id"]), eventType, payload, createdAt });
  }
  return parsed;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Every read goes through here, for the same reason as in probe.ts. */
function query(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}
