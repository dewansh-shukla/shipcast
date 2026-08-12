import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import {
  assertDatabaseReachable,
  getDb,
  isDatabaseConfigured,
  redact,
} from "../../../db/client.ts";
import { claimCodes } from "../../../db/schema.ts";
import type { BuilderRow, ClaimCodeRow } from "../../../db/schema.ts";
import { getIngestStore, type IngestStore } from "../../../db/store.ts";
import type { IngestDatabase } from "../../../db/postgres-store.ts";

/**
 * TICKET 10 — device-claim state. TICKET 20 — and it has to survive the trip.
 *
 * The collector runs on a machine with no browser session and must never ask
 * for a password or a GitHub token. So it asks for a code, the user approves
 * that code in a browser where they are already signed in with GitHub, and the
 * server hands the collector a bearer token bound to the handle GitHub
 * reported. This is the shape of RFC 8628, for the same reason it exists there.
 *
 * Two codes, not one:
 *
 * - `userCode` is short, unambiguous and appears in the URL the CLI prints. It
 *   is on screen, over a shoulder, in a screen recording.
 * - `deviceCode` is a secret the CLI keeps and polls with. Seeing the printed
 *   URL is therefore not enough to steal the token that approval mints.
 *
 * A code lives ten minutes and is single-use in both directions: it can be
 * approved once, and the token it mints is handed to the CLI once.
 *
 * ## Why this is not a Map any more
 *
 * The flow spans three requests — the CLI issues a code, the browser opens the
 * approval page, GitHub redirects back to the callback — and on Vercel none of
 * them need land on the same instance. In-memory state meant the page answered
 * "No such code" for a code issued seconds earlier, which is the first thing a
 * stranger sees and the reason nobody could join the board. The OAuth state is
 * persisted for the same reason: fixing only the user code moves the failure
 * one step later, into the callback.
 *
 * Both implementations live here and `getClaimStore()` picks between them on
 * `DATABASE_URL`, exactly as `getIngestStore()` does, so the suite still runs
 * without a database.
 */

/** Ten minutes, as the ticket specifies. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Seconds the CLI should wait between polls. */
export const POLL_INTERVAL_SECONDS = 2;

/**
 * How long an expired row is kept before it is swept.
 *
 * Deleting on the stroke of expiry would turn "your code expired, run it again"
 * into "no such code", which reads as a bug on the one screen that cannot
 * afford to.
 */
const SWEEP_GRACE_MS = CODE_TTL_MS;

/**
 * No I, L, O, 0 or 1. The code is read off a terminal and typed into a browser,
 * so the alphabet matters more than the entropy: 31^8 is ~39 bits, which is far
 * beyond what a ten-minute single-use code needs.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export type ClaimState = "pending" | "approved" | "denied" | "consumed";

/** What a poll or a page lookup sees. Never includes the device code. */
export type ClaimStatus = "pending" | "approved" | "denied" | "expired" | "used" | "unknown";

export interface ApprovedIdentity {
  handle: string;
  githubId: string | null;
  avatarUrl: string | null;
}

/** A record as the browser is allowed to see it — no device code, no token. */
export interface PublicClaim {
  userCode: string;
  status: ClaimStatus;
  handleHint: string | null;
  handle: string | null;
  expiresInSeconds: number;
}

export interface StartedClaim {
  userCode: string;
  deviceCode: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export interface ApprovalResult {
  ok: boolean;
  status: ClaimStatus;
  handle?: string;
}

export interface PollResult {
  status: ClaimStatus;
  token?: string;
  handle?: string;
  retryAfterSeconds?: number;
}

export type BeginOauthResult = { state: string } | { error: ClaimStatus };

export class ClaimUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimUnavailableError";
  }
}

/**
 * The claim flow's storage contract.
 *
 * Every method is async because one implementation talks to Postgres. The
 * in-memory one satisfies it without awaiting anything real, which is what
 * keeps the test suite database-free.
 */
