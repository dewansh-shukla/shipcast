/**
 * Worker harnesses AO accepts, mirrored from the CHECK constraint on
 * `sessions.harness` in ao.db (verified against AO v0.12.3).
 *
 * If a probe reports a harness not in this list, the AO install is newer than
 * this build. Treat it as `unknown` rather than rejecting the payload.
 */
export const HARNESSES = [
  "claude-code",
  "codex",
  "aider",
  "opencode",
  "grok",
  "droid",
  "amp",
  "agy",
  "crush",
  "cursor",
  "qwen",
  "copilot",
  "goose",
  "auggie",
  "continue",
  "devin",
  "cline",
  "kimi",
  "kiro",
  "kilocode",
  "vibe",
  "pi",
  "autohand",
  "unknown",
] as const;

export type Harness = (typeof HARNESSES)[number];

/** Harnesses AO records token usage for — `usage_bindings.harness` CHECK. */
export const TOKEN_METERED_HARNESSES: readonly Harness[] = ["claude-code", "codex"];

export function normalizeHarness(raw: string): Harness {
  const found = HARNESSES.find((h) => h === raw);
  return found ?? "unknown";
}
