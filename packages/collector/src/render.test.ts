import { afterEach, describe, expect, it } from "vitest";
import {
  IngestPayloadSchema,
  OUTCOMES,
  SIZE_BUCKETS,
  type AgentStats,
  type IngestPayload,
} from "@ao-wrapped/shared";
import { awardsFor, renderCard, renderPersonalities } from "./render.ts";

/**
 * Every fixture here is parsed through IngestPayloadSchema before it is
 * rendered. The card is only allowed to assume what the schema guarantees, so a
 * fixture the server would reject is not a valid thing to test against.
 */

const ESCAPE = String.fromCodePoint(27);
const ANSI = new RegExp(`${ESCAPE}\\[[0-9;]*m`, "g");

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function payload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return IngestPayloadSchema.parse({
    schema: 1,
    handle: "dewansh-shukla",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: "2026-07-13", to: "2026-08-12" },
    totals: {
      tasks: 0,
      merges: 0,
      ciRecoveries: 0,
      interventions: 0,
      peakParallelism: 0,
      harnesses: 0,
      turns: 0,
      repos: 0,
    },
    outcomes: zeroed(OUTCOMES),
    sizeMix: zeroed(SIZE_BUCKETS),
    topRepoShare: 0,
    agents: [],
    graveyard: [],
    ...overrides,
  });
}

