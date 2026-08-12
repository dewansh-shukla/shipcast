import type { IngestPayload } from "@ao-wrapped/shared";

/**
 * TICKET A5 — publish.
 *
 * Device-claim flow: the CLI requests a short code, the user approves it in the
 * browser while signed in with GitHub, and the CLI stores the returned bearer
 * token under ~/.ao-wrapped/. No password ever touches this process.
 *
 * `--dry-run` prints the exact JSON that would be sent and exits without
 * sending it. That flag is a demo beat, not a debug aid: it is how a viewer
 * verifies the privacy claim for themselves in one screen.
 */
export function dryRun(payload: IngestPayload): string {
  return JSON.stringify(payload, null, 2);
}

export async function publish(_payload: IngestPayload, _apiBase: string): Promise<string> {
  throw new Error("TICKET A5: not implemented");
}
