/** Shareable titles beat raw ranks. Bands by percentile of the connected pool. */
export const TIERS = [
  { name: "Conductor", minPercentile: 0.95 },
  { name: "Orchestrator", minPercentile: 0.75 },
  { name: "Operator", minPercentile: 0.4 },
  { name: "Soloist", minPercentile: 0 },
] as const;

export type Tier = (typeof TIERS)[number]["name"];

/**
 * `percentile` is the fraction of the connected pool this builder outranks.
 * A single-harness, no-parallelism run is a Soloist regardless of score — the
 * title names the upgrade path rather than the output.
 */
export function tierFor(percentile: number, harnesses: number, peakParallel: number): Tier {
  if (harnesses <= 1 && peakParallel <= 1) return "Soloist";
  return (TIERS.find((t) => percentile >= t.minPercentile) ?? TIERS[TIERS.length - 1]!).name;
}
