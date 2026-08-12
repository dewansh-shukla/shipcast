/** How a session's pull request ended. Ordered by autonomy demonstrated. */
export const OUTCOMES = [
  "conflict_resolved",
  "ci_recovered",
  "review_resolved",
  "clean",
  "opened_unmerged",
  "died",
] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** Why a session ended without a merge. Derived from the last `pr` row. */
export const DEATH_CAUSES = ["ci_failed", "merge_conflict", "review_blocked", "no_signal"] as const;
export type DeathCause = (typeof DEATH_CAUSES)[number];

/** Diff-size buckets. Computed from pr.additions + pr.deletions. */
export const SIZE_BUCKETS = ["xs", "s", "m", "l", "xl"] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];

export function bucketForLines(changedLines: number): SizeBucket {
  if (changedLines < 10) return "xs";
  if (changedLines < 50) return "s";
  if (changedLines < 250) return "m";
  if (changedLines < 1000) return "l";
  return "xl";
}
