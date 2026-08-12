import { InMemoryIngestStore, getIngestStore } from "../../../db/store.ts";

/**
 * TICKET 10 — device-claim state.
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
 */

/** Ten minutes, as the ticket specifies. */
export const CODE_TTL_MS = 10 * 60 * 1000;

/** Seconds the CLI should wait between polls. */
export const POLL_INTERVAL_SECONDS = 2;

/**
 * No I, L, O, 0 or 1. The code is read off a terminal and typed into a browser,
 * so the alphabet matters more than the entropy: 31^8 is ~39 bits, which is far
 * beyond what a ten-minute single-use code needs.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export type ClaimState = "pending" | "approved" | "denied";

/** What a poll or a page lookup sees. Never includes the device code. */
export type ClaimStatus = "pending" | "approved" | "denied" | "expired" | "used" | "unknown";

export interface ApprovedIdentity {
  handle: string;
  githubId: string | null;
  avatarUrl: string | null;
}

export interface ClaimRecord {
  userCode: string;
  deviceCode: string;
  /** The handle the CLI believes it is publishing for. Advisory only. */
  handleHint: string | null;
  createdAt: number;
  expiresAt: number;
  state: ClaimState;
  /** OAuth CSRF state, minted when the browser starts the GitHub round trip. */
  oauthState: string | null;
  identity: ApprovedIdentity | null;
  builderId: string | null;
  token: string | null;
  /** True once the CLI has collected the token. Makes the code single-use. */
  delivered: boolean;
  lastPolledAt: number | null;
}

/** A record as the browser is allowed to see it — no device code, no token. */
export interface PublicClaim {
  userCode: string;
  status: ClaimStatus;
  handleHint: string | null;
  handle: string | null;
  expiresInSeconds: number;
}

/** The subset of a builder row the claim flow needs to remember. */
interface LinkedBuilder {
  id: string;
  handle: string;
}

export class ClaimUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimUnavailableError";
  }
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

