import { IngestPayloadSchema } from "@ao-wrapped/shared";

/**
 * TICKET B1 — ingest.
 *
 * The schema is the privacy guarantee, so validation is strict on purpose: an
 * unknown key is a 400 naming the offending field, not a silently-stored
 * surprise. Store the validated counters and nothing else.
 *
 * Auth is a bearer token issued by the device-claim flow. Scores are NOT
 * accepted from the client under any circumstance — the collector reports
 * counters and the server does the arithmetic (see lib/score.ts).
 */
export async function POST(request: Request): Promise<Response> {
  const parsed = IngestPayloadSchema.safeParse(await request.json());

  if (!parsed.success) {
    return Response.json(
      { error: "invalid payload", issues: parsed.error.issues.slice(0, 10) },
      { status: 400 },
    );
  }

  // TODO(B1): authenticate the bearer token, then upsert parsed.data.
  return Response.json({ error: "not implemented" }, { status: 501 });
}
