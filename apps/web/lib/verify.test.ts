import { afterEach, describe, expect, it } from "vitest";
import { LIMITS, weekWindowFromKey, type WeekWindow } from "@ao-wrapped/shared";
import {
  classify,
  clearVerificationCache,
  publicMergesFor,
  searchQueryFor,
  UNCHECKED,
  verifyRows,
  type GraphQLResponse,
  type GraphQLTransport,
} from "./verify.ts";

/**
 * No token and no network anywhere in here. The transport is injected, so every
 * GitHub answer below — including the failures — is a fixture.
 */

const WEEK: WeekWindow = weekWindowFromKey("2026-W33")!;

/** A transport that answers each handle with a count, or throws for it. */
function transportFor(answers: Record<string, number | Error>): GraphQLTransport {
  return async (_query, variables) => {
    const search = String(variables.query);
    const handle = /author:(\S+)/.exec(search)?.[1] ?? "";
    const answer = answers[handle];
    if (answer === undefined) throw new Error(`no fixture for ${handle}`);
    if (answer instanceof Error) throw answer;
    return { data: { search: { issueCount: answer } } } satisfies GraphQLResponse;
  };
}

/** A clock that only moves when a test moves it. */
function clock(start = 1_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

afterEach(() => {
  clearVerificationCache();
});

describe("classify", () => {
  it("verifies when GitHub can see at least as many merges as were reported", () => {
    expect(classify(7, 9)).toEqual({ state: "verified", publicMerges: 9, gap: null });
    expect(classify(7, 7)).toEqual({ state: "verified", publicMerges: 7, gap: null });
  });

  it("still verifies a gap inside the private-merge allowance", () => {
    // Private repositories are a legitimate reason to be ahead of public, so
    // the allowance is the product saying so rather than an accusation.
    const reported = 10 + LIMITS.privateMergeAllowance;
    expect(classify(reported, 10)).toEqual({ state: "verified", publicMerges: 10, gap: null });
  });

  it("fails verification once the gap exceeds the allowance, and records it", () => {
    const reported = 11 + LIMITS.privateMergeAllowance;
    expect(classify(reported, 10)).toEqual({
      state: "unverified",
      publicMerges: 10,
      gap: 1 + LIMITS.privateMergeAllowance,
    });
  });

  it("treats a zero-merge season as verified rather than suspicious", () => {
    expect(classify(0, 0).state).toBe("verified");
  });
});

describe("searchQueryFor", () => {
  it("asks only for merged pull requests by that author inside the season", () => {
    expect(searchQueryFor("octocat", WEEK)).toBe(
      `is:pr is:merged author:octocat merged:${WEEK.from}..${WEEK.to}`,
    );
  });
});

describe("publicMergesFor", () => {
  it("reads the count GitHub returns", async () => {
    await expect(publicMergesFor("octocat", WEEK, transportFor({ octocat: 4 }))).resolves.toBe(4);
  });

  it("throws on a GraphQL error rather than reading it as zero", async () => {
    const transport: GraphQLTransport = async () => ({ errors: [{ message: "rate limited" }] });
    await expect(publicMergesFor("octocat", WEEK, transport)).rejects.toThrow("rate limited");
  });

  it("throws when the payload carries no count, which is not the same as none", async () => {
    const transport: GraphQLTransport = async () => ({ data: { search: null } });
    await expect(publicMergesFor("octocat", WEEK, transport)).rejects.toThrow("issueCount");
  });
});

describe("verifyRows", () => {
  const rows = [
    { handle: "octocat", merges: 4 },
    { handle: "hubot", merges: 40 },
  ];

  it("marks the three states apart in one pass", async () => {
    const result = await verifyRows(rows, WEEK, {
      transport: transportFor({ octocat: 9, hubot: 1 }),
    });

    expect(result.get("octocat")?.state).toBe("verified");
    expect(result.get("hubot")).toEqual({
      state: "unverified",
      publicMerges: 1,
      gap: 39,
    });
  });

  it("leaves every row unchecked when there is no token", async () => {
    const result = await verifyRows(rows, WEEK, { transport: null });

    expect(result.get("octocat")).toEqual(UNCHECKED);
    expect(result.get("hubot")).toEqual(UNCHECKED);
  });

  it("is unchecked, not unverified, when GitHub fails", async () => {
    // A rate limit says nothing about the builder. Reporting it as a failed
    // verification would put a finding on a row nobody looked at.
    const result = await verifyRows(rows, WEEK, {
      transport: transportFor({ octocat: new Error("403"), hubot: 40 }),
    });

    expect(result.get("octocat")).toEqual(UNCHECKED);
    expect(result.get("hubot")?.state).toBe("verified");
  });

  it("never rejects, whatever the transport does", async () => {
    const transport: GraphQLTransport = async () => {
      throw new Error("network down");
    };
    await expect(verifyRows(rows, WEEK, { transport })).resolves.toBeInstanceOf(Map);
  });

  it("asks GitHub once per handle per season and serves the rest from cache", async () => {
    let calls = 0;
    const counting: GraphQLTransport = async (query, variables) => {
      calls += 1;
      return await transportFor({ octocat: 9, hubot: 40 })(query, variables);
    };

    await verifyRows(rows, WEEK, { transport: counting });
    await verifyRows(rows, WEEK, { transport: counting });

    expect(calls).toBe(2);
  });

  it("asks again once the cached answer is older than its TTL", async () => {
    const time = clock();
    let calls = 0;
    const counting: GraphQLTransport = async (query, variables) => {
      calls += 1;
      return await transportFor({ octocat: 9 })(query, variables);
    };
    const one = [rows[0]!];

    await verifyRows(one, WEEK, { transport: counting, now: time.now });
    time.advance(61 * 60 * 1000);
    await verifyRows(one, WEEK, { transport: counting, now: time.now });

    expect(calls).toBe(2);
  });

  it("does not cache a failure, so an outage cannot blank the board for an hour", async () => {
    const time = clock();
    const answers: Record<string, number | Error> = { octocat: new Error("503") };
    const flaky: GraphQLTransport = async (query, variables) =>
      await transportFor(answers)(query, variables);
    const one = [rows[0]!];

    expect(
      (await verifyRows(one, WEEK, { transport: flaky, now: time.now })).get("octocat"),
    ).toEqual(UNCHECKED);

    answers.octocat = 9;
    const second = await verifyRows(one, WEEK, { transport: flaky, now: time.now });
    expect(second.get("octocat")?.state).toBe("verified");
  });

  it("stops spending the budget and leaves the rest unchecked", async () => {
    const time = clock();
    const slow: GraphQLTransport = async (query, variables) => {
      time.advance(1_500);
      return await transportFor({ octocat: 9, hubot: 40 })(query, variables);
    };

    const result = await verifyRows(rows, WEEK, {
      transport: slow,
      budgetMs: 1_000,
      now: time.now,
    });

    expect(result.get("octocat")?.state).toBe("verified");
    expect(result.get("hubot")).toEqual(UNCHECKED);
  });

  it("keeps seasons apart, so a closed week's answer is not reused for this one", async () => {
    const other = weekWindowFromKey("2026-W32")!;
    let calls = 0;
    const counting: GraphQLTransport = async (query, variables) => {
      calls += 1;
      return await transportFor({ octocat: 9 })(query, variables);
    };
    const one = [rows[0]!];

    await verifyRows(one, WEEK, { transport: counting });
    await verifyRows(one, other, { transport: counting });

    expect(calls).toBe(2);
  });

  it("answers every row it was given, even an empty season", async () => {
    await expect(verifyRows([], WEEK, { transport: transportFor({}) })).resolves.toEqual(new Map());
  });
});
