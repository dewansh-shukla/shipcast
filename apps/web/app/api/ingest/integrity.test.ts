import type { AgentStats, IngestPayload } from "@ao-wrapped/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_MERGES_PER_HOUR,
  MAX_PEAK_PARALLELISM,
  MIN_PUBLISH_INTERVAL_MS,
  checkIntegrity,
  minPublishIntervalMs,
  publishedTooSoon,
  windowHours,
} from "./integrity.ts";

/**
 * TICKET 27 — one test per invariant, each breaking exactly one relationship.
 *
 * The fixture is coherent, so every case below is "this payload, with one
 * number changed". A test that broke two rules at once would pass while the
 * rule it names was missing.
 */

function agent(overrides: Partial<AgentStats> & Pick<AgentStats, "harness">): AgentStats {
  return {
    tasks: 0,
    merges: 0,
    recoveries: 0,
    interventions: 0,
    died: 0,
    turns: 0,
    medianMinutes: 10,
    ...overrides,
  };
}

/** Two harnesses, everything adding up. A real week off a real database. */
function coherent(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: "2026-08-10", to: "2026-08-16" },
    totals: {
      tasks: 12,
      merges: 9,
      ciRecoveries: 3,
      interventions: 2,
      peakParallelism: 4,
      harnesses: 2,
      turns: 187,
      repos: 3,
    },
    outcomes: { clean: 5, ci_recovered: 3, died: 1, opened_unmerged: 3 },
    sizeMix: { xs: 1, s: 3, m: 6, l: 2 },
    topRepoShare: 0.35,
    agents: [
      agent({
        harness: "claude-code",
        tasks: 8,
        merges: 6,
        recoveries: 2,
        interventions: 1,
        died: 1,
      }),
      agent({ harness: "codex", tasks: 4, merges: 3, recoveries: 1, interventions: 1 }),
    ],
    graveyard: [{ harness: "claude-code", cause: "merge_conflict" }],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a coherent payload", () => {
  it("passes", () => {
    expect(checkIntegrity(coherent())).toBeNull();
  });

  it("passes with no agents at all — an empty week is coherent", () => {
    expect(
      checkIntegrity(
        coherent({
          totals: {
            ...coherent().totals,
            tasks: 0,
            merges: 0,
            ciRecoveries: 0,
            interventions: 0,
            peakParallelism: 0,
            harnesses: 0,
          },
          outcomes: {},
          agents: [],
          graveyard: [],
        }),
      ),
    ).toBeNull();
  });

  /**
   * Graves outnumber deaths on real data: a session that opened a pull request
   * and never merged it is `opened_unmerged`, and still a grave.
   */
  it("passes when graves outnumber outcomes.died", () => {
    const payload = coherent({
      outcomes: { clean: 5, ci_recovered: 3, died: 1, opened_unmerged: 3 },
      graveyard: [
        { harness: "claude-code", cause: "merge_conflict" },
        { harness: "claude-code", cause: "ci_failed" },
        { harness: "codex", cause: "no_signal" },
        { harness: "codex", cause: "review_blocked" },
      ],
    });

    expect(checkIntegrity(payload)).toBeNull();
  });
});

describe("coherence", () => {
  it("catches per-agent merges that do not add up", () => {
    const failure = checkIntegrity(coherent({ totals: { ...coherent().totals, merges: 400 } }));

    expect(failure?.invariant).toBe("agents.merges-sum");
    expect(failure?.reason).toBe("sum of per-agent merges (9) does not equal totals.merges (400)");
    expect(failure?.fields).toEqual(["agents[].merges", "totals.merges"]);
  });

  it("catches per-agent tasks that do not add up", () => {
    const payload = coherent();
    payload.agents[0]!.tasks = 7;

    expect(checkIntegrity(payload)?.invariant).toBe("agents.tasks-sum");
  });

  it("catches per-agent interventions that do not add up", () => {
    const payload = coherent();
    payload.agents[1]!.interventions = 9;

    const failure = checkIntegrity(payload);
    expect(failure?.invariant).toBe("agents.interventions-sum");
    expect(failure?.reason).toContain("(10)");
  });

  it("catches outcomes that do not account for every session", () => {
    const failure = checkIntegrity(coherent({ outcomes: { clean: 5, died: 1 } }));

    expect(failure?.invariant).toBe("outcomes-sum");
    expect(failure?.reason).toContain("every session ends in exactly one outcome");
  });

  it("catches a graveyard with more entries than unmerged sessions", () => {
    const failure = checkIntegrity(
      coherent({
        outcomes: { clean: 11, died: 1 },
        totals: { ...coherent().totals, tasks: 12 },
        graveyard: Array.from({ length: 4 }, () => ({
          harness: "claude-code" as const,
          cause: "no_signal" as const,
        })),
      }),
    );

    expect(failure?.invariant).toBe("graveyard-vs-unmerged");
    expect(failure?.reason).toContain("4 entries");
  });

  it("catches a harness count that does not match the roster", () => {
    const failure = checkIntegrity(coherent({ totals: { ...coherent().totals, harnesses: 7 } }));

    expect(failure?.invariant).toBe("harness-count");
    expect(failure?.reason).toContain("(7)");
  });

  it("catches more agents at once than ran at all", () => {
    const payload = coherent();
    payload.totals.tasks = 3;
    payload.agents = [agent({ harness: "claude-code", tasks: 3, merges: 9, interventions: 2 })];
    payload.totals.harnesses = 1;
    payload.outcomes = { clean: 2, died: 1 };
    payload.totals.peakParallelism = 4;

    const failure = checkIntegrity(payload);
    expect(failure?.invariant).toBe("parallelism-vs-tasks");
  });

  it("catches per-agent recoveries adding up to more than the total", () => {
    const payload = coherent();
    payload.agents[0]!.recoveries = 9;

    const failure = checkIntegrity(payload);
    expect(failure?.invariant).toBe("agents.recoveries-sum");
    expect(failure?.reason).toContain("exceeds totals.ciRecoveries (3)");
  });

  /** Attribution is partial, so fewer per-agent recoveries than the total is fine. */
  it("allows per-agent recoveries adding up to less than the total", () => {
    const payload = coherent();
    payload.agents[0]!.recoveries = 0;
    payload.agents[1]!.recoveries = 0;

    expect(checkIntegrity(payload)).toBeNull();
  });

  it("catches one agent claiming more than the whole window", () => {
    const payload = coherent();
    payload.agents[0]!.died = 99;

    const failure = checkIntegrity(payload);
    expect(failure?.invariant).toBe("agent-exceeds-total");
    expect(failure?.reason).toContain("claude-code");
  });
});

