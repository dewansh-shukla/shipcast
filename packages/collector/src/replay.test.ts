import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay, type Transition } from "./replay.ts";

/**
 * Fixtures are built here rather than read from ~/.ao: the developer's real
 * database is read-only by house rule, and CI has no AO install at all.
 *
 * Payload shapes below are copied from real `change_log` rows on AO v0.12.3 —
 * pr events carry `url`/`session`/`state`/`ci`/`review`/`mergeability`, checks
 * carry `pr`/`name`/`commit`/`status`. Timestamps are Go `time.Time` strings,
 * which is the whole reason parseAoTimestamp exists.
 */

const temporaries: string[] = [];

interface Event {
  type: string;
  /** change_log.session_id. Undefined means the column holds NULL. */
  session?: string;
  payload: unknown;
  /** Defaults to a fresh Go-format timestamp, one second later than the last. */
  at?: string;
}

interface FixtureOptions {
  sessions?: Record<string, string>;
  omitChangeLog?: boolean;
  omitSessionIdColumn?: boolean;
}

const DEFAULT_SESSIONS = { "frontend-1": "claude-code", "backend-1": "codex" };

function goTimestamp(index: number): string {
  const at = new Date(Date.UTC(2026, 6, 7, 6, 58, 31, 0) + index * 1000);
  return `${at.toISOString().slice(0, 19).replace("T", " ")}.825841 +0000 UTC`;
}

function fixtureDb(events: Event[], options: FixtureOptions = {}): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), "ao-wrapped-replay-"));
  temporaries.push(dir);
  const db = new DatabaseSync(join(dir, "ao.db"));

  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, harness TEXT)");
  for (const [id, harness] of Object.entries(options.sessions ?? DEFAULT_SESSIONS)) {
    db.prepare("INSERT INTO sessions (id, harness) VALUES (?, ?)").run(id, harness);
  }

  if (!options.omitChangeLog) {
    const sessionIdColumn = options.omitSessionIdColumn ? "" : "session_id TEXT, ";
    db.exec(
      `CREATE TABLE change_log (seq INTEGER PRIMARY KEY, project_id TEXT, ${sessionIdColumn}` +
        "event_type TEXT, payload TEXT, created_at TIMESTAMP)",
    );
    const columns = options.omitSessionIdColumn
      ? "(seq, event_type, payload, created_at)"
      : "(seq, session_id, event_type, payload, created_at)";
    const insert = db.prepare(
      `INSERT INTO change_log ${columns} VALUES (?${options.omitSessionIdColumn ? "" : ", ?"}, ?, ?, ?)`,
    );
    events.forEach((event, index) => {
      const payload =
        typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
      const at = event.at ?? goTimestamp(index);
      if (options.omitSessionIdColumn) insert.run(index + 1, event.type, payload, at);
      else insert.run(index + 1, event.session ?? null, event.type, payload, at);
    });
  }

  return db;
}

/** Compact view of an edge, for assertions that do not care about timestamps. */
function edges(transitions: Transition[]): string[] {
  return transitions.map((t) => `${t.kind} ${t.from}->${t.to}`);
}

function session(id: string, activity: string, created = false): Event {
  return {
    type: created ? "session_created" : "session_updated",
    session: id,
    payload: {
      id,
      activity,
      isTerminated: activity === "exited",
      previewUrl: "",
      previewRevision: 0,
    },
  };
}

const PR = "https://github.com/acme/widgets/pull/7";

function pr(overrides: Record<string, unknown> = {}, created = false): Event {
  return {
    type: created ? "pr_created" : "pr_updated",
    session: "frontend-1",
    payload: {
      url: PR,
      session: "frontend-1",
      state: "open",
      ci: "unknown",
      review: "none",
      mergeability: "unknown",
      ...overrides,
    },
  };
}

function check(name: string, status: string, commit: string): Event {
  return {
    type: "pr_check_recorded",
    session: "frontend-1",
    payload: { pr: PR, name, commit, status },
  };
}

