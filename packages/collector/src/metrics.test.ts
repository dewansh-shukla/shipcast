import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEATH_CAUSES,
  HARNESSES,
  IngestPayloadSchema,
  OBSERVABLE_METRICS,
  OUTCOMES,
  SIZE_BUCKETS,
  type Harness,
  type IngestPayload,
} from "@ao-wrapped/shared";
import { COLLECTOR_VERSION, computeMetrics, type MetricsInput } from "./metrics.ts";
import type { Transition } from "./replay.ts";

/**
 * Transitions are hand-built here rather than replayed from a database. Ticket
 * A2 owns `replay()` and is being written in a parallel session; `Transition`
 * is the frozen contract between the two, so these tests depend on the shape
 * and never on the implementation.
 */

const BASE = Date.UTC(2026, 6, 1, 12, 0, 0);

const WINDOW = { from: new Date(Date.UTC(2026, 6, 1)), to: new Date(Date.UTC(2026, 6, 31)) };

const PROBE: MetricsInput["probe"] = {
  aoVersion: "0.12.3",
  gooseVersion: 85,
  tables: new Map(),
  has: {
    changeLog: true,
    prSizes: false,
    tokenUsage: false,
    conversationTurns: false,
    agentSwitches: false,
    reviewRuns: false,
  },
};

/** Every key IngestPayloadSchema declares. Anything else in the JSON is a leak. */
const PAYLOAD_KEYS = [
  "schema",
  "handle",
  "aoVersion",
  "collectorVersion",
  "window",
  "from",
  "to",
  "totals",
  "tasks",
  "merges",
  "ciRecoveries",
  "interventions",
  "peakParallelism",
  "harnesses",
  "turns",
  "repos",
  "outcomes",
  "sizeMix",
  "topRepoShare",
  "agents",
  "harness",
  "recoveries",
  "died",
  "medianMinutes",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "graveyard",
  "cause",
  "observed",
];

interface Spec {
  kind: Transition["kind"];
  to: string;
  sessionId?: string | null;
  harness?: Harness;
  from?: string | null;
  at?: Date;
}

/** A fresh `seq` counter per test, so ordering is explicit and local. */
function stream(): (spec: Spec) => Transition {
  let seq = 0;
  return (spec) => {
    seq += 1;
    return {
      seq,
      at: spec.at ?? new Date(BASE + seq * 60_000),
      sessionId: spec.sessionId === undefined ? "s1" : spec.sessionId,
      harness: spec.harness ?? "claude-code",
      kind: spec.kind,
      from: spec.from ?? null,
      to: spec.to,
    };
  };
}

/** Adds a per-agent column up, for the invariants the agent rows must hold. */
function sumAgents(
  payload: IngestPayload,
  field: "merges" | "recoveries" | "interventions" | "died" | "tasks",
): number {
  return payload.agents.reduce((total, agent) => total + agent[field], 0);
}

function metrics(transitions: Transition[], overrides: Partial<MetricsInput> = {}) {
  return computeMetrics({
    probe: PROBE,
    transitions,
    handle: "dewansh-shukla",
    window: WINDOW,
    ...overrides,
  });
}

describe("computeMetrics totals", () => {
  it("counts distinct sessions as tasks and distinct harnesses", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "activity", to: "idle", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "activity", to: "active", sessionId: "s2", harness: "codex" }),
      t({ kind: "activity", to: "active", sessionId: "s3", harness: "codex" }),
    ]);

    expect(payload.totals.tasks).toBe(3);
    expect(payload.totals.harnesses).toBe(2);
  });

  it("counts pr_state transitions into merged", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "open", sessionId: "s1" }),
      t({ kind: "pr_state", to: "merged", from: "open", sessionId: "s1" }),
      t({ kind: "pr_state", to: "open", sessionId: "s2" }),
      t({ kind: "pr_state", to: "closed", from: "open", sessionId: "s2" }),
      t({ kind: "pr_state", to: "merged", from: "open", sessionId: "s3" }),
    ]);

    expect(payload.totals.merges).toBe(2);
  });

  it("counts transitions into waiting_input and blocked as interventions", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active" }),
      t({ kind: "activity", to: "waiting_input", from: "active" }),
      t({ kind: "activity", to: "active", from: "waiting_input" }),
      t({ kind: "activity", to: "blocked", from: "active" }),
      t({ kind: "activity", to: "idle", from: "blocked" }),
    ]);

    expect(payload.totals.interventions).toBe(2);
  });

  it("ignores transitions outside the window", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active", sessionId: "s1", at: new Date(Date.UTC(2026, 5, 1)) }),
      t({ kind: "activity", to: "active", sessionId: "s2", at: new Date(Date.UTC(2026, 6, 10)) }),
      t({ kind: "activity", to: "active", sessionId: "s3", at: new Date(Date.UTC(2026, 7, 1)) }),
    ]);

    expect(payload.totals.tasks).toBe(1);
    expect(payload.window).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });
});

