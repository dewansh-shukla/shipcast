import type { Config } from "drizzle-kit";

/**
 * TICKET B1 — migration generation only.
 *
 * There is no provisioned database yet, so `npm run db:generate` writes SQL
 * into db/migrations and nothing applies it. `DATABASE_URL` is read only so
 * that `drizzle-kit push` works unchanged once Postgres exists.
 */
export default {
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
} satisfies Config;
