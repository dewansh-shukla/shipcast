import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IngestPayload, WeekWindow } from "@ao-wrapped/shared";
import { weekWindowFor } from "@ao-wrapped/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeCredentials } from "./publish.ts";
import {
  claimWatcher,
  fingerprintPayload,
  hasChanged,
  readState,
  recordPublish,
  releaseWatcher,
  writeState,
} from "./state.ts";
import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  formatStatus,
  parseSse,
  runStatus,
  runStop,
  runWatch,
  seqOf,
} from "./watch.ts";

/**
 * TICKET 14 — continuous sync.
 *
 * The four behaviours the ticket names are the four that make the difference
 * between a live board and a busy one: resuming from a stored seq, collapsing a
 * burst into one publish, staying silent when nothing changed, and reconnecting
 * after a drop. The Monday rollover is tested here too, because it only
 * reproduces once every seven days in production.
 */

const BASE = "http://localhost:3000";
const EVENTS = "http://127.0.0.1:3001/api/v1/events";

/** A stream a test can push SSE records into, one record at a time. */
function sseStream(): {
  response: Response;
  push: (text: string) => void;
  close: () => void;
  error: (reason: Error) => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();

  return {
    response: new Response(stream, { status: 200 }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    error: (reason) => controller.error(reason),
  };
}

function event(seq: number, type = "session_updated"): string {
  const data = JSON.stringify({
    seq,
    sessionId: "frontend-1",
    type,
    payload: { id: "frontend-1", activity: seq % 2 === 0 ? "active" : "idle" },
    createdAt: "2026-08-13T09:00:00.000000Z",
  });
  return `id: ${seq}\nevent: ${type}\ndata: ${data}\n\n`;
}

function payloadFor(week: WeekWindow, merges: number, handle = "octocat"): IngestPayload {
  return {
    schema: 1,
    handle,
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: week.from, to: week.to },
    totals: {
      tasks: 4,
      merges,
      ciRecoveries: 0,
      interventions: 1,
      peakParallelism: 3,
      harnesses: 1,
      turns: 0,
      repos: 1,
    },
    outcomes: { clean: merges, died: 1 },
    sizeMix: { s: 1, m: 1 },
    topRepoShare: 1,
    agents: [
      {
        harness: "claude-code",
        tasks: 4,
        merges,
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

let home: string;
let stateFile: string;
let credentialsFile: string;
let printed: string[];
let clock: number;

/** A watcher under test: scripted streams in, published payloads out. */
function harness(
  options: {
    streams?: Array<ReturnType<typeof sseStream>>;
    merges?: () => number;
    publishFails?: () => boolean;
    maxWaitMs?: number;
  } = {},
) {
  const streams = options.streams ?? [sseStream()];
  const requests: Array<{ url: string; lastEventId: string | null }> = [];
  const published: Array<{ payload: IngestPayload; at: number }> = [];
  const controller = new AbortController();
  let opened = 0;

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
    requests.push({ url, lastEventId: headers.get("last-event-id") });
    const stream = streams[Math.min(opened, streams.length - 1)];
    opened += 1;
    if (!stream) throw new Error("no scripted stream");
    return stream.response;
  };

  const done = runWatch({
    api: BASE,
    handle: "octocat",
    eventsUrl: EVENTS,
    statePath: stateFile,
    credentialsFile,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    maxWaitMs: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    rolloverCheckMs: 60_000,
    maxBackoffMs: 4_000,
    signal: controller.signal,
    now: () => new Date(clock),
    write: (text) => void printed.push(text),
    fetch: fetchImpl,
    snapshotFor: (week, handle) => payloadFor(week, options.merges?.() ?? 2, handle),
    publishImpl: async (payload) => {
      if (options.publishFails?.()) throw new Error("board is down");
      published.push({ payload, at: clock });
      return `${BASE}/w/octocat`;
    },
  });

  return { done, requests, published, streams, controller };
}

/** Advances both the fake timer clock and the injected wall clock together. */
async function advance(ms: number): Promise<void> {
  clock += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

/** Lets queued stream reads run without moving any clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
}

async function stop(h: ReturnType<typeof harness>): Promise<number> {
  h.controller.abort();
  await settle();
  return h.done;
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = Date.parse("2026-08-13T09:00:00.000Z"); // a Thursday, ISO week 2026-W33
  home = mkdtempSync(join(tmpdir(), "ao-wrapped-watch-"));
  stateFile = join(home, "state.json");
  credentialsFile = join(home, "credentials.json");
  printed = [];
  writeCredentials(
    { version: 1, boards: { [BASE]: { handle: "octocat", token: "aow_t", issuedAt: "x" } } },
    credentialsFile,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resuming where it left off", () => {
  it("asks AO to replay from the stored seq", async () => {
    writeState({ version: 1, lastSeq: 412, boards: {}, watcher: null }, stateFile);

    const h = harness();
    await settle();

    expect(h.requests[0]).toEqual({ url: EVENTS, lastEventId: "412" });
    await stop(h);
  });

  it("asks for the whole log when it has never synced", async () => {
    const h = harness();
    await settle();

    expect(h.requests[0]!.lastEventId).toBeNull();
    await stop(h);
  });

  it("persists the seq it published through", async () => {
    const h = harness();
    await settle();

    h.streams[0]!.push(event(101));
    h.streams[0]!.push(event(102));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published).toHaveLength(1);
    expect(readState(stateFile).lastSeq).toBe(102);
    await stop(h);
  });

  it("refuses to run without a connected machine, rather than prompting a daemon", async () => {
    writeCredentials({ version: 1, boards: {} }, credentialsFile);

    const code = await runWatch({
      api: BASE,
      statePath: stateFile,
      credentialsFile,
      write: (text) => void printed.push(text),
      now: () => new Date(clock),
    });

    expect(code).toBe(1);
    expect(printed.join("")).toContain("ao-wrapped --publish");
  });
});

describe("debounce", () => {
  it("collapses a burst of 53 events into one publish", async () => {
    const h = harness();
    await settle();

    for (let seq = 1; seq <= 53; seq++) {
      h.streams[0]!.push(event(seq));
      // Events arrive faster than the quiet period; each resets it.
      await advance(200);
    }
    expect(h.published).toHaveLength(0);

    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published).toHaveLength(1);
    expect(readState(stateFile).lastSeq).toBe(53);
    await stop(h);
  });

  it("holds a burst until the stream goes quiet", async () => {
    let merges = 2;
    const h = harness({ merges: () => merges });
    await settle();

    // A minute of steady activity, always inside the quiet period.
    for (let seq = 1; seq <= 12; seq++) {
      merges = seq;
      h.streams[0]!.push(event(seq));
      await advance(5_000);
    }
    expect(h.published).toHaveLength(0);

    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.payload.totals.merges).toBe(12);
    await stop(h);
  });

  /**
   * Measured against a live AO: with agents running, events arrive every one to
   * six seconds, so a quiet period never happens. Without this bound the board
   * would go stale exactly while there was the most to report.
   */
  it("still publishes on a cadence when the stream is never quiet", async () => {
    let merges = 0;
    const h = harness({ merges: () => merges, maxWaitMs: 120_000 });
    await settle();

    for (let seq = 1; seq <= 30; seq++) {
      merges = seq;
      h.streams[0]!.push(event(seq));
      // Always sooner than the 30s debounce would fire.
      await advance(20_000);
    }

    // Ten minutes of unbroken activity: bounded waiting means several
    // publishes, and far fewer than the thirty events that caused them.
    expect(h.published.length).toBeGreaterThanOrEqual(4);
    expect(h.published.length).toBeLessThanOrEqual(6);
    await stop(h);
  });

  it("writes exactly one log line per publish", async () => {
    const h = harness();
    await settle();

    h.streams[0]!.push(event(7));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    const lines = printed.join("").split("\n").filter(Boolean);
    const publishLines = lines.filter((line) => line.includes("published"));
    expect(publishLines).toHaveLength(1);
    expect(publishLines[0]).toMatch(
      /^2026-08-13T09:00:\d\dZ published 2026-W33 · 4 tasks · 2 merges · 0 recoveries · 1 interventions → http:\/\/localhost:3000\/w\/octocat$/,
    );
    await stop(h);
  });
});

describe("only publishing what changed", () => {
  it("stays silent when the numbers are identical", async () => {
    const h = harness({ merges: () => 2 });
    await settle();

    h.streams[0]!.push(event(1));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);
    expect(h.published).toHaveLength(1);

    h.streams[0]!.push(event(2));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published).toHaveLength(1);
    // The cursor still advances: those events are accounted for.
    expect(readState(stateFile).lastSeq).toBe(2);
    await stop(h);
  });

  it("publishes again as soon as a counter moves", async () => {
    let merges = 2;
    const h = harness({ merges: () => merges });
    await settle();

    h.streams[0]!.push(event(1));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    merges = 3;
    h.streams[0]!.push(event(2));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published.map((p) => p.payload.totals.merges)).toEqual([2, 3]);
    await stop(h);
  });
});