describe("peakParallelism", () => {
  it("reaches 2 for two overlapping sessions", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "active", sessionId: "s2" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s2" }),
    ]);

    expect(payload.totals.peakParallelism).toBe(2);
  });

  it("stays at 1 when the same two sessions never overlap", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "active", sessionId: "s2" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s2" }),
    ]);

    expect(payload.totals.peakParallelism).toBe(1);
  });

  it("walks the stream in seq order regardless of input order", () => {
    const t = stream();
    const ordered = [
      t({ kind: "activity", to: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "active", sessionId: "s2" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s2" }),
    ];

    expect(metrics([...ordered].reverse()).totals.peakParallelism).toBe(1);
  });

  it("drops a session from the active set on idle, not just exited", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "idle", from: "active", sessionId: "s1" }),
      t({ kind: "activity", to: "active", sessionId: "s2" }),
    ]);

    expect(payload.totals.peakParallelism).toBe(1);
  });
});

describe("ciRecoveries", () => {
  it("counts one recovery for a failed then passed pair, not two", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "ci_check", to: "failed" }),
      t({ kind: "ci_check", to: "passed", from: "failed" }),
    ]);

    expect(payload.totals.ciRecoveries).toBe(1);
  });

  it("does not count a passed edge that follows no failure", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "ci_check", to: "passed" }),
      t({ kind: "ci_check", to: "passed" }),
    ]);

    expect(payload.totals.ciRecoveries).toBe(0);
  });

  it("counts a second recovery only after a second failure", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "ci_check", to: "failed" }),
      t({ kind: "ci_check", to: "passed", from: "failed" }),
      t({ kind: "ci_check", to: "passed" }),
      t({ kind: "ci_check", to: "failed", from: "passed" }),
      t({ kind: "ci_check", to: "passed", from: "failed" }),
    ]);

    expect(payload.totals.ciRecoveries).toBe(2);
  });

  it("tracks pending failures per session", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "ci_check", to: "failed", sessionId: "s1" }),
      t({ kind: "ci_check", to: "passed", sessionId: "s2" }),
      t({ kind: "ci_check", to: "passed", from: "failed", sessionId: "s1" }),
    ]);

    expect(payload.totals.ciRecoveries).toBe(1);
  });

  it("ignores the pr.ci_state vocabulary, which is passing/failing", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "ci_check", to: "failing" }),
      t({ kind: "ci_check", to: "passing", from: "failing" }),
    ]);

    expect(payload.totals.ciRecoveries).toBe(0);
  });
});

