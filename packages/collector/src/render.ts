import type {
  AgentStats,
  DeathCause,
  GraveyardEntry,
  IngestPayload,
  ObservableMetric,
} from "@ao-wrapped/shared";

/**
 * TICKET A4 — terminal card.
 *
 * The collector prints a complete Wrapped card to stdout with no network call
 * and no account. Publishing is strictly opt-in; someone who never runs
 * `--publish` still gets the whole product locally. That is the trust argument,
 * so the offline card has to be genuinely good rather than a teaser.
 *
 * Two rules shape everything below.
 *
 * The card renders the payload and nothing else. It never reaches for a
 * database, a clock or an environment beyond the colour decision, so the same
 * payload always prints the same card — which is what makes it snapshot-testable
 * and what makes the printed card and the published one agree.
 *
 * The card claims only what the payload can support. Awards compare harnesses
 * against each other, so a window with one harness earns no awards and says so.
 * A counter whose metric is missing from `payload.observed` had no data source
 * at all, and prints as `—` with the reason rather than as a `0` that would
 * read as "your agents fixed nothing". Counters that genuinely are zero — CI
 * ran and nothing needed recovering, an empty graveyard — print as zero with
 * copy that reads as a fact rather than a failure.
 */

export interface RenderOptions {
  /** Force colour on or off. Defaults to: on when stdout is a TTY and NO_COLOR is unset. */
  color?: boolean;
  /** Total card width including borders. 60 survives a screen recording. */
  width?: number;
}

const DEFAULT_WIDTH = 60;
/** Space between the border and the text on each side. */
const GUTTER = 2;

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  bone: "\u001b[38;5;223m",
  phosphor: "\u001b[38;5;214m",
  signal: "\u001b[38;5;79m",
  ember: "\u001b[38;5;209m",
} as const;

type Ink = keyof typeof ANSI;

/**
 * NO_COLOR is honoured at any value, per no-color.org. A non-TTY stdout means
 * the card is being piped into a file or a pager, where escape codes are noise.
 */
function colorEnabled(options: RenderOptions): boolean {
  if (options.color !== undefined) return options.color;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  return process.stdout.isTTY === true;
}

function painter(enabled: boolean): (ink: Ink, text: string) => string {
  return (ink, text) => (enabled && text.length > 0 ? `${ANSI[ink]}${text}${ANSI.reset}` : text);
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Printed width, ignoring escape codes. All padding goes through this. */
function visibleLength(text: string): number {
  return text.replace(ANSI_PATTERN, "").length;
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

function padLeft(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleLength(text))) + text;
}

/** Truncates on visible characters so a colour code is never cut in half. */
function truncate(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 3) return ".".repeat(Math.max(0, width));
  return text.replace(ANSI_PATTERN, "").slice(0, width - 3) + "...";
}

/** Greedy wrap on spaces, for the one or two places prose appears. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(" ")) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Accumulates rows and draws the box around them once the content is known. */
class Card {
  private readonly rows: string[] = [];
  readonly width: number;
  readonly paint: (ink: Ink, text: string) => string;

  // Written out rather than declared as constructor parameter properties:
  // `node --experimental-strip-types` rejects those, and the collector runs
  // straight from source.
  constructor(width: number, paint: (ink: Ink, text: string) => string) {
    this.width = width;
    this.paint = paint;
  }

  /** Usable columns between the gutters. */
  get inner(): number {
    return this.width - 2 - GUTTER * 2;
  }

  line(text = ""): void {
    this.rows.push(
      `│${" ".repeat(GUTTER)}${padRight(truncate(text, this.inner), this.inner)}${" ".repeat(GUTTER)}│`,
    );
  }

  /** A left label and a right value on one row, filled to the full width. */
  split(left: string, right: string): void {
    const gap = Math.max(1, this.inner - visibleLength(left) - visibleLength(right));
    this.line(`${left}${" ".repeat(gap)}${right}`);
  }

  prose(text: string, ink: Ink = "dim"): void {
    for (const line of wrap(text, this.inner)) this.line(this.paint(ink, line));
  }

  heading(text: string): void {
    this.line(this.paint("bold", text.toUpperCase()));
  }

