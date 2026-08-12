/**
 * AO writes Go `time.Time` values straight into SQLite:
 *
 *   2026-07-07 06:58:31.825841 +0000 UTC
 *
 * SQLite cannot parse that. `julianday()` and `datetime()` both return NULL, so
 * any `WHERE created_at BETWEEN ...` filter silently matches zero rows and no
 * error is raised anywhere. Every timestamp entering this collector goes through
 * here first.
 *
 * Some columns (pr.created_at_provider) use a second-precision variant, and rows
 * written by newer AO builds may already be ISO-8601 — all three are handled.
 */

const GO_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*([+-]\d{4})?(?:\s+(\w+))?$/;

export function parseAoTimestamp(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const match = GO_TIME.exec(trimmed);
  if (!match) {
    const fallback = new Date(trimmed);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }

  const [, date, time, fraction, offset] = match;
  // Go prints microseconds; JS Date only takes milliseconds.
  const millis = fraction ? fraction.slice(0, 4).padEnd(4, "0") : ".000";
  const zone = offset ? `${offset.slice(0, 3)}:${offset.slice(3)}` : "Z";

  const parsed = new Date(`${date}T${time}${millis}${zone}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * SQL-side equivalent for use inside queries, where pulling every row into JS
 * would be wasteful: `substr(col, 1, 19)` yields a comparable 'YYYY-MM-DD HH:MM:SS'.
 */
export const SQL_TS = (column: string) => `substr(${column}, 1, 19)`;

export function withinWindow(at: Date | null, from: Date, to: Date): boolean {
  if (!at) return false;
  return at >= from && at <= to;
}
