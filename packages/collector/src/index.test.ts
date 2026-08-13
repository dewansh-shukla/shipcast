import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The CLI is tested by running it, not by importing it.
 *
 * `index.ts` dispatches at module scope and exits the process, so importing it
 * into a test would take the runner down with it. Spawning also tests the thing
 * users actually invoke — argument parsing, exit codes, which stream a message
 * lands on — rather than a re-implementation of it.
 *
 * Every run gets `AO_WRAPPED_HOME` pointed at a throwaway directory, so nothing
 * here can read or damage a real credentials file, state file or watcher.
 */

const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));

/** No network: a port nothing serves, so a stray request fails fast. */
const NOWHERE = "http://127.0.0.1:59999";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

let home: string;

function run(args: string[], options: { timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--experimental-strip-types", CLI, ...args],
      {
        env: { ...process.env, AO_WRAPPED_HOME: home, NO_COLOR: "1" },
        timeout: options.timeoutMs ?? 20_000,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });
}

/** A watcher will not start without an approved board, so stand one in. */
function approve(api: string): void {
  mkdirSync(join(home, ".ao-wrapped"), { recursive: true });
  writeFileSync(
    join(home, ".ao-wrapped", "credentials.json"),
    JSON.stringify({
      version: 1,
      boards: { [api]: { handle: "tester", token: "not-a-real-token", issuedAt: "2026-08-12" } },
    }),
  );
}

function state(): { watcher: { pid: number } | null } {
  const path = join(home, ".ao-wrapped", "state.json");
  if (!existsSync(path)) return { watcher: null };
  return JSON.parse(readFileSync(path, "utf8")) as { watcher: { pid: number } | null };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ao-wrapped-cli-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("usage", () => {
  it("documents the three subcommands, because an undocumented one is barely reachable", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("ao-wrapped watch");
    expect(stdout).toContain("ao-wrapped status");
    expect(stdout).toContain("ao-wrapped stop");
  });

  it("rejects an unknown verb on stderr and shows the usage", async () => {
    const { code, stderr } = await run(["bogus"]);
    expect(code).toBe(1);
    expect(stderr).toContain('unknown command "bogus"');
    expect(stderr).toContain("ao-wrapped watch");
  });

  it("rejects extra arguments rather than silently ignoring them", async () => {
    const { code, stderr } = await run(["status", "extra"]);
    expect(code).toBe(1);
    expect(stderr).toContain("takes no arguments");
  });
});

describe("status", () => {
  it("answers without an AO database, since the watcher's state is the question", async () => {
    // Deliberately a path that does not exist: `status` reports on a watcher,
    // and refusing to answer because AO is not installed here is nonsense.
    const { code, stdout } = await run(["status", "--db", join(home, "no-such.db")]);
    expect(code).toBe(0);
    expect(stdout).toContain("not running");
    expect(stdout).toContain("ao-wrapped watch starts it");
  });
});

describe("stop", () => {
  it("says so plainly when nothing is running, and does not fail", async () => {
    const { code, stdout } = await run(["stop"]);
    expect(code).toBe(0);
    expect(stdout).toContain("not running");
  });
});

describe("watch", () => {
  it("refuses to start when this machine has not been approved for the board", async () => {
    const { code, stderr, stdout } = await run(["watch", "--api", NOWHERE]);
    expect(code).toBe(1);
    expect(`${stdout}${stderr}`).toContain("not connected");
  });

  it("takes the lock, reports itself to status, and releases it on Ctrl-C", async () => {
    approve(NOWHERE);
    const child = execFile(
      process.execPath,
      ["--experimental-strip-types", CLI, "watch", "--api", NOWHERE],
      { env: { ...process.env, AO_WRAPPED_HOME: home } },
    );

    try {
      for (let attempt = 0; attempt < 60 && state().watcher === null; attempt++) await sleep(100);
      expect(state().watcher).not.toBeNull();

      // `status` reports the board the watcher chose, not the default one.
      const reported = await run(["status"]);
      expect(reported.stdout).toContain("syncing");
      expect(reported.stdout).toContain(NOWHERE);

      child.kill("SIGINT");
      for (let attempt = 0; attempt < 60 && state().watcher !== null; attempt++) await sleep(100);

      // The lock is what matters: a stale one makes the next `watch` refuse.
      expect(state().watcher).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("the existing flags", () => {
  it("still prints the payload for --dry-run without touching the network", async () => {
    // A database that does not exist is the fastest proof the flag still routes
    // the old way: it fails in the collector, not in argument parsing.
    const { code, stderr } = await run(["--dry-run", "--db", join(home, "no-such.db")]);
    expect(code).toBe(1);
    expect(stderr).toContain("ao-wrapped:");
    expect(stderr).not.toContain("unknown command");
  });
});