describe("outcomes", () => {
  /** Merge preceded by whatever obstacles `extra` describes. */
  function outcomeOf(extra: Spec[]): string {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "open" }),
      ...extra.map(t),
      t({ kind: "pr_state", to: "merged", from: "open" }),
      t({ kind: "activity", to: "exited" }),
    ]);
    const entries = Object.entries(payload.outcomes).filter(([, count]) => count > 0);
    expect(entries).toHaveLength(1);
    return entries[0]?.[0] ?? "";
  }

  it("classifies a plain merge as clean", () => {
    expect(outcomeOf([])).toBe("clean");
  });

  it("classifies a merge after a resolved review thread as review_resolved", () => {
    expect(
      outcomeOf([
        { kind: "review_thread", to: "added" },
        { kind: "review_thread", to: "resolved", from: "added" },
      ]),
    ).toBe("review_resolved");
  });

  it("classifies a merge after a CI recovery as ci_recovered", () => {
    expect(
      outcomeOf([
        { kind: "ci_check", to: "failed" },
        { kind: "ci_check", to: "passed", from: "failed" },
      ]),
    ).toBe("ci_recovered");
  });

  it("classifies a session with both a conflict and a CI recovery once", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "open" }),
      t({ kind: "ci_check", to: "failed" }),
      t({ kind: "ci_check", to: "passed", from: "failed" }),
      t({ kind: "mergeability", to: "conflicting", from: "clean" }),
      t({ kind: "mergeability", to: "clean", from: "conflicting" }),
      t({ kind: "pr_state", to: "merged", from: "open" }),
      t({ kind: "activity", to: "exited" }),
    ]);

    expect(payload.outcomes.conflict_resolved).toBe(1);
    expect(payload.outcomes.ci_recovered).toBe(0);
    expect(payload.outcomes.clean).toBe(0);
    // The recovery itself is still a real event and still counts as a total.
    expect(payload.totals.ciRecoveries).toBe(1);
  });

  it("classifies an unmerged open PR as opened_unmerged and a PR-less session as died", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "open", sessionId: "s1" }),
      t({ kind: "activity", to: "exited", sessionId: "s1" }),
      t({ kind: "activity", to: "active", sessionId: "s2" }),
      t({ kind: "activity", to: "exited", from: "active", sessionId: "s2" }),
    ]);

    expect(payload.outcomes.opened_unmerged).toBe(1);
    expect(payload.outcomes.died).toBe(1);
  });

  it("gives every session exactly one outcome", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "s1" }),
      t({ kind: "pr_state", to: "open", sessionId: "s2" }),
      t({ kind: "activity", to: "exited", sessionId: "s3" }),
      t({ kind: "activity", to: "active", sessionId: "s4" }),
    ]);

    const total = Object.values(payload.outcomes).reduce((a, b) => a + b, 0);
    expect(total).toBe(payload.totals.tasks);
    expect(total).toBe(4);
  });
});

describe("graveyard", () => {
  /** One session that exits without merging, ending on `last`. */
  function causeAfter(last: Spec[]): string {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active" }),
      ...last.map(t),
      t({ kind: "activity", to: "exited", from: "active" }),
    ]);
    expect(payload.graveyard).toHaveLength(1);
    return payload.graveyard[0]?.cause ?? "";
  }

  it("reads ci_failed off a trailing failed check", () => {
    expect(
      causeAfter([
        { kind: "pr_state", to: "open" },
        { kind: "ci_check", to: "failed" },
      ]),
    ).toBe("ci_failed");
  });

  it("reads merge_conflict off a trailing conflicting mergeability", () => {
    expect(causeAfter([{ kind: "mergeability", to: "conflicting" }])).toBe("merge_conflict");
  });

  it("reads review_blocked off an unresolved review thread", () => {
    expect(causeAfter([{ kind: "review_thread", to: "added" }])).toBe("review_blocked");
  });

  it("falls back to no_signal when the session touched no PR", () => {
    expect(causeAfter([])).toBe("no_signal");
  });

  it("excludes sessions that merged and sessions still running", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "merged-session" }),
      t({ kind: "activity", to: "exited", sessionId: "merged-session" }),
      t({ kind: "activity", to: "active", sessionId: "still-running" }),
      t({ kind: "activity", to: "exited", sessionId: "dead", harness: "codex" }),
    ]);

    expect(payload.graveyard).toEqual([{ harness: "codex", cause: "no_signal" }]);
  });
});

