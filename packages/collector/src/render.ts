import type { IngestPayload } from "@ao-wrapped/shared";

/**
 * TICKET A4 — terminal card.
 *
 * The collector prints a complete Wrapped card to stdout with no network call
 * and no account. Publishing is strictly opt-in; someone who never runs
 * `--publish` still gets the whole product locally. That is the trust argument,
 * so the offline card has to be genuinely good rather than a teaser.
 */
export function renderCard(_payload: IngestPayload): string {
  throw new Error("TICKET A4: not implemented");
}

/** Deterministic awards, computed from counters. No model call — see the plan. */
export function renderPersonalities(_payload: IngestPayload): string {
  throw new Error("TICKET A4: not implemented");
}
