#!/usr/bin/env node
/**
 * Public GitHub seeder.
 *
 * Given repositories and a date window, counts merged pull requests per author
 * from the GitHub GraphQL API and prints a `GitHubSeed` JSON document on stdout.
 *
 * This is what puts people on the leaderboard without them installing anything,
 * so it only ever reads public data and only ever needs a read-only
 * `GITHUB_TOKEN`. It writes no database — storage is the ingest route's job.
 *
 *   node --experimental-strip-types scripts/seed-github.ts \
 *     --repos Untrivial-ai/agent-orchestrator --from 2026-08-01 --to 2026-08-13
 *
 * The network is injected (`GraphQLTransport`), so the tests replay recorded
 * fixtures and never need a token.
 */
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SIZE_BUCKETS, bucketForLines, type SizeBucket } from "@ao-wrapped/shared";

// ---------------------------------------------------------------------------
// Output shape — ticket 02 consumes this.
// ---------------------------------------------------------------------------

export interface SeedWindow {
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Inclusive `YYYY-MM-DD`; the whole UTC day counts. */
  to: string;
}

/**
 * Per-author totals. `sizeMix` is already bucketed with `bucketForLines`;
 * `additions`/`deletions` are kept so a consumer can re-bucket differently
 * without another pass over the API.
 */
export interface SeedAuthorCounts {
  handle: string;
  merges: number;
  additions: number;
  deletions: number;
  sizeMix: Record<SizeBucket, number>;
  /** Distinct repositories merged into, within the window. */
  repos: number;
  /** Share of this author's merges from their busiest repo. Feeds `LIMITS.maxRepoShare`. */
  topRepoShare: number;
}

export interface SeedRepoSummary {
  nameWithOwner: string;
  merges: number;
  /** How many GraphQL pages this repo cost. Useful when a window looks truncated. */
  pages: number;
}

export type SkipReason = "invalid" | "not_found" | "forbidden";

export interface SeedSkippedRepo {
  repo: string;
  reason: SkipReason;
  message: string;
}

export interface SeedQuota {
  limit: number;
  cost: number;
  remaining: number;
  resetAt: string;
}

export interface GitHubSeed {
  schema: 1;
  source: "github";
  window: SeedWindow;
  /** Repositories that resolved, in the order they were requested. */
  repos: SeedRepoSummary[];
  /** Repositories that 404'd (or were malformed) — reported, never fatal. */
  skipped: SeedSkippedRepo[];
  /** Sorted by merges descending, then handle ascending. Deterministic. */
  authors: SeedAuthorCounts[];
  /** Quota left after the last query, as reported by the API itself. */
  quota: SeedQuota | null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface GraphQLError {
  type?: string;
  message: string;
  path?: (string | number)[];
}

interface PullRequestNode {
  number: number;
  mergedAt: string | null;
  updatedAt: string;
  additions: number;
  deletions: number;
  author: { __typename?: string; login?: string } | null;
}

interface MergedPullRequestsPage {
  repository: {
    nameWithOwner: string;
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: (PullRequestNode | null)[] | null;
    };
  } | null;
  rateLimit: SeedQuota | null;
}

export interface GraphQLResponse {
  data?: MergedPullRequestsPage | null;
  errors?: GraphQLError[];
}

export type GraphQLTransport = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<GraphQLResponse>;

/**
 * Ordered by `UPDATED_AT DESC` rather than filtered by merge date, because
 * `pullRequests` has no server-side date filter. A merged PR's `updatedAt` is
 * never earlier than its `mergedAt`, so once a page drops below the window
 * start every later page is out of the window too — that is the early stop in
 * `collectRepo`, and it is why hundreds-of-PR repos cost a couple of pages.
 */
export const MERGED_PRS_QUERY = `
query MergedPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(states: MERGED, orderBy: {field: UPDATED_AT, direction: DESC}, first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        mergedAt
        updatedAt
        additions
        deletions
        author { __typename login }
      }
    }
  }
  rateLimit { limit cost remaining resetAt }
}`;

const GITHUB_GRAPHQL = "https://api.github.com/graphql";

