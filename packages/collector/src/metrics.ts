import {
  OBSERVABLE_METRICS,
  OUTCOMES,
  SIZE_BUCKETS,
  type AgentStats,
  type DeathCause,
  type GraveyardEntry,
  type Harness,
  type IngestPayload,
  type ObservableMetric,
  type Outcome,
} from "@ao-wrapped/shared";
import type { SchemaProbe } from "./probe.ts";
import type { Transition } from "./replay.ts";

/**
 * TICKET A3 — metrics.
 *
 * A pure function: transitions and schema facts in, the ingest payload out. No
 * database access, no network, no clock reads — everything it needs is an
 * argument, so it is fixture-testable end to end without a real AO install.
 *
 * Derivations:
 *   tasks            distinct sessions appearing in the window
 *   merges           pr_state transitions into 'merged'
 *   ciRecoveries     a 'failed' ci_check edge followed by a 'passed' one
 *                    (note: pr_checks uses passed/failed while pr.ci_state uses
 *                    passing/failing — mixing the two silently yields zero, so
 *                    only the pr_checks vocabulary is accepted here)
 *   interventions    transitions INTO 'waiting_input' or 'blocked'
 *   peakParallelism  running count of sessions in 'active', max over the stream
 *   harnesses        distinct harnesses seen
 *   outcomes         one per session, by the precedence in OUTCOMES
 *   graveyard        sessions ending with no merge; cause from the last
 *                    PR-related transition
 *   observed         which of the above this install had a source for at all
 *
 * `observed` is the one output here that is not a count. A zero that means
 * "unmeasured" is the one kind of dishonesty that looks like precision, so
 * every counter is emitted unchanged and this set says which of them are
 * claims about agents rather than claims about an empty table.
 *
 * The result must satisfy IngestPayloadSchema. If it does not, that is a bug
 * here and not a reason to relax the schema.
 *
 * Privacy: nothing derived from a repo name, branch name, PR title or path is
 * read here, let alone emitted. Session ids are grouping keys only — they never
 * reach the payload, which is numbers, dates and closed enums.
 */

export interface MetricsInput {
  probe: SchemaProbe;
  transitions: Transition[];
  handle: string;
  window: { from: Date; to: Date };
}

/**
 * Mirrors packages/collector/package.json. A pure function cannot read the
 * manifest, so the literal lives here and is asserted against the manifest by
 * the test rather than left to drift.
 */
export const COLLECTOR_VERSION = "0.1.0";

/** Schema ceilings, enforced here so a busy install cannot produce a 400. */
const MAX_COUNT = 100_000;
const MAX_MEDIAN_MINUTES = 10_000;
const MAX_AGENTS = 30;
const MAX_GRAVEYARD = 100;

/** Grouping key for PR-side events replay could not attribute to a session. */
const UNATTRIBUTED = "<unattributed>";

/**
 * The table each derivable metric answers to. A metric is observed when that
 * table holds rows, not merely when it exists: `pr_checks` present but empty
 * means CI recovery was not measurable here, whatever the schema says. That is
 * the real case this exists for — GitHub Actions is billing-locked on the
 * account building this, so no check ever ran and `ciRecoveries` is 0 for a
 * reason that has nothing to do with the agents.
 *
 * `turns`, `repos`, `sizeMix` and `tokens` are deliberately absent from this
 * list. `Transition` carries none of them, so no table makes them derivable
 * here and they are never observed — the zero beside them in `totals` is a
 * placeholder the schema requires, not a measurement anyone took.
 */
const METRIC_SOURCE: ReadonlyArray<readonly [ObservableMetric, string]> = [
  ["tasks", "sessions"],
  ["harnesses", "sessions"],
  ["merges", "pr"],
  ["ciRecoveries", "pr_checks"],
  ["interventions", "change_log"],
  ["peakParallelism", "change_log"],
];

const PR_KINDS = new Set<Transition["kind"]>([
  "pr_state",
  "ci_check",
  "mergeability",
  "review_thread",
]);

/**
 * AO, GitHub's API and GitHub's UI each spell "this branch does not merge
 * cleanly" differently, and replay passes the stored token through untouched.
 */
const CONFLICT_STATES = new Set([
  "conflicting",
  "conflict",
  "conflicted",
  "dirty",
  "merge_conflict",
]);

interface SessionFacts {
  harness: Harness;
  firstAt: number;
  lastAt: number;
  merged: boolean;
  openedPr: boolean;
  exited: boolean;
  sawConflict: boolean;
  reviewResolved: boolean;
  ciRecoveries: number;
  interventions: number;
  lastPrTransition: Transition | null;
}

