import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresIngestStore, type IngestDatabase } from "../../../db/postgres-store.ts";
import { claimCodes } from "../../../db/schema.ts";
import { InMemoryIngestStore, setIngestStore } from "../../../db/store.ts";
import {
  CODE_TTL_MS,
  InMemoryClaimStore,
  PostgresClaimStore,
  hashDeviceCode,
  type ClaimStore,
} from "./store.ts";

/**
 * TICKET 20 — claim codes, across instances.
 *
 * The defect these exist for is not visible in a single process: the code was
 * issued on one Vercel instance and looked up on another, whose Maps were
 * empty, so the approval page said "No such code" for a code seconds old.
 *
 * So the Postgres cases below deliberately build a *second store object* — the
 * same thing a second serverless invocation gets — and resolve through it. The
 * in-memory store cannot do that and is not asked to; it is asked to keep every
 * other property intact so a contributor without a database can still run the
 * suite.
 *
 * PGlite is real Postgres in this process, so the conditional updates that make
 * a code single-use are exercised as database behaviour rather than mocked.
 */

const MIGRATIONS = [
  "0000_init.sql",
  "0001_weekly_seasons.sql",
  "0002_device_tokens.sql",
  "0003_claim_codes.sql",
];

async function applyMigrations(pg: PGlite): Promise<void> {
  for (const file of MIGRATIONS) {
    const sql = await readFile(join(import.meta.dirname, "../../../db/migrations", file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() === "") continue;
      await pg.exec(statement);
    }
  }
}

const IDENTITY = { handle: "octocat", githubId: "583231", avatarUrl: null };
const NOW = Date.parse("2026-08-13T09:00:00.000Z");

let pg: PGlite;
let db: IngestDatabase;

beforeAll(async () => {
  pg = new PGlite();
  await pg.waitReady;
  await applyMigrations(pg);
  db = drizzle(pg) as unknown as IngestDatabase;
});

afterAll(async () => {
  await pg.close();
});

afterEach(() => {
  setIngestStore(null);
});

/**
 * Both implementations, behind one factory, so the contract below is written
 * once and proved twice. `fresh()` is the interesting part: for Postgres it
 * returns a store that shares nothing with the first but the database, which is
 * what a second serverless instance is.
 */
interface Backend {
  name: string;
  make: () => Promise<{ store: ClaimStore; fresh: () => ClaimStore }>;
}

const BACKENDS: Backend[] = [
  {
    name: "in memory",
    make: async () => {
      setIngestStore(new InMemoryIngestStore());
      const store = new InMemoryClaimStore();
      return { store, fresh: () => store };
    },
  },
  {
    name: "postgres",
    make: async () => {
      await db.delete(claimCodes);
      await pg.exec("TRUNCATE builders, device_tokens, snapshots, agent_stats CASCADE");
      setIngestStore(new PostgresIngestStore(db));
      return { store: new PostgresClaimStore(db), fresh: () => new PostgresClaimStore(db) };
    },
  },
];

