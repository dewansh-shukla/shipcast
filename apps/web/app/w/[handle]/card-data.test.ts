import { afterEach, describe, expect, it } from "vitest";
import type { AgentStats, IngestPayload } from "@ao-wrapped/shared";
import { InMemoryIngestStore, setIngestStore } from "../../../db/store.ts";
import type { ConnectedCard } from "./card-data.ts";
import {
  awardsWithheldNote,
  chaosScore,
  getWrappedCard,
  graveyardByCause,
  isWithheld,
  mostChaoticAgent,
  mostRecoveries,
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

/** A connected card carrying exactly the agents a test cares about. */
function card(agents: AgentStats[], totals: Partial<ConnectedCard["totals"]> = {}): ConnectedCard {
  return {
    state: "connected",
    handle: "octocat",
    window: { from: "2026-08-10", to: "2026-08-16" },
    totals: {
      tasks: agents.reduce((sum, row) => sum + row.tasks, 0),
      merges: agents.reduce((sum, row) => sum + row.merges, 0),
      ciRecoveries: agents.reduce((sum, row) => sum + row.recoveries, 0),
      interventions: agents.reduce((sum, row) => sum + row.interventions, 0),
      peakParallelism: 2,
      harnesses: agents.length,
      turns: 0,
      repos: 1,
      ...totals,
    },
    agents,
    graveyard: [],
  };
}

function titles(awards: ReturnType<typeof personalitiesFor>): string[] {
  return awards.filter((award) => !isWithheld(award)).map((award) => award.award);
}

describe("an award needs a real contest", () => {
  it("crowns a winner when one harness genuinely beat another", () => {
    const awards = personalitiesFor(
      card([
        agent({ harness: "claude-code", tasks: 6, merges: 4, recoveries: 2, interventions: 1 }),
        agent({ harness: "codex", tasks: 3, merges: 1, died: 1 }),
      ]),
    );

    expect(titles(awards)).toEqual(["Closer", "Most chaotic", "Firefighter"]);
    expect(awards.find((award) => award.award === "Closer")?.harness).toBe("claude-code");
    expect(awards.find((award) => award.award === "Most chaotic")?.harness).toBe("codex");
    /** Only the halves that happened, and no plural for one of anything. */
    expect(awards.find((award) => award.award === "Most chaotic")?.detail).toBe("1 dead session");
    expect(awards.find((award) => award.award === "Firefighter")?.detail).toBe("2 CI recoveries");
    expect(awards.every((award) => !isWithheld(award))).toBe(true);
  });

  /**
   * The bug this ticket exists for: the OG image printed "Most Chaotic:
   * claude-code" on a card whose harness count was 1.
   */
  it("awards nothing at all when there is only one harness", () => {
    const awards = personalitiesFor(
      card([
        agent({
          harness: "claude-code",
          tasks: 11,
          merges: 10,
          recoveries: 3,
          interventions: 13,
          died: 2,
        }),
      ]),
    );

    expect(titles(awards)).toEqual([]);
    expect(awards).toHaveLength(1);
    expect(isWithheld(awards[0]!)).toBe(true);
    expect(awards[0]!.detail).toContain("claude-code is the only harness here");
  });

  it("awards nothing when every candidate ties on the counter the award names", () => {
    const awards = personalitiesFor(
      card([
        agent({ harness: "codex", tasks: 10, merges: 5 }),
        agent({ harness: "aider", tasks: 10, merges: 5 }),
        // More tasks, but the same merges: a tiebreak is an order, not a win.
        agent({ harness: "cursor", tasks: 12, merges: 5 }),
      ]),
    );

    expect(titles(awards)).toEqual([]);
    expect(awards[0]!.detail).toContain("No category had a clear winner");
  });

  it("withholds a category whose counter is zero for everyone", () => {
    const awards = personalitiesFor(
      card([
        agent({ harness: "claude-code", tasks: 6, merges: 4, interventions: 2 }),
        agent({ harness: "codex", tasks: 4, merges: 1 }),
      ]),
    );

    // Nobody recovered a red build, so "Firefighter" names nobody.
    expect(titles(awards)).toEqual(["Closer", "Most chaotic"]);
    expect(awards.find((award) => award.award === "Firefighter")).toBeUndefined();
  });

  it("still crowns the categories that do have a winner", () => {
    const awards = personalitiesFor(
      card([
        agent({ harness: "claude-code", tasks: 6, merges: 3, recoveries: 2 }),
        // Ties on merges, so Closer is withheld; Firefighter is not.
        agent({ harness: "codex", tasks: 6, merges: 3 }),
      ]),
    );

    expect(titles(awards)).toEqual(["Firefighter"]);
  });

  it("says why it withheld, in the terms of this window", () => {
    expect(awardsWithheldNote(card([]))).toContain("No agent ran in this window");
    expect(awardsWithheldNote(card([agent({ harness: "codex", tasks: 3 })]))).toContain(
      "An award is a comparison and codex is the only harness here",
    );
    expect(
      awardsWithheldNote(
        card([agent({ harness: "codex", tasks: 3 }), agent({ harness: "aider", tasks: 3 })]),
      ),
    ).toContain("No category had a clear winner");
  });

  /**
   * The OG image looks awards up by title and renders nothing when the lookup
   * misses, so a withheld category has to be invisible to that lookup rather
   * than present and empty.
   */
  it("keeps withheld rows out of the names the OG image looks up", () => {
    const awards = personalitiesFor(card([agent({ harness: "claude-code", tasks: 9, died: 4 })]));

    expect(awards.find((award) => award.award === "Closer")).toBeUndefined();
    expect(awards.find((award) => award.award === "Most chaotic")).toBeUndefined();
    // It still carries the three fields the page renders, so nothing breaks.
    expect(Object.keys(awards[0]!).sort()).toEqual(["award", "detail", "harness", "withheld"]);
  });

  it("does not depend on the order rows came back in", () => {
    const agents = [
      agent({ harness: "codex", tasks: 3, merges: 1, died: 1 }),
      agent({ harness: "claude-code", tasks: 6, merges: 4, recoveries: 2 }),
      agent({ harness: "aider", tasks: 2, merges: 0 }),
    ];

    expect(personalitiesFor(card(agents))).toEqual(personalitiesFor(card([...agents].reverse())));
  });
});

describe("the winners themselves", () => {
  it("has no Closer when only one harness ran, however many it merged", () => {
    expect(topAgentByMerges([agent({ harness: "claude-code", tasks: 20, merges: 20 })])).toBeNull();
  });

  it("has no Closer when nothing merged", () => {
    expect(
      topAgentByMerges([
        agent({ harness: "codex", tasks: 4 }),
        agent({ harness: "aider", tasks: 4 }),
      ]),
    ).toBeNull();
  });

  it("measures chaos per task, not by raw counts", () => {
    const busy = agent({ harness: "claude-code", tasks: 100, interventions: 10, died: 5 });
    const small = agent({ harness: "cursor", tasks: 6, interventions: 4, died: 1 });

    expect(chaosScore(small)).toBeGreaterThan(chaosScore(busy));
    expect(mostChaoticAgent([busy, small])?.harness).toBe("cursor");
  });

  it("ignores agents that never needed a hand", () => {
    expect(
      mostChaoticAgent([
        agent({ harness: "codex", tasks: 9, merges: 9 }),
        agent({ harness: "aider", tasks: 4, merges: 4 }),
      ]),
    ).toBeNull();
  });

  it("has no Firefighter when the recoveries are level", () => {
    expect(
      mostRecoveries([
        agent({ harness: "codex", tasks: 5, recoveries: 2 }),
        agent({ harness: "aider", tasks: 5, recoveries: 2 }),
      ]),
    ).toBeNull();
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

function payload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: "2026-07-14", to: "2026-08-12" },
    totals: {
      tasks: 9,
      merges: 5,
      ciRecoveries: 2,
      interventions: 1,
      peakParallelism: 3,
      harnesses: 2,
      turns: 120,
      repos: 2,
    },
    outcomes: { clean: 3, ci_recovered: 2, opened_unmerged: 4 },
    sizeMix: { s: 4, m: 5 },
    topRepoShare: 0.6,
    agents: [
      agent({ harness: "codex", tasks: 3, merges: 1, died: 1, turns: 40, medianMinutes: 8 }),
      agent({
        harness: "claude-code",
        tasks: 6,
        merges: 4,
        recoveries: 2,
        interventions: 1,
        turns: 80,
        medianMinutes: 11,
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: 4_000,
      }),
    ],
    graveyard: [{ harness: "codex", cause: "ci_failed" }],
    ...overrides,
  };
}

/** Seed the store the way a real publish would: a builder, then a payload. */
async function publish(handle: string, overrides: Partial<IngestPayload> = {}) {
  const store = new InMemoryIngestStore();
  const builder = store.addBuilder({ handle });
  await store.saveSnapshot(builder.id, payload({ handle, ...overrides }));
  setIngestStore(store);
  return { store, builder };
}

afterEach(() => {
  setIngestStore(null);
});

describe("getWrappedCard", () => {
  it("renders a published payload, counters and all", async () => {
    await publish("octocat");

    const card = await getWrappedCard("octocat");
    expect(card.state).toBe("connected");
    if (card.state !== "connected") return;

    expect(card.totals.merges).toBe(5);
    expect(card.totals.ciRecoveries).toBe(2);
    expect(card.window).toEqual({ from: "2026-07-14", to: "2026-08-12" });
    expect(card.graveyard).toEqual([{ harness: "codex", cause: "ci_failed" }]);

    /** Busiest agent first, whatever order the rows came back in. */
    expect(card.agents.map((row) => row.harness)).toEqual(["claude-code", "codex"]);

    const awards = personalitiesFor(card);
    expect(awards.find((award) => award.award === "Closer")?.harness).toBe("claude-code");
  });

  it("keeps unmetered token counters absent rather than turning them into zero", async () => {
    await publish("octocat");

    const card = await getWrappedCard("octocat");
    if (card.state !== "connected") throw new Error("expected a connected card");

    const metered = card.agents.find((row) => row.harness === "claude-code");
    const unmetered = card.agents.find((row) => row.harness === "codex");
    expect(metered?.inputTokens).toBe(900);
    expect(unmetered?.inputTokens).toBeUndefined();
  });

  it("matches handles case-insensitively and answers in the builder's own casing", async () => {
    await publish("DewanshShukla");

    const card = await getWrappedCard("dewanshshukla");
    expect(card.state).toBe("connected");
    expect(card.handle).toBe("DewanshShukla");
  });

  it("shows the newest window when a builder has published more than one", async () => {
    const { store, builder } = await publish("octocat");

    await store.saveSnapshot(
      builder.id,
      payload({
        window: { from: "2026-06-01", to: "2026-06-30" },
        totals: { ...payload().totals, merges: 99 },
      }),
    );

    const card = await getWrappedCard("octocat");
    if (card.state !== "connected") throw new Error("expected a connected card");
    expect(card.window.to).toBe("2026-08-12");
    expect(card.totals.merges).toBe(5);
  });

  it("renders the not-yet state for an unknown handle instead of 404ing", async () => {
    await publish("octocat");

    const card = await getWrappedCard("some-builder");
    expect(card.state).toBe("not_connected");
    expect(card.handle).toBe("some-builder");
    /** No counters exist for an unpublished handle, so the card carries none. */
    expect(Object.keys(card)).toEqual(["state", "handle", "window"]);
  });

  it("is not connected when the store is empty", async () => {
    setIngestStore(new InMemoryIngestStore());
    expect((await getWrappedCard("octocat")).state).toBe("not_connected");
  });
});