  rule(): void {
    this.rows.push(`├${"─".repeat(this.width - 2)}┤`);
  }

  toString(): string {
    return [
      `┌${"─".repeat(this.width - 2)}┐`,
      ...this.rows,
      `└${"─".repeat(this.width - 2)}┘`,
    ].join("\n");
  }
}

/** What the card prints where a number would go, when there was no source. */
const NOT_MEASURED = "—";

/**
 * Why a metric is blank, in the reader's terms rather than the schema's. Short
 * enough to sit under the grid; specific enough that "no CI ran here" cannot be
 * mistaken for "your agents fixed nothing".
 */
const UNOBSERVED_REASON: Record<ObservableMetric, string> = {
  tasks: "AO recorded no sessions",
  merges: "AO recorded no pull requests",
  ciRecoveries: "AO recorded no CI checks",
  interventions: "no change log to replay",
  peakParallelism: "no change log to replay",
  harnesses: "AO recorded no sessions",
  turns: "AO records no turns for TUI-mode sessions",
  repos: "the collector does not derive this yet",
  sizeMix: "the collector does not derive this yet",
  tokens: "the collector does not derive this yet",
};

/**
 * A payload from a collector too old to report `observed` makes no claim either
 * way, so its counters are read at face value exactly as before. An empty array
 * is the opposite: a collector that looked and found no source for anything.
 */
function observedIn(payload: IngestPayload): (metric: ObservableMetric) => boolean {
  const { observed } = payload;
  if (observed === undefined) return () => true;
  const set = new Set(observed);
  return (metric) => set.has(metric);
}

export function renderCard(payload: IngestPayload, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const paint = painter(colorEnabled(options));
  const card = new Card(width, paint);

  header(card, payload);
  card.rule();
  totals(card, payload);
  card.rule();
  crew(card, payload);
  card.rule();
  for (const line of personalityLines(payload, paint, card.inner)) card.line(line);
  card.rule();
  graveyard(card, payload);
  card.rule();
  footer(card);

  return card.toString();
}

/**
 * Deterministic awards, computed from counters. No model call — see the plan.
 *
 * Returned on its own so the section can be inspected, tested and reused
 * without the box around it.
 */
export function renderPersonalities(payload: IngestPayload, options: RenderOptions = {}): string {
  const width = (options.width ?? DEFAULT_WIDTH) - 2 - GUTTER * 2;
  const paint = painter(colorEnabled(options));
  return personalityLines(payload, paint, width).join("\n");
}

function header(card: Card, payload: IngestPayload): void {
  card.line();
  card.split(
    card.paint("phosphor", card.paint("bold", "AO WRAPPED")),
    card.paint("dim", formatWindow(payload.window)),
  );
  card.line(card.paint("bone", payload.handle));
  card.line();
}

/** The stat grid, in reading order. `metric` is what decides `—` versus a number. */
const TOTAL_STATS: ReadonlyArray<{
  label: string;
  metric: ObservableMetric;
  ink: Ink;
  of: (t: IngestPayload["totals"]) => number;
}> = [
  { label: "CI recoveries", metric: "ciRecoveries", ink: "signal", of: (t) => t.ciRecoveries },
  { label: "Interventions", metric: "interventions", ink: "ember", of: (t) => t.interventions },
  { label: "Peak parallel", metric: "peakParallelism", ink: "bone", of: (t) => t.peakParallelism },
  { label: "Harnesses", metric: "harnesses", ink: "bone", of: (t) => t.harnesses },
  { label: "Turns", metric: "turns", ink: "bone", of: (t) => t.turns },
  { label: "Repos", metric: "repos", ink: "bone", of: (t) => t.repos },
];

