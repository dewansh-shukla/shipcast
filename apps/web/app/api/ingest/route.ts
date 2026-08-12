import { IngestPayloadSchema } from "@ao-wrapped/shared";
import type { ZodIssue } from "zod";
import { getIngestStore, weekKeyForWindow } from "../../../db/store.ts";

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
 *
 * Nor is the season accepted from the client. The board runs in weekly seasons
 * and the week a payload lands in is derived here from its window, so a
 * collector cannot file this week's numbers into a season that has closed.
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

  /**
   * Weeks are the unit the board resets on, so a window that straddles a Monday
   * has no season to land in — splitting it here would mean inventing a split
   * of the counters, which is exactly the arithmetic the collector is not
   * allowed to hand us. Reject it and name the field instead.
   */
  const weekKey = weekKeyForWindow(parsed.data.window);
  if (weekKey === null) {
    return Response.json(
      {
        error: "invalid payload",
        reason:
          "window spans more than one week; the board runs in weekly seasons, " +
          "so send one Monday-to-Sunday window per publish",
        fields: ["window.from", "window.to"],
        unknownFields: [],
      },
      { status: 400 },
    );
  }

  const stored = await store.saveSnapshot(builder.id, parsed.data);

  return Response.json(
    {
      ok: true,
      snapshotId: stored.snapshot.id,
      handle: builder.handle,
      /** The season the row landed in, derived here — never read off the body. */
      weekKey: stored.snapshot.weekKey,
      window: { from: stored.snapshot.windowFrom, to: stored.snapshot.windowTo },
      agents: stored.agents.length,
      replaced: stored.replaced,
    },
    { status: stored.replaced ? 200 : 201 },
  );
}
