import { describe, expect, it } from "vitest";
import type { AgentStats } from "@ao-wrapped/shared";
import {
  chaosScore,
  getWrappedCard,
  graveyardByCause,
  mostChaoticAgent,
  personalitiesFor,
  topAgentByMerges,
} from "./card-data.ts";

function agent(overrides: Partial<AgentStats> & Pick<AgentStats, "harness">): AgentStats {
  return {
    tasks: 0,
    merges: 0,
    recoveries: 0,
    interventions: 0,
    died: 0,
    turns: 0,
    medianMinutes: 0,
    ...overrides,
  };
}

describe("topAgentByMerges", () => {
  it("breaks ties on tasks, then harness name, so order in is irrelevant", () => {
    const rows = [
      agent({ harness: "codex", merges: 5, tasks: 10 }),
      agent({ harness: "aider", merges: 5, tasks: 10 }),
      agent({ harness: "cursor", merges: 5, tasks: 12 }),
    ];
    expect(topAgentByMerges(rows)?.harness).toBe("cursor");
    expect(topAgentByMerges([...rows].reverse())?.harness).toBe("cursor");
  });

  it("has no winner when nothing merged", () => {
    expect(topAgentByMerges([agent({ harness: "codex", tasks: 4 })])).toBeNull();
  });
});

describe("chaos", () => {
  it("measures hand-holding per task, not raw counts", () => {
    const busy = agent({ harness: "claude-code", tasks: 100, interventions: 10, died: 5 });
    const small = agent({ harness: "cursor", tasks: 6, interventions: 4, died: 1 });
    expect(chaosScore(small)).toBeGreaterThan(chaosScore(busy));
    expect(mostChaoticAgent([busy, small])?.harness).toBe("cursor");
  });

  it("ignores agents that never needed a hand", () => {
    expect(mostChaoticAgent([agent({ harness: "codex", tasks: 9, merges: 9 })])).toBeNull();
  });
});

describe("graveyardByCause", () => {
  it("counts causes and orders them biggest first", () => {
    expect(
      graveyardByCause([
        { harness: "codex", cause: "ci_failed" },
        { harness: "cursor", cause: "merge_conflict" },
        { harness: "cursor", cause: "ci_failed" },
      ]),
    ).toEqual([
      { cause: "ci_failed", count: 2 },
      { cause: "merge_conflict", count: 1 },
    ]);
  });
});

describe("getWrappedCard", () => {
  it("returns the connected fixture with awards attached", async () => {
    const card = await getWrappedCard("dewansh-shukla");
    expect(card.state).toBe("connected");
    if (card.state !== "connected") return;

    expect(card.totals.merges).toBe(61);
    expect(card.graveyard).toHaveLength(card.agents.reduce((sum, row) => sum + row.died, 0));

    const awards = personalitiesFor(card);
    expect(awards.map((award) => award.award)).toContain("Closer");
    expect(awards.find((award) => award.award === "Closer")?.harness).toBe("claude-code");
    expect(awards.find((award) => award.award === "Most chaotic")?.harness).toBe("cursor");
  });

  it("falls back to a seeded card for an unknown handle, stable across calls", async () => {
    const first = await getWrappedCard("some-builder");
    const second = await getWrappedCard("SOME-BUILDER");
    expect(first.state).toBe("seeded");
    expect(second.state).toBe("seeded");
    if (first.state !== "seeded" || second.state !== "seeded") return;
    expect(first.merges).toBe(second.merges);
    expect(first.handle).toBe("some-builder");
  });

  it("matches handles case-insensitively", async () => {
    expect((await getWrappedCard("DEWANSH-SHUKLA")).state).toBe("connected");
  });
});