function statusOf(record: ClaimRecord, now: number): ClaimStatus {
  if (record.delivered) return "used";
  if (record.state === "denied") return "denied";
  if (record.state === "approved") return "approved";
  return now >= record.expiresAt ? "expired" : "pending";
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

export class ClaimStore {
  private readonly byUserCode = new Map<string, ClaimRecord>();
  private readonly byDeviceCode = new Map<string, string>();
  private readonly byOauthState = new Map<string, string>();
  /**
   * handle (lowercased) → the builder it resolved to. The ingest store can
   * create builders and issue tokens but cannot yet look one up by handle, so a
   * second claim by the same person would otherwise mint a duplicate builder
   * row. Ticket 12 owns that store; this map stands in until it grows the read
   * method.
   */
  private readonly buildersByHandle = new Map<string, LinkedBuilder>();

  start(handleHint: string | null, now = Date.now()): StartedClaim {
    this.prune(now);

    const record: ClaimRecord = {
      userCode: randomCode(),
      deviceCode: randomHex(32),
      handleHint: handleHint && isValidHandle(handleHint) ? handleHint : null,
      createdAt: now,
      expiresAt: now + CODE_TTL_MS,
      state: "pending",
      oauthState: null,
      identity: null,
      builderId: null,
      token: null,
      delivered: false,
      lastPolledAt: null,
    };

    this.byUserCode.set(record.userCode, record);
    this.byDeviceCode.set(record.deviceCode, record.userCode);

    return {
      userCode: record.userCode,
      deviceCode: record.deviceCode,
      expiresInSeconds: Math.round(CODE_TTL_MS / 1000),
      intervalSeconds: POLL_INTERVAL_SECONDS,
    };
  }

  /** Browser-side lookup. Returns null for a code that never existed. */
  lookup(userCode: string, now = Date.now()): PublicClaim | null {
    const record = this.byUserCode.get(normalizeUserCode(userCode));
    if (!record) return null;

    return {
      userCode: record.userCode,
      status: statusOf(record, now),
      handleHint: record.handleHint,
      handle: record.identity?.handle ?? null,
      expiresInSeconds: Math.max(0, Math.round((record.expiresAt - now) / 1000)),
    };
  }

  /** Attach a freshly minted OAuth `state` to a pending code. */
  beginOauth(userCode: string, now = Date.now()): { state: string } | { error: ClaimStatus } {
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

  userCodeForOauthState(state: string): string | null {
    return this.byOauthState.get(state) ?? null;
  }

  /**
   * Approve a code as a GitHub identity and mint the bearer token.
   *
   * Single-use: a code that is already approved, denied, expired or spent is
   * refused rather than re-approved, so a code read off a screen cannot be
   * replayed into a second token.
   */
  approve(userCode: string, identity: ApprovedIdentity, now = Date.now()): ApprovalResult {
    const record = this.byUserCode.get(normalizeUserCode(userCode));
    if (!record) return { ok: false, status: "unknown" };

    const status = statusOf(record, now);
    if (status !== "pending") return { ok: false, status };
    if (!isValidHandle(identity.handle)) return { ok: false, status: "denied" };

    const token = randomToken();
    const builder = this.linkBuilder(identity, token);

    record.state = "approved";
    record.identity = { ...identity, handle: builder.handle };
    record.builderId = builder.id;
    record.token = token;
    if (record.oauthState) {
      this.byOauthState.delete(record.oauthState);
      record.oauthState = null;
    }

    return { ok: true, status: "approved", handle: builder.handle };
  }

  deny(userCode: string, now = Date.now()): ApprovalResult {
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

  /**
   * The CLI's poll. Hands the token over exactly once; every later poll for the
   * same device code reports `used` rather than re-issuing it.
   */
  poll(
    deviceCode: string,
    now = Date.now(),
  ): { status: ClaimStatus; token?: string; handle?: string; retryAfterSeconds?: number } {
    const userCode = this.byDeviceCode.get(deviceCode);
    const record = userCode ? this.byUserCode.get(userCode) : undefined;
    if (!record) return { status: "unknown" };

    /** Cheap flood control. The CLI is told the interval; hold it to it. */
    if (record.lastPolledAt !== null && now - record.lastPolledAt < POLL_INTERVAL_SECONDS * 500) {
      return { status: "pending", retryAfterSeconds: POLL_INTERVAL_SECONDS };
    }
    record.lastPolledAt = now;

    const status = statusOf(record, now);
    if (status !== "approved") return { status };

    record.delivered = true;
    return { status: "approved", token: record.token!, handle: record.identity!.handle };
  }

  /**
   * Find or create the builder this token belongs to, and register the token
   * with the ingest store so `/api/ingest` resolves it.
   *
   * A second claim by the same person must reuse the first builder row —
   * otherwise their two windows land under two ids and only one of them is ever
   * on the board.
   */
  private linkBuilder(identity: ApprovedIdentity, token: string): LinkedBuilder {
    const store = getIngestStore();
    if (!(store instanceof InMemoryIngestStore)) {
      throw new ClaimUnavailableError("the active ingest store cannot issue device tokens");
    }

    const key = identity.handle.toLowerCase();
    const existing = this.buildersByHandle.get(key);

    const builder: LinkedBuilder =
      existing ??
      (() => {
        const row = store.addBuilder({
          handle: identity.handle,
          githubId: identity.githubId,
          avatarUrl: identity.avatarUrl,
        });
        return { id: row.id, handle: row.handle };
      })();

    this.buildersByHandle.set(key, builder);
    store.issueToken(builder.id, token);
    return builder;
  }

  private prune(now: number): void {
    for (const [userCode, record] of this.byUserCode) {
      if (now - record.expiresAt < CODE_TTL_MS) continue;
      this.byUserCode.delete(userCode);
      this.byDeviceCode.delete(record.deviceCode);
      if (record.oauthState) this.byOauthState.delete(record.oauthState);
    }
  }
}

/**
 * The store hangs off `globalThis`, not off a module-level binding.
 *
 * Next gives route handlers and server-rendered pages separate module graphs,
 * so a plain module singleton is instantiated twice: the CLI would claim a code
 * through the route handler and the approval page would render "no such code"
 * for it. Verified against `next dev` — this is not a theoretical concern. The
 * same indirection survives hot reload in development.
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

export function getClaimStore(): ClaimStore {
  const current = slot();
  current.store ??= new ClaimStore();
  return current.store;
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