describe("reconnecting", () => {
  it("reopens the stream carrying the last seq it published", async () => {
    const first = sseStream();
    const second = sseStream();
    const h = harness({ streams: [first, second] });
    await settle();

    first.push(event(500));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);
    expect(h.published).toHaveLength(1);

    first.close();
    await settle();
    await advance(2_000);

    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]).toEqual({ url: EVENTS, lastEventId: "500" });
    expect(printed.join("")).toContain("stream ended");
    await stop(h);
  });

  it("keeps counting events across the reconnect", async () => {
    const first = sseStream();
    const second = sseStream();
    let merges = 2;
    const h = harness({ streams: [first, second], merges: () => merges });
    await settle();

    first.push(event(10));
    first.error(new Error("connection reset"));
    await settle();
    await advance(2_000);

    merges = 5;
    second.push(event(11));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    expect(printed.join("")).toContain("stream lost");
    expect(h.published.at(-1)!.payload.totals.merges).toBe(5);
    expect(readState(stateFile).lastSeq).toBe(11);
    await stop(h);
  });

  it("backs off when AO refuses the connection outright", async () => {
    const requests: string[] = [];
    const controller = new AbortController();
    const done = runWatch({
      api: BASE,
      eventsUrl: EVENTS,
      statePath: stateFile,
      credentialsFile,
      maxBackoffMs: 4_000,
      signal: controller.signal,
      now: () => new Date(clock),
      write: (text) => void printed.push(text),
      fetch: async (url) => {
        requests.push(url);
        return new Response("no", { status: 503 });
      },
      snapshotFor: (week) => payloadFor(week, 2),
      publishImpl: async () => `${BASE}/w/octocat`,
    });

    await settle();
    await advance(1_000);
    await advance(2_000);

    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(printed.join("")).toContain("AO answered 503");

    controller.abort();
    await settle();
    await done;
  });
});