export function computeMetrics(input: MetricsInput): IngestPayload {
  const { probe, handle, window } = input;
  const from = requireDate(window.from, "window.from");
  const to = requireDate(window.to, "window.to");

  const transitions = input.transitions
    .filter((t) => inWindow(t, from, to))
    .sort((a, b) => a.seq - b.seq);

  const sessions = new Map<string, SessionFacts>();
  const harnesses = new Set<Harness>();
  /** Sessions currently in `active`, walked in seq order for the peak. */
  const active = new Set<string>();
  /** A failure is pending per CI key until a later `passed` edge clears it. */
  const pendingCiFailure = new Set<string>();

  let peakParallelism = 0;
  let merges = 0;
  let interventions = 0;
  let ciRecoveries = 0;

  for (const transition of transitions) {
    harnesses.add(transition.harness);
    const session = transition.sessionId === null ? null : facts(sessions, transition);

    switch (transition.kind) {
      case "activity": {
        if (transition.to === "waiting_input" || transition.to === "blocked") {
          interventions += 1;
          if (session) session.interventions += 1;
        }
        if (transition.to === "exited" && session) session.exited = true;
        if (transition.sessionId !== null) {
          if (transition.to === "active") active.add(transition.sessionId);
          else active.delete(transition.sessionId);
          peakParallelism = Math.max(peakParallelism, active.size);
        }
        break;
      }

      case "ci_check": {
        // Ideally keyed by (pr, check). Transition carries neither, and the
        // interface is frozen, so the owning session is the available proxy:
        // two checks failing and passing inside one session collapse to one
        // recovery. TODO(A2 follow-up): give Transition a check identity.
        const key = transition.sessionId ?? UNATTRIBUTED;
        if (transition.to === "failed") {
          pendingCiFailure.add(key);
        } else if (transition.to === "passed" && pendingCiFailure.delete(key)) {
          ciRecoveries += 1;
          if (session) session.ciRecoveries += 1;
        }
        break;
      }

      case "pr_state": {
        if (session) session.openedPr = true;
        if (transition.to === "merged") {
          merges += 1;
          if (session) session.merged = true;
        }
        break;
      }

      case "mergeability": {
        if (session && CONFLICT_STATES.has(transition.to.toLowerCase())) session.sawConflict = true;
        break;
      }

      case "review_thread": {
        if (session && transition.to === "resolved") session.reviewResolved = true;
        break;
      }
    }

    if (session && PR_KINDS.has(transition.kind)) session.lastPrTransition = transition;
  }

  const outcomes = zeroed(OUTCOMES);
  const perSessionOutcome = new Map<string, Outcome>();
  for (const [id, session] of sessions) {
    const outcome = classify(session);
    perSessionOutcome.set(id, outcome);
    outcomes[outcome] += 1;
  }

  const graveyard: GraveyardEntry[] = [];
  for (const session of sessions.values()) {
    if (session.merged || !session.exited) continue;
    graveyard.push({ harness: session.harness, cause: causeOf(session.lastPrTransition) });
  }

  return {
    schema: 1,
    handle,
    aoVersion: probe.aoVersion.slice(0, 20),
    collectorVersion: COLLECTOR_VERSION,
    window: { from: isoDate(from), to: isoDate(to) },
    totals: {
      tasks: clamp(sessions.size),
      merges: clamp(merges),
      ciRecoveries: clamp(ciRecoveries),
      interventions: clamp(interventions),
      peakParallelism: clamp(peakParallelism),
      harnesses: clamp(harnesses.size),
      // TODO(A3 follow-up): `turns` needs conversation_turns and `repos` needs
      // a repo identity; the frozen Transition carries neither. Both stay zero
      // until replay supplies them — see probe.has.conversationTurns.
      turns: 0,
      repos: 0,
    },
    outcomes,
    // TODO(A3 follow-up): sizeMix and topRepoShare need pr.additions +
    // pr.deletions (probe.has.prSizes) and a per-merge repo identity. The
    // frozen Transition carries no diff size, and widening it to get one is
    // ticket A2's call, not this ticket's. Zeroed until then.
    sizeMix: zeroed(SIZE_BUCKETS),
    topRepoShare: 0,
    agents: agentStats(sessions, perSessionOutcome),
    graveyard: graveyard.slice(0, MAX_GRAVEYARD),
    observed: observedMetrics(probe),
  };
}

/**
 * Emitted in OBSERVABLE_METRICS order and never repeating, so two runs over the
 * same install produce the same array and the schema's uniqueness check cannot
 * be tripped by the order sources happen to be listed in above.
 */
function observedMetrics(probe: SchemaProbe): ObservableMetric[] {
  const sourced = new Set(
    METRIC_SOURCE.filter(([, table]) => hasRows(probe, table)).map(([metric]) => metric),
  );
  return OBSERVABLE_METRICS.filter((metric) => sourced.has(metric));
}

