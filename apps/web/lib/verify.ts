import { LIMITS, type WeekWindow } from "@ao-wrapped/shared";

/**
 * TICKET 28 — verification against public GitHub.
 *
 * Compares a builder's self-reported merges for a season against merged pull
 * requests publicly visible for that handle in the same window.
 *
 * This is an upper-bound check and never proof. Private repositories are a
 * legitimate reason for reported to exceed public, so a gap is not an
 * accusation — `LIMITS.privateMergeAllowance` is the slack that says so out
 * loud. And GitHub cannot tell an agent's pull request from a person's, which
 * is exactly why this can corroborate scale and can never rank anybody.
 *
 * Three states, and the third is the important one: `unchecked` means nobody
 * looked, which is not a finding. With no `GITHUB_TOKEN` every row is unchecked
 * and the board renders exactly as it did before this file existed.
 *
 * The network is injected as a `GraphQLTransport`, the same shape
 * `scripts/seed-github.ts` uses, so the tests below run without a token and
 * without a network.
 */

export type VerificationState = "verified" | "unverified" | "unchecked";

export interface Verification {
  state: VerificationState;
  /** Merged pull requests GitHub could see. Null when nobody looked. */
  publicMerges: number | null;
  /**
   * How far self-reported ran ahead of public, when that is the finding.
   * Null for `verified` and `unchecked` — there is no gap worth naming.
   */
  gap: number | null;
}

export const UNCHECKED: Verification = { state: "unchecked", publicMerges: null, gap: null };

/**
 * The rule, as a pure function, because it is the part worth being sure about.
 *
 * - public at or above reported → verified, nothing to explain
 * - reported ahead by more than the private-merge allowance → unverified, and
 *   the gap is recorded so the number can be shown rather than implied
 * - reported ahead but inside the allowance → verified; a handful of private
 *   merges is the ordinary case, not a discrepancy
 */
