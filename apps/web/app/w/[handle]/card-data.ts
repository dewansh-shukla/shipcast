import type { AgentStats, DeathCause, GraveyardEntry, Harness } from "@ao-wrapped/shared";
import type { AgentStatsRow } from "../../../db/schema.ts";
import { getIngestStore, type PublishedSnapshot } from "../../../db/store.ts";

/**
 * TICKET 12 — the data the Wrapped card reads.
 *
 * `getWrappedCard` is the only door between the card and storage, and the store
 * is the only source. A handle appears here because its owner ran the collector
 * and published; nothing is inferred, seeded or estimated from anywhere else.
 *
 * Everything below the read is a pure derivation over counters — awards
 * included. Deterministic, so the page and the image can never disagree.
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
 * A handle with no published snapshot. Deliberately not a 404 and deliberately
 * carrying no counters: the collector is the only way onto the board, so the
 * most useful — and only honest — thing this page can do is name the handle and
 * show the command that fills it in.
 */
export interface UnconnectedCard {
  state: "not_connected";
  handle: string;
  window: CardWindow;
}

export type WrappedCard = ConnectedCard | UnconnectedCard;

export const HACKATHON_WINDOW: CardWindow = { from: "2026-07-14", to: "2026-08-12" };

/** The one command that puts a handle on the board. Page and PNG share it. */
export const CONNECT_COMMAND = "npx ao-wrapped --publish";

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

/** Roster order, so the card never depends on the order rows came back in. */
function byBusiest(a: AgentStats, b: AgentStats): number {
  return b.tasks - a.tasks || b.merges - a.merges || a.harness.localeCompare(b.harness);
}

/**
 * A stored row back to the payload shape. The token columns are nullable
 * because AO meters only some harnesses; absent stays absent rather than
 * becoming a zero, which would read as "spent nothing".
 */
function toAgentStats(row: AgentStatsRow): AgentStats {
  const stats: AgentStats = {
    harness: row.harness,
    tasks: row.tasks,
    merges: row.merges,
    recoveries: row.recoveries,
    interventions: row.interventions,
    died: row.died,
    turns: row.turns,
    medianMinutes: row.medianMinutes,
  };
  if (row.inputTokens !== null) stats.inputTokens = row.inputTokens;
  if (row.outputTokens !== null) stats.outputTokens = row.outputTokens;
  if (row.cacheReadTokens !== null) stats.cacheReadTokens = row.cacheReadTokens;
  return stats;
}

/**
 * The stored snapshot as the card sees it. The window comes from the payload,
 * not from `HACKATHON_WINDOW`: the card must state the window it measured.
 */
export function toConnectedCard({ builder, snapshot, agents }: PublishedSnapshot): ConnectedCard {
  return {
    state: "connected",
    /** The builder's own casing, not whatever casing the URL used. */
    handle: builder.handle,
    window: { from: snapshot.windowFrom, to: snapshot.windowTo },
    totals: {
      tasks: snapshot.tasks,
      merges: snapshot.merges,
      ciRecoveries: snapshot.ciRecoveries,
      interventions: snapshot.interventions,
      peakParallelism: snapshot.peakParallelism,
      harnesses: snapshot.harnesses,
      turns: snapshot.turns,
      repos: snapshot.repos,
    },
    agents: agents.map(toAgentStats).sort(byBusiest),
    graveyard: snapshot.graveyard.map((entry) => ({ ...entry })),
  };
}

/**
 * The single read path for the card.
 *
 * An unknown handle is not an error and never a 404 — it is the page a builder
 * lands on before they have connected anything, which makes it the best
 * argument the product gets to make. It shows no counters, because there are
 * none: GitHub cannot tell an agent's pull request from a person's, so there is
 * nothing to fall back to.
 */
export async function getWrappedCard(handle: string): Promise<WrappedCard> {
  const published = await getIngestStore().latestSnapshotForHandle(handle);
  if (published) return toConnectedCard(published);

  return { state: "not_connected", handle, window: HACKATHON_WINDOW };
}
