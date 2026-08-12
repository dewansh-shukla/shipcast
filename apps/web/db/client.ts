import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

/**
 * TICKET 16 — the one Postgres connection this process gets.
 *
 * The client is module-level on purpose. On serverless a client per request is
 * the classic way to exhaust a pool even with pooling switched on: every
 * invocation opens its own sockets and the pooler runs out of upstream slots
 * long before the app notices. One client per module instance, reused.
 *
 * `DATABASE_URL` points at Neon's **pooled** endpoint, and two of these options
 * were established against the live database rather than reasoned about:
 *
 * - `prepare: false` is mandatory. The pooled endpoint is PgBouncer in
 *   transaction mode, which does not keep a session across statements, so
 *   session-level prepared statements are not available. Without the flag every
 *   query fails with `bind message supplies 0 parameters, but prepared
 *   statement "PGBOUNCER_2" requires 1`.
 * - `ssl: "require"`. `channel_binding=require` was stripped from the URL
 *   because `postgres.js` does not understand it; do not put it back.
 */

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * The configured connection string, or undefined when there is none. An empty
 * or whitespace-only value counts as unset — a blank `DATABASE_URL` in a `.env`
 * is a variable someone meant to fill in, not a request to connect to "".
 */
export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL?.trim();
  return url === undefined || url === "" ? undefined : url;
}

/** True when this process is configured to persist to Postgres. */
export function isDatabaseConfigured(): boolean {
  return databaseUrl() !== undefined;
}

/**
 * Every `postgres://user:password@host/db` in a string, with the credentials
 * removed.
 *
 * Connection strings reach places nobody intends them to. `postgres.js` puts
 * the host in some errors, drivers put the whole URL in others, and an
 * unhandled rejection prints a stack straight into the response on a bad day.
 * A password in a log is a leak whether or not anyone meant to write it, so
 * everything this module surfaces goes through here first.
 */
export function redact(text: string): string {
  return text
    .replace(/([a-zA-Z][\w+.-]*:\/\/)[^/\s@]*@/g, "$1<redacted>@")
    .replace(/\b(password|pgpassword)\s*=\s*\S+/gi, "$1=<redacted>");
}

/**
 * Raised when `DATABASE_URL` is set but the database will not answer.
 *
 * This is deliberately fatal rather than a fallback to memory. A silent
 * fallback means the board looks perfectly healthy in development and quietly
 * drops every write in production, which is the failure nobody notices until
 * the data is already gone.
 */
export class DatabaseUnreachableError extends Error {
  constructor(cause: unknown) {
    super(`DATABASE_URL is set but the database is unreachable: ${redact(messageOf(cause))}`);
    this.name = "DatabaseUnreachableError";
    /** The cause is dropped, not chained — its stack can carry the URL. */
  }
}

/** Raised when something asks for the database and none is configured. */
export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("DATABASE_URL is not set; this process has no database");
    this.name = "DatabaseNotConfiguredError";
  }
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "unknown error";
}

let client: postgres.Sql | undefined;
let database: Database | undefined;
let reachable: Promise<void> | undefined;

/**
 * The shared client, created on first use and never again.
 *
 * `onnotice` is silenced because Postgres notices are chatty and arrive on the
 * same path as everything else this module is careful not to print.
 */
function getClient(): postgres.Sql {
  const url = databaseUrl();
  if (url === undefined) throw new DatabaseNotConfiguredError();

  client ??= postgres(url, {
    ssl: "require",
    prepare: false,
    onnotice: () => {},
  });
  return client;
}

export function getDb(): Database {
  database ??= drizzle(getClient(), { schema });
  return database;
}

/**
 * Resolve once the database has answered a trivial query, and reject with a
 * redacted `DatabaseUnreachableError` if it will not.
 *
 * Memoised: the check runs once per process and every later caller awaits the
 * same promise, so this is a per-process startup cost rather than a per-request
 * round trip. Call it from a startup hook to fail at boot; the store awaits it
 * before its first query either way, so a broken database can never be mistaken
 * for an empty one.
 */
export function assertDatabaseReachable(): Promise<void> {
  reachable ??= (async () => {
    const client = getClient();
    try {
      await client`select 1`;
    } catch (cause) {
      /** Re-check on the next call: the outage may be transient. */
      reachable = undefined;
      throw new DatabaseUnreachableError(cause);
    }
  })();

  return reachable;
}

/**
 * Close the pool and forget the memoised client. For tests and for a graceful
 * shutdown; ordinary request handling never calls this.
 */
export async function closeDatabase(): Promise<void> {
  const open = client;
  client = undefined;
  database = undefined;
  reachable = undefined;
  if (open) await open.end({ timeout: 5 });
}