describe("the Monday rollover", () => {
  it("closes out the old week with its final numbers, then opens the new one", async () => {
    let merges = 2;
    const h = harness({ merges: () => merges });
    await settle();

    h.streams[0]!.push(event(1));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);
    expect(h.published.map((p) => p.payload.window)).toEqual([
      { from: "2026-08-10", to: "2026-08-16" },
    ]);

    // Late Sunday activity that has not been published yet, then midnight UTC
    // arrives with the machine otherwise idle: the rollover tick is the only
    // thing that can notice, and it must send the closing week's final numbers.
    merges = 4;
    clock = Date.parse("2026-08-17T00:00:30.000Z");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.published.at(-1)!.payload.window).toEqual({ from: "2026-08-10", to: "2026-08-16" });
    expect(h.published.at(-1)!.payload.totals.merges).toBe(4);
    expect(printed.join("")).toContain("published 2026-W33 (final)");

    // The new week opens through the normal path, on the next real activity.
    merges = 1;
    h.streams[0]!.push(event(2));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published.at(-1)!.payload.window).toEqual({ from: "2026-08-17", to: "2026-08-23" });
    expect(readState(stateFile).boards[BASE]!.season).toBe("2026-W34");
    await stop(h);
  });

  it("sends nothing at the rollover when the closing week is already current", async () => {
    const h = harness({ merges: () => 2 });
    await settle();

    h.streams[0]!.push(event(1));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);
    expect(h.published).toHaveLength(1);

    clock = Date.parse("2026-08-17T00:00:30.000Z");
    await vi.advanceTimersByTimeAsync(60_000);

    // The board already holds exactly this week; a "final" republish of
    // identical numbers is noise, not closure.
    expect(h.published).toHaveLength(1);
    await stop(h);
  });

  it("never writes to the closed week again once it has rolled", async () => {
    const h = harness();
    await settle();

    clock = Date.parse("2026-08-17T00:00:30.000Z");
    await vi.advanceTimersByTimeAsync(60_000);

    h.streams[0]!.push(event(9));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    const seasons = h.published.map(
      (p) => weekWindowFor(new Date(`${p.payload.window.from}T12:00:00Z`)).key,
    );
    expect(seasons.slice(1).every((key) => key === "2026-W34")).toBe(true);
    await stop(h);
  });
});

