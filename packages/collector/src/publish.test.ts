import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestPayload } from "@ao-wrapped/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_API_BASE,
  PublishError,
  dryRun,
  normalizeBase,
  publish,
  readCredentials,
  writeCredentials,
  type PublishOptions,
} from "./publish.ts";

/**
 * TICKET 10 — the CLI half of the claim flow.
 *
 * Every failure mode here is one a first-time user will actually hit: a board
 * that is not running, a code left on screen too long, a handle that does not
 * match the account they signed in with. What the CLI prints in those moments
 * is the feature, so the messages are asserted, not just the control flow.
 */

const BASE = "http://localhost:3000";

function payload(handle = "octocat"): IngestPayload {
  return {
    schema: 1,
    handle,
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: "2026-08-01", to: "2026-08-13" },
    totals: {
      tasks: 4,
      merges: 2,
      ciRecoveries: 0,
      interventions: 1,
      peakParallelism: 3,
      harnesses: 1,
      turns: 0,
      repos: 1,
    },
    outcomes: { clean: 2, died: 1 },
    sizeMix: { s: 1, m: 1 },
    topRepoShare: 1,
    agents: [
      {
        harness: "claude-code",
        tasks: 4,
        merges: 2,
        recoveries: 0,
        interventions: 1,
        died: 1,
        turns: 0,
        medianMinutes: 12,
      },
    ],
    graveyard: [{ harness: "claude-code", cause: "no_signal" }],
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STARTED = {
  userCode: "WXQZ-4T7K",
  deviceCode: "d".repeat(64),
  verificationUrl: `${BASE}/claim/WXQZ-4T7K`,
  expiresIn: 600,
  interval: 2,
};

interface Recorded {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

/**
 * A scripted board. Handlers are consumed in order per endpoint, so a test says
 * "pending, then approved" by listing two claim responses.
 */
class FakeBoard {
  readonly calls: Recorded[] = [];
  private claimCall = 0;
  private ingestCall = 0;

  constructor(
    private readonly script: {
      claim?: Array<Response | (() => Response)>;
      ingest?: Array<Response | (() => Response)>;
    },
  ) {}

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const authorization = ((init?.headers ?? {}) as Record<string, string>).authorization ?? null;
    this.calls.push({ url, body, authorization });

    const queue = url.endsWith("/api/ingest") ? this.script.ingest : this.script.claim;
    const index = url.endsWith("/api/ingest") ? this.ingestCall++ : this.claimCall++;
    const next = queue?.[index];
    if (!next) throw new Error(`no scripted response for ${url} (call ${index + 1})`);
    return typeof next === "function" ? next() : next;
  };

  urls(): string[] {
    return this.calls.map((call) => call.url);
  }
}

let credentialsFile: string;
let printed: string;

function options(board: FakeBoard): PublishOptions {
  return {
    fetch: board.fetch,
    sleep: async () => {},
    now: () => Date.parse("2026-08-13T09:00:00Z"),
    write: (text) => {
      printed += text;
    },
    credentialsFile,
  };
}

beforeEach(() => {
  credentialsFile = join(mkdtempSync(join(tmpdir(), "ao-wrapped-creds-")), "credentials.json");
  printed = "";
});

describe("a cold run", () => {
  it("claims a token, stores it 0600 and ingests the payload", async () => {
    const board = new FakeBoard({
      claim: [
        json(STARTED, 201),
        json({ status: "pending", interval: 2 }),
        json({ status: "approved", token: "aow_secret", handle: "octocat", tokenType: "Bearer" }),
      ],
      ingest: [json({ ok: true }, 201)],
    });

    const url = await publish(payload(), BASE, options(board));

    expect(url).toBe(`${BASE}/w/octocat`);
    expect(board.urls()).toEqual([
      `${BASE}/api/claim`,
      `${BASE}/api/claim`,
      `${BASE}/api/claim`,
      `${BASE}/api/ingest`,
    ]);
    expect(board.calls.at(-1)!.authorization).toBe("Bearer aow_secret");

    const stored = readCredentials(credentialsFile);
    expect(stored.boards[BASE]).toMatchObject({ handle: "octocat", token: "aow_secret" });
    expect(statSync(credentialsFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(credentialsFile, "..")).mode & 0o777).toBe(0o700);
  });

  it("prints the URL to open and never asks for a secret", async () => {
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "approved", token: "aow_x", handle: "octocat" })],
      ingest: [json({ ok: true }, 202)],
    });

    await publish(payload(), BASE, options(board));

    expect(printed).toContain(`${BASE}/claim/WXQZ-4T7K`);
    expect(printed).toContain("WXQZ-4T7K");
    expect(printed).toContain("expires in 10 minutes");
    expect(printed).toContain("never asks for a password");
    expect(printed).toMatch(/password|GitHub token/);
    expect(printed).not.toMatch(/enter your (password|token)/i);
  });

  it("keeps polling while the board says pending or slow down", async () => {
    const board = new FakeBoard({
      claim: [
        json(STARTED, 201),
        json({ status: "pending" }),
        json({ status: "pending", reason: "polling too fast", interval: 5 }, 429),
        json({ status: "pending" }),
        json({ status: "approved", token: "aow_x", handle: "octocat" }),
      ],
      ingest: [json({ ok: true }, 201)],
    });

    await expect(publish(payload(), BASE, options(board))).resolves.toBe(`${BASE}/w/octocat`);
  });

  it("sends the handle the token is bound to, and says so", async () => {
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "approved", token: "aow_x", handle: "octocat" })],
      ingest: [json({ ok: true }, 201)],
    });

    const url = await publish(payload("anonymous"), BASE, options(board));

    expect(board.calls.at(-1)!.body.handle).toBe("octocat");
    expect(url).toBe(`${BASE}/w/octocat`);
    expect(printed).toContain('built for "anonymous"');
    expect(printed).toContain("Publishing as octocat");
  });
});