export interface TransportOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  /** Retries for 403/429/5xx. Each one waits for the reset the response asks for. */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/** Real network transport. Retries throttling and transient 5xx; fails fast on a bad token. */
export function createGitHubTransport(
  token: string,
  options: TransportOptions = {},
): GraphQLTransport {
  const endpoint = options.endpoint ?? GITHUB_GRAPHQL;
  const doFetch = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const log = options.log ?? defaultLog;

  return async (query, variables) => {
    for (let attempt = 0; ; attempt++) {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "ao-wrapped-seeder",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.status === 401) {
        throw new Error(
          "GITHUB_TOKEN was rejected (401). A read-only public-repo token is enough.",
        );
      }

      const throttled = response.status === 403 || response.status === 429;
      if ((throttled || response.status >= 500) && attempt < retries) {
        const waitMs = retryDelayMs(response.headers, attempt);
        log(`http ${response.status}; retrying in ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const body = (await response.text()).slice(0, 200);
        throw new Error(`GitHub API returned ${response.status}: ${body}`);
      }

      return (await response.json()) as GraphQLResponse;
    }
  };
}

function retryDelayMs(headers: Headers, attempt: number): number {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const waitMs = reset * 1000 - Date.now();
    if (waitMs > 0) return Math.min(waitMs, MAX_WAIT_MS);
  }
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

/** A single wait is capped so a wrong clock cannot park the run for an hour. */
const MAX_WAIT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

export interface SeedOptions {
  repos: string[];
  from: string;
  to: string;
  transport: GraphQLTransport;
  /** PRs per page. 100 is the GraphQL maximum. */
  pageSize?: number;
  /** Progress and quota reporting. Defaults to stderr — stdout stays pure JSON. */
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Pause until the quota resets once fewer than this many points are left. */
  minRemaining?: number;
}

interface MergedPr {
  repo: string;
  author: string;
  additions: number;
  deletions: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function seedGitHub(options: SeedOptions): Promise<GitHubSeed> {
  const { repos, from, to, transport } = options;
  const log = options.log ?? defaultLog;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const pageSize = options.pageSize ?? 100;
  const minRemaining = options.minRemaining ?? 10;

  if (!DATE.test(from) || !DATE.test(to)) {
    throw new Error(`--from and --to must be YYYY-MM-DD (got ${from}..${to})`);
  }
  const fromMs = Date.parse(`${from}T00:00:00.000Z`);
  const toMs = Date.parse(`${to}T23:59:59.999Z`);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs))
    throw new Error(`Unparseable window ${from}..${to}`);
  if (fromMs > toMs) throw new Error(`Window ends before it starts: ${from}..${to}`);

  const summaries: SeedRepoSummary[] = [];
  const skipped: SeedSkippedRepo[] = [];
  const merged: MergedPr[] = [];
  let quota: SeedQuota | null = null;

  for (const repo of repos) {
    const parsed = parseRepo(repo);
    if (!parsed) {
      skipped.push({ repo, reason: "invalid", message: "expected owner/name" });
      log(`skipped ${repo}: expected owner/name`);
      continue;
    }

    const result = await collectRepo(parsed, {
      transport,
      pageSize,
      fromMs,
      toMs,
      log,
      sleep,
      minRemaining,
      onQuota: (next) => {
        quota = next;
      },
    });

    if ("skipped" in result) {
      skipped.push(result.skipped);
      log(`skipped ${repo}: ${result.skipped.message}`);
      continue;
    }

    merged.push(...result.prs);
    summaries.push({
      nameWithOwner: result.nameWithOwner,
      merges: result.prs.length,
      pages: result.pages,
    });
    log(
      `${result.nameWithOwner}: ${result.prs.length} merged PRs in window (${result.pages} page(s))`,
    );
  }

  return {
    schema: 1,
    source: "github",
    window: { from, to },
    repos: summaries,
    skipped,
    authors: aggregate(merged),
    quota,
  };
}

export function parseRepo(raw: string): { owner: string; name: string } | null {
  const trimmed = raw
    .trim()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

interface CollectContext {
  transport: GraphQLTransport;
  pageSize: number;
  fromMs: number;
  toMs: number;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  minRemaining: number;
  onQuota: (quota: SeedQuota) => void;
}

type CollectResult =
  { nameWithOwner: string; prs: MergedPr[]; pages: number } | { skipped: SeedSkippedRepo };

async function collectRepo(
  repo: { owner: string; name: string },
  ctx: CollectContext,
): Promise<CollectResult> {
  const slug = `${repo.owner}/${repo.name}`;
  const prs: MergedPr[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let nameWithOwner = slug;

  for (;;) {
    const response = await ctx.transport(MERGED_PRS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      first: ctx.pageSize,
      after: cursor,
    });
    pages++;

    const quota = response.data?.rateLimit ?? null;
    if (quota) {
      ctx.onQuota(quota);
      ctx.log(`quota ${quota.remaining}/${quota.limit} points left, resets ${quota.resetAt}`);
      if (quota.remaining <= ctx.minRemaining) {
        const waitMs = Math.min(Math.max(Date.parse(quota.resetAt) - Date.now(), 0), MAX_WAIT_MS);
        ctx.log(`quota nearly exhausted; waiting ${Math.round(waitMs / 1000)}s for reset`);
        await ctx.sleep(waitMs);
      }
    }

    const fatal = classifyErrors(response.errors, slug);
    if (fatal) return fatal;

    const repository = response.data?.repository;
    if (!repository) {
      return { skipped: { repo: slug, reason: "not_found", message: "repository not found" } };
    }
    nameWithOwner = repository.nameWithOwner || slug;

    let reachedWindowStart = false;
    for (const node of repository.pullRequests.nodes ?? []) {
      if (!node) continue;
      if (Date.parse(node.updatedAt) < ctx.fromMs) {
        // Descending updatedAt, and mergedAt <= updatedAt: nothing later can qualify.
        reachedWindowStart = true;
        break;
      }
      const mergedAtMs = node.mergedAt ? Date.parse(node.mergedAt) : NaN;
      if (Number.isNaN(mergedAtMs) || mergedAtMs < ctx.fromMs || mergedAtMs > ctx.toMs) continue;
      // Deleted accounts have a null author; bots are not people and skew the board.
      const login = node.author?.login;
      if (!login || (node.author?.__typename && node.author.__typename !== "User")) continue;
      prs.push({
        repo: nameWithOwner,
        author: login,
        additions: node.additions,
        deletions: node.deletions,
      });
    }

    const { hasNextPage, endCursor } = repository.pullRequests.pageInfo;
    if (reachedWindowStart || !hasNextPage || !endCursor) break;
    cursor = endCursor;
  }

  return { nameWithOwner, prs, pages };
}

/** NOT_FOUND and access errors skip the repo; anything else is a real bug and aborts. */
function classifyErrors(
  errors: GraphQLError[] | undefined,
  slug: string,
): { skipped: SeedSkippedRepo } | null {
  if (!errors?.length) return null;

  const notFound = errors.find((e) => e.type === "NOT_FOUND");
  if (notFound) return { skipped: { repo: slug, reason: "not_found", message: notFound.message } };

  const forbidden = errors.find((e) => e.type === "FORBIDDEN" || e.type === "SAML_PROTECTED");
  if (forbidden)
    return { skipped: { repo: slug, reason: "forbidden", message: forbidden.message } };

  throw new Error(`GitHub GraphQL error for ${slug}: ${errors.map((e) => e.message).join("; ")}`);
}

export function aggregate(merged: MergedPr[]): SeedAuthorCounts[] {
  const byAuthor = new Map<string, { counts: SeedAuthorCounts; repos: Map<string, number> }>();

  for (const pr of merged) {
    let entry = byAuthor.get(pr.author);
    if (!entry) {
      entry = {
        counts: {
          handle: pr.author,
          merges: 0,
          additions: 0,
          deletions: 0,
          sizeMix: emptySizeMix(),
          repos: 0,
          topRepoShare: 0,
        },
        repos: new Map(),
      };
      byAuthor.set(pr.author, entry);
    }
    entry.counts.merges++;
    entry.counts.additions += pr.additions;
    entry.counts.deletions += pr.deletions;
    entry.counts.sizeMix[bucketForLines(pr.additions + pr.deletions)]++;
    entry.repos.set(pr.repo, (entry.repos.get(pr.repo) ?? 0) + 1);
  }

  const authors: SeedAuthorCounts[] = [];
  for (const { counts, repos } of byAuthor.values()) {
    counts.repos = repos.size;
    counts.topRepoShare = counts.merges === 0 ? 0 : Math.max(...repos.values()) / counts.merges;
    authors.push(counts);
  }

  return authors.sort((a, b) => b.merges - a.merges || a.handle.localeCompare(b.handle));
}

function emptySizeMix(): Record<SizeBucket, number> {
  return Object.fromEntries(SIZE_BUCKETS.map((b) => [b, 0])) as Record<SizeBucket, number>;
}

function defaultLog(line: string): void {
  process.stderr.write(`seed-github: ${line}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `
seed-github — merged-PR counts per author, from public GitHub

  node --experimental-strip-types scripts/seed-github.ts \\
    --repos owner/name[,owner/name...] --from YYYY-MM-DD --to YYYY-MM-DD

Options
  --repos <list>     comma-separated; repeat the flag for more
  --from <date>      window start, inclusive
  --to <date>        window end, inclusive
  --page-size <n>    PRs per GraphQL page (default 100, the API maximum)
  --help

Reads GITHUB_TOKEN (read-only, public data only). JSON goes to stdout; progress
and remaining quota go to stderr. Repositories that 404 are reported and skipped.
`;

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repos: { type: "string", multiple: true },
      from: { type: "string" },
      to: { type: "string" },
      "page-size": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const repos = (values.repos ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (repos.length === 0) throw new Error("--repos is required (owner/name, comma-separated)");
  if (!values.from || !values.to) throw new Error("--from and --to are required (YYYY-MM-DD)");

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not set. GitHub's GraphQL API requires a token even for public data; " +
        "a read-only token with no scopes is enough. Tests run off recorded fixtures instead.",
    );
  }

  const pageSize = values["page-size"] ? Number(values["page-size"]) : 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error(`--page-size must be an integer in 1..100 (got ${values["page-size"]})`);
  }

  const seed = await seedGitHub({
    repos,
    from: values.from,
    to: values.to,
    pageSize,
    transport: createGitHubTransport(token),
  });

  process.stdout.write(JSON.stringify(seed, null, 2) + "\n");

  // Every requested repo failing to resolve is a failed run, not an empty one.
  return seed.repos.length === 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(
        `seed-github: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    });
}
