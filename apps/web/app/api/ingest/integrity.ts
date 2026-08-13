import type { IngestPayload } from "@ao-wrapped/shared";

/**
 * TICKET 27 — payloads that contradict themselves.
 *
 * **This is not security, and reading it is enough to defeat it.** The
 * collector runs on the sender's machine: the process, the telemetry it reads
 * and the JSON it posts are all theirs, so any check that could run there can
 * be removed there, and every rule below can be satisfied by a forger who
 * bothers to satisfy it. Nothing here makes forgery impossible.
 *
 * What it does is make forgery *work*, and carelessness *visible*. The schema
 * is deliberately redundant — the same quantity is reported twice, once per
 * agent and once as a total — so a number edited by hand breaks a relationship
 * the editor did not know was checked. That is the whole claim.
 *
 * It also catches honest bugs, which is the more valuable half in practice: the
 * per-agent merge count used to count sessions while the total counted pull
 * requests, and these invariants are what that would have failed.
 *
 * Two kinds of rule, kept apart on purpose:
 *
 * - **Coherence** — the payload disagrees with itself. Always a defect, in the
 *   collector or in the editor, and safe to reject outright.
 * - **Plausibility** — the payload agrees with itself and is still absurd.
 *   Judgement calls, so each ceiling below says where its number comes from and
 *   errs high: a false rejection of a real builder costs more than an
 *   implausible row nobody believes.
 */

export interface IntegrityFailure {
  /** Stable identifier for the rule, for logs and for tests. */
  invariant: string;
  /** One sentence, with the numbers in it, in the API's plain voice. */
  reason: string;
  /** Payload paths a client should look at. */
  fields: string[];
}

/**
 * Sixty-four concurrent agents is the parallelism ceiling below, and a merged
 * pull request costs at least a CI round trip — so about one merge per agent
 * per hour is already an exceptional fleet running flat out. The two limits are
 * derived from each other on purpose: a payload cannot satisfy one by
 * contradicting the other.
 */
export const MAX_MERGES_PER_HOUR = 64;

/**
 * Sixty-four agent processes on one machine is already implausible; this is a
 * ceiling on the claim, not a recommendation.
 */
export const MAX_PEAK_PARALLELISM = 64;

/** Publishing faster than this is not a human workflow. See `publishedTooSoon`. */
export const MIN_PUBLISH_INTERVAL_MS = 30_000;

/**
 * The interval in force, which is the constant above unless the environment
 * overrides it.
 *
 * The override exists for tests that publish twice on purpose — replacing a
 * snapshot, crossing a season rollover — where waiting thirty real seconds
 * would be the only thing the test measured. It is read from the server's own
 * environment, never from the request, so a forger cannot set it: they control
 * their machine and their JSON, and neither is this.
 */