function totals(card: Card, payload: IngestPayload): void {
  const { totals: t } = payload;
  const observed = observedIn(payload);

  card.line();
  card.line(
    card.paint(
      "phosphor",
      card.paint("bold", observed("merges") ? `${formatCount(t.merges)} merges` : "— merges"),
    ),
  );
  card.prose(
    !observed("merges")
      ? `Not measured here — ${UNOBSERVED_REASON.merges}.`
      : t.tasks === 0
        ? "No tasks ran in this window."
        : `out of ${formatCount(t.tasks)} tasks handed to agents (${percent(t.merges, t.tasks)} closed)`,
  );
  card.line();

  // An unobserved stat still gets its cell: the blank is the finding, and
  // dropping the row would hide it. A payload predating `observed` keeps the
  // old rule instead, where turns and repos are omitted while they read zero.
  const legacy = payload.observed === undefined;
  const stats = TOTAL_STATS.filter((stat) => {
    if (!legacy) return true;
    return stat.metric === "turns" || stat.metric === "repos" ? stat.of(t) > 0 : true;
  });

  const gap = 2;
  const cellWidth = Math.floor((card.inner - gap) / 2);
  const valueWidth = 5;
  for (let i = 0; i < stats.length; i += 2) {
    const cells = stats.slice(i, i + 2).map((stat) => {
      const value = observed(stat.metric)
        ? card.paint(stat.ink, formatCount(stat.of(t)))
        : card.paint("dim", NOT_MEASURED);
      const shown = padRight(stat.label, cellWidth - valueWidth) + padLeft(value, valueWidth);
      return padRight(shown, cellWidth);
    });
    card.line(cells.join(" ".repeat(gap)));
  }

  const blank = stats.filter((stat) => !observed(stat.metric));
  if (blank.length > 0) {
    card.line();
    card.prose(`${NOT_MEASURED} is not zero. This install had no source for:`);
    for (const stat of blank) {
      // Wrapped rather than truncated: a reason cut off at "so none co..." is
      // exactly the kind of half-claim this whole section exists to remove.
      for (const line of wrap(
        `${stat.label} — ${UNOBSERVED_REASON[stat.metric]}`,
        card.inner - 2,
      )) {
        card.line(card.paint("dim", `  ${line}`));
      }
    }
  }
  card.line();
}

/**
 * `metric` names the payload-level source a column depends on, or null when the
 * column is derived from the session rows themselves. A per-agent counter is as
 * unmeasured as the total above it, so the column blanks with the same glyph.
 */
const CREW_COLUMNS: ReadonlyArray<{
  header: string;
  width: number;
  metric: ObservableMetric | null;
  of: (a: AgentStats) => string;
}> = [
  { header: "tasks", width: 6, metric: "tasks", of: (a) => formatCount(a.tasks) },
  { header: "merged", width: 7, metric: "merges", of: (a) => formatCount(a.merges) },
  { header: "ci saves", width: 9, metric: "ciRecoveries", of: (a) => formatCount(a.recoveries) },
  { header: "died", width: 6, metric: null, of: (a) => formatCount(a.died) },
  { header: "median", width: 9, metric: null, of: (a) => formatDuration(a.medianMinutes) },
];

/** Busiest first, then most merges, then name — never database order. */
function rankAgents(agents: readonly AgentStats[]): AgentStats[] {
  return [...agents].sort(
    (a, b) => b.tasks - a.tasks || b.merges - a.merges || a.harness.localeCompare(b.harness),
  );
}

function crew(card: Card, payload: IngestPayload): void {
  card.line();
  card.heading("The crew");
  card.line();

  if (payload.agents.length === 0) {
    card.prose("No sessions ran in this window. Point --from at a range where AO was working.");
    card.line();
    return;
  }

  const nameWidth = card.inner - CREW_COLUMNS.reduce((total, column) => total + column.width, 0);
  const head =
    padRight("harness", nameWidth) +
    CREW_COLUMNS.map((column) => padLeft(column.header, column.width)).join("");
  card.line(card.paint("dim", head));

  const observed = observedIn(payload);
  for (const agent of rankAgents(payload.agents)) {
    const cells = CREW_COLUMNS.map((column) => {
      const cell =
        column.metric !== null && !observed(column.metric)
          ? card.paint("dim", NOT_MEASURED)
          : column.of(agent);
      return padLeft(cell, column.width);
    }).join("");
    card.line(
      padRight(card.paint("bone", truncate(agent.harness, nameWidth - 1)), nameWidth) + cells,
    );
  }
  card.line();
}

/** An award, its holder and the arithmetic that earned it. */
interface Award {
  title: string;
  harness: string;
  detail: string;
}