describe("agents", () => {
  it("rolls counters up per harness and reconciles died with outcomes", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "activity", to: "blocked", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "ci_check", to: "failed", sessionId: "s2", harness: "claude-code" }),
      t({
        kind: "ci_check",
        to: "passed",
        from: "failed",
        sessionId: "s2",
        harness: "claude-code",
      }),
      t({ kind: "pr_state", to: "merged", sessionId: "s2", harness: "claude-code" }),
      t({ kind: "activity", to: "exited", sessionId: "s3", harness: "codex" }),
    ]);

    const claude = payload.agents.find((a) => a.harness === "claude-code");
    expect(claude).toMatchObject({
      tasks: 2,
      merges: 2,
      recoveries: 1,
      interventions: 1,
      died: 0,
    });

    expect(payload.agents.find((a) => a.harness === "codex")).toMatchObject({ tasks: 1, died: 1 });
    const died = payload.agents.reduce((total, agent) => total + agent.died, 0);
    expect(died).toBe(payload.outcomes.died);
  });

  it("counts merged pull requests per agent, not sessions that merged something", () => {
    // The defect this test exists for: one session shipping three PRs was
    // reported as one merge in the agent row while the headline counted three,
    // so the card disagreed with itself in public.
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "s1" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s1" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s1" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s2" }),
    ]);

    expect(payload.totals).toMatchObject({ tasks: 2, merges: 4 });
    expect(payload.agents[0]).toMatchObject({ harness: "claude-code", tasks: 2, merges: 4 });
  });

  it("keeps the per-agent merge column summing to totals.merges", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "pr_state", to: "opened", sessionId: "s2", harness: "claude-code" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s3", harness: "codex" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s3", harness: "codex" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s4", harness: "codex" }),
    ]);

    expect(sumAgents(payload, "merges")).toBe(payload.totals.merges);
    expect(payload.agents.find((a) => a.harness === "claude-code")?.merges).toBe(2);
    expect(payload.agents.find((a) => a.harness === "codex")?.merges).toBe(3);
  });

  it("still sums when a merge names no session, rather than dropping it", () => {
    // `change_log` rows can carry no session id at all. Those merges are real
    // and counted in the total, so they have to land in a harness row too.
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "s1", harness: "claude-code" }),
      t({ kind: "pr_state", to: "merged", sessionId: null, harness: "unknown" }),
      t({ kind: "ci_check", to: "failed", sessionId: null, harness: "unknown" }),
      t({ kind: "ci_check", to: "passed", from: "failed", sessionId: null, harness: "unknown" }),
    ]);

    expect(payload.totals.merges).toBe(2);
    expect(sumAgents(payload, "merges")).toBe(2);
    expect(sumAgents(payload, "recoveries")).toBe(payload.totals.ciRecoveries);
    // A harness with an unattributed merge and no session of its own is an
    // honest row, not a hidden one.
    expect(payload.agents.find((a) => a.harness === "unknown")).toMatchObject({
      tasks: 0,
      merges: 1,
      recoveries: 1,
    });
  });

  it("keeps recoveries and interventions summing to their totals too", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "ci_check", to: "failed", sessionId: "s1" }),
      t({ kind: "ci_check", to: "passed", from: "failed", sessionId: "s1" }),
      t({ kind: "activity", to: "blocked", sessionId: "s1" }),
      t({ kind: "ci_check", to: "failed", sessionId: "s2", harness: "codex" }),
      t({ kind: "ci_check", to: "passed", from: "failed", sessionId: "s2", harness: "codex" }),
      t({ kind: "activity", to: "waiting_input", sessionId: "s2", harness: "codex" }),
      t({ kind: "activity", to: "waiting_input", sessionId: "s2", harness: "codex" }),
    ]);

    expect(sumAgents(payload, "recoveries")).toBe(payload.totals.ciRecoveries);
    expect(sumAgents(payload, "interventions")).toBe(payload.totals.interventions);
  });

  it("counts died as sessions, which is what keeps it level with outcomes", () => {
    // Deliberately not events: a session has exactly one outcome, so this
    // column reconciles with the outcome histogram rather than with a total.
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "exited", sessionId: "s1" }),
      t({ kind: "activity", to: "exited", sessionId: "s2", harness: "codex" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s3", harness: "codex" }),
      t({ kind: "pr_state", to: "merged", sessionId: "s3", harness: "codex" }),
    ]);

    expect(sumAgents(payload, "died")).toBe(payload.outcomes.died);
    expect(sumAgents(payload, "tasks")).toBe(payload.totals.tasks);
  });

  it("reports a median session span in minutes", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "activity", to: "active", sessionId: "s1", at: new Date(BASE) }),
      t({ kind: "activity", to: "exited", sessionId: "s1", at: new Date(BASE + 10 * 60_000) }),
    ]);

    expect(payload.agents[0]?.medianMinutes).toBe(10);
  });

  it("omits token counters rather than reporting a confident zero", () => {
    const t = stream();
    const payload = metrics([t({ kind: "activity", to: "active" })]);

    expect(payload.agents[0]).not.toHaveProperty("inputTokens");
    expect(payload.agents[0]).not.toHaveProperty("outputTokens");
    expect(payload.agents[0]).not.toHaveProperty("cacheReadTokens");
  });
});

describe("deferred fields", () => {
  it("zeroes sizeMix and topRepoShare, which need PR diff sizes Transition lacks", () => {
    const t = stream();
    const payload = metrics([t({ kind: "pr_state", to: "merged" })]);

    expect(payload.sizeMix).toEqual({ xs: 0, s: 0, m: 0, l: 0, xl: 0 });
    expect(payload.topRepoShare).toBe(0);
    expect(payload.totals.repos).toBe(0);
    expect(payload.totals.turns).toBe(0);
  });
});

