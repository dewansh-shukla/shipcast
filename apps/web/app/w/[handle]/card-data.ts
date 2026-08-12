import type { AgentStats, DeathCause, GraveyardEntry, Harness } from "@ao-wrapped/shared";

/**
 * TICKET C2 — the data the Wrapped card reads.
 *
 * `getWrappedCard` is the only door between the card and storage. It returns
 * fixtures today; B1 owns `apps/web/db` and lands the real query behind this
 * same signature, so nothing in the page or the PNG route changes when it does.
 *
 * Everything else here is a pure derivation over counters — awards included.
 * Deterministic, so the page and the image can never disagree.
 */

export interface CardWindow {
  from: string;
  to: string;
}

export interface CardTotals {
  tasks: number;
  merges: number;
  ciRecoveries: number;
  interventions: number;
  peakParallelism: number;
  harnesses: number;
  turns: number;
  repos: number;
}

/** An award, its holder, and the arithmetic that earned it. */
export interface Personality {
  award: string;
  harness: Harness;
  detail: string;
}

export interface ConnectedCard {
  state: "connected";
  handle: string;
  window: CardWindow;
  totals: CardTotals;
  agents: AgentStats[];
  graveyard: GraveyardEntry[];
}

/**
 * A builder who appears on the board from public GitHub data alone. Merges are
 * the one number GitHub can prove, so merges are the one number shown.
 */
export interface SeededCard {
  state: "seeded";
  handle: string;
  window: CardWindow;
  merges: number;
}

export type WrappedCard = ConnectedCard | SeededCard;

export const HACKATHON_WINDOW: CardWindow = { from: "2026-07-14", to: "2026-08-12" };

/** Card palette. Shared by the page and the PNG so the unfurl matches the link. */
export const PALETTE = {
  ink: "#0E1116",
  slate: "#161B23",
  edge: "#242D3A",
  bone: "#E8E6E1",
  ash: "#7E8794",
  phosphor: "#FFB454",
  signal: "#5FD4C4",
  ember: "#E0685A",
} as const;

const DEATH_CAUSE_LABELS: Record<DeathCause, string> = {
  ci_failed: "CI never went green",
  merge_conflict: "Conflict it could not resolve",
  review_blocked: "Review it could not answer",
  no_signal: "Stopped without a signal",
};

