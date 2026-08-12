import type { Outcome, SizeBucket } from "./outcomes.ts";

/**
 * The Orchestrator Score.
 *
 *   session_pts = max(0, base(outcome) - INTERVENTION_PENALTY * interventions)
 *                 * sizeFactor(bucket)
 *   score       = sum(session_pts) * parallelismFactor * diversityFactor * decay
 *
 * Every weight is priced by how much autonomy the outcome proves, not by how
 * much work it looks like. These numbers are the product's argument — change
 * them only with a reason you can say in one sentence.
 *
 * Authoritative scoring runs server-side. The collector may compute this for a
 * local preview, but the value it prints is never trusted by the API.
 */
export const OUTCOME_POINTS: Record<Outcome, number> = {
  conflict_resolved: 20, // hardest autonomous loop; most agents die here
  ci_recovered: 18, // the exact loop AO exists to close
  review_resolved: 16, // agent read human feedback and acted on it
  clean: 10, // the baseline unit
  opened_unmerged: 3, // work happened and is inspectable
  died: 0, // no penalty: punishing failure punishes experimentation
};

/** Charged against the session it happened in, never globally. */
export const INTERVENTION_PENALTY = 4;

export const SIZE_FACTOR: Record<SizeBucket, number> = {
  xs: 0.25, // kills the fifty-typo-PR strategy
  s: 0.6,
  m: 1.0,
  l: 1.0,
  xl: 0.85, // mild discount: giant diffs are usually generated, not reasoned
};

export const PARALLELISM_STEP = 0.06;
export const PARALLELISM_CAP = 1.5;
export const DIVERSITY_STEP = 0.05;
export const DIVERSITY_CAP = 1.25;

/** Half-life in days. Set to null to disable decay (hackathon window). */
export const DECAY_HALF_LIFE_DAYS: number | null = null;

/** Anti-gaming limits. Enforced server-side before scoring. */
export const LIMITS = {
  /** Max share of a builder's score allowed to come from one repository. */
  maxRepoShare: 0.4,
  /** A PR opened and merged faster than this is scored as `xs`. */
  rubberStampSeconds: 60,
  /** A session needs at least this many agent turns to count at all. */
  minTurnsPerSession: 2,
  /** Self-reported merges may exceed GitHub-visible merges by this many. */
  privateMergeAllowance: 5,
} as const;

export function parallelismFactor(peakConcurrent: number): number {
  const raw = 1 + PARALLELISM_STEP * Math.max(0, peakConcurrent - 1);
  return Math.min(raw, PARALLELISM_CAP);
}

export function diversityFactor(distinctHarnesses: number): number {
  const raw = 1 + DIVERSITY_STEP * Math.max(0, distinctHarnesses - 1);
  return Math.min(raw, DIVERSITY_CAP);
}

export function decayFactor(ageDays: number): number {
  if (DECAY_HALF_LIFE_DAYS === null) return 1;
  return Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
}