export function classify(reported: number, publicMerges: number): Verification {
  const gap = reported - publicMerges;
  if (gap > LIMITS.privateMergeAllowance) {
    return { state: "unverified", publicMerges, gap };
  }
  return { state: "verified", publicMerges, gap: null };
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export interface GraphQLResponse {
  data?: { search?: { issueCount?: number } | null } | null;
  errors?: { message: string }[];
}

export type GraphQLTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphQLResponse>;

/**
 * `search` returns a count without returning the pull requests, so one handle
 * costs one point out of 5000 an hour and no pagination at all. `first: 1` is
 * the smallest page the API accepts; the node itself is never read.
 */
export const VERIFY_QUERY = `
query VerifyHandle($query: String!) {
  search(query: $query, type: ISSUE, first: 1) {
    issueCount
  }
}`;

/** `is:pr is:merged author:octocat merged:2026-08-10..2026-08-16`. */
export function searchQueryFor(handle: string, week: WeekWindow): string {
  return `is:pr is:merged author:${handle} merged:${week.from}..${week.to}`;
}

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

/**
 * A read-only public-data transport. Deliberately no retry loop: this runs
 * while a page is rendering, so a slow or throttled GitHub has to become
 * `unchecked` quickly rather than hold the board open.
 */
export function createTransport(token: string, fetchImpl: typeof fetch = fetch): GraphQLTransport {
  return async (query, variables) => {
    const response = await fetchImpl(GITHUB_GRAPHQL, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "ao-wrapped-verifier",
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`);
    return (await response.json()) as GraphQLResponse;
  };
}

/** Merged pull requests GitHub can see for this handle in this week. */
export async function publicMergesFor(
  handle: string,
  week: WeekWindow,
  transport: GraphQLTransport,
): Promise<number> {
  const result = await transport(VERIFY_QUERY, { query: searchQueryFor(handle, week) });

  if (result.errors && result.errors.length > 0) {
    throw new Error(result.errors.map((error) => error.message).join("; "));
  }

  const count = result.data?.search?.issueCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    throw new Error("GitHub returned no issueCount");
  }
  return count;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Per handle and season, because that pair is what a verdict is about: a closed
 * season's answer can never change, and the live one only moves as fast as
 * someone merges.
 *
 * The rate limit is 5000 points an hour and one handle costs 1, so the ceiling
 * is far away — but a board that re-verified on every page load would still
 * reach it, and this is also what keeps a render from waiting on the network
 * more than once per handle per hour.
 */
export const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  verification: Verification;
  storedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(handle: string, weekKey: string): string {
  return `${handle.toLowerCase()} ${weekKey}`;
}

export function cachedVerification(
  handle: string,
  weekKey: string,
  now = Date.now(),
): Verification | null {
  const entry = cache.get(cacheKey(handle, weekKey));
  if (entry === undefined) return null;
  if (now - entry.storedAt > CACHE_TTL_MS) {
    cache.delete(cacheKey(handle, weekKey));
    return null;
  }
  return entry.verification;
}

export function rememberVerification(
  handle: string,
  weekKey: string,
  verification: Verification,
  now = Date.now(),
): void {
  cache.set(cacheKey(handle, weekKey), { verification, storedAt: now });
}

/** Test seam. Nothing in the app calls this. */
export function clearVerificationCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

export interface VerifyBudget {
  /**
   * Wall-clock budget for the whole batch. Handles not answered inside it stay
   * unchecked, which is the honest word for "nobody looked in time".
   */
  budgetMs?: number;
  now?: () => number;
}

export interface VerifyRowsOptions extends VerifyBudget {
  /**
   * Required, and explicitly nullable. Defaulting this to "no network" made it
   * possible to call the whole thing with a token configured and get a page of
   * unchecked rows with nothing to explain why — so the caller has to say.
   */
  transport: GraphQLTransport | null;
}

export interface VerifyOptions extends VerifyBudget {
  /** Omitted means "read `GITHUB_TOKEN`"; explicit null means no network. */
  transport?: GraphQLTransport | null;
}

const DEFAULT_BUDGET_MS = 2_000;

export interface VerifiableRow {
  handle: string;
  merges: number;
}

/**
 * Verify a season's rows, cache first.
 *
 * Never throws and never rejects: every failure mode — no token, a GitHub
 * error, a handle that ran past the budget — resolves to `unchecked` for that
 * row. A verification problem must not be able to take the board down with it.
 *
 * Sequential on purpose. A season is a handful of rows at this stage, each
 * costing one rate-limit point, and going one at a time means the budget can
 * actually stop the work rather than merely stop waiting for it.
 */
export async function verifyRows(
  rows: readonly VerifiableRow[],
  week: WeekWindow,
  options: VerifyRowsOptions,
): Promise<Map<string, Verification>> {
  const now = options.now ?? Date.now;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const { transport } = options;
  const deadline = now() + budgetMs;

  const results = new Map<string, Verification>();

  for (const row of rows) {
    const cached = cachedVerification(row.handle, week.key, now());
    if (cached) {
      results.set(row.handle, cached);
      continue;
    }

    if (transport === null || now() >= deadline) {
      results.set(row.handle, UNCHECKED);
      continue;
    }

    try {
      const publicMerges = await publicMergesFor(row.handle, week, transport);
      const verification = classify(row.merges, publicMerges);
      rememberVerification(row.handle, week.key, verification, now());
      results.set(row.handle, verification);
    } catch {
      /**
       * Not cached. A rate limit or an outage is temporary, and remembering
       * `unchecked` for an hour would turn a blip into a blank board.
       */
      results.set(row.handle, UNCHECKED);
    }
  }

  return results;
}

/**
 * The transport the board uses, or null when the deployment has no token.
 *
 * Optional by design: without `GITHUB_TOKEN` the board renders exactly as it
 * does today, every row unchecked, and nothing about the page announces that
 * something is missing.
 */
export function transportFromEnv(): GraphQLTransport | null {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token ? createTransport(token) : null;
}
