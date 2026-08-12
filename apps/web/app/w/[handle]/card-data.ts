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
 * An award is a comparison, so a category needs a genuine contest to award.
 *
 * The OG image used to print "Most Chaotic: claude-code" on a card whose
 * harness count was 1 — a superlative over a field of one, which is decoration
 * pretending to be a finding. A judge who spots one stops believing the real
 * numbers beside it, so the gaps are worth more than the labels.
 *
 * The terminal card (`packages/collector/src/render.ts`) already settled this.
 * The rule is applied again here rather than imported, because the web app does
 * not depend on the collector; the judgement is what has to match, and the
 * cases below are the same three it withholds on:
 *
 *   - fewer than two eligible harnesses — nothing to compare against
 *   - the leader ties with the runner-up — no winner, just an order
 *   - the winning counter is zero — "Firefighter" over a window with no CI
 *     recoveries names nobody
 */
const MIN_CANDIDATES = 2;

interface Category {
  title: string;
  /** Agents this category is willing to judge. */
  eligible: (agent: AgentStats) => boolean;
  /** Higher wins. */
  score: (agent: AgentStats) => number;
  /** A winner needs a score that means something, not just the top of the pile. */
  meaningful: (agent: AgentStats) => boolean;
  detail: (agent: AgentStats, card: ConnectedCard) => string;
}

/** Interventions and deaths per task. How much hand-holding an agent cost. */
export function chaosScore(agent: AgentStats): number {
  if (agent.tasks === 0) return 0;
  return (agent.interventions + agent.died) / agent.tasks;
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : many}`;
}

const CLOSER: Category = {
  title: "Closer",
  eligible: (agent) => agent.tasks > 0,
  score: (agent) => agent.merges,
  meaningful: (agent) => agent.merges > 0,
  detail: (agent, card) =>
    `${formatCount(agent.merges)} of ${formatCount(card.totals.merges)} merges`,
};

const MOST_CHAOTIC: Category = {
  title: "Most chaotic",
  eligible: (agent) => agent.tasks > 0,
  score: chaosScore,
  meaningful: (agent) => agent.interventions + agent.died > 0,
  /**
   * Only the halves that actually happened. "0 interventions, 1 dead sessions"
   * is two mistakes in one line: a count of nothing, and a plural for one.
   */
  detail: (agent) =>
    [
      agent.interventions > 0 ? plural(agent.interventions, "intervention") : null,
      agent.died > 0 ? plural(agent.died, "dead session") : null,
    ]
      .filter((part): part is string => part !== null)
      .join(", "),
};

const FIREFIGHTER: Category = {
  title: "Firefighter",
  eligible: (agent) => agent.tasks > 0,
  score: (agent) => agent.recoveries,
  meaningful: (agent) => agent.recoveries > 0,
  detail: (agent) => plural(agent.recoveries, "CI recovery", "CI recoveries"),
};

/** In the order they read best on the card. */
const CATEGORIES = [CLOSER, MOST_CHAOTIC, FIREFIGHTER] as const;

/**
 * The winner of one category, or null when the contest was not real.
 *
 * Sorting is fully determined — score, then harness name — so the same counters
 * always produce the same card whatever order the rows came back in.
 */
function winnerOf(category: Category, agents: readonly AgentStats[]): AgentStats | null {
  const ranked = [...agents]
    .filter(category.eligible)
    .sort((a, b) => category.score(b) - category.score(a) || a.harness.localeCompare(b.harness));

  const [winner, runnerUp] = ranked;
  if (!winner || ranked.length < MIN_CANDIDATES) return null;
  if (!category.meaningful(winner)) return null;
  /**
   * A tie on the counter the award is named for is not a win. Breaking it on
   * tasks or on alphabetical order would crown somebody the numbers did not.
   */
  if (runnerUp && category.score(runnerUp) === category.score(winner)) return null;
  return winner;
}

/** Most merges, against at least one other harness that also ran. */
export function topAgentByMerges(agents: readonly AgentStats[]): AgentStats | null {
  return winnerOf(CLOSER, agents);
}

export function mostChaoticAgent(agents: readonly AgentStats[]): AgentStats | null {
  return winnerOf(MOST_CHAOTIC, agents);
}

export function mostRecoveries(agents: readonly AgentStats[]): AgentStats | null {
  return winnerOf(FIREFIGHTER, agents);
}

/**
 * Why a card carries no awards, in the terms of this particular window.
 *
 * Withholding without explaining reads as a bug. The wording follows the
 * terminal card's, because a builder who has seen one should recognise the
 * other.
 */
export function awardsWithheldNote(card: ConnectedCard): string {
  if (card.agents.length === 0) {
    return "No agent ran in this window, so no title was earned.";
  }
  if (card.agents.length < MIN_CANDIDATES) {
    return (
      `An award is a comparison and ${card.agents[0]!.harness} is the only harness here. ` +
      `Run a second one and these fill in.`
    );
  }
  return "No category had a clear winner — every one tied or had nothing to count.";
}

/**
 * A category deliberately not awarded.
 *
 * It carries the same three fields a real award does so the page renders it as
 * a row without knowing the difference, and a title no consumer looks up by
 * name — the OG image asks for "Closer" and "Most chaotic" specifically, so a
 * withheld category drops off the image entirely rather than printing a row
 * with nothing in it.
 */
export interface WithheldAwards {
  award: string;
  harness: string;
  detail: string;
  withheld: true;
}

export type CardAward = Personality | WithheldAwards;

export function isWithheld(award: CardAward): award is WithheldAwards {
  return "withheld" in award;
}

/**
 * Awards, in the order they read best on the card. Never longer than three.
 *
 * When no category had a real contest the result is a single withheld row
 * saying so, rather than an empty list that would read as a rendering bug — or,
 * worse, a list of superlatives the numbers cannot support.
 */
export function personalitiesFor(card: ConnectedCard): CardAward[] {
  const earned: Personality[] = [];

  for (const category of CATEGORIES) {
    const winner = winnerOf(category, card.agents);
    if (!winner) continue;
    earned.push({
      award: category.title,
      harness: winner.harness,
      detail: category.detail(winner, card),
    });
  }

  if (earned.length > 0) return earned.slice(0, 3);

  return [
    {
      award: "No awards yet",
      harness: "not enough data yet",
      detail: awardsWithheldNote(card),
      withheld: true,
    },
  ];
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