describe("a publish that fails", () => {
  it("keeps the cursor, says so once, and retries on a timer", async () => {
    let failing = true;
    const h = harness({ publishFails: () => failing });
    await settle();

    h.streams[0]!.push(event(77));
    await settle();
    await advance(DEFAULT_DEBOUNCE_MS);

    expect(h.published).toHaveLength(0);
    expect(readState(stateFile).lastSeq).toBe(0);
    expect(printed.join("")).toContain("publish failed for 2026-W33");

    failing = false;
    await advance(60_000);

    expect(h.published).toHaveLength(1);
    expect(readState(stateFile).lastSeq).toBe(77);
    await stop(h);
  });
});

describe("two watchers", () => {
  it("refuses to start a second one while the first is alive", async () => {
    // The parent process is a real, live pid that is not this one.
    writeState(
      {
        version: 1,
        lastSeq: 0,
        boards: {},
        watcher: { pid: process.ppid, startedAt: "2026-08-13T08:00:00.000Z", api: BASE },
      },
      stateFile,
    );

    const code = await runWatch({
      api: BASE,
      statePath: stateFile,
      credentialsFile,
      write: (text) => void printed.push(text),
      now: () => new Date(clock),
    });

    expect(code).toBe(1);
    expect(printed.join("")).toContain("already syncing");
    expect(readState(stateFile).watcher!.pid).toBe(process.ppid);
  });

  it("releases its claim when it stops", async () => {
    const h = harness();
    await settle();
    expect(readState(stateFile).watcher).not.toBeNull();

    await stop(h);

    expect(readState(stateFile).watcher).toBeNull();
    expect(printed.join("")).toContain("stopped");
  });
});

describe("status", () => {
  it("answers the question a background process raises", () => {
    writeState(
      {
        version: 1,
        lastSeq: 3314,
        boards: {
          [BASE]: {
            season: "2026-W33",
            publishedAt: "2026-08-13T08:57:00.000Z",
            fingerprint: "abc",
          },
        },
        watcher: { pid: process.pid, startedAt: "2026-08-13T07:00:00.000Z", api: BASE },
      },
      stateFile,
    );

    const lines: string[] = [];
    runStatus({
      statePath: stateFile,
      write: (t) => void lines.push(t),
      now: () => new Date(clock),
    });

    const text = lines.join("");
    expect(text).toContain("syncing · last published 3m ago · season 2026-W33");
    expect(text).toContain(`board ${BASE}`);
    expect(text).toContain("synced through seq 3314");
  });

  it("says plainly when nothing is running", () => {
    const text = formatStatus(readState(stateFile), new Date(clock));

    expect(text).toContain("not running · last published never");
    expect(text).toContain("nothing starts it automatically");
  });

  it("reports a watcher whose process is gone as not running", () => {
    writeState(
      {
        version: 1,
        lastSeq: 5,
        boards: {},
        // A pid that cannot exist: a crashed daemon must not read as syncing.
        watcher: { pid: 2 ** 30, startedAt: "2026-08-13T07:00:00.000Z", api: BASE },
      },
      stateFile,
    );

    expect(formatStatus(readState(stateFile), new Date(clock))).toContain("not running");
  });
});

describe("stop", () => {
  it("signals the running watcher and clears the record", async () => {
    writeState(
      {
        version: 1,
        lastSeq: 5,
        boards: {},
        watcher: { pid: 4242, startedAt: "2026-08-13T07:00:00.000Z", api: BASE },
      },
      stateFile,
    );

    const signals: Array<[number, string]> = [];
    let alive = true;
    const lines: string[] = [];

    const code = await runStop({
      statePath: stateFile,
      write: (t) => void lines.push(t),
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        alive = false;
      },
      alive: () => alive,
      sleep: async () => {},
    });

    expect(code).toBe(0);
    expect(signals).toEqual([[4242, "SIGTERM"]]);
    expect(lines.join("")).toBe("stopped.\n");
    expect(readState(stateFile).watcher).toBeNull();
  });

  it("is a no-op when nothing is running", async () => {
    const lines: string[] = [];

    const code = await runStop({
      statePath: stateFile,
      write: (t) => void lines.push(t),
      kill: () => {
        throw new Error("must not signal anything");
      },
      alive: () => false,
      sleep: async () => {},
    });

    expect(code).toBe(0);
    expect(lines.join("")).toContain("not running");
  });
});