describe("a run with a stored token", () => {
  beforeEach(() => {
    writeCredentials(
      {
        version: 1,
        boards: { [BASE]: { handle: "octocat", token: "aow_stored", issuedAt: "2026-08-12" } },
      },
      credentialsFile,
    );
  });

  it("skips the claim entirely", async () => {
    const board = new FakeBoard({ ingest: [json({ ok: true }, 200)] });

    const url = await publish(payload(), BASE, options(board));

    expect(url).toBe(`${BASE}/w/octocat`);
    expect(board.urls()).toEqual([`${BASE}/api/ingest`]);
    expect(board.calls[0]!.authorization).toBe("Bearer aow_stored");
    expect(printed).toBe("");
  });

  it("reconnects once when the board no longer knows the token", async () => {
    const board = new FakeBoard({
      claim: [
        json(STARTED, 201),
        json({ status: "approved", token: "aow_fresh", handle: "octocat" }),
      ],
      ingest: [json({ error: "unauthorized" }, 401), json({ ok: true }, 201)],
    });

    await expect(publish(payload(), BASE, options(board))).resolves.toBe(`${BASE}/w/octocat`);

    expect(board.calls.at(-1)!.authorization).toBe("Bearer aow_fresh");
    expect(readCredentials(credentialsFile).boards[BASE]!.token).toBe("aow_fresh");
    expect(printed).toContain("no longer valid");
  });

  it("gives up rather than looping when the fresh token is rejected too", async () => {
    const board = new FakeBoard({
      claim: [
        json(STARTED, 201),
        json({ status: "approved", token: "aow_fresh", handle: "octocat" }),
      ],
      ingest: [json({ error: "unauthorized" }, 401), json({ error: "unauthorized" }, 401)],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(/reconnect/);
    expect(readCredentials(credentialsFile).boards[BASE]).toBeUndefined();
  });

  it("ignores a corrupt credentials file instead of refusing to run", async () => {
    writeFileSync(credentialsFile, "{ not json");
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "approved", token: "aow_x", handle: "octocat" })],
      ingest: [json({ ok: true }, 201)],
    });

    await expect(publish(payload(), BASE, options(board))).resolves.toBe(`${BASE}/w/octocat`);
  });
});

describe("codes that cannot be exchanged", () => {
  it("reports an expired code and sends nothing", async () => {
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "expired", reason: "the code expired" }, 410)],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(
      /WXQZ-4T7K expired before it was approved[\s\S]*Nothing was sent/,
    );
    expect(board.urls()).not.toContain(`${BASE}/api/ingest`);
    expect(readCredentials(credentialsFile).boards[BASE]).toBeUndefined();
  });

  it("reports a code that was already exchanged", async () => {
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "used" }, 410)],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(/was already used/);
  });

  it("reports a code the user declined", async () => {
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "denied" }, 403)],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(
      /declined in the browser/,
    );
  });

  it("stops waiting once the code's own lifetime has run out", async () => {
    let clock = Date.parse("2026-08-13T09:00:00Z");
    const board = new FakeBoard({
      claim: [json(STARTED, 201), json({ status: "pending" })],
    });

    await expect(
      publish(payload(), BASE, {
        ...options(board),
        now: () => clock,
        sleep: async () => {
          clock += 11 * 60 * 1000;
        },
      }),
    ).rejects.toThrow(/expired before it was approved/);
  });
});

