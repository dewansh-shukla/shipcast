import {
  previousWeek,
  weekWindowFor,
  weekWindowFromKey,
  type WeekWindow,
} from "@ao-wrapped/shared";
import { getIngestStore, type PublishedSnapshot } from "../../db/store.ts";
import {
  transportFromEnv,
  UNCHECKED,
  verifyRows,
  type Verification,
  type VerifyOptions,
} from "../../lib/verify.ts";

/**
 * TICKET 06 — the data the leaderboard reads.
 *
 * `getBoard` is the only door between the board and storage, and the store is
 * the only source. Every row here belongs to somebody who ran the collector and
 * published this season; nothing is seeded, inferred or estimated.
 *
 * The read goes through `getIngestStore()` rather than drizzle so the in-memory
 * implementation the tests run against stays a real option. Everything below the
 * read is a pure function of rows plus `now`, which is what makes ranking and
 * freshness testable without a database or a clock.
 *
 * No score is computed here. Ticket 05 owns scoring and may not land; ranking on
 * merges with an explainable tiebreak ships either way, and the column set says
 * more than one opaque number would.
 *
 * TICKET 28 — verification is deliberately not part of `getBoard`. That read is
 * a pure function of the store and stays that way; `withVerification` is a
 * separate pass that may touch the network, so a board can always be built and
 * tested without one.
 */

/** One builder's season, as the board displays it. */
export interface BoardRow {
  /** 1-based, after ranking. Equal rows still get distinct ranks. */
  rank: number;
  handle: string;
  merges: number;
  tasks: number;
  ciRecoveries: number;
  peakParallelism: number;
  interventions: number;
  harnesses: number;
  /** When this builder last published into this season. */
  publishedAt: Date;
  /**
   * Whether public GitHub corroborates `merges`. Every row starts `unchecked`
   * — the store knows nothing about GitHub — and `withVerification` fills it in
   * when a token is configured.
   */
  verification: Verification;
}

export interface Board {
  week: WeekWindow;
  /** True when this is the season currently taking publishes. */
  live: boolean;
  rows: BoardRow[];
  /** The instant the freshness column is relative to. */
  asOf: Date;
}

/** The one command that puts a handle on the board. */
export const CONNECT_COMMAND = "npx ao-wrapped --publish";

/**
 * Rank on merges, then fewer interventions, then handle.
 *
 * Deliberately not a weighted score. Merges are the outcome the product claims
 * to measure; interventions break ties toward the workforce that needed less
 * hand-holding to get there; the handle makes the order total, so a season reads
 * identically on every render regardless of the order rows came back in.
 */
export function rankSnapshots(published: readonly PublishedSnapshot[]): BoardRow[] {
  return [...published]
    .sort(
      (a, b) =>
        b.snapshot.merges - a.snapshot.merges ||
        a.snapshot.interventions - b.snapshot.interventions ||
        a.builder.handle.localeCompare(b.builder.handle),
    )
    .map((entry, index) => ({
      rank: index + 1,
      handle: entry.builder.handle,
      merges: entry.snapshot.merges,
      tasks: entry.snapshot.tasks,
      ciRecoveries: entry.snapshot.ciRecoveries,
      peakParallelism: entry.snapshot.peakParallelism,
      interventions: entry.snapshot.interventions,
      harnesses: entry.snapshot.harnesses,
      publishedAt: entry.snapshot.receivedAt,
      verification: UNCHECKED,
    }));
}

/**
 * The board for one season. `weekKey` omitted means the season running now.
 *
 * Returns null only for a key that names no week — `2026-W99`, or anything that
 * is not a week key at all. A season nobody published in is an empty board and a
 * perfectly valid page, not a 404.
 */
export async function getBoard(weekKey?: string, now: Date = new Date()): Promise<Board | null> {
  const week = weekKey === undefined ? weekWindowFor(now) : weekWindowFromKey(weekKey);
  if (week === null) return null;

  const published = await getIngestStore().snapshotsForWeek(week.key);
  return {
    week,
    live: week.key === weekWindowFor(now).key,
    rows: rankSnapshots(published),
    asOf: now,
  };
}

/**
 * Attach verification to a season's rows.
 *
 * Separate from `getBoard` on purpose, and never in the ingest path: a publish
 * must not wait on GitHub, and it does not — nothing here runs until somebody
 * loads the board. Cache-first, bounded by a wall-clock budget, and every
 * failure resolves to `unchecked`, so with no `GITHUB_TOKEN`, a rate limit or a
 * GitHub outage this returns the same board it was handed.
 *
 * It never throws. A verification problem is not a reason to lose the board.
 */
export async function withVerification(board: Board, options: VerifyOptions = {}): Promise<Board> {
  const transport = options.transport === undefined ? transportFromEnv() : options.transport;
  if (transport === null || board.rows.length === 0) return board;

  const verified = await verifyRows(board.rows, board.week, { ...options, transport });

  return {
    ...board,
    rows: board.rows.map((row) => ({
      ...row,
      verification: verified.get(row.handle) ?? UNCHECKED,
    })),
  };
}

/**
 * The season and what happens to it — `2026-W33 · resets Monday`.
 *
 * A visitor who does not know the board is weekly reads a ranking as all of
 * history and concludes they can never catch up. Saying "resets Monday" on the
 * live board, and naming a closed one as closed, is the difference between a
 * ranking that looks finished and one worth entering.
 */
export function seasonLabel(board: Board): string {
  if (board.live) return `${board.week.key} · resets Monday`;
  if (board.week.from > weekWindowFor(board.asOf).from) return `${board.week.key} · not open yet`;
  return `${board.week.key} · closed`;
}

/** `Mon Aug 10 — Sun Aug 16`, the days a season actually covers. */
export function seasonDates(week: WeekWindow): string {
  const format = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  return `${format(week.from)} — ${format(week.to)}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago something happened, in the coarsest unit that is still true.
 *
 * Freshness is a column on this board rather than a footnote: with `ao-wrapped
 * watch` running, some builders update every few minutes while others published
 * once and walked away, and "3m ago" against "yesterday" is what tells those two
 * apart at a glance. A future timestamp — a clock skewed forward on the
 * publishing machine — reads as "just now" rather than as negative minutes.
 */
export function formatFreshness(then: Date, now: Date): string {
  const elapsed = now.getTime() - then.getTime();
  if (Number.isNaN(elapsed)) return "unknown";
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  if (elapsed < 2 * DAY_MS) return "yesterday";
  if (elapsed < 7 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  return new Date(then).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** A machine-readable stamp for the `datetime` attribute beside the label. */
export function isoStamp(date: Date): string {
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** The season before this one, for the "previous week" link. */
export function previousSeasonKey(week: WeekWindow): string {
  return previousWeek(week).key;
}