function agent(overrides: Partial<AgentStats> & { harness: AgentStats["harness"] }): AgentStats {
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

/** Nothing ran. The card a user gets on a fresh AO install. */
const EMPTY = payload();

/**
 * Our own first real card, copied from `npm run collector` against
 * ~/.ao/data/ao.db: one harness, no CI recoveries, no turns, and an empty
 * graveyard even though four sessions died. All four are zero states the card
 * has to survive, which is why this fixture is the real numbers and not a
 * prettier invention.
 */
const OURS = payload({
  handle: "dewansh-shukla",
  aoVersion: "goose-85",
  totals: {
    tasks: 10,
    merges: 6,
    ciRecoveries: 0,
    interventions: 12,
    peakParallelism: 5,
    harnesses: 1,
    turns: 0,
    repos: 0,
  },
  outcomes: { ...zeroed(OUTCOMES), clean: 6, died: 4 },
  agents: [
    agent({
      harness: "claude-code",
      tasks: 10,
      merges: 6,
      interventions: 12,
      died: 4,
      medianMinutes: 296.5296166666667,
    }),
  ],
});

/** Four harnesses, real spread, every award category live. */
const BUSY = payload({
  handle: "octocat",
  totals: {
    tasks: 128,
    merges: 61,
    ciRecoveries: 19,
    interventions: 23,
    peakParallelism: 7,
    harnesses: 4,
    turns: 1840,
    repos: 6,
  },
  outcomes: {
    ...zeroed(OUTCOMES),
    conflict_resolved: 8,
    ci_recovered: 14,
    review_resolved: 9,
    clean: 30,
    opened_unmerged: 41,
    died: 26,
  },
  agents: [
    agent({
      harness: "claude-code",
      tasks: 58,
      merges: 31,
      recoveries: 11,
      interventions: 6,
      died: 7,
      turns: 902,
      medianMinutes: 12.5,
    }),
    agent({
      harness: "codex",
      tasks: 34,
      merges: 16,
      recoveries: 5,
      interventions: 4,
      died: 6,
      turns: 511,
      medianMinutes: 9.2,
    }),
    agent({
      harness: "cursor",
      tasks: 22,
      merges: 9,
      recoveries: 2,
      interventions: 9,
      died: 8,
      turns: 288,
      medianMinutes: 18.4,
    }),
    agent({
      harness: "copilot",
      tasks: 14,
      merges: 5,
      recoveries: 1,
      interventions: 4,
      died: 5,
      turns: 139,
      medianMinutes: 6.7,
    }),
  ],
  graveyard: [
    { harness: "claude-code", cause: "ci_failed" },
    { harness: "claude-code", cause: "ci_failed" },
    { harness: "claude-code", cause: "merge_conflict" },
    { harness: "codex", cause: "review_blocked" },
    { harness: "cursor", cause: "merge_conflict" },
    { harness: "cursor", cause: "no_signal" },
  ],
});

const plain = (payload: IngestPayload) => renderCard(payload, { color: false });

/** The harness names in the crew table, in the order the card printed them. */
function crewRows(card: string): string[] {
  const lines = card.split("\n");
  const header = lines.findIndex((line) => line.includes("harness"));
  const rows: string[] = [];
  for (const line of lines.slice(header + 1)) {
    const cells = line.replace(/[│]/g, "").trim().split(/\s+/);
    if (cells.length < 6) break;
    rows.push(cells[0]!);
  }
  return rows;
}

/** Award title → holder, for the categories a fixture actually earned. */
function winners(card: IngestPayload): Record<string, string> {
  const held: Record<string, string> = {};
  for (const award of awardsFor(card)) {
    if ("harness" in award) held[award.title] = award.harness;
  }
  return held;
}

afterEach(() => {
  delete process.env.NO_COLOR;
});

describe("renderCard layout", () => {
  it("boxes every line to exactly the requested width", () => {
    for (const fixture of [EMPTY, OURS, BUSY]) {
      for (const line of plain(fixture).split("\n")) {
        expect(line).toHaveLength(60);
      }
      for (const line of renderCard(fixture, { color: false, width: 72 }).split("\n")) {
        expect(line).toHaveLength(72);
      }
    }
  });

  it("keeps the box intact when colour is on, because padding ignores escapes", () => {
    for (const line of renderCard(BUSY, { color: true }).split("\n")) {
      expect(line.replace(ANSI, "")).toHaveLength(60);
    }
  });

  it("prints all four sections", () => {
    const card = plain(OURS);
    expect(card).toContain("AO WRAPPED");
    expect(card).toContain("THE CREW");
    expect(card).toContain("AWARDS");
    expect(card).toContain("GRAVEYARD");
  });

  it("never leaks a NaN, an Infinity or an undefined into the output", () => {
    for (const fixture of [EMPTY, OURS, BUSY]) {
      expect(plain(fixture)).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it("is stable: same payload in, byte-identical card out", () => {
    expect(plain(BUSY)).toBe(plain(BUSY));
  });

  it("does not depend on the order agents arrive in", () => {
    const reversed = payload({ ...BUSY, agents: [...BUSY.agents].reverse() });
    expect(plain(reversed)).toBe(plain(BUSY));
  });
});

describe("colour", () => {
  it("emits escapes when asked", () => {
    expect(renderCard(OURS, { color: true })).toMatch(ANSI);
  });

  it("emits none when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(renderCard(OURS)).not.toMatch(ANSI);
  });

  it("emits none when stdout is not a TTY, which is how CI and pipes see it", () => {
    // vitest runs with stdout piped, so the default path is the non-TTY one.
    expect(process.stdout.isTTY).not.toBe(true);
    expect(renderCard(OURS)).not.toMatch(ANSI);
  });
});

describe("totals", () => {
  it("reports the merge rate against tasks", () => {
    expect(plain(OURS)).toContain("6 merges");
    expect(plain(OURS)).toContain("out of 10 tasks handed to agents (60% closed)");
  });

  it("says so plainly when nothing ran, rather than dividing by zero", () => {
    const card = plain(EMPTY);
    expect(card).toContain("0 merges");
    expect(card).toContain("No tasks ran in this window.");
  });

  it("prints a real zero rather than hiding it", () => {
    expect(plain(OURS)).toMatch(/CI recoveries\s+0/);
  });

  it("omits turns and repos until something measures them", () => {
    // Both are hard-coded to 0 upstream today. A printed "0 turns" would claim
    // a measurement nobody took.
    expect(plain(OURS)).not.toContain("Turns");
    expect(plain(OURS)).not.toContain("Repos");
    expect(plain(BUSY)).toMatch(/Turns\s+1,840/);
    expect(plain(BUSY)).toMatch(/Repos\s+6/);
  });
});

describe("the crew", () => {
  it("lists each harness with its counters", () => {
    expect(plain(OURS)).toMatch(/claude-code\s+10\s+6\s+0\s+4\s+4h 57m/);
  });

  it("orders by tasks, busiest first", () => {
    expect(crewRows(plain(BUSY))).toEqual(["claude-code", "codex", "cursor", "copilot"]);
  });

  it("says nothing ran rather than printing an empty table", () => {
    expect(plain(EMPTY)).toContain("No sessions ran in this window.");
  });
});

describe("awards", () => {
  it("awards nothing when one harness is the only candidate", () => {
    expect(winners(OURS)).toEqual({});
    const section = renderPersonalities(OURS, { color: false });
    expect(section).toContain("Most Productive");
    expect(section).toContain("not enough data yet");
    expect(section).toContain("claude-code is the only");
  });

  it("still prints every category, so the card shows what it does not know", () => {
    const section = renderPersonalities(OURS, { color: false });
    for (const title of [
      "Most Productive",
      "Most Reliable",
      "Most Chaotic",
      "Firefighter",
      "Workhorse",
      "Speed Demon",
      "Drama Queen",
    ]) {
      expect(section).toContain(title);
    }
  });

  it("awards nothing at all on an empty payload", () => {
    expect(winners(EMPTY)).toEqual({});
    expect(renderPersonalities(EMPTY, { color: false })).toContain("No agent ran in this window");
  });

  it("crowns the right harness in each category once there is a contest", () => {
    expect(winners(BUSY)).toEqual({
      "Most Productive": "claude-code",
      "Most Reliable": "claude-code",
      "Most Chaotic": "cursor",
      Firefighter: "claude-code",
      Workhorse: "claude-code",
      "Speed Demon": "copilot",
      "Drama Queen": "cursor",
    });
  });

  it("shows the arithmetic behind an award", () => {
    const section = renderPersonalities(BUSY, { color: false });
    expect(section).toContain("31 of 61 merges");
    expect(section).toContain("11 red builds saved");
    expect(section).toContain("36% of its sessions died");
  });

  it("withholds a category when the leaders tie", () => {
    const tied = payload({
      totals: { ...BUSY.totals, tasks: 20, merges: 10, harnesses: 2 },
      agents: [
        agent({ harness: "claude-code", tasks: 10, merges: 5, medianMinutes: 5 }),
        agent({ harness: "codex", tasks: 10, merges: 5, medianMinutes: 5 }),
      ],
    });
    expect(winners(tied)["Most Productive"]).toBeUndefined();
    expect(renderPersonalities(tied, { color: false })).toContain("clear winner");
  });

  it("withholds a category whose winning score is zero", () => {
    // Two harnesses, so there is a contest — but neither ever recovered a
    // build, and "most CI recoveries" over zero recoveries names nobody.
    const noCi = payload({
      totals: { ...BUSY.totals, tasks: 12, merges: 5, ciRecoveries: 0, harnesses: 2 },
      agents: [
        agent({ harness: "claude-code", tasks: 8, merges: 4, medianMinutes: 11 }),
        agent({ harness: "codex", tasks: 4, merges: 1, medianMinutes: 20 }),
      ],
    });
    expect(winners(noCi).Firefighter).toBeUndefined();
    expect(winners(noCi)["Most Productive"]).toBe("claude-code");
  });

  it("ignores rate awards for harnesses under three tasks", () => {
    // codex has a perfect record over two tasks; claude-code has a worse rate
    // over a sample that means something. Reliability goes to the sample.
    const thin = payload({
      totals: { ...BUSY.totals, tasks: 12, merges: 7, harnesses: 2 },
      agents: [
        agent({ harness: "claude-code", tasks: 10, merges: 5, medianMinutes: 30 }),
        agent({ harness: "codex", tasks: 2, merges: 2, medianMinutes: 1 }),
      ],
    });
    // Only one harness clears the three-task floor, so there is no contest and
    // neither rate award is handed out.
    expect(winners(thin)["Most Reliable"]).toBeUndefined();
    expect(winners(thin)["Speed Demon"]).toBeUndefined();
    expect(winners(thin)["Most Productive"]).toBe("claude-code");
  });
});

describe("graveyard", () => {
  it("counts the sessions that ended without a merge and groups them by cause", () => {
    const card = plain(BUSY);
    expect(card).toContain("67 sessions ended without a merge");
    expect(card).toContain("2 CI never went green");
    expect(card).toContain("2 conflict it could not resolve");
    expect(card).toContain("1 review it could not answer");
  });

  it("admits when deaths have no recorded cause instead of inventing one", () => {
    // Our own payload: four dead sessions, zero graveyard rows.
    const card = plain(OURS);
    expect(card).toContain("4 sessions ended without a merge");
    expect(card).toContain("No cause was recorded for any of them.");
  });

  it("says how many deaths it has a cause for, rather than implying it has them all", () => {
    // 67 sessions ended without a merge; only 6 carry a recorded cause.
    expect(plain(BUSY)).toContain("A cause was recorded for 6:");
  });

  it("reads as a fact, not a failure, when nothing died", () => {
    const clean = payload({
      totals: { ...OURS.totals, tasks: 3, merges: 3 },
      outcomes: { ...zeroed(OUTCOMES), clean: 3 },
      agents: [agent({ harness: "claude-code", tasks: 3, merges: 3, medianMinutes: 4 })],
    });
    expect(plain(clean)).toContain("Empty. Every session that started ended in a merge.");
  });

  it("does not claim a clean sweep when nothing ran at all", () => {
    expect(plain(EMPTY)).toContain("Empty. Nothing ran in this window to bury.");
  });
});

describe("privacy copy", () => {
  it("names the local read and the opt-in publish, and never a remote source", () => {
    const card = plain(OURS);
    expect(card).toContain("read-only pass over");
    expect(card).toContain("ao-wrapped --publish");
    // The collector is the only way data reaches the board — the card must not
    // imply anything was pulled from GitHub or any other service.
    expect(card).not.toMatch(/GitHub|github/);
  });
});

describe("snapshots", () => {
  it("renders the all-zeros card", () => {
    expect(plain(EMPTY)).toMatchSnapshot();
  });

  it("renders our own first real card", () => {
    expect(plain(OURS)).toMatchSnapshot();
  });

  it("renders a populated multi-harness card", () => {
    expect(plain(BUSY)).toMatchSnapshot();
  });
});