export function minPublishIntervalMs(): number {
  /**
   * An empty value counts as unset. `Number("")` is 0, which would have turned
   * the rate limit off for any deployment that declared the variable and left
   * it blank — the one way this seam could have become a hole in production.
   */
  const raw = process.env.AO_WRAPPED_MIN_PUBLISH_INTERVAL_MS?.trim();
  if (!raw) return MIN_PUBLISH_INTERVAL_MS;

  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : MIN_PUBLISH_INTERVAL_MS;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function countsIn(record: Partial<Record<string, number>>): number[] {
  return Object.values(record).filter((value): value is number => typeof value === "number");
}

/**
 * Inclusive window length in hours. `from` and `to` are both dates the window
 * covers, so a Monday-to-Sunday week is seven days, not six.
 */
export function windowHours(window: { from: string; to: string }): number {
  const from = Date.parse(`${window.from}T00:00:00.000Z`);
  const to = Date.parse(`${window.to}T00:00:00.000Z`);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return 24;
  return (to - from + DAY_MS) / HOUR_MS;
}

/** Every coherence rule, in the order a reader would check them by hand. */
const COHERENCE: Array<(payload: IngestPayload) => IntegrityFailure | null> = [
  (payload) => {
    const agents = sum(payload.agents.map((agent) => agent.merges));
    if (agents === payload.totals.merges) return null;
    return {
      invariant: "agents.merges-sum",
      reason: `sum of per-agent merges (${agents}) does not equal totals.merges (${payload.totals.merges})`,
      fields: ["agents[].merges", "totals.merges"],
    };
  },
  (payload) => {
    const agents = sum(payload.agents.map((agent) => agent.tasks));
    if (agents === payload.totals.tasks) return null;
    return {
      invariant: "agents.tasks-sum",
      reason: `sum of per-agent tasks (${agents}) does not equal totals.tasks (${payload.totals.tasks})`,
      fields: ["agents[].tasks", "totals.tasks"],
    };
  },
  (payload) => {
    const agents = sum(payload.agents.map((agent) => agent.interventions));
    if (agents === payload.totals.interventions) return null;
    return {
      invariant: "agents.interventions-sum",
      reason: `sum of per-agent interventions (${agents}) does not equal totals.interventions (${payload.totals.interventions})`,
      fields: ["agents[].interventions", "totals.interventions"],
    };
  },
  /**
   * One outcome per session. Sessions are the unit both sides count, so this is
   * the rule that catches a totals field edited without its breakdown.
   */
  (payload) => {
    const outcomes = sum(countsIn(payload.outcomes));
    if (outcomes === payload.totals.tasks) return null;
    return {
      invariant: "outcomes-sum",
      reason: `sum of outcomes (${outcomes}) does not equal totals.tasks (${payload.totals.tasks}); every session ends in exactly one outcome`,
      fields: ["outcomes", "totals.tasks"],
    };
  },
  /**
   * A grave is a session that ended without a merge, which is a wider set than
   * `outcomes.died`.
   *
   * The ticket states this bound as `graveyard.length <= outcomes.died`, and
   * that rejects real payloads: `classify()` calls a session `died` only when
   * it never opened a pull request, so one that opened a PR and never merged it
   * is `opened_unmerged` — and still a grave. A real week off this project's
   * own database has four graves against two deaths, so the stricter reading
   * would have 422'd an honest collector.
   *
   * The bound below is the tight one: every non-merge session, since the four
   * merge outcomes are exactly the sessions with `merges > 0`. Inventing graves
   * still fails it, which is what the rule is for.
   */
  (payload) => {
    const unmerged = (payload.outcomes.died ?? 0) + (payload.outcomes.opened_unmerged ?? 0);
    if (payload.graveyard.length <= unmerged) return null;
    return {
      invariant: "graveyard-vs-unmerged",
      reason:
        `graveyard has ${payload.graveyard.length} entries but only ${unmerged} sessions ended ` +
        `without a merge (outcomes.died plus outcomes.opened_unmerged)`,
      fields: ["graveyard", "outcomes.died", "outcomes.opened_unmerged"],
    };
  },
  (payload) => {
    if (payload.totals.harnesses === payload.agents.length) return null;
    return {
      invariant: "harness-count",
      reason: `totals.harnesses (${payload.totals.harnesses}) does not equal the number of agents reported (${payload.agents.length})`,
      fields: ["totals.harnesses", "agents"],
    };
  },
  /**
   * Peak parallelism counts sessions running at once, so it cannot exceed the
   * sessions that ran at all.
   */
  (payload) => {
    if (payload.totals.peakParallelism <= payload.totals.tasks) return null;
    return {
      invariant: "parallelism-vs-tasks",
      reason: `totals.peakParallelism (${payload.totals.peakParallelism}) exceeds totals.tasks (${payload.totals.tasks}); no more agents can run at once than ran at all`,
      fields: ["totals.peakParallelism", "totals.tasks"],
    };
  },
  /**
   * Recoveries are attributed to a session where replay can tell which one, and
   * counted globally either way — so the per-agent figures may add up to less
   * than the total, and can never add up to more.
   */
  (payload) => {
    const agents = sum(payload.agents.map((agent) => agent.recoveries));
    if (agents <= payload.totals.ciRecoveries) return null;
    return {
      invariant: "agents.recoveries-sum",
      reason: `sum of per-agent CI recoveries (${agents}) exceeds totals.ciRecoveries (${payload.totals.ciRecoveries})`,
      fields: ["agents[].recoveries", "totals.ciRecoveries"],
    };
  },
  /** No single agent can have done more of something than everyone together. */
  (payload) => {
    for (const agent of payload.agents) {
      if (agent.died > payload.totals.tasks) {
        return {
          invariant: "agent-exceeds-total",
          reason: `${agent.harness} reports ${agent.died} dead sessions, more than the ${payload.totals.tasks} tasks in the window`,
          fields: ["agents[].died", "totals.tasks"],
        };
      }
      if (agent.merges > payload.totals.merges) {
        return {
          invariant: "agent-exceeds-total",
          reason: `${agent.harness} reports ${agent.merges} merges, more than totals.merges (${payload.totals.merges})`,
          fields: ["agents[].merges", "totals.merges"],
        };
      }
    }
    return null;
  },
];

const PLAUSIBILITY: Array<(payload: IngestPayload) => IntegrityFailure | null> = [
  (payload) => {
    const hours = windowHours(payload.window);
    const ceiling = Math.ceil(hours * MAX_MERGES_PER_HOUR);
    if (payload.totals.merges <= ceiling) return null;
    return {
      invariant: "merge-rate",
      reason:
        `totals.merges (${payload.totals.merges}) exceeds ${ceiling} for a ${Math.round(hours)}-hour window; ` +
        `the ceiling is ${MAX_MERGES_PER_HOUR} merges an hour, which is ${MAX_PEAK_PARALLELISM} agents each landing one an hour`,
      fields: ["totals.merges", "window"],
    };
  },
  (payload) => {
    if (payload.totals.peakParallelism <= MAX_PEAK_PARALLELISM) return null;
    return {
      invariant: "parallelism-ceiling",
      reason: `totals.peakParallelism (${payload.totals.peakParallelism}) exceeds ${MAX_PEAK_PARALLELISM}, which would be ${MAX_PEAK_PARALLELISM} agent processes on one machine`,
      fields: ["totals.peakParallelism"],
    };
  },
];

/**
 * The first invariant this payload breaks, or null when it holds together.
 *
 * First rather than all: a client fixes one thing at a time, and a list of
 * eight failures from one mistyped number reads as noise.
 */
export function checkIntegrity(payload: IngestPayload): IntegrityFailure | null {
  for (const check of [...COHERENCE, ...PLAUSIBILITY]) {
    const failure = check(payload);
    if (failure) return failure;
  }
  return null;
}

/**
 * Seconds to wait, or null when this publish is welcome.
 *
 * The clock is the last stored snapshot's `receivedAt`, so the limit needs no
 * table of its own and holds across serverless instances — the two properties
 * an in-memory counter would have failed. `watch` publishes at most once every
 * thirty seconds by design, so this is the same number stated server-side.
 */
export function publishedTooSoon(previous: Date | null | undefined, now: Date): number | null {
  const interval = minPublishIntervalMs();
  if (!previous || interval === 0) return null;

  const elapsed = now.getTime() - previous.getTime();
  /** A clock that ran backwards is not evidence of anything; let it through. */
  if (elapsed < 0 || elapsed >= interval) return null;

  return Math.max(1, Math.ceil((interval - elapsed) / 1000));
}
