/**
 * The leaderboard runs in weekly seasons and resets every Monday.
 *
 * Two reasons this beats a rolling window. A season is explainable in one
 * sentence — "this week's board" — where "last 30 days, half-life 14" is not.
 * And a board that never resets freezes around whoever showed up first, which
 * removes the reason to come back.
 *
 * ISO-8601 weeks, UTC, Monday start. UTC rather than local time because a board
 * whose boundary moves per viewer is not a shared ranking; the cost is that a
 * Sunday evening in Asia already counts as next week, which we state plainly in
 * the UI rather than hide.
 */

export interface WeekWindow {
  /** ISO week key, e.g. `2026-W33`. Sorts lexically within a year. */
  key: string;
  /** Monday, `YYYY-MM-DD`, inclusive. */
  from: string;
  /** Sunday, `YYYY-MM-DD`, inclusive. */
  to: string;
}

const DAY_MS = 86_400_000;
const WEEK_KEY = /^(\d{4})-W(\d{2})$/;

function utcDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Monday of the ISO week containing `date`. */
export function weekStart(date: Date): Date {
  const day = utcDate(date);
  // getUTCDay is Sunday-first; shift so Monday is 0.
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

/**
 * ISO week number. Week 1 is the week containing the year's first Thursday, so
 * early January can belong to the previous year's final week — which is why the
 * year in the key comes from the Thursday and not from `date`.
 */
export function weekKeyFor(date: Date): string {
  const monday = weekStart(date);
  const thursday = new Date(monday.getTime() + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = 1 + Math.round((thursday.getTime() - weekStart(jan1).getTime()) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function weekWindowFor(date: Date): WeekWindow {
  const monday = weekStart(date);
  return {
    key: weekKeyFor(date),
    from: iso(monday),
    to: iso(new Date(monday.getTime() + 6 * DAY_MS)),
  };
}

/** Resolve a `2026-W33` key back to its dates. Returns null if malformed. */
export function weekWindowFromKey(key: string): WeekWindow | null {
  const match = WEEK_KEY.exec(key);
  if (!match) return null;
  const [, yearRaw, weekRaw] = match;
  const year = Number(yearRaw);
  const week = Number(weekRaw);
  if (week < 1 || week > 53) return null;

  const jan4 = new Date(Date.UTC(year, 0, 4)); // always in ISO week 1
  const monday = new Date(weekStart(jan4).getTime() + (week - 1) * 7 * DAY_MS);
  const window = weekWindowFor(monday);
  // Week 53 does not exist in every year; reject rather than silently shifting.
  return window.key === key ? window : null;
}

export function previousWeek(week: WeekWindow): WeekWindow {
  return weekWindowFor(new Date(Date.parse(`${week.from}T00:00:00.000Z`) - DAY_MS));
}

export function isCurrentWeek(week: WeekWindow, now: Date): boolean {
  return week.key === weekKeyFor(now);
}