export interface ClaimStore {
  start(handleHint: string | null, now?: number): Promise<StartedClaim>;
  lookup(userCode: string, now?: number): Promise<PublicClaim | null>;
  beginOauth(userCode: string, now?: number): Promise<BeginOauthResult>;
  userCodeForOauthState(state: string, now?: number): Promise<string | null>;
  approve(userCode: string, identity: ApprovedIdentity, now?: number): Promise<ApprovalResult>;
  deny(userCode: string, now?: number): Promise<ApprovalResult>;
  poll(deviceCode: string, now?: number): Promise<PollResult>;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function randomHex(byteLength: number): string {
  return [...randomBytes(byteLength)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Rejection sampling, not modulo. 256 is not a multiple of 31, so `byte % 31`
 * would make the first nine letters of the alphabet measurably likelier.
 */
function randomCode(): string {
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= 248) continue;
      code += ALPHABET[byte % ALPHABET.length];
      if (code.length === CODE_LENGTH) break;
    }
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function randomToken(): string {
  const bytes = randomBytes(32);
  const binary = String.fromCharCode(...bytes);
  const base64 = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `aow_${base64}`;
}

/**
 * The device code is looked up by hash, never by value.
 *
 * A hash lookup is what keeps the comparison from leaking: the index — a Map
 * here, a b-tree in Postgres — only ever sees the digest of what the caller
 * presented, and a digest cannot be walked backwards into the secret one byte
 * at a time the way a prefix comparison on the raw code could be. It is also
 * why a leaked `claim_codes` row cannot be polled with.
 */
export function hashDeviceCode(deviceCode: string): string {
  return createHash("sha256").update(deviceCode, "utf8").digest("hex");
}

/** Constant-time equality for two hex digests of equal length. */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Codes get retyped, lowercased, and pasted with or without the dash. Accept
 * all of that and compare on one canonical form.
 */
export function normalizeUserCode(input: string): string {
  const stripped = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
  return stripped.length === CODE_LENGTH
    ? `${stripped.slice(0, 4)}-${stripped.slice(4)}`
    : stripped;
}

/** The same handle rule the ingest payload enforces. */
export function isValidHandle(handle: string): boolean {
  return /^[a-zA-Z0-9-]{1,39}$/.test(handle);
}

/** The facts any implementation needs to answer "what state is this code in". */
interface ClaimFacts {
  state: ClaimState;
  expiresAt: number;
}

function statusOf(facts: ClaimFacts, now: number): ClaimStatus {
  if (facts.state === "consumed") return "used";
  if (facts.state === "denied") return "denied";
  if (facts.state === "approved") return "approved";
  return now >= facts.expiresAt ? "expired" : "pending";
}

/** True when this poll arrived sooner than the interval the CLI was given. */
function polledTooSoon(lastPolledAt: number | null, now: number): boolean {
  return lastPolledAt !== null && now - lastPolledAt < POLL_INTERVAL_SECONDS * 500;
}

/**
 * What the claim flow needs from a store beyond `IngestStore`: somewhere to put
 * a builder and somewhere to put a token. Both implementations satisfy it —
 * structurally, so adding a third store does not mean editing this file.
 */
interface TokenIssuingStore {
  upsertBuilder(init: {
    handle: string;
    githubId?: string | null;
    avatarUrl?: string | null;
  }): Promise<BuilderRow>;
  issueToken(builderId: string, token: string): void | Promise<void>;
}

function canIssueTokens(store: IngestStore): store is IngestStore & TokenIssuingStore {
  const candidate = store as Partial<TokenIssuingStore>;
  return (
    typeof candidate.upsertBuilder === "function" && typeof candidate.issueToken === "function"
  );
}

function tokenIssuer(): IngestStore & TokenIssuingStore {
  const store = getIngestStore();
  if (!canIssueTokens(store)) {
    throw new ClaimUnavailableError("the active ingest store cannot issue device tokens");
  }
  return store;
}

/**
 * Find or create the builder behind a GitHub identity.
 *
 * A second claim by the same person must reuse the first builder row —
 * otherwise their weeks land under two ids and only one is ever ranked.
 * `upsertBuilder` does that lookup in whichever store is active.
 */
async function resolveBuilder(identity: ApprovedIdentity): Promise<BuilderRow> {
  return tokenIssuer().upsertBuilder({
    handle: identity.handle,
    githubId: identity.githubId,
    avatarUrl: identity.avatarUrl,
  });
}

/**
 * Mint the bearer token for a builder.
 *
 * Deliberately called when the CLI *collects* the token, not when the browser
 * approves. The claim row therefore never holds a live credential: an approved
 * code carries a builder id and nothing a leaked row could publish with. It
 * also means a code that is approved and never polled mints nothing at all.
 */
async function mintTokenFor(builderId: string): Promise<string> {
  const store = tokenIssuer();
  const token = randomToken();
  await store.issueToken(builderId, token);
  return token;
}

interface MemoryRecord extends ClaimFacts {
  userCode: string;
  deviceCodeHash: string;
  handleHint: string | null;
  oauthState: string | null;
  builderId: string | null;
  handle: string | null;
  lastPolledAt: number | null;
}

/**
 * The store a process without `DATABASE_URL` gets.
 *
 * Still correct for a single long-lived server and for the whole test suite; it
 * is only wrong across instances, which is what the Postgres one is for.
 */
export class InMemoryClaimStore implements ClaimStore {
  private readonly byUserCode = new Map<string, MemoryRecord>();
  private readonly byDeviceHash = new Map<string, string>();
  private readonly byOauthState = new Map<string, string>();

  async start(handleHint: string | null, now = Date.now()): Promise<StartedClaim> {
    this.sweep(now);

    const deviceCode = randomHex(32);
    const record: MemoryRecord = {
      userCode: randomCode(),
      deviceCodeHash: hashDeviceCode(deviceCode),
      handleHint: handleHint && isValidHandle(handleHint) ? handleHint : null,
      expiresAt: now + CODE_TTL_MS,
      state: "pending",
      oauthState: null,
      builderId: null,
      handle: null,
      lastPolledAt: null,
    };

    this.byUserCode.set(record.userCode, record);
    this.byDeviceHash.set(record.deviceCodeHash, record.userCode);

    return {
      userCode: record.userCode,
      deviceCode,
      expiresInSeconds: Math.round(CODE_TTL_MS / 1000),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }

  async lookup(userCode: string, now = Date.now()): Promise<PublicClaim | null> {
    this.sweep(now);
    const record = this.byUserCode.get(normalizeUserCode(userCode));
    if (!record) return null;

    return {
      userCode: record.userCode,
      status: statusOf(record, now),
      handleHint: record.handleHint,
      handle: record.handle,
      expiresInSeconds: Math.max(0, Math.round((record.expiresAt - now) / 1000)),
    };
  }

  async beginOauth(userCode: string, now = Date.now()): Promise<BeginOauthResult> {
    const record = this.byUserCode.get(normalizeUserCode(userCode));
    if (!record) return { error: "unknown" };

    const status = statusOf(record, now);
    if (status !== "pending") return { error: status };

    if (record.oauthState) this.byOauthState.delete(record.oauthState);
    const state = randomHex(16);
    record.oauthState = state;
    this.byOauthState.set(state, record.userCode);
    return { state };
  }

  async userCodeForOauthState(state: string): Promise<string | null> {
    return this.byOauthState.get(state) ?? null;
  }

  async approve(
    userCode: string,
    identity: ApprovedIdentity,
    now = Date.now(),
  ): Promise<ApprovalResult> {
    const record = this.byUserCode.get(normalizeUserCode(userCode));
    if (!record) return { ok: false, status: "unknown" };

    const status = statusOf(record, now);
    if (status !== "pending") return { ok: false, status };
    if (!isValidHandle(identity.handle)) return { ok: false, status: "denied" };

    const builder = await resolveBuilder(identity);

    record.state = "approved";
    record.builderId = builder.id;
    record.handle = builder.handle;
    if (record.oauthState) {
      this.byOauthState.delete(record.oauthState);
      record.oauthState = null;
    }

    return { ok: true, status: "approved", handle: builder.handle };
  }

  async deny(userCode: string, now = Date.now()): Promise<ApprovalResult> {
    const record = this.byUserCode.get(normalizeUserCode(userCode));
    if (!record) return { ok: false, status: "unknown" };

    const status = statusOf(record, now);
    if (status !== "pending") return { ok: false, status };

    record.state = "denied";
    if (record.oauthState) {
      this.byOauthState.delete(record.oauthState);
      record.oauthState = null;
    }
    return { ok: true, status: "denied" };
  }

  async poll(deviceCode: string, now = Date.now()): Promise<PollResult> {
    const presented = hashDeviceCode(deviceCode);
    const userCode = this.byDeviceHash.get(presented);
    const record = userCode ? this.byUserCode.get(userCode) : undefined;
    if (!record || !digestsEqual(record.deviceCodeHash, presented)) return { status: "unknown" };

    if (polledTooSoon(record.lastPolledAt, now)) {
      return { status: "pending", retryAfterSeconds: POLL_INTERVAL_SECONDS };
    }
    record.lastPolledAt = now;

    const status = statusOf(record, now);
    if (status !== "approved") return { status };

    /** Burn the code first: a token is minted for a delivery that happened. */
    record.state = "consumed";
    const token = await mintTokenFor(record.builderId!);
    return { status: "approved", token, handle: record.handle! };
  }

  /** Expired rows go once reporting them as expired stops being useful. */
  private sweep(now: number): void {
    for (const [userCode, record] of this.byUserCode) {
      if (now - record.expiresAt < SWEEP_GRACE_MS) continue;
      this.byUserCode.delete(userCode);
      this.byDeviceHash.delete(record.deviceCodeHash);
      if (record.oauthState) this.byOauthState.delete(record.oauthState);
    }
  }
}

function factsOf(row: ClaimCodeRow): ClaimFacts {
  return { state: row.status, expiresAt: row.expiresAt.getTime() };
}

/**
 * The same store against Postgres, so a code issued by one instance resolves on
 * every other one.
 *
 * The state transitions are conditional UPDATEs rather than read-then-write.
 * Two browser tabs approving the same code, or two polls racing, are the cases
 * that would otherwise mint two tokens from one single-use code; `WHERE status
 * = 'pending'` makes the database the thing that decides who won.
 */
export class PostgresClaimStore implements ClaimStore {
  private readonly db: IngestDatabase;
  private readonly ownsDefaultClient: boolean;

  constructor(db?: IngestDatabase) {
    this.ownsDefaultClient = db === undefined;
    this.db = db ?? (getDb() as unknown as IngestDatabase);
  }

  /** As in `PostgresIngestStore`: one clear, credential-free error on failure. */
  private async query<T>(run: (db: IngestDatabase) => Promise<T>): Promise<T> {
    if (this.ownsDefaultClient) await assertDatabaseReachable();

    try {
      return await run(this.db);
    } catch (cause) {
      if (cause instanceof ClaimUnavailableError) throw cause;
      throw new Error(redact(cause instanceof Error ? cause.message : "database query failed"));
    }
  }

  async start(handleHint: string | null, now = Date.now()): Promise<StartedClaim> {
    const deviceCode = randomHex(32);
    const userCode = randomCode();

    await this.query(async (db) => {
      await db.delete(claimCodes).where(lt(claimCodes.expiresAt, new Date(now - SWEEP_GRACE_MS)));
      await db.insert(claimCodes).values({
        userCode,
        deviceCodeHash: hashDeviceCode(deviceCode),
        handleHint: handleHint && isValidHandle(handleHint) ? handleHint : null,
        status: "pending",
        createdAt: new Date(now),
        expiresAt: new Date(now + CODE_TTL_MS),
      });
    });

    return {
      userCode,
      deviceCode,
      expiresInSeconds: Math.round(CODE_TTL_MS / 1000),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }

  async lookup(userCode: string, now = Date.now()): Promise<PublicClaim | null> {
    const code = normalizeUserCode(userCode);
    const row = await this.query(async (db) => {
      await db.delete(claimCodes).where(lt(claimCodes.expiresAt, new Date(now - SWEEP_GRACE_MS)));
      const [found] = await db.select().from(claimCodes).where(eq(claimCodes.userCode, code));
      return found;
    });
    if (!row) return null;

    return {
      userCode: row.userCode,
      status: statusOf(factsOf(row), now),
      handleHint: row.handleHint,
      handle: row.handle,
      expiresInSeconds: Math.max(0, Math.round((row.expiresAt.getTime() - now) / 1000)),
    };
  }

  async beginOauth(userCode: string, now = Date.now()): Promise<BeginOauthResult> {
    const code = normalizeUserCode(userCode);
    const state = randomHex(16);

    const updated = await this.query(async (db) =>
      db
        .update(claimCodes)
        .set({ oauthState: state })
        .where(
          and(
            eq(claimCodes.userCode, code),
            eq(claimCodes.status, "pending"),
            gt(claimCodes.expiresAt, new Date(now)),
          ),
        )
        .returning(),
    );

    if (updated.length > 0) return { state };

    /** No row moved: say precisely why, so the page can. */
    const existing = await this.lookup(code, now);
    return { error: existing?.status ?? "unknown" };
  }

  async userCodeForOauthState(state: string, now = Date.now()): Promise<string | null> {
    if (state === "") return null;

    const row = await this.query(async (db) => {
      const [found] = await db
        .select({ userCode: claimCodes.userCode, expiresAt: claimCodes.expiresAt })
        .from(claimCodes)
        .where(eq(claimCodes.oauthState, state));
      return found;
    });

    if (!row) return null;
    /** A state outlives nothing: an expired code's callback is not honoured. */
    return row.expiresAt.getTime() > now - SWEEP_GRACE_MS ? row.userCode : null;
  }

  async approve(
    userCode: string,
    identity: ApprovedIdentity,
    now = Date.now(),
  ): Promise<ApprovalResult> {
    const code = normalizeUserCode(userCode);

    const existing = await this.lookup(code, now);
    if (!existing) return { ok: false, status: "unknown" };
    if (existing.status !== "pending") return { ok: false, status: existing.status };
    if (!isValidHandle(identity.handle)) return { ok: false, status: "denied" };

    /**
     * The builder is resolved before the update so the row is only ever moved
     * to `approved` once there is a builder to bind it to.
     */
    const builder = await resolveBuilder(identity);

    const updated = await this.query(async (db) =>
      db
        .update(claimCodes)
        .set({
          status: "approved",
          builderId: builder.id,
          handle: builder.handle,
          approvedAt: new Date(now),
          oauthState: null,
        })
        .where(
          and(
            eq(claimCodes.userCode, code),
            eq(claimCodes.status, "pending"),
            gt(claimCodes.expiresAt, new Date(now)),
          ),
        )
        .returning(),
    );

    /** Somebody else approved it between the read and the write. */
    if (updated.length === 0) {
      const now2 = await this.lookup(code, now);
      return { ok: false, status: now2?.status ?? "unknown" };
    }

    return { ok: true, status: "approved", handle: builder.handle };
  }

  async deny(userCode: string, now = Date.now()): Promise<ApprovalResult> {
    const code = normalizeUserCode(userCode);

    const updated = await this.query(async (db) =>
      db
        .update(claimCodes)
        .set({ status: "denied", oauthState: null })
        .where(
          and(
            eq(claimCodes.userCode, code),
            eq(claimCodes.status, "pending"),
            gt(claimCodes.expiresAt, new Date(now)),
          ),
        )
        .returning(),
    );

    if (updated.length > 0) return { ok: true, status: "denied" };

    const existing = await this.lookup(code, now);
    return { ok: false, status: existing?.status ?? "unknown" };
  }

  async poll(deviceCode: string, now = Date.now()): Promise<PollResult> {
    const presented = hashDeviceCode(deviceCode);

    const row = await this.query(async (db) => {
      const [found] = await db
        .select()
        .from(claimCodes)
        .where(eq(claimCodes.deviceCodeHash, presented));
      return found;
    });

    if (!row || !digestsEqual(row.deviceCodeHash, presented)) return { status: "unknown" };

    if (polledTooSoon(row.lastPolledAt?.getTime() ?? null, now)) {
      return { status: "pending", retryAfterSeconds: POLL_INTERVAL_SECONDS };
    }

    const status = statusOf(factsOf(row), now);
    if (status !== "approved") {
      await this.query(async (db) => {
        await db
          .update(claimCodes)
          .set({ lastPolledAt: new Date(now) })
          .where(eq(claimCodes.id, row.id));
      });
      return { status };
    }

    /**
     * Claim the delivery before minting. If two polls race, exactly one moves
     * the row out of `approved` and only that one gets a token — the other is
     * told the code was already used, which is what single-use means.
     */
    const claimed = await this.query(async (db) =>
      db
        .update(claimCodes)
        .set({ status: "consumed", lastPolledAt: new Date(now) })
        .where(and(eq(claimCodes.id, row.id), eq(claimCodes.status, "approved")))
        .returning(),
    );

    const won = claimed[0];
    if (!won || won.builderId === null) return { status: "used" };

    const token = await mintTokenFor(won.builderId);
    return { status: "approved", token, handle: won.handle ?? "" };
  }
}

/**
 * The store hangs off `globalThis`, not off a module-level binding.
 *
 * Next gives route handlers and server-rendered pages separate module graphs,
 * so a plain module singleton is instantiated twice: the CLI would claim a code
 * through the route handler and the approval page would render "no such code"
 * for it. Verified against `next dev` — this is not a theoretical concern, and
 * it is the same bug at process scale that ticket 20 fixes at instance scale.
 */
const CLAIM_STORE_SLOT = Symbol.for("ao-wrapped.claim-store");

interface ClaimStoreSlot {
  store?: ClaimStore | null;
}

function slot(): ClaimStoreSlot {
  const container = globalThis as unknown as Record<symbol, ClaimStoreSlot | undefined>;
  container[CLAIM_STORE_SLOT] ??= {};
  return container[CLAIM_STORE_SLOT]!;
}

/**
 * Postgres when `DATABASE_URL` is set, memory when it is not — the same rule
 * `getIngestStore()` follows, and for the same reason: there is deliberately no
 * third case where a configured database silently degrades to memory.
 */
export function getClaimStore(): ClaimStore {
  const current = slot();
  current.store ??= isDatabaseConfigured() ? new PostgresClaimStore() : new InMemoryClaimStore();
  return current.store;
}

/** Swap the active store. Tests use this; nothing else should. */
export function setClaimStore(store: ClaimStore | null): void {
  slot().store = store;
}

/** Drop all in-flight codes. Tests call this; nothing else should. */
export function resetClaimStore(): void {
  slot().store = null;
}

/** True when a real GitHub OAuth app is configured for this deployment. */
export function isGithubConfigured(): boolean {
  return Boolean(process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim());
}

/**
 * Approving without GitHub is a local-development affordance and must never be
 * reachable in production: it would let anyone claim any handle.
 */
export function isLocalApprovalAllowed(): boolean {
  return !isGithubConfigured() && process.env.NODE_ENV !== "production";
}

/** Absolute origin for redirect URLs. Configured value wins over the request. */
export function siteOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (configured) {
    return new URL(configured.startsWith("http") ? configured : `https://${configured}`).origin;
  }
  return new URL(request.url).origin;
}
