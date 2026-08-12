import { IngestPayloadSchema } from "@ao-wrapped/shared";
import type { ZodIssue } from "zod";
import { getIngestStore } from "../../../db/store.ts";

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

/** Extract the bearer token, or null if the header is absent or malformed. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;

  const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Dotted field paths for every issue, so the response names what was wrong.
 * `.strict()` reports unknown keys against the *parent* object, so the key
 * itself has to be appended to the path to be useful to a collector author.
 */
function fieldsForIssue(issue: ZodIssue): string[] {
  const base = issue.path.map(String);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => [...base, key].join("."));
  }
  return [base.join(".") || "(root)"];
}

function unauthorized(reason: string): Response {
  return Response.json(
    { error: "unauthorized", reason },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const token = bearerToken(request);
  if (token === null) return unauthorized("missing bearer token");

  const store = getIngestStore();
  const builder = await store.builderForToken(token);
  if (builder === null) return unauthorized("unrecognized bearer token");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid payload", reason: "body is not JSON" }, { status: 400 });
  }

  const parsed = IngestPayloadSchema.safeParse(body);

  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10);
    const fields = [...new Set(issues.flatMap(fieldsForIssue))];
    const unknownFields = [
      ...new Set(
        issues.filter((issue) => issue.code === "unrecognized_keys").flatMap(fieldsForIssue),
      ),
    ];

    return Response.json(
      {
        error: "invalid payload",
        reason:
          unknownFields.length > 0
            ? `unknown field: ${unknownFields.join(", ")}`
            : `invalid field: ${fields.join(", ")}`,
        fields,
        unknownFields,
        issues: issues.map((issue) => ({
          path: fieldsForIssue(issue).join(", "),
          code: issue.code,
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  /**
   * A token is issued to one builder, so it may only report for that builder.
   * Without this a leaked token could overwrite somebody else's window.
   */
  if (parsed.data.handle.toLowerCase() !== builder.handle.toLowerCase()) {
    return Response.json(
      { error: "forbidden", reason: "token was not issued to this handle", fields: ["handle"] },
      { status: 403 },
    );
  }

  const stored = await store.saveSnapshot(builder.id, parsed.data);

  return Response.json(
    {
      ok: true,
      snapshotId: stored.snapshot.id,
      handle: builder.handle,
      window: { from: stored.snapshot.windowFrom, to: stored.snapshot.windowTo },
      agents: stored.agents.length,
      replaced: stored.replaced,
    },
    { status: stored.replaced ? 200 : 201 },
  );
}
