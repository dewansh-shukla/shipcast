import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { IngestPayload } from "@ao-wrapped/shared";

/**
 * TICKET 10 — publish.
 *
 * Device-claim flow: the CLI requests a short code, the user approves it in the
 * browser while signed in with GitHub, and the CLI stores the returned bearer
 * token under ~/.ao-wrapped/. No password ever touches this process, and no
 * GitHub token is ever asked for — the whole interaction is "open this URL".
 *
 * Publishing is now the only way a builder appears on the board, so every
 * failure here has to leave the user knowing exactly what happened and that
 * their card is unaffected. A failed publish is not a failed run.
 *
 * `--dry-run` prints the exact JSON that would be sent and exits without
 * sending it. That flag is a demo beat, not a debug aid: it is how a viewer
 * verifies the privacy claim for themselves in one screen.
 */
export function dryRun(payload: IngestPayload): string {
  return JSON.stringify(payload, null, 2);
}

/**
 * Where the board lives when nothing says otherwise. Replace this constant when
 * the board is deployed; until then a local `next dev` is the only board there
 * is, and pointing at it beats failing with "no API configured".
 */
export const DEFAULT_API_BASE = "http://localhost:3000";

/** How long to keep polling past the server's stated expiry before giving up. */
const POLL_GRACE_MS = 15_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 2;
const REQUEST_TIMEOUT_MS = 15_000;

/** One board's credential. The token is bound to `handle` by the server. */
export interface StoredCredential {
  handle: string;
  token: string;
  issuedAt: string;
}

export interface CredentialsFile {
  version: 1;
  /** Keyed by normalized API base, so a second board does not evict the first. */
  boards: Record<string, StoredCredential>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PublishOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Where progress goes. Defaults to stdout. */
  write?: (text: string) => void;
  /** Overrides the credentials location. Tests use it; the CLI does not. */
  credentialsFile?: string;
}

/**
 * Anything the user should read as "publishing failed", never as "the run
 * failed". The message is printed verbatim, so it is written to be read.
 */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

/** `~/.ao-wrapped/credentials.json`, or `$AO_WRAPPED_HOME` when set. */
export function credentialsPath(): string {
  const home = process.env.AO_WRAPPED_HOME?.trim() || homedir();
  return join(home, ".ao-wrapped", "credentials.json");
}

const EMPTY: CredentialsFile = { version: 1, boards: {} };

/**
 * A credentials file we cannot parse is treated as absent rather than fatal:
 * the worst case is one extra approval, and refusing to publish because of a
 * mangled local file would be a strange way to fail.
 */
export function readCredentials(path = credentialsPath()): CredentialsFile {
  if (!existsSync(path)) return { ...EMPTY, boards: {} };

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return { ...EMPTY, boards: {} };

    const boards = (parsed as { boards?: unknown }).boards;
    if (typeof boards !== "object" || boards === null) return { ...EMPTY, boards: {} };

    const valid: Record<string, StoredCredential> = {};
    for (const [base, value] of Object.entries(boards as Record<string, unknown>)) {
      const entry = value as Partial<StoredCredential>;
      if (typeof entry?.handle === "string" && typeof entry?.token === "string") {
        valid[base] = {
          handle: entry.handle,
          token: entry.token,
          issuedAt: typeof entry.issuedAt === "string" ? entry.issuedAt : new Date(0).toISOString(),
        };
      }
    }
    return { version: 1, boards: valid };
  } catch {
    return { ...EMPTY, boards: {} };
  }
}

/**
 * The file holds bearer tokens, so it is created 0600 inside a 0700 directory
 * and re-chmodded on every write — `writeFileSync`'s mode only applies when it
 * creates the file, and a token in a world-readable file is a real leak.
 */
