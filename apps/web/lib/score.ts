import type { IngestPayload } from "@ao-wrapped/shared";

/**
 * TICKET B2 — scoring.
 *
 * Authoritative and server-side, always. The collector runs on a machine the
 * user controls, so a score it computed is a claim, not a fact. Weights live in
 * @ao-wrapped/shared so both sides agree on the arithmetic while only this side
 * decides the result.
 *
 * Every score must ship with its breakdown. See the anti-gaming LIMITS in
 * shared/weights.ts — repo concentration, rubber-stamp merges, empty sessions
 * and GitHub reconciliation are all enforced here, before points are awarded.
 */

export interface ScoreLine {
  label: string;
  points: number;
}

export interface ScoreResult {
  total: number;
  breakdown: ScoreLine[];
  verified: boolean;
}

export function scorePayload(_payload: IngestPayload): ScoreResult {
  throw new Error("TICKET B2: not implemented");
}
