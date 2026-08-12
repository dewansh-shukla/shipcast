import { z } from "zod";
import { HARNESSES } from "./harness.ts";
import { DEATH_CAUSES, OUTCOMES, SIZE_BUCKETS } from "./outcomes.ts";

/**
 * The complete shape accepted by POST /api/ingest.
 *
 * This schema IS the privacy guarantee. Everything here is a number, a date, or
 * a value from a closed enum. There is no field that can carry a repo name, a
 * branch name, a PR title, a file path, a prompt, or a diff — and `.strict()`
 * means an unknown key is a 400, not a silently-stored surprise.
 *
 * Before adding a field, ask: could a user's private information survive a trip
 * through it? If the answer is anything but a flat no, it does not go in.
 */

const count = z.number().int().min(0).max(100_000);

/**
 * Metrics a collector can report on, as a closed vocabulary.
 *
 * A counter alone cannot say whether it measured nothing or measured no data.
 * `CI recoveries 0` reads the same whether agents recovered from nothing or no
 * CI ever ran — opposite facts sharing a glyph. `observed` below carries the
 * difference, and this list keeps it a whitelist: metric names only, never a
 * free string that could smuggle a repo or a path past the schema.
 */
export const OBSERVABLE_METRICS = [
  "tasks",
  "merges",
  "ciRecoveries",
  "interventions",
  "peakParallelism",
  "harnesses",
  "turns",
  "repos",
  "sizeMix",
  "tokens",
] as const;

export const AgentStatsSchema = z
  .object({
    harness: z.enum(HARNESSES),
    tasks: count,
    merges: count,
    recoveries: count,
    interventions: count,
    died: count,
    turns: count,
    medianMinutes: z.number().min(0).max(10_000),
    /** Present only for token-metered harnesses; omitted elsewhere. */
    inputTokens: count.optional(),
    outputTokens: count.optional(),
    cacheReadTokens: count.optional(),
  })
  .strict();

export const GraveyardEntrySchema = z
  .object({
    harness: z.enum(HARNESSES),
    cause: z.enum(DEATH_CAUSES),
  })
  .strict();

export const IngestPayloadSchema = z
  .object({
    schema: z.literal(1),
    handle: z
      .string()
      .min(1)
      .max(39)
      .regex(/^[a-zA-Z0-9-]+$/, "GitHub handles only"),
    aoVersion: z.string().max(20),
    collectorVersion: z.string().max(20),
    window: z
      .object({
        from: z.string().date(),
        to: z.string().date(),
      })
      .strict(),
    totals: z
      .object({
        tasks: count,
        merges: count,
        ciRecoveries: count,
        interventions: count,
        peakParallelism: count,
        harnesses: count,
        turns: count,
        repos: count,
      })
      .strict(),
    outcomes: z.record(z.enum(OUTCOMES), count),
    sizeMix: z.record(z.enum(SIZE_BUCKETS), count),
    /** Share of merges from the single busiest repo. Feeds the concentration cap. */
    topRepoShare: z.number().min(0).max(1),
    agents: z.array(AgentStatsSchema).max(30),
    graveyard: z.array(GraveyardEntrySchema).max(100),

    /**
     * The metrics this install actually had a data source for. A counter whose
     * metric is missing here is *unmeasured*, not zero, and a reader is
     * entitled to be told which one it is looking at.
     *
     * Optional on purpose. `schema` is pinned at 1 and collectors ship by
     * `npx`, so a required field would 400 every already-installed collector.
     * Absent means "this collector did not report observability" and the
     * counters are read at face value, exactly as before; an empty array is a
     * different and much stronger claim — nothing here was measurable.
     */
    observed: z
      .array(z.enum(OBSERVABLE_METRICS))
      .max(OBSERVABLE_METRICS.length)
      .refine((metrics) => new Set(metrics).size === metrics.length, {
        message: "observed must not repeat a metric",
      })
      .optional(),
  })
  .strict();

export type ObservableMetric = (typeof OBSERVABLE_METRICS)[number];
export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type AgentStats = z.infer<typeof AgentStatsSchema>;
export type GraveyardEntry = z.infer<typeof GraveyardEntrySchema>;