afterEach(() => {
  while (temporaries.length > 0) {
    const dir = temporaries.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("replay", () => {
  it("emits an activity edge when a session goes idle -> active", () => {
    const transitions = replay(
      fixtureDb([session("frontend-1", "idle", true), session("frontend-1", "active")]),
    );

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      seq: 2,
      sessionId: "frontend-1",
      harness: "claude-code",
      kind: "activity",
      from: "idle",
      to: "active",
    });
    expect(transitions[0]?.at.toISOString()).toBe("2026-07-07T06:58:32.825Z");
  });

  it("treats the first sighting of an entity as state, not as a transition", () => {
    // session_created is a full snapshot; an edge here would be invented.
    expect(replay(fixtureDb([session("frontend-1", "idle", true)]))).toEqual([]);
    expect(replay(fixtureDb([pr({}, true)]))).toEqual([]);
    expect(replay(fixtureDb([check("build", "queued", "abc1234")]))).toEqual([]);
  });

  it("emits no transition for a repeated identical payload", () => {
    const transitions = replay(
      fixtureDb([
        session("frontend-1", "active", true),
        session("frontend-1", "active"),
        session("frontend-1", "active"),
        session("frontend-1", "active"),
      ]),
    );

    expect(transitions).toEqual([]);
  });

  it("follows a CI check from failed to passed on a later commit", () => {
    const transitions = replay(
      fixtureDb([
        check("build", "queued", "aaaa111"),
        check("build", "failed", "aaaa111"),
        check("build", "passed", "bbbb222"),
      ]),
    );

    expect(edges(transitions)).toEqual(["ci_check queued->failed", "ci_check failed->passed"]);
    expect(transitions.every((t) => t.kind === "ci_check" && t.harness === "claude-code")).toBe(
      true,
    );
  });

  it("keys CI checks on (pr, check name) so two checks do not cross-talk", () => {
    const other = "https://github.com/acme/widgets/pull/9";
    const transitions = replay(
      fixtureDb([
        check("build", "passed", "aaaa111"),
        check("lint", "failed", "aaaa111"),
        // Same check name, different PR: must not read as lint recovering.
        {
          type: "pr_check_recorded",
          session: "frontend-1",
          payload: { pr: other, name: "lint", commit: "cccc333", status: "passed" },
        },
        check("lint", "passed", "bbbb222"),
      ]),
    );

    expect(edges(transitions)).toEqual(["ci_check failed->passed"]);
    expect(transitions[0]?.seq).toBe(4);
  });

  it("emits a mergeability edge when a conflict is resolved", () => {
    const transitions = replay(
      fixtureDb([
        pr({ mergeability: "conflicting" }, true),
        pr({ mergeability: "conflicting" }),
        pr({ mergeability: "mergeable" }),
      ]),
    );

    expect(edges(transitions)).toEqual(["mergeability conflicting->mergeable"]);
    expect(transitions[0]).toMatchObject({
      seq: 3,
      sessionId: "frontend-1",
      harness: "claude-code",
    });
  });

  it("emits pr_state, mergeability and review edges from one pr_updated row", () => {
    const transitions = replay(
      fixtureDb([
        pr({ state: "draft", mergeability: "conflicting", review: "changes_requested" }, true),
        pr({ state: "merged", mergeability: "mergeable", review: "approved" }),
      ]),
    );

    expect(edges(transitions)).toEqual([
      "pr_state draft->merged",
      "mergeability conflicting->mergeable",
      "review_thread changes_requested->approved",
    ]);
    expect(transitions.every((t) => t.seq === 2)).toBe(true);
  });

  it("does not turn pr.ci into a ci_check edge", () => {
    // pr.ci reads passing/failing while pr_checks reads passed/failed; mixing
    // the two is the documented way to silently get zero recoveries.
    const transitions = replay(
      fixtureDb([pr({ ci: "pending" }, true), pr({ ci: "failing" }), pr({ ci: "passing" })]),
    );

    expect(transitions).toEqual([]);
  });

  it("skips a row whose timestamp cannot be parsed rather than throwing", () => {
    const transitions = replay(
      fixtureDb([
        session("frontend-1", "idle", true),
        { ...session("frontend-1", "blocked"), at: "not a timestamp at all" },
        { ...session("frontend-1", "active"), at: "" },
        session("frontend-1", "waiting_input"),
      ]),
    );

    // The two undated rows are dropped whole, so the surviving edge is measured
    // against the last value we could date rather than against a guess.
    expect(edges(transitions)).toEqual(["activity idle->waiting_input"]);
    expect(transitions[0]?.seq).toBe(4);
  });

  it("skips a row whose payload is not a JSON object", () => {
    const transitions = replay(
      fixtureDb([
        session("frontend-1", "idle", true),
        { type: "session_updated", session: "frontend-1", payload: "{not json" },
        { type: "session_updated", session: "frontend-1", payload: "[1,2,3]" },
        session("frontend-1", "active"),
      ]),
    );

    expect(edges(transitions)).toEqual(["activity idle->active"]);
  });

  it("ignores a payload that omits the field being tracked", () => {
    // Older AO builds wrote {"id":"..."} with no activity at all.
    const transitions = replay(
      fixtureDb([
        session("frontend-1", "idle", true),
        { type: "session_updated", session: "frontend-1", payload: { id: "frontend-1" } },
        session("frontend-1", "active"),
      ]),
    );

    expect(edges(transitions)).toEqual(["activity idle->active"]);
  });

  it("joins the harness of each session and falls back to unknown", () => {
    const transitions = replay(
      fixtureDb(
        [
          session("frontend-1", "idle", true),
          session("frontend-1", "active"),
          session("backend-1", "idle", true),
          session("backend-1", "active"),
          // A session AO has since deleted: the edge still happened.
          session("deleted-9", "idle", true),
          session("deleted-9", "active"),
          // A harness newer than this build's enum.
          session("future-1", "idle", true),
          session("future-1", "active"),
        ],
        { sessions: { ...DEFAULT_SESSIONS, "future-1": "some-new-harness" } },
      ),
    );

    expect(transitions.map((t) => [t.sessionId, t.harness])).toEqual([
      ["frontend-1", "claude-code"],
      ["backend-1", "codex"],
      ["deleted-9", "unknown"],
      ["future-1", "unknown"],
    ]);
  });

  it("returns transitions ordered by seq even when the rows are not", () => {
    const db = fixtureDb([session("frontend-1", "idle", true)]);
    const insert = db.prepare(
      "INSERT INTO change_log (seq, session_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    const later = JSON.stringify({ id: "frontend-1", activity: "exited", isTerminated: true });
    const middle = JSON.stringify({ id: "frontend-1", activity: "active", isTerminated: false });
    insert.run(9, "frontend-1", "session_updated", later, goTimestamp(9));
    insert.run(4, "frontend-1", "session_updated", middle, goTimestamp(4));

    const transitions = replay(db);

    expect(transitions.map((t) => t.seq)).toEqual([4, 9]);
    expect(edges(transitions)).toEqual(["activity idle->active", "activity active->exited"]);
  });

  it("ignores event types that carry no state this stream models", () => {
    const transitions = replay(
      fixtureDb([
        session("frontend-1", "idle", true),
        {
          type: "pr_session_changed",
          session: "frontend-1",
          payload: { url: PR, session: "backend-1" },
        },
        session("frontend-1", "active"),
      ]),
    );

    expect(edges(transitions)).toEqual(["activity idle->active"]);
  });

  it("reads session ids from the payload when the session_id column is absent", () => {
    const transitions = replay(
      fixtureDb([session("frontend-1", "idle", true), session("frontend-1", "active")], {
        omitSessionIdColumn: true,
      }),
    );

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ sessionId: "frontend-1", harness: "claude-code" });
  });

  it("returns nothing rather than throwing when change_log does not exist", () => {
    expect(replay(fixtureDb([], { omitChangeLog: true }))).toEqual([]);
  });

  it("returns nothing rather than throwing on a database with no AO tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "ao-wrapped-replay-"));
    temporaries.push(dir);
    expect(replay(new DatabaseSync(join(dir, "ao.db")))).toEqual([]);
  });
});
