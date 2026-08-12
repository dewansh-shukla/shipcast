import type { IngestPayload } from "@ao-wrapped/shared";
import type { SchemaProbe } from "./probe.ts";
import type { Transition } from "./replay.ts";

/**
 * TICKET A3 — metrics.
 *
 * A pure function: transitions and schema facts in, the ingest payload out. No
 * database access, no network, no clock reads — everything it needs is an
 * argument, so it is fixture-testable end to end.
 *
 * Derivations, all verified against the real AO v0.12.3 schema:
 *   tasks            sessions created in window
 *   merges           pr.pr_state = 'merged'
 *   ciRecoveries     pr_checks: 'failed' then 'passed' on a later commit_hash
 *                    (note: pr.ci_state uses passing/failing, pr_checks uses
 *                    passed/failed — mixing the two silently yields zero)
 *   interventions    transitions INTO 'waiting_input' or 'blocked'
 *   peakParallelism  running count of sessions in 'active', max over the stream
 *   harnesses        distinct sessions.harness
 *   sizeMix          bucketed from pr.additions + pr.deletions
 *   graveyard        terminated with no merged PR, cause from the last pr row
 *
 * The result must satisfy IngestPayloadSchema. If it does not, that is a bug
 * here and not a reason to relax the schema.
 */

export interface MetricsInput {
  probe: SchemaProbe;
  transitions: Transition[];
  handle: string;
  window: { from: Date; to: Date };
}

export function computeMetrics(_input: MetricsInput): IngestPayload {
  throw new Error("TICKET A3: not implemented");
}
