# 20 · Persist claim codes

**Harness:** claude-code · **Owns:** `apps/web/app/api/claim/store.ts`, `apps/web/app/api/claim/claim-store.test.ts`, `apps/web/db/schema.ts`, `apps/web/db/migrations/`

**This is the highest-priority defect in the project. Nobody can join the board
until it is fixed.**

## What happens

Reproduced against production just now:

1. `ao-wrapped --publish` calls `POST /api/claim` and is issued `CKK7-P3AB`.
2. The user opens `https://ao-wrapped.vercel.app/claim/CKK7-P3AB`.
3. The page says **"No such code"**.

## Why

`ClaimStore` holds everything in memory:

```ts
private readonly byUserCode = new Map<string, ClaimRecord>();
private readonly byDeviceCode = new Map<string, string>();
private readonly byOauthState = new Map<string, string>();
```

Every request on Vercel can land on a different serverless instance. The POST
that created the code ran on one instance; the browser hit another, whose maps
are empty. It works locally only because there is a single process.

Ticket 16 fixed exactly this for snapshots and device tokens and stopped short of
the claim flow, which is the one part a stranger touches first.

Note the flow crosses **three** requests — issue, GitHub redirect, callback — so
`byOauthState` has to survive too, not just `byUserCode`. Fixing the visible
symptom without it will fail one step later.

## Work

Add a `claim_codes` table and back the store with it. Suggested shape, adjust as
the code needs:

| column             | notes                                             |
| ------------------ | ------------------------------------------------- |
| `user_code`        | unique, what the human types or clicks            |
| `device_code_hash` | hashed, never stored raw — follow `device_tokens` |
| `oauth_state`      | indexed; the GitHub callback looks up by it       |
| `handle_hint`      | nullable                                          |
| `status`           | pending / approved / consumed                     |
| `builder_id`       | nullable until approved                           |
| `expires_at`       | timestamptz                                       |

Keep the in-memory implementation and select on `DATABASE_URL` exactly as
`getIngestStore()` does, so tests keep running without a database.

Preserve the security properties already in place, all of which have tests:
codes expire in ten minutes, are single-use, the device code is compared without
leaking timing, and an approved code binds to exactly one handle. Persisting must
not weaken any of them — re-read the existing tests before changing behaviour.

Expired rows should be deleted opportunistically on lookup. A cron job is not
worth it for this.

## Done when

A code issued by one process is resolvable by another, the full flow works
against the deployed board, expired and reused codes are still rejected, and the
in-memory path still works with `DATABASE_URL` unset.