describe("plausibility", () => {
  it("counts an inclusive window in hours", () => {
    expect(windowHours({ from: "2026-08-10", to: "2026-08-16" })).toBe(168);
    expect(windowHours({ from: "2026-08-10", to: "2026-08-10" })).toBe(24);
    /** A window that runs backwards is the schema's problem, not this one's. */
    expect(windowHours({ from: "2026-08-16", to: "2026-08-10" })).toBe(24);
  });

  it("rejects more merges than a week could hold, and says where the ceiling comes from", () => {
    const merges = 168 * MAX_MERGES_PER_HOUR + 1;
    const payload = coherent({
      totals: { ...coherent().totals, merges },
      agents: [
        agent({
          harness: "claude-code",
          tasks: 8,
          merges,
          recoveries: 2,
          interventions: 1,
          died: 1,
        }),
        agent({ harness: "codex", tasks: 4, merges: 0, recoveries: 1, interventions: 1 }),
      ],
    });

    const failure = checkIntegrity(payload);
    expect(failure?.invariant).toBe("merge-rate");
    expect(failure?.reason).toContain(`${MAX_MERGES_PER_HOUR} merges an hour`);
    expect(failure?.reason).toContain("168-hour window");
  });

  it("allows a fleet right at the ceiling", () => {
    const merges = 168 * MAX_MERGES_PER_HOUR;
    const payload = coherent({
      totals: { ...coherent().totals, merges },
      agents: [
        agent({
          harness: "claude-code",
          tasks: 8,
          merges,
          recoveries: 2,
          interventions: 1,
          died: 1,
        }),
        agent({ harness: "codex", tasks: 4, merges: 0, recoveries: 1, interventions: 1 }),
      ],
    });

    expect(checkIntegrity(payload)).toBeNull();
  });

  it("rejects more agents at once than fit on a machine", () => {
    const payload = coherent({
      totals: { ...coherent().totals, tasks: 500, peakParallelism: MAX_PEAK_PARALLELISM + 1 },
      outcomes: { clean: 499, died: 1 },
      agents: [
        agent({
          harness: "claude-code",
          tasks: 496,
          merges: 6,
          recoveries: 2,
          interventions: 1,
          died: 1,
        }),
        agent({ harness: "codex", tasks: 4, merges: 3, recoveries: 1, interventions: 1 }),
      ],
    });

    const failure = checkIntegrity(payload);
    expect(failure?.invariant).toBe("parallelism-ceiling");
    expect(failure?.reason).toContain("agent processes on one machine");
  });
});

describe("the publish interval", () => {
  const now = new Date("2026-08-13T09:00:30.000Z");

  it("lets a first publish through", () => {
    expect(publishedTooSoon(null, now)).toBeNull();
    expect(publishedTooSoon(undefined, now)).toBeNull();
  });

  it("lets a publish through once the interval has passed", () => {
    expect(publishedTooSoon(new Date(now.getTime() - MIN_PUBLISH_INTERVAL_MS), now)).toBeNull();
  });

  it("asks a faster one to wait, and says how long", () => {
    expect(publishedTooSoon(new Date(now.getTime() - 10_000), now)).toBe(20);
    expect(publishedTooSoon(new Date(now.getTime() - 29_500), now)).toBe(1);
    expect(publishedTooSoon(now, now)).toBe(30);
  });

  /** Two instances whose clocks disagree is not evidence of forgery. */
  it("lets a publish through when the stored time is in the future", () => {
    expect(publishedTooSoon(new Date(now.getTime() + 60_000), now)).toBeNull();
  });

  it("can be turned off for tests that publish twice on purpose", () => {
    vi.stubEnv("AO_WRAPPED_MIN_PUBLISH_INTERVAL_MS", "0");

    expect(minPublishIntervalMs()).toBe(0);
    expect(publishedTooSoon(now, now)).toBeNull();
  });

  it("ignores an unset or nonsense override", () => {
    vi.stubEnv("AO_WRAPPED_MIN_PUBLISH_INTERVAL_MS", "");
    expect(minPublishIntervalMs()).toBe(MIN_PUBLISH_INTERVAL_MS);

    vi.stubEnv("AO_WRAPPED_MIN_PUBLISH_INTERVAL_MS", "soon");
    expect(minPublishIntervalMs()).toBe(MIN_PUBLISH_INTERVAL_MS);
  });
});