export function writeCredentials(file: CredentialsFile, path = credentialsPath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });

  /** No-ops on filesystems without POSIX modes; never a reason to fail a publish. */
  try {
    chmodSync(dir, 0o700);
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

export function saveCredential(base: string, credential: StoredCredential, path: string): void {
  const file = readCredentials(path);
  file.boards[base] = credential;
  writeCredentials(file, path);
}

export function forgetCredential(base: string, path: string): void {
  const file = readCredentials(path);
  if (!(base in file.boards)) return;
  delete file.boards[base];
  writeCredentials(file, path);
}

/** Trailing slashes and casing must not mint a second credential entry. */
export function normalizeBase(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new PublishError(
      `"${trimmed}" is not a URL. Pass --api https://board.example or set AO_WRAPPED_API.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PublishError(`board URL must be http or https, not ${url.protocol}`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

interface Deps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  write: (text: string) => void;
  credentialsFile: string;
}

function resolveDeps(options: PublishOptions): Deps {
  return {
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? (() => Date.now()),
    write: options.write ?? ((text) => void process.stdout.write(text)),
    credentialsFile: options.credentialsFile ?? credentialsPath(),
  };
}

function unreachable(base: string, cause: unknown): PublishError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new PublishError(
    `could not reach the board at ${base} (${detail}).\n` +
      `Nothing was sent. Your Wrapped card above already printed and is complete — ` +
      `only publishing needs the network.\n` +
      `Retry any time with: ao-wrapped --publish`,
  );
}

async function postJson(
  url: string,
  body: unknown,
  deps: Deps,
  headers: Record<string, string> = {},
): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function reasonFrom(body: Record<string, unknown>, fallback: string): string {
  const reason = body.reason ?? body.error;
  return typeof reason === "string" && reason ? reason : fallback;
}

interface StartedClaim {
  userCode: string;
  deviceCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

async function startClaim(base: string, handleHint: string, deps: Deps): Promise<StartedClaim> {
  let response: Response;
  try {
    response = await postJson(`${base}/api/claim`, { action: "start", handle: handleHint }, deps);
  } catch (error) {
    throw unreachable(base, error);
  }

  const body = await readJson(response);
  if (!response.ok) {
    throw new PublishError(
      `the board at ${base} would not start a claim (${response.status}: ` +
        `${reasonFrom(body, "no reason given")}).\nYour card above is unaffected.`,
    );
  }

  const { userCode, deviceCode, verificationUrl } = body;
  if (
    typeof userCode !== "string" ||
    typeof deviceCode !== "string" ||
    typeof verificationUrl !== "string"
  ) {
    throw new PublishError(
      `the board at ${base} returned a claim without a code. It may be running a ` +
        `different version of the API than this collector.`,
    );
  }

  return {
    userCode,
    deviceCode,
    verificationUrl,
    expiresIn: typeof body.expiresIn === "number" ? body.expiresIn : 600,
    interval: typeof body.interval === "number" ? body.interval : DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

function announce(claim: StartedClaim, deps: Deps): void {
  const minutes = Math.max(1, Math.round(claim.expiresIn / 60));

  deps.write(
    [
      "",
      "Connect this machine to the board",
      "",
      "  Open this URL and approve the code:",
      "",
      `    ${claim.verificationUrl}`,
      "",
      `  Code ${claim.userCode} · expires in ${minutes} minute${minutes === 1 ? "" : "s"}`,
      "",
      "  You sign in with GitHub there. This CLI never asks for a password or a",
      "  GitHub token, and nothing is sent until you approve.",
      "",
      "Waiting for approval…",
      "",
    ].join("\n"),
  );
}

/** Runs the device-claim flow to completion and returns the minted credential. */
export async function claimToken(
  base: string,
  handleHint: string,
  deps: Deps,
): Promise<StoredCredential> {
  const claim = await startClaim(base, handleHint, deps);
  announce(claim, deps);

  const deadline = deps.now() + claim.expiresIn * 1000 + POLL_GRACE_MS;
  let interval = Math.max(1, claim.interval);

  while (deps.now() < deadline) {
    await deps.sleep(interval * 1000);

    let response: Response;
    try {
      response = await postJson(
        `${base}/api/claim`,
        { action: "poll", deviceCode: claim.deviceCode },
        deps,
      );
    } catch (error) {
      throw unreachable(base, error);
    }

    const body = await readJson(response);
    const status = typeof body.status === "string" ? body.status : "";

    if (
      status === "approved" &&
      typeof body.token === "string" &&
      typeof body.handle === "string"
    ) {
      return {
        handle: body.handle,
        token: body.token,
        issuedAt: new Date(deps.now()).toISOString(),
      };
    }

    if (response.status === 429 || status === "pending") {
      if (typeof body.interval === "number" && body.interval > interval) interval = body.interval;
      continue;
    }

    if (status === "denied") {
      throw new PublishError(
        `the code ${claim.userCode} was declined in the browser. Nothing was sent.\n` +
          `Run ao-wrapped --publish again if that was not you.`,
      );
    }

    if (status === "expired" || status === "used") {
      throw new PublishError(
        `the code ${claim.userCode} ${status === "used" ? "was already used" : "expired"} ` +
          `before it was approved. Nothing was sent.\nRun ao-wrapped --publish again for a new code.`,
      );
    }

    throw new PublishError(
      `the board at ${base} refused the claim (${response.status}: ` +
        `${reasonFrom(body, "no reason given")}). Nothing was sent.`,
    );
  }

  throw new PublishError(
    `the code ${claim.userCode} expired before it was approved. Nothing was sent.\n` +
      `Run ao-wrapped --publish again for a new code.`,
  );
}

/**
 * The handle on the payload is a label the collector was given; the handle on
 * the token is what GitHub said. When they disagree the token wins — that is
 * what makes the board's rows provable — but it is stated out loud rather than
 * quietly swapped.
 */
function reconcileHandle(
  payload: IngestPayload,
  credential: StoredCredential,
  deps: Deps,
): IngestPayload {
  if (payload.handle.toLowerCase() === credential.handle.toLowerCase()) return payload;

  deps.write(
    `\nThis card was built for "${payload.handle}", but your token is bound to the\n` +
      `GitHub handle "${credential.handle}". Publishing as ${credential.handle}.\n`,
  );

  return { ...payload, handle: credential.handle };
}

async function sendPayload(
  base: string,
  payload: IngestPayload,
  credential: StoredCredential,
  deps: Deps,
): Promise<Response> {
  try {
    return await postJson(`${base}/api/ingest`, payload, deps, {
      authorization: `Bearer ${credential.token}`,
    });
  } catch (error) {
    throw unreachable(base, error);
  }
}

/**
 * Publish derived counters to the board, claiming a token first if this machine
 * has never connected. Returns the URL of the card that was updated.
 */
export async function publish(
  payload: IngestPayload,
  apiBase: string,
  options: PublishOptions = {},
): Promise<string> {
  const deps = resolveDeps(options);
  const base = normalizeBase(apiBase || process.env.AO_WRAPPED_API?.trim() || DEFAULT_API_BASE);

  let credential = readCredentials(deps.credentialsFile).boards[base] ?? null;
  let claimedThisRun = false;

  if (!credential) {
    credential = await claimToken(base, payload.handle, deps);
    saveCredential(base, credential, deps.credentialsFile);
    claimedThisRun = true;
    deps.write(
      `\nApproved as ${credential.handle}. Token stored at ${deps.credentialsFile} (mode 0600).\n`,
    );
  }

  let body = reconcileHandle(payload, credential, deps);
  let response = await sendPayload(base, body, credential, deps);

  /**
   * A stored token the board no longer recognises is the ordinary consequence
   * of a restarted server or a revoked builder, not an error worth explaining.
   * Drop it and claim once — but only once, so a board that 401s everything
   * cannot put the CLI in a loop.
   */
  if (response.status === 401 && !claimedThisRun) {
    forgetCredential(base, deps.credentialsFile);
    deps.write(`\nThe stored token for ${base} is no longer valid. Reconnecting.\n`);

    credential = await claimToken(base, payload.handle, deps);
    saveCredential(base, credential, deps.credentialsFile);
    deps.write(
      `\nApproved as ${credential.handle}. Token stored at ${deps.credentialsFile} (mode 0600).\n`,
    );

    body = reconcileHandle(payload, credential, deps);
    response = await sendPayload(base, body, credential, deps);
  }

  if (response.ok) return `${base}/w/${encodeURIComponent(credential.handle)}`;

  const failure = await readJson(response);

  if (response.status === 401) {
    forgetCredential(base, deps.credentialsFile);
    throw new PublishError(
      `the board rejected this machine's token, so nothing was stored.\n` +
        `The stored credential has been removed — run ao-wrapped --publish to reconnect.`,
    );
  }

  if (response.status === 403) {
    throw new PublishError(
      `the board's token is bound to a different GitHub handle than "${body.handle}", ` +
        `so nothing was stored.\nRe-run with --handle set to the account you approved with.`,
    );
  }

  if (response.status === 400) {
    throw new PublishError(
      `the board rejected the payload: ${reasonFrom(failure, "no reason given")}.\n` +
        `Nothing was stored. Run ao-wrapped --dry-run to see exactly what was sent.`,
    );
  }

  throw new PublishError(
    `the board returned ${response.status} (${reasonFrom(failure, "no reason given")}), ` +
      `so nothing was stored.\nYour card above is unaffected — retry with ao-wrapped --publish.`,
  );
}