interface Category {
  title: string;
  /** Agents this category is willing to judge. */
  eligible: (agent: AgentStats) => boolean;
  /** Higher wins. */
  score: (agent: AgentStats) => number;
  /** A winner needs a score that means something, not just the top of the pile. */
  meaningful: (agent: AgentStats) => boolean;
  detail: (agent: AgentStats, payload: IngestPayload) => string;
}

/** Reliability and speed are noise below a handful of tasks. */
const MIN_TASKS_FOR_RATE = 3;

/**
 * An award is a comparison, so it needs at least two harnesses to compare and a
 * strict winner between them. One harness with every title is the failure mode
 * this guard exists to prevent — see the ticket.
 */
const MIN_CANDIDATES = 2;

const CATEGORIES: Category[] = [
  {
    title: "Most Productive",
    eligible: (a) => a.tasks > 0,
    score: (a) => a.merges,
    meaningful: (a) => a.merges > 0,
    detail: (a, p) => `${formatCount(a.merges)} of ${formatCount(p.totals.merges)} merges`,
  },
  {
    title: "Most Reliable",
    eligible: (a) => a.tasks >= MIN_TASKS_FOR_RATE,
    score: (a) => a.merges / a.tasks,
    meaningful: (a) => a.merges > 0,
    detail: (a) => `${percent(a.merges, a.tasks)} of ${formatCount(a.tasks)} merged`,
  },
  {
    title: "Most Chaotic",
    eligible: (a) => a.tasks > 0,
    score: (a) => a.died / a.tasks,
    meaningful: (a) => a.died > 0,
    detail: (a) => `${percent(a.died, a.tasks)} of its sessions died`,
  },
  {
    title: "Firefighter",
    eligible: (a) => a.tasks > 0,
    score: (a) => a.recoveries,
    meaningful: (a) => a.recoveries > 0,
    detail: (a) => `${formatCount(a.recoveries)} red builds saved`,
  },
  {
    title: "Workhorse",
    eligible: () => true,
    score: (a) => a.tasks,
    meaningful: (a) => a.tasks > 0,
    detail: (a, p) => `${formatCount(a.tasks)} of ${formatCount(p.totals.tasks)} tasks`,
  },
  {
    title: "Speed Demon",
    eligible: (a) => a.tasks >= MIN_TASKS_FOR_RATE && a.medianMinutes > 0,
    score: (a) => -a.medianMinutes,
    meaningful: (a) => a.medianMinutes > 0,
    detail: (a) => `${formatDuration(a.medianMinutes)} median run`,
  },
  {
    title: "Drama Queen",
    eligible: (a) => a.tasks > 0,
    score: (a) => a.interventions / a.tasks,
    meaningful: (a) => a.interventions > 0,
    detail: (a) => `${ratio(a.interventions, a.tasks)} nudges per task`,
  },
];

/**
 * One award per category, or none. A category is withheld when fewer than two
 * agents qualify, when the leader ties, or when the winning score is zero —
 * "most CI recoveries" over a window with no CI recoveries names nobody.
 */
export function awardsFor(payload: IngestPayload): Array<Award | { title: string }> {
  return CATEGORIES.map((category) => {
    const ranked = payload.agents
      .filter(category.eligible)
      .sort((a, b) => category.score(b) - category.score(a) || a.harness.localeCompare(b.harness));

    const [winner, runnerUp] = ranked;
    if (winner === undefined || ranked.length < MIN_CANDIDATES) return { title: category.title };
    if (!category.meaningful(winner)) return { title: category.title };
    if (runnerUp !== undefined && category.score(runnerUp) === category.score(winner)) {
      return { title: category.title };
    }
    return {
      title: category.title,
      harness: winner.harness,
      detail: category.detail(winner, payload),
    };
  });
}