describe("when the board cannot be reached", () => {
  it("says so plainly and points back at the card that already printed", async () => {
    const board = new FakeBoard({
      claim: [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    });

    const error = await publish(payload(), BASE, options(board)).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(PublishError);
    expect((error as Error).message).toContain(`could not reach the board at ${BASE}`);
    expect((error as Error).message).toContain("Wrapped card above already printed");
    expect((error as Error).message).toContain("Nothing was sent");
  });

  it("says the same thing when ingest is the request that fails", async () => {
    writeCredentials(
      { version: 1, boards: { [BASE]: { handle: "octocat", token: "t", issuedAt: "x" } } },
      credentialsFile,
    );
    const board = new FakeBoard({
      ingest: [
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(/could not reach/);
  });
});

describe("when the board rejects the payload", () => {
  beforeEach(() => {
    writeCredentials(
      { version: 1, boards: { [BASE]: { handle: "octocat", token: "aow_stored", issuedAt: "x" } } },
      credentialsFile,
    );
  });

  it("explains a handle bound to another account", async () => {
    const board = new FakeBoard({
      ingest: [json({ error: "forbidden", reason: "token was not issued to this handle" }, 403)],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(/--handle/);
  });

  it("names the field a 400 complained about", async () => {
    const board = new FakeBoard({
      ingest: [json({ error: "invalid payload", reason: "unknown field: repoName" }, 400)],
    });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(
      /unknown field: repoName[\s\S]*--dry-run/,
    );
  });

  it("reports a server error without losing the stored token", async () => {
    const board = new FakeBoard({ ingest: [json({ error: "boom" }, 500)] });

    await expect(publish(payload(), BASE, options(board))).rejects.toThrow(/returned 500/);
    expect(readCredentials(credentialsFile).boards[BASE]).toBeDefined();
  });
});

describe("board URLs", () => {
  it("normalizes trailing slashes so one board keeps one credential", () => {
    expect(normalizeBase("http://localhost:3000/")).toBe(BASE);
    expect(normalizeBase(" https://board.example/// ")).toBe("https://board.example");
  });

  it("rejects something that is not a URL", () => {
    expect(() => normalizeBase("board.example")).toThrow(PublishError);
    expect(() => normalizeBase("ftp://board.example")).toThrow(/http or https/);
  });

  it("falls back to the default board when nothing is configured", async () => {
    const board = new FakeBoard({
      claim: [
        json({ ...STARTED, verificationUrl: `${DEFAULT_API_BASE}/claim/WXQZ-4T7K` }, 201),
        json({ status: "approved", token: "aow_x", handle: "octocat" }),
      ],
      ingest: [json({ ok: true }, 201)],
    });

    await expect(publish(payload(), "", options(board))).resolves.toBe(
      `${DEFAULT_API_BASE}/w/octocat`,
    );
  });
});

describe("dry run", () => {
  it("returns the exact JSON that publishing would send, and touches nothing", () => {
    const printedJson = dryRun(payload());

    expect(JSON.parse(printedJson)).toEqual(payload());
    expect(printedJson).toContain('"handle": "octocat"');
  });
});

describe("credentials on disk", () => {
  it("keeps one entry per board", () => {
    mkdirSync(join(credentialsFile, ".."), { recursive: true });
    writeCredentials(
      {
        version: 1,
        boards: {
          [BASE]: { handle: "octocat", token: "a", issuedAt: "x" },
          "https://board.example": { handle: "octocat", token: "b", issuedAt: "x" },
        },
      },
      credentialsFile,
    );

    const stored = readCredentials(credentialsFile);
    expect(Object.keys(stored.boards)).toHaveLength(2);
    expect(readFileSync(credentialsFile, "utf8")).not.toContain("password");
  });

  it("reports no credentials when the file does not exist", () => {
    expect(readCredentials(join(credentialsFile, "..", "missing.json")).boards).toEqual({});
  });
});
