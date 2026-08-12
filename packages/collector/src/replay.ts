import type { DatabaseSync } from "node:sqlite";
import type { Harness } from "@ao-wrapped/shared";

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

export function replay(_db: DatabaseSync): Transition[] {
  throw new Error("TICKET A2: not implemented");
}
