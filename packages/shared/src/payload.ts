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
  })
  .strict();

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type AgentStats = z.infer<typeof AgentStatsSchema>;
export type GraveyardEntry = z.infer<typeof GraveyardEntrySchema>;
