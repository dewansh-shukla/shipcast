import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  aggregate,
  createGitHubTransport,
  parseRepo,
  seedGitHub,
  type GraphQLResponse,
  type GraphQLTransport,
} from "./seed-github.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/github/", import.meta.url));

function fixture(name: string): GraphQLResponse {
  return JSON.parse(readFileSync(`${FIXTURES}${name}.json`, "utf8")) as GraphQLResponse;
}

const WINDOW = { from: "2026-08-01", to: "2026-08-13" };

/**
 * Replays recorded responses keyed by repo plus the cursor the request carried,
 * so pagination is exercised the way the real API drives it. No token, no network.
 */
function fixtureTransport(pages: Record<string, string>): GraphQLTransport & { calls: string[] } {
  const calls: string[] = [];
  const transport = async (_query: string, variables: Record<string, unknown>) => {
    const key = `${variables.owner as string}/${variables.name as string}@${(variables.after as string | null) ?? "start"}`;
    calls.push(key);
    const name = pages[key];
    if (!name) throw new Error(`no fixture recorded for ${key}`);
    return fixture(name);
  };
  return Object.assign(transport, { calls });
}

const silent = () => {};

describe("seedGitHub", () => {
  it("pages until the window closes and aggregates per author", async () => {
    const transport = fixtureTransport({
      "Untrivial-ai/agent-orchestrator@start": "agent-orchestrator-page1",
      "Untrivial-ai/agent-orchestrator@Y3Vyc29yOjI=": "agent-orchestrator-page2",
    });

    const seed = await seedGitHub({
      repos: ["Untrivial-ai/agent-orchestrator"],
      ...WINDOW,
      transport,
      log: silent,
    });

    // Page two's cursor came from page one, and page three is never requested:
    // PR #97 updated before the window start ends the walk.
    expect(transport.calls).toEqual([
      "Untrivial-ai/agent-orchestrator@start",
      "Untrivial-ai/agent-orchestrator@Y3Vyc29yOjI=",
    ]);
    expect(seed.repos).toEqual([
      { nameWithOwner: "Untrivial-ai/agent-orchestrator", merges: 3, pages: 2 },
    ]);

    // #98 is a Bot and #97 is outside the window; both are excluded.
    expect(seed.authors.map((a) => [a.handle, a.merges])).toEqual([
      ["octocat", 2],
      ["dewansh-shukla", 1],
    ]);
    const octocat = seed.authors[0]!;
    expect(octocat.additions).toBe(124);
    expect(octocat.deletions).toBe(31);
    expect(octocat.sizeMix).toEqual({ xs: 1, s: 0, m: 1, l: 0, xl: 0 });
    expect(seed.authors[1]!.sizeMix.l).toBe(1);
  });

  it("skips a repo that 404s and still counts the rest", async () => {
    const transport = fixtureTransport({
      "Untrivial-ai/definitely-not-a-repo@start": "not-found",
      "Untrivial-ai/ao-docs@start": "ao-docs-page1",
    });
    const lines: string[] = [];

    const seed = await seedGitHub({
      repos: ["Untrivial-ai/definitely-not-a-repo", "Untrivial-ai/ao-docs"],
      ...WINDOW,
      transport,
      log: (line) => lines.push(line),
    });

    expect(seed.skipped).toEqual([
      {
        repo: "Untrivial-ai/definitely-not-a-repo",
        reason: "not_found",
        message:
          "Could not resolve to a Repository with the name 'Untrivial-ai/definitely-not-a-repo'.",
      },
    ]);
    expect(lines.some((l) => l.includes("skipped Untrivial-ai/definitely-not-a-repo"))).toBe(true);
    // The run continued: the second repo was still queried and counted.
    expect(seed.repos).toEqual([{ nameWithOwner: "Untrivial-ai/ao-docs", merges: 1, pages: 1 }]);
    expect(seed.authors).toHaveLength(1);
    expect(seed.authors[0]!.handle).toBe("octocat");
  });

  it("rejects a malformed repo without a network call", async () => {
    const transport = fixtureTransport({});
    const seed = await seedGitHub({ repos: ["not-a-slug"], ...WINDOW, transport, log: silent });

    expect(transport.calls).toEqual([]);
    expect(seed.skipped).toEqual([
      { repo: "not-a-slug", reason: "invalid", message: "expected owner/name" },
    ]);
  });

  it("counts one author across repos and reports their concentration", async () => {
    const transport = fixtureTransport({
      "Untrivial-ai/agent-orchestrator@start": "agent-orchestrator-page1",
      "Untrivial-ai/agent-orchestrator@Y3Vyc29yOjI=": "agent-orchestrator-page2",
      "Untrivial-ai/ao-docs@start": "ao-docs-page1",
    });

    const seed = await seedGitHub({
      repos: ["Untrivial-ai/agent-orchestrator", "Untrivial-ai/ao-docs"],
      ...WINDOW,
      transport,
      log: silent,
    });

    const octocat = seed.authors.find((a) => a.handle === "octocat")!;
    expect(octocat.merges).toBe(3);
    expect(octocat.repos).toBe(2);
    expect(octocat.topRepoShare).toBeCloseTo(2 / 3);
  });

  it("reports remaining quota and waits when it runs low", async () => {
    const lines: string[] = [];
    const waits: number[] = [];
    const resetAt = new Date(Date.now() + 30_000).toISOString();
    const transport: GraphQLTransport = async () => ({
      data: {
        repository: {
          nameWithOwner: "Untrivial-ai/agent-orchestrator",
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
        rateLimit: { limit: 5000, cost: 1, remaining: 3, resetAt },
      },
    });

    const seed = await seedGitHub({
      repos: ["Untrivial-ai/agent-orchestrator"],
      ...WINDOW,
      transport,
      log: (line) => lines.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(seed.quota?.remaining).toBe(3);
    expect(lines.some((l) => l.includes("quota 3/5000 points left"))).toBe(true);
    expect(waits).toHaveLength(1);
    expect(waits[0]!).toBeGreaterThan(0);
  });

  it("does not wait while quota is healthy", async () => {
    const waits: number[] = [];
    const transport = fixtureTransport({ "Untrivial-ai/ao-docs@start": "ao-docs-page1" });

    await seedGitHub({
      repos: ["Untrivial-ai/ao-docs"],
      ...WINDOW,
      transport,
      log: silent,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([]);
  });

  it("rejects a window it cannot honour", async () => {
    const transport = fixtureTransport({});
    await expect(
      seedGitHub({ repos: [], from: "08-01-2026", to: "2026-08-13", transport, log: silent }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      seedGitHub({ repos: [], from: "2026-08-13", to: "2026-08-01", transport, log: silent }),
    ).rejects.toThrow(/ends before it starts/);
  });

  it("surfaces an unexpected GraphQL error instead of silently dropping the repo", async () => {
    const transport: GraphQLTransport = async () => ({
      errors: [{ type: "INTERNAL", message: "something went wrong" }],
    });
    await expect(
      seedGitHub({ repos: ["Untrivial-ai/ao-docs"], ...WINDOW, transport, log: silent }),
    ).rejects.toThrow(/something went wrong/);
  });
});

describe("parseRepo", () => {
  it("accepts slugs and full URLs, rejects everything else", () => {
    expect(parseRepo("Untrivial-ai/agent-orchestrator")).toEqual({
      owner: "Untrivial-ai",
      name: "agent-orchestrator",
    });
    expect(parseRepo("https://github.com/Untrivial-ai/agent-orchestrator.git")).toEqual({
      owner: "Untrivial-ai",
      name: "agent-orchestrator",
    });
    expect(parseRepo("agent-orchestrator")).toBeNull();
    expect(parseRepo("a/b/c")).toBeNull();
  });
});

describe("aggregate", () => {
  it("buckets diff size with bucketForLines", () => {
    const [author] = aggregate([
      { repo: "o/r", author: "octocat", additions: 5, deletions: 2 },
      { repo: "o/r", author: "octocat", additions: 900, deletions: 200 },
    ]);
    expect(author!.sizeMix).toEqual({ xs: 1, s: 0, m: 0, l: 0, xl: 1 });
  });
});

describe("createGitHubTransport", () => {
  it("retries a secondary rate limit and honours retry-after", async () => {
    const waits: number[] = [];
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      if (call === 1) {
        return new Response("slow down", { status: 403, headers: { "retry-after": "7" } });
      }
      return new Response(JSON.stringify({ data: null }), { status: 200 });
    }) as unknown as typeof fetch;

    const transport = createGitHubTransport("token", {
      fetchImpl,
      log: silent,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    await expect(transport("query", {})).resolves.toEqual({ data: null });
    expect(waits).toEqual([7000]);
  });

  it("fails fast on a rejected token", async () => {
    const fetchImpl = (async () =>
      new Response("bad credentials", { status: 401 })) as unknown as typeof fetch;
    const transport = createGitHubTransport("nope", { fetchImpl, log: silent });
    await expect(transport("query", {})).rejects.toThrow(/401/);
  });
});