/** A probe whose named tables hold that many rows. Any other table is absent. */
function probeWith(rows: Record<string, number>): MetricsInput["probe"] {
  return {
    ...PROBE,
    tables: new Map(
      Object.entries(rows).map(([name, rowCount]) => [name, { name, columns: [], rowCount }]),
    ),
  };
}

describe("observed", () => {
  const CI_STREAM: Spec[] = [
    { kind: "ci_check", to: "failed" },
    { kind: "ci_check", to: "passed" },
  ];

  it("does not claim a zero for CI recovery when no CI ever ran", () => {
    // The real case: Actions is billing-locked on this account, so pr_checks
    // exists and is empty. 0 recoveries here is an empty table, not an agent.
    const payload = metrics([], {
      probe: probeWith({ sessions: 4, pr: 2, change_log: 900, pr_checks: 0 }),
    });

    expect(payload.observed).not.toContain("ciRecoveries");
    expect(payload.totals.ciRecoveries).toBe(0);
  });

  it("still reports a true zero when CI ran and nothing needed recovering", () => {
    const payload = metrics([], {
      probe: probeWith({ sessions: 4, pr: 2, change_log: 900, pr_checks: 31 }),
    });

    expect(payload.observed).toContain("ciRecoveries");
    expect(payload.totals.ciRecoveries).toBe(0);
  });

  it("counts recoveries and reports them observed when the source has rows", () => {
    const t = stream();
    const payload = metrics(CI_STREAM.map(t), {
      probe: probeWith({ sessions: 1, pr: 1, change_log: 12, pr_checks: 4 }),
    });

    expect(payload.totals.ciRecoveries).toBe(1);
    expect(payload.observed).toContain("ciRecoveries");
  });

  it("treats a present but empty table as no source at all", () => {
    const payload = metrics([], {
      probe: probeWith({ sessions: 0, pr: 0, change_log: 0, pr_checks: 0 }),
    });

    expect(payload.observed).toEqual([]);
  });

  it("observes nothing when the install has no tables", () => {
    expect(metrics([]).observed).toEqual([]);
  });

  it("maps each metric to the table it actually answers to", () => {
    expect(metrics([], { probe: probeWith({ sessions: 3 }) }).observed).toEqual([
      "tasks",
      "harnesses",
    ]);
    expect(metrics([], { probe: probeWith({ pr: 3 }) }).observed).toEqual(["merges"]);
    expect(metrics([], { probe: probeWith({ change_log: 3 }) }).observed).toEqual([
      "interventions",
      "peakParallelism",
    ]);
  });

  it("never claims turns, repos, sizeMix or tokens, which it cannot derive", () => {
    // Their tables are full and the counters are still placeholders: Transition
    // carries none of them, so claiming them observed would be the same lie in
    // the other direction.
    const payload = metrics([], {
      probe: probeWith({
        sessions: 9,
        pr: 9,
        change_log: 9,
        pr_checks: 9,
        conversation_turns: 4_000,
        model_usage_events: 4_000,
      }),
    });

    expect(payload.observed).not.toContain("turns");
    expect(payload.observed).not.toContain("repos");
    expect(payload.observed).not.toContain("sizeMix");
    expect(payload.observed).not.toContain("tokens");
    expect(payload.totals.turns).toBe(0);
  });

  it("emits metrics in a stable order and never repeats one", () => {
    const payload = metrics([], {
      probe: probeWith({ sessions: 1, pr: 1, change_log: 1, pr_checks: 1 }),
    });

    expect(payload.observed).toEqual([
      "tasks",
      "merges",
      "ciRecoveries",
      "interventions",
      "peakParallelism",
      "harnesses",
    ]);
    expect(new Set(payload.observed).size).toBe(payload.observed?.length);
  });

  it("changes no counter — observed is context beside the numbers, not a filter", () => {
    const rows = { sessions: 2, pr: 2, change_log: 40, pr_checks: 6 };
    const build = (probe: MetricsInput["probe"]) => {
      const t = stream();
      return metrics(CI_STREAM.map(t), { probe });
    };

    const withSources = build(probeWith(rows));
    const withoutSources = build(probeWith({}));

    expect(withSources.totals).toEqual(withoutSources.totals);
    expect(withSources.agents).toEqual(withoutSources.agents);
  });

  it("stays schema-valid, including across the JSON trip that publishes it", () => {
    const payload = metrics([], {
      probe: probeWith({ sessions: 1, pr: 1, change_log: 1, pr_checks: 1 }),
    });

    expect(() => IngestPayloadSchema.parse(payload)).not.toThrow();
    expect(IngestPayloadSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it("rejects a repeated metric, so the set stays a set", () => {
    const payload = metrics([], { probe: probeWith({ sessions: 1 }) });

    expect(() => IngestPayloadSchema.parse({ ...payload, observed: ["tasks", "tasks"] })).toThrow();
  });

  it("rejects a metric name outside the closed enum", () => {
    const payload = metrics([], { probe: probeWith({ sessions: 1 }) });

    expect(() => IngestPayloadSchema.parse({ ...payload, observed: ["repoName"] })).toThrow();
  });
});

describe("the payload contract", () => {
  const RICH: Spec[] = [
    { kind: "activity", to: "active", sessionId: "s1" },
    { kind: "activity", to: "active", sessionId: "s2", harness: "codex" },
    { kind: "pr_state", to: "open", sessionId: "s1" },
    { kind: "ci_check", to: "failed", sessionId: "s1" },
    { kind: "activity", to: "waiting_input", sessionId: "s1" },
    { kind: "ci_check", to: "passed", from: "failed", sessionId: "s1" },
    { kind: "mergeability", to: "conflicting", sessionId: "s1" },
    { kind: "mergeability", to: "clean", from: "conflicting", sessionId: "s1" },
    { kind: "pr_state", to: "merged", from: "open", sessionId: "s1" },
    { kind: "activity", to: "exited", sessionId: "s1" },
    { kind: "review_thread", to: "added", sessionId: "s2", harness: "codex" },
    { kind: "activity", to: "exited", sessionId: "s2", harness: "codex" },
  ];

  function richPayload() {
    const t = stream();
    return metrics(RICH.map(t));
  }

  it("satisfies IngestPayloadSchema", () => {
    expect(() => IngestPayloadSchema.parse(richPayload())).not.toThrow();
  });

  it("survives a round trip through JSON, which is how it is published", () => {
    const payload = richPayload();
    expect(IngestPayloadSchema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(payload);
  });

  it("produces a schema-valid payload from an empty stream", () => {
    const payload = metrics([]);
    expect(() => IngestPayloadSchema.parse(payload)).not.toThrow();
    expect(payload.totals).toEqual({
      tasks: 0,
      merges: 0,
      ciRecoveries: 0,
      interventions: 0,
      peakParallelism: 0,
      harnesses: 0,
      turns: 0,
      repos: 0,
    });
    expect(payload.agents).toEqual([]);
    expect(payload.graveyard).toEqual([]);
  });

  it("leaks no session identifier into the payload", () => {
    const t = stream();
    const payload = metrics([
      t({ kind: "pr_state", to: "merged", sessionId: "acme-private-repo/feature-branch" }),
      t({ kind: "activity", to: "exited", sessionId: "acme-private-repo/feature-branch" }),
    ]);

    expect(JSON.stringify(payload)).not.toContain("acme");
    expect(JSON.stringify(payload)).not.toContain("feature-branch");
  });

  it("emits only numbers, dates and closed enums", () => {
    const payload = richPayload();
    const strings = JSON.stringify(payload).match(/"[^"]*"/g) ?? [];
    // Values are drawn from the shared enums rather than listed by hand, so a
    // new enum member never has to be mirrored here — but a free-text string
    // reaching the payload still fails.
    const allowed = new Set(
      [
        ...OUTCOMES,
        ...SIZE_BUCKETS,
        ...DEATH_CAUSES,
        ...HARNESSES,
        ...OBSERVABLE_METRICS,
        ...PAYLOAD_KEYS,
        "dewansh-shukla",
        "0.12.3",
        COLLECTOR_VERSION,
        "2026-07-01",
        "2026-07-31",
      ].map((value) => `"${value}"`),
    );

    expect(strings.filter((value) => !allowed.has(value))).toEqual([]);
  });

  it("carries the probe's AO version through", () => {
    expect(richPayload().aoVersion).toBe("0.12.3");
  });

  it("keeps COLLECTOR_VERSION in step with the package manifest", () => {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
    const version: unknown = JSON.parse(readFileSync(manifest, "utf8")).version;
    expect(COLLECTOR_VERSION).toBe(version);
  });

  it("rejects an unusable window rather than emitting an invalid date", () => {
    expect(() => metrics([], { window: { from: new Date("nonsense"), to: WINDOW.to } })).toThrow(
      /window\.from/,
    );
  });
});