describe.each(BACKENDS)("the claim contract ($name)", (backend) => {
  let store: ClaimStore;
  let fresh: () => ClaimStore;

  beforeEach(async () => {
    ({ store, fresh } = await backend.make());
  });

  it("issues a short code and a separate polling secret", async () => {
    const started = await store.start("octocat", NOW);

    expect(started.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(started.deviceCode).toMatch(/^[0-9a-f]{64}$/);
    expect(started.deviceCode).not.toContain(started.userCode);
    expect(started.expiresInSeconds).toBe(600);
    expect(started.intervalSeconds).toBe(2);
  });

  it("reports a pending code to the browser without leaking the device code", async () => {
    const started = await store.start("octocat", NOW);

    const claim = await fresh().lookup(started.userCode, NOW);

    expect(claim).toMatchObject({
      userCode: started.userCode,
      status: "pending",
      handleHint: "octocat",
      handle: null,
    });
    expect(JSON.stringify(claim)).not.toContain(started.deviceCode);
  });

  it("hands the token over once, bound to the approved handle", async () => {
    const started = await store.start("octocat", NOW);

    await expect(fresh().approve(started.userCode, IDENTITY, NOW)).resolves.toEqual({
      ok: true,
      status: "approved",
      handle: "octocat",
    });

    const polled = await fresh().poll(started.deviceCode, NOW + 3_000);
    expect(polled.status).toBe("approved");
    expect(polled.handle).toBe("octocat");
    expect(polled.token).toMatch(/^aow_/);

    /** Single-use: the second collection gets nothing. */
    const again = await fresh().poll(started.deviceCode, NOW + 9_000);
    expect(again.status).toBe("used");
    expect(again.token).toBeUndefined();
  });

  it("refuses to approve the same code twice", async () => {
    const started = await store.start("octocat", NOW);
    await store.approve(started.userCode, IDENTITY, NOW);

    const second = await fresh().approve(
      started.userCode,
      { handle: "someone-else", githubId: null, avatarUrl: null },
      NOW + 1_000,
    );

    expect(second).toEqual({ ok: false, status: "approved" });
    const polled = await fresh().poll(started.deviceCode, NOW + 3_000);
    expect(polled.handle).toBe("octocat");
  });

  it("refuses to approve a code that was already spent", async () => {
    const started = await store.start("octocat", NOW);
    await store.approve(started.userCode, IDENTITY, NOW);
    await store.poll(started.deviceCode, NOW + 3_000);

    await expect(fresh().approve(started.userCode, IDENTITY, NOW + 5_000)).resolves.toMatchObject({
      ok: false,
      status: "used",
    });
  });

  it("expires a code after ten minutes", async () => {
    const started = await store.start("octocat", NOW);
    const expired = NOW + CODE_TTL_MS + 1_000;

    await expect(fresh().lookup(started.userCode, expired)).resolves.toMatchObject({
      status: "expired",
    });
    await expect(fresh().approve(started.userCode, IDENTITY, expired)).resolves.toEqual({
      ok: false,
      status: "expired",
    });
    await expect(fresh().poll(started.deviceCode, expired)).resolves.toEqual({ status: "expired" });
  });

  it("honours a code approved with a second to spare", async () => {
    const started = await store.start("octocat", NOW);
    const nearly = NOW + CODE_TTL_MS - 1_000;

    await expect(fresh().approve(started.userCode, IDENTITY, nearly)).resolves.toMatchObject({
      ok: true,
    });
    await expect(fresh().poll(started.deviceCode, nearly + 500)).resolves.toMatchObject({
      status: "approved",
    });
  });

  it("carries the OAuth state across the GitHub round trip", async () => {
    const started = await store.start("octocat", NOW);

    const begun = await store.beginOauth(started.userCode, NOW);
    expect(begun).toHaveProperty("state");
    if (!("state" in begun)) return;

    /** The callback is a third request, and may be a third instance. */
    await expect(fresh().userCodeForOauthState(begun.state, NOW + 2_000)).resolves.toBe(
      started.userCode,
    );
  });

  it("does not recognise a state it never issued", async () => {
    await store.start("octocat", NOW);

    await expect(fresh().userCodeForOauthState("forged", NOW)).resolves.toBeNull();
    await expect(fresh().userCodeForOauthState("", NOW)).resolves.toBeNull();
  });

  it("retires the OAuth state once the code is decided", async () => {
    const started = await store.start("octocat", NOW);
    const begun = await store.beginOauth(started.userCode, NOW);
    if (!("state" in begun)) throw new Error("expected a state");

    await store.approve(started.userCode, IDENTITY, NOW + 1_000);

    await expect(fresh().userCodeForOauthState(begun.state, NOW + 2_000)).resolves.toBeNull();
  });

  it("will not start an OAuth round trip for a code that is not pending", async () => {
    const started = await store.start("octocat", NOW);
    await store.deny(started.userCode, NOW);

    await expect(fresh().beginOauth(started.userCode, NOW + 1_000)).resolves.toEqual({
      error: "denied",
    });
    await expect(fresh().beginOauth("ZZZZ-ZZZZ", NOW)).resolves.toEqual({ error: "unknown" });
  });

  it("declines a code and mints nothing", async () => {
    const started = await store.start("octocat", NOW);

    await expect(fresh().deny(started.userCode, NOW)).resolves.toEqual({
      ok: true,
      status: "denied",
    });
    const polled = await fresh().poll(started.deviceCode, NOW + 3_000);
    expect(polled).toEqual({ status: "denied" });
  });

  it("rejects a handle GitHub could not have issued", async () => {
    const started = await store.start(null, NOW);

    await expect(
      fresh().approve(
        started.userCode,
        { handle: "not a handle", githubId: null, avatarUrl: null },
        NOW,
      ),
    ).resolves.toEqual({ ok: false, status: "denied" });
    await expect(fresh().lookup(started.userCode, NOW)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("ignores a handle hint that is not a handle", async () => {
    const started = await store.start("not a handle", NOW);

    await expect(fresh().lookup(started.userCode, NOW)).resolves.toMatchObject({
      handleHint: null,
    });
  });

  it("accepts a code retyped in lower case or without its dash", async () => {
    const started = await store.start("octocat", NOW);
    const typed = started.userCode.replace("-", "").toLowerCase();

    await expect(fresh().lookup(typed, NOW)).resolves.toMatchObject({ status: "pending" });
    await expect(fresh().approve(typed, IDENTITY, NOW)).resolves.toMatchObject({ ok: true });
  });

  it("knows nothing about a device code it never issued", async () => {
    await store.start("octocat", NOW);

    await expect(fresh().poll("0".repeat(64), NOW)).resolves.toEqual({ status: "unknown" });
  });

  it("asks a CLI that polls too fast to slow down", async () => {
    const started = await store.start("octocat", NOW);

    await store.poll(started.deviceCode, NOW);
    await expect(fresh().poll(started.deviceCode, NOW + 100)).resolves.toEqual({
      status: "pending",
      retryAfterSeconds: 2,
    });
  });

  it("answers nothing for a code that never existed", async () => {
    await expect(fresh().lookup("ZZZZ-ZZZZ", NOW)).resolves.toBeNull();
    await expect(fresh().approve("ZZZZ-ZZZZ", IDENTITY, NOW)).resolves.toEqual({
      ok: false,
      status: "unknown",
    });
    await expect(fresh().deny("ZZZZ-ZZZZ", NOW)).resolves.toEqual({
      ok: false,
      status: "unknown",
    });
  });
});

describe("across instances (postgres)", () => {
  beforeEach(async () => {
    await db.delete(claimCodes);
    await pg.exec("TRUNCATE builders, device_tokens, snapshots, agent_stats CASCADE");
    setIngestStore(new PostgresIngestStore(db));
  });

  /**
   * The reported defect, end to end: issue on one instance, open the page on a
   * second, complete the GitHub round trip on a third, poll from a fourth.
   */
  it("carries a code through four separate instances", async () => {
    const cli = new PostgresClaimStore(db);
    const page = new PostgresClaimStore(db);
    const oauthStart = new PostgresClaimStore(db);
    const callback = new PostgresClaimStore(db);
    const poller = new PostgresClaimStore(db);

    const started = await cli.start("octocat", NOW);

    /** This is the request that used to answer "No such code". */
    await expect(page.lookup(started.userCode, NOW)).resolves.toMatchObject({ status: "pending" });

    const begun = await oauthStart.beginOauth(started.userCode, NOW + 1_000);
    if (!("state" in begun)) throw new Error("expected a state");

    await expect(callback.userCodeForOauthState(begun.state, NOW + 2_000)).resolves.toBe(
      started.userCode,
    );
    await expect(callback.approve(started.userCode, IDENTITY, NOW + 2_000)).resolves.toMatchObject({
      ok: true,
      handle: "octocat",
    });

    const polled = await poller.poll(started.deviceCode, NOW + 5_000);
    expect(polled.status).toBe("approved");
    expect(polled.token).toMatch(/^aow_/);

    /** And the token it handed over authorises publishing. */
    await expect(new PostgresIngestStore(db).builderForToken(polled.token!)).resolves.toMatchObject(
      { handle: "octocat" },
    );
  });

  it("never stores the device code in the clear", async () => {
    const started = await new PostgresClaimStore(db).start("octocat", NOW);

    const [row] = await db.select().from(claimCodes);
    expect(row!.deviceCodeHash).toBe(
      createHash("sha256").update(started.deviceCode, "utf8").digest("hex"),
    );
    expect(row!.deviceCodeHash).not.toBe(started.deviceCode);
    expect(JSON.stringify(row)).not.toContain(started.deviceCode);
  });

  it("never stores a bearer token on the claim row", async () => {
    const store = new PostgresClaimStore(db);
    const started = await store.start("octocat", NOW);
    await store.approve(started.userCode, IDENTITY, NOW);

    /** Approved, not yet collected: there is no credential in this row. */
    const [approved] = await db.select().from(claimCodes);
    expect(JSON.stringify(approved)).not.toContain("aow_");
    expect(approved!.builderId).not.toBeNull();

    const polled = await store.poll(started.deviceCode, NOW + 3_000);
    const [consumed] = await db.select().from(claimCodes);
    expect(JSON.stringify(consumed)).not.toContain(polled.token!);
    expect(consumed!.status).toBe("consumed");
  });

  it("lets exactly one of two racing approvals win", async () => {
    const started = await new PostgresClaimStore(db).start("octocat", NOW);

    const results = await Promise.all([
      new PostgresClaimStore(db).approve(started.userCode, IDENTITY, NOW),
      new PostgresClaimStore(db).approve(
        started.userCode,
        { handle: "someone-else", githubId: null, avatarUrl: null },
        NOW,
      ),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const [row] = await db.select().from(claimCodes);
    expect(row!.status).toBe("approved");
  });

  it("mints one token when two polls race", async () => {
    const store = new PostgresClaimStore(db);
    const started = await store.start("octocat", NOW);
    await store.approve(started.userCode, IDENTITY, NOW);

    const results = await Promise.all([
      new PostgresClaimStore(db).poll(started.deviceCode, NOW + 3_000),
      new PostgresClaimStore(db).poll(started.deviceCode, NOW + 3_000),
    ]);

    const delivered = results.filter((result) => result.token !== undefined);
    expect(delivered).toHaveLength(1);
    expect(results.some((result) => result.status === "used")).toBe(true);
  });

  it("sweeps expired rows on the next lookup rather than on a cron", async () => {
    const store = new PostgresClaimStore(db);
    const stale = await store.start("octocat", NOW);
    expect(await db.select().from(claimCodes)).toHaveLength(1);

    /** Still reported as expired for a grace period — "no such code" reads as a bug. */
    const justExpired = NOW + CODE_TTL_MS + 1_000;
    await expect(store.lookup(stale.userCode, justExpired)).resolves.toMatchObject({
      status: "expired",
    });

    /** Long past that, the row is gone the next time anything looks. */
    const later = NOW + CODE_TTL_MS * 3;
    await store.start("someone", later);
    const rows = await db.select().from(claimCodes);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userCode).not.toBe(stale.userCode);
  });

  it("does not honour a callback for a code that has been swept", async () => {
    const store = new PostgresClaimStore(db);
    const started = await store.start("octocat", NOW);
    const begun = await store.beginOauth(started.userCode, NOW);
    if (!("state" in begun)) throw new Error("expected a state");

    await expect(
      store.userCodeForOauthState(begun.state, NOW + CODE_TTL_MS * 3),
    ).resolves.toBeNull();
  });
});

describe("hashing", () => {
  it("is the plain SHA-256 the schema documents", () => {
    expect(hashDeviceCode("abc")).toBe(createHash("sha256").update("abc", "utf8").digest("hex"));
    expect(hashDeviceCode("abc")).not.toBe(hashDeviceCode("abd"));
  });
});