describe("the SSE parser", () => {
  async function collect(chunks: string[]): Promise<Array<{ id: string | null; data: string }>> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    const events = [];
    for await (const event of parseSse(stream)) events.push({ id: event.id, data: event.data });
    return events;
  }

  it("reassembles records split across chunks", async () => {
    const events = await collect(["id: 1\nevent: session_updated\nda", 'ta: {"seq":1}\n\n']);

    expect(events).toEqual([{ id: "1", data: '{"seq":1}' }]);
  });

  it("joins multi-line data and ignores comments and keep-alives", async () => {
    const events = await collect([": keep-alive\n\n", "id: 2\ndata: one\ndata: two\n\n"]);

    expect(events).toEqual([{ id: "2", data: "one\ntwo" }]);
  });

  it("accepts CRLF separators", async () => {
    const events = await collect(["id: 3\r\ndata: x\r\n\r\n"]);

    expect(events).toEqual([{ id: "3", data: "x" }]);
  });

  it("drops a record the connection cut in half", async () => {
    const events = await collect(["id: 4\ndata: complete\n\n", "id: 5\ndata: trunc"]);

    expect(events).toEqual([{ id: "4", data: "complete" }]);
  });

  it("falls back to the payload's seq when id is missing", () => {
    expect(seqOf({ id: null, event: "x", data: '{"seq":9}' })).toBe(9);
    expect(seqOf({ id: "12", event: "x", data: "{}" })).toBe(12);
    expect(seqOf({ id: "not-a-number", event: "x", data: "garbage" })).toBeNull();
  });
});

describe("state on disk", () => {
  it("is written 0600 like the token beside it", () => {
    writeState({ version: 1, lastSeq: 1, boards: {}, watcher: null }, stateFile);

    expect(statSync(stateFile).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("treats an unreadable file as never synced rather than failing", () => {
    writeState({ version: 1, lastSeq: 9, boards: {}, watcher: null }, stateFile);
    const path = join(home, "broken.json");
    writeState({ version: 1, lastSeq: 9, boards: {}, watcher: null }, path);
    expect(readState(path).lastSeq).toBe(9);

    expect(readState(join(home, "missing.json")).lastSeq).toBe(0);
  });

  it("fingerprints payloads by value, not by property order", () => {
    const week = weekWindowFor(new Date(clock));
    const a = payloadFor(week, 2);
    // Same values, different insertion order — the hash must not notice.
    const b = Object.fromEntries(Object.entries(a).reverse()) as IngestPayload;

    expect(fingerprintPayload(b)).toBe(fingerprintPayload(a));
    expect(fingerprintPayload(payloadFor(week, 3))).not.toBe(fingerprintPayload(a));
  });

  it("treats a new season as changed even when the counters match", () => {
    const week = weekWindowFor(new Date(clock));
    const payload = payloadFor(week, 2);
    const state = recordPublish(
      { base: BASE, season: "2026-W33", payload, lastSeq: 4, at: new Date(clock) },
      stateFile,
    );

    expect(hasChanged(state, BASE, "2026-W33", payload)).toBe(false);
    expect(hasChanged(state, BASE, "2026-W34", payload)).toBe(true);
  });

  it("never moves the cursor backwards", () => {
    const week = weekWindowFor(new Date(clock));
    recordPublish(
      {
        base: BASE,
        season: "2026-W33",
        payload: payloadFor(week, 2),
        lastSeq: 90,
        at: new Date(clock),
      },
      stateFile,
    );
    recordPublish(
      {
        base: BASE,
        season: "2026-W33",
        payload: payloadFor(week, 3),
        lastSeq: 12,
        at: new Date(clock),
      },
      stateFile,
    );

    expect(readState(stateFile).lastSeq).toBe(90);
  });

  it("replaces a claim whose process is gone, and refuses a live one", () => {
    const stale = { pid: 2 ** 30, startedAt: "2026-08-13T07:00:00.000Z", api: BASE };
    writeState({ version: 1, lastSeq: 0, boards: {}, watcher: stale }, stateFile);

    const mine = { pid: process.pid, startedAt: "2026-08-13T09:00:00.000Z", api: BASE };
    expect(claimWatcher(mine, stateFile).ok).toBe(true);

    const other = { pid: process.pid + 0, startedAt: "x", api: BASE };
    void other;
    releaseWatcher(process.pid, stateFile);
    expect(readState(stateFile).watcher).toBeNull();
  });

  it("keeps the token file and the state file separate", () => {
    writeState({ version: 1, lastSeq: 1, boards: {}, watcher: null }, stateFile);

    expect(readFileSync(stateFile, "utf8")).not.toContain("aow_");
  });
});