/** Rows, not existence. An empty table measured nothing. */
function hasRows(probe: SchemaProbe, table: string): boolean {
  return (probe.tables.get(table)?.rowCount ?? 0) > 0;
}

/**
 * Exactly one outcome per session, highest precedence first. A merge that
 * survived both a conflict and a CI failure is `conflict_resolved` only — the
 * order in OUTCOMES ranks demonstrated autonomy, so a session is credited for
 * the hardest loop it closed and never for two at once.
 */
function classify(session: SessionFacts): Outcome {
  if (session.merged) {
    if (session.sawConflict) return "conflict_resolved";
    if (session.ciRecoveries > 0) return "ci_recovered";
    if (session.reviewResolved) return "review_resolved";
    return "clean";
  }
  if (session.openedPr) return "opened_unmerged";
  return "died";
}

/** Why a session ended without a merge, read off its last PR-related edge. */
function causeOf(last: Transition | null): DeathCause {
  if (last === null) return "no_signal";
  if (last.kind === "ci_check" && last.to === "failed") return "ci_failed";
  if (last.kind === "mergeability" && CONFLICT_STATES.has(last.to.toLowerCase())) {
    return "merge_conflict";
  }
  if (last.kind === "review_thread" && last.to !== "resolved") return "review_blocked";
  return "no_signal";
}

/**
 * Per-harness rollup. `died` counts sessions whose outcome is `died`, so the
 * agent rows and the outcome histogram always reconcile.
 */
function agentStats(
  sessions: Map<string, SessionFacts>,
  perSessionOutcome: Map<string, Outcome>,
): AgentStats[] {
  const byHarness = new Map<Harness, { rows: SessionFacts[]; died: number }>();
  for (const [id, session] of sessions) {
    let bucket = byHarness.get(session.harness);
    if (bucket === undefined) {
      bucket = { rows: [], died: 0 };
      byHarness.set(session.harness, bucket);
    }
    bucket.rows.push(session);
    if (perSessionOutcome.get(id) === "died") bucket.died += 1;
  }

  const stats: AgentStats[] = [];
  for (const [harness, { rows, died }] of byHarness) {
    stats.push({
      harness,
      tasks: clamp(rows.length),
      merges: clamp(rows.filter((s) => s.merged).length),
      recoveries: clamp(sum(rows.map((s) => s.ciRecoveries))),
      interventions: clamp(sum(rows.map((s) => s.interventions))),
      died: clamp(died),
      // TODO(A3 follow-up): turns and token counts are not in Transition. The
      // token fields are optional in the schema and stay omitted rather than
      // being reported as a confident zero.
      turns: 0,
      medianMinutes: medianMinutes(rows),
    });
  }
  return stats.slice(0, MAX_AGENTS);
}

/** Session span, first to last transition seen in the window. */
function medianMinutes(rows: SessionFacts[]): number {
  if (rows.length === 0) return 0;
  const spans = rows.map((s) => Math.max(0, s.lastAt - s.firstAt) / 60_000).sort((a, b) => a - b);
  const mid = Math.floor(spans.length / 2);
  const raw =
    spans.length % 2 === 1 ? (spans[mid] ?? 0) : ((spans[mid - 1] ?? 0) + (spans[mid] ?? 0)) / 2;
  return Math.min(MAX_MEDIAN_MINUTES, Math.max(0, raw));
}

function facts(sessions: Map<string, SessionFacts>, transition: Transition): SessionFacts {
  const id = transition.sessionId ?? UNATTRIBUTED;
  const at = transition.at.getTime();
  const existing = sessions.get(id);
  if (existing === undefined) {
    const created: SessionFacts = {
      harness: transition.harness,
      firstAt: at,
      lastAt: at,
      merged: false,
      openedPr: false,
      exited: false,
      sawConflict: false,
      reviewResolved: false,
      ciRecoveries: 0,
      interventions: 0,
      lastPrTransition: null,
    };
    sessions.set(id, created);
    return created;
  }
  // A session's first event can predate the row that names its harness, so a
  // later concrete harness beats an earlier `unknown`.
  if (existing.harness === "unknown" && transition.harness !== "unknown") {
    existing.harness = transition.harness;
  }
  existing.firstAt = Math.min(existing.firstAt, at);
  existing.lastAt = Math.max(existing.lastAt, at);
  return existing;
}

function inWindow(transition: Transition, from: Date, to: Date): boolean {
  const at = transition.at.getTime();
  return Number.isFinite(at) && at >= from.getTime() && at <= to.getTime();
}

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(MAX_COUNT, Math.trunc(value)));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function requireDate(date: Date, label: string): Date {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`computeMetrics: ${label} is not a valid date`);
  }
  return date;
}
