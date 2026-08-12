# 10 · Publish and claim flow

**Harness:** claude-code · **Owns:** `packages/collector/src/publish.ts`, `apps/web/app/api/claim/`, `apps/web/app/claim/`

`--publish` currently throws. This ticket makes the board fillable by anyone,
which is now the _only_ way rows get on it — the GitHub seeding path was
removed, so an unconnected builder does not appear at all.

That raises the stakes: this flow is the product's front door, and it has to
work for someone who has never seen the repo.

## Flow

1. `ao-wrapped --publish` POSTs to `/api/claim` and receives a short code plus a
   URL.
2. The CLI prints the URL and polls. The user opens it, signs in with GitHub,
   approves.
3. `/api/claim` returns a bearer token bound to that GitHub handle.
4. The CLI stores it at `~/.ao-wrapped/credentials.json`, mode `0600`, then
   POSTs the payload to `/api/ingest`.
5. Subsequent runs reuse the stored token and skip straight to step 4.

## Requirements

Codes expire in ten minutes and are single-use. A token is bound to one handle —
`/api/ingest` already rejects a payload whose handle does not match the token,
so do not weaken that.

The CLI must never ask for a password or a GitHub token. Print the exact URL and
wait; that is the whole interaction.

`--dry-run` keeps working without any of this and must not require a token.

If the API is unreachable, say so plainly and remind the user the local card
already printed. A failed publish is not a failed run.

## Done when

A cold `npx`-style run — no stored credentials — reaches a stored token and a
202 from ingest against a locally running web app, and tests cover an expired
code, a reused code, and a handle mismatch.