function personalityLines(
  payload: IngestPayload,
  paint: (ink: Ink, text: string) => string,
  inner: number,
): string[] {
  const awards = awardsFor(payload);
  const titleWidth = Math.max(...CATEGORIES.map((c) => c.title.length)) + 2;
  const lines: string[] = ["", paint("bold", "AWARDS"), ""];

  for (const award of awards) {
    const title = padRight(
      "harness" in award ? paint("bone", award.title) : paint("dim", award.title),
      titleWidth,
    );
    const body =
      "harness" in award
        ? `${paint("phosphor", award.harness)} ${paint("dim", `· ${award.detail}`)}`
        : paint("dim", "not enough data yet");
    lines.push(truncate(`${title}${body}`, inner));
  }

  lines.push("");
  for (const line of wrap(withholdingNote(payload, awards), inner)) lines.push(paint("dim", line));
  lines.push("");
  return lines;
}

/** Says why the blanks are blank, in the terms of this particular window. */
function withholdingNote(payload: IngestPayload, awards: Array<Award | { title: string }>): string {
  const given = awards.filter((award) => "harness" in award).length;
  if (given === awards.length) return "Every category had a clear winner.";
  if (payload.agents.length === 0) return "No agent ran in this window, so no title was earned.";
  if (payload.agents.length < MIN_CANDIDATES) {
    return `An award is a comparison and ${payload.agents[0]?.harness ?? "one harness"} is the only harness here. Run a second one and these fill in.`;
  }
  if (given === 0)
    return "No category had a clear winner — every one tied or had nothing to count.";
  return "Blank categories had no clear winner — a tie, or nothing to count.";
}

const DEATH_CAUSE_LABELS: Record<DeathCause, string> = {
  ci_failed: "CI never went green",
  merge_conflict: "conflict it could not resolve",
  review_blocked: "review it could not answer",
  no_signal: "stopped without a signal",
};

/** Deaths grouped by cause, biggest first. Ties break on cause name. */
function byCause(entries: readonly GraveyardEntry[]): Array<{ cause: DeathCause; count: number }> {
  const counts = new Map<DeathCause, number>();
  for (const entry of entries) counts.set(entry.cause, (counts.get(entry.cause) ?? 0) + 1);
  return [...counts.entries()]
    .map(([cause, count]) => ({ cause, count }))
    .sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
}

function graveyard(card: Card, payload: IngestPayload): void {
  // `outcomes` is a partial record in the schema, so a missing key means zero
  // rather than a hole to propagate.
  const unmerged = (payload.outcomes.died ?? 0) + (payload.outcomes.opened_unmerged ?? 0);
  const groups = byCause(payload.graveyard);

  card.line();
  card.heading("Graveyard");
  card.line();

  if (unmerged === 0) {
    card.prose(
      payload.totals.tasks === 0
        ? "Empty. Nothing ran in this window to bury."
        : "Empty. Every session that started ended in a merge.",
    );
    card.line();
    return;
  }

  card.prose(
    `${formatCount(unmerged)} ${plural(unmerged, "session")} ended without a merge. None of them cost anything — punishing failure punishes trying.`,
  );
  card.line();

  // A payload can carry deaths in `outcomes` and fewer graveyard rows than
  // deaths: a cause is only recorded for a session AO was seen exiting. The
  // card says which of the two numbers it is showing rather than implying the
  // causes below account for every death above.
  const recorded = payload.graveyard.length;
  if (recorded === 0) {
    card.prose("No cause was recorded for any of them.");
  } else if (recorded < unmerged) {
    card.prose(`A cause was recorded for ${formatCount(recorded)}:`);
  }
  for (const group of groups) {
    card.split(
      card.paint("ember", formatCount(group.count)) + " " + DEATH_CAUSE_LABELS[group.cause],
      "",
    );
  }
  card.line();
}

function footer(card: Card): void {
  card.line();
  card.prose(
    "Measured here, from a read-only pass over AO's own database. No code, diffs, repo names or prompts were read at all.",
  );
  card.line();
  card.prose("Run  ao-wrapped --publish  to put these counters on the board.", "dim");
  card.line();
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function ratio(part: number, whole: number): string {
  if (whole <= 0) return "0";
  return (part / whole).toFixed(1);
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

/** Minutes in, something a human reads at a glance out. */
function formatDuration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 1) return "<1m";
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  if (hours < 24) return `${hours}h ${rounded % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatWindow(window: IngestPayload["window"]): string {
  const format = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${format(window.from)} — ${format(window.to)}`;
}