export function deathCauseLabel(cause: DeathCause): string {
  return DEATH_CAUSE_LABELS[cause];
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatWindow(window: CardWindow): string {
  const format = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${format(window.from)} — ${format(window.to)}`;
}

/**
 * Most merges wins. Ties break on tasks, then harness name, so the award never
 * depends on the order rows came back in.
 */
export function topAgentByMerges(agents: readonly AgentStats[]): AgentStats | null {
  const ranked = [...agents].sort(
    (a, b) => b.merges - a.merges || b.tasks - a.tasks || a.harness.localeCompare(b.harness),
  );
  const best = ranked[0];
  return best && best.merges > 0 ? best : null;
}

/** Interventions and deaths per task. How much hand-holding an agent cost. */
export function chaosScore(agent: AgentStats): number {
  if (agent.tasks === 0) return 0;
  return (agent.interventions + agent.died) / agent.tasks;
}

export function mostChaoticAgent(agents: readonly AgentStats[]): AgentStats | null {
  const ranked = [...agents]
    .filter((agent) => agent.tasks > 0 && agent.interventions + agent.died > 0)
    .sort(
      (a, b) =>
        chaosScore(b) - chaosScore(a) || b.tasks - a.tasks || a.harness.localeCompare(b.harness),
    );
  return ranked[0] ?? null;
}

export function mostRecoveries(agents: readonly AgentStats[]): AgentStats | null {
  const ranked = [...agents]
    .filter((agent) => agent.recoveries > 0)
    .sort((a, b) => b.recoveries - a.recoveries || a.harness.localeCompare(b.harness));
  return ranked[0] ?? null;
}

/** Awards, in the order they read best on the card. Never longer than three. */
export function personalitiesFor(card: ConnectedCard): Personality[] {
  const awards: Personality[] = [];
  const closer = topAgentByMerges(card.agents);
  const chaotic = mostChaoticAgent(card.agents);
  const firefighter = mostRecoveries(card.agents);

  if (closer) {
    awards.push({
      award: "Closer",
      harness: closer.harness,
      detail: `${formatCount(closer.merges)} of ${formatCount(card.totals.merges)} merges`,
    });
  }
  if (chaotic) {
    awards.push({
      award: "Most chaotic",
      harness: chaotic.harness,
      detail: `${formatCount(chaotic.interventions)} interventions, ${formatCount(chaotic.died)} dead sessions`,
    });
  }
  if (firefighter && firefighter.harness !== closer?.harness) {
    awards.push({
      award: "Firefighter",
      harness: firefighter.harness,
      detail: `${formatCount(firefighter.recoveries)} CI recoveries`,
    });
  }
  return awards.slice(0, 3);
}

export interface GraveyardGroup {
  cause: DeathCause;
  count: number;
}

/** Deaths grouped by cause, biggest first. Ties break on cause name. */
export function graveyardByCause(entries: readonly GraveyardEntry[]): GraveyardGroup[] {
  const counts = new Map<DeathCause, number>();
  for (const entry of entries) {
    counts.set(entry.cause, (counts.get(entry.cause) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

function expandGraveyard(rows: ReadonlyArray<[Harness, DeathCause, number]>): GraveyardEntry[] {
  return rows.flatMap(([harness, cause, count]) =>
    Array.from({ length: count }, () => ({ harness, cause })),
  );
}

const CONNECTED_FIXTURE: ConnectedCard = {
  state: "connected",
  handle: "dewansh-shukla",
  window: HACKATHON_WINDOW,
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
  agents: [
    {
      harness: "claude-code",
      tasks: 58,
      merges: 31,
      recoveries: 11,
      interventions: 6,
      died: 7,
      turns: 902,
      medianMinutes: 12.5,
      inputTokens: 4_812_000,
      outputTokens: 391_400,
      cacheReadTokens: 21_640_000,
    },
    {
      harness: "codex",
      tasks: 34,
      merges: 16,
      recoveries: 5,
      interventions: 4,
      died: 6,
      turns: 511,
      medianMinutes: 9.2,
      inputTokens: 2_104_000,
      outputTokens: 188_900,
      cacheReadTokens: 6_320_000,
    },
    {
      harness: "cursor",
      tasks: 22,
      merges: 9,
      recoveries: 2,
      interventions: 9,
      died: 8,
      turns: 288,
      medianMinutes: 18.4,
    },
    {
      harness: "copilot",
      tasks: 14,
      merges: 5,
      recoveries: 1,
      interventions: 4,
      died: 5,
      turns: 139,
      medianMinutes: 6.7,
    },
  ],
  graveyard: expandGraveyard([
    ["claude-code", "ci_failed", 3],
    ["claude-code", "merge_conflict", 2],
    ["claude-code", "no_signal", 2],
    ["codex", "ci_failed", 2],
    ["codex", "review_blocked", 2],
    ["codex", "merge_conflict", 2],
    ["cursor", "merge_conflict", 4],
    ["cursor", "ci_failed", 3],
    ["cursor", "no_signal", 1],
    ["copilot", "ci_failed", 2],
    ["copilot", "review_blocked", 2],
    ["copilot", "no_signal", 1],
  ]),
};

const SEEDED_FIXTURE: SeededCard = {
  state: "seeded",
  handle: "octocat",
  window: HACKATHON_WINDOW,
  merges: 34,
};

const FIXTURES: WrappedCard[] = [CONNECTED_FIXTURE, SEEDED_FIXTURE];

/** Stable per handle, so a demo URL shows the same card every time. */
function seededMergeCount(handle: string): number {
  let hash = 7;
  for (const char of handle) {
    hash = (hash * 31 + char.codePointAt(0)!) % 100_003;
  }
  return 4 + (hash % 45);
}

/**
 * The single read path for the card.
 *
 * Unknown handles fall back to a seeded card rather than a 404: the board is
 * seeded from public GitHub, so a builder who never installed anything still
 * has a page to land on — and that page is the pitch for connecting.
 */
export async function getWrappedCard(handle: string): Promise<WrappedCard> {
  const match = FIXTURES.find((card) => card.handle.toLowerCase() === handle.toLowerCase());
  if (match) return match;

  return {
    state: "seeded",
    handle,
    window: HACKATHON_WINDOW,
    merges: seededMergeCount(handle.toLowerCase()),
  };
}
