import { Fragment } from "react";
import type { Metadata } from "next";
import {
  getClaimStore,
  isGithubConfigured,
  isLocalApprovalAllowed,
  normalizeUserCode,
  type ClaimStatus,
} from "../../api/claim/store.ts";
import "../../brutal.css";
import "../claim.css";

/**
 * TICKET 10 — the approval page. TICKET 25 — in the shared system.
 *
 * The one screen a person who has never seen this repo has to understand. It
 * says what is being connected, what will be sent, and what will not, then
 * offers a single button. No account to create, nothing to configure.
 *
 * Codes live ten minutes and work once, so every terminal state here is a state
 * a real user will hit — an expired code is routine, not an error page.
 *
 * Styling only in ticket 25: every branch, form, field name and destination
 * below is unchanged. Colour, border, shadow and typeface all come from the
 * tokens in `brutal.css`; this file names none of its own.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect a machine · AO Wrapped",
  robots: { index: false, follow: false },
};

type Screen = ClaimStatus | "badhandle" | "badstate" | "error" | "unconfigured";

const SCREENS: Record<Screen, { title: string; body: string; tone: "wait" | "good" | "stop" }> = {
  pending: {
    title: "Connect this machine",
    body: "Approving links the code below to your GitHub handle, so the numbers your collector sends are provably yours.",
    tone: "wait",
  },
  approved: {
    title: "Approved",
    body: "Your terminal has the token and is publishing now. You can close this tab.",
    tone: "good",
  },
  denied: {
    title: "Declined",
    body: "Nothing was connected and nothing was sent. If you did not start this, you are done — the code is dead.",
    tone: "stop",
  },
  expired: {
    title: "This code expired",
    body: "Codes last ten minutes. Run the command again for a fresh one.",
    tone: "stop",
  },
  used: {
    title: "This code was already used",
    body: "Each code connects one machine, once. Run the command again to connect another.",
    tone: "stop",
  },
  unknown: {
    title: "No such code",
    body: "Check the code in your terminal, or run the command again for a new one.",
    tone: "stop",
  },
  badhandle: {
    title: "That is not a GitHub handle",
    body: "Handles are up to 39 letters, digits and hyphens. Try the code again.",
    tone: "stop",
  },
  badstate: {
    title: "That sign-in did not match",
    body: "The link back from GitHub did not match a code we issued. Start again from your terminal.",
    tone: "stop",
  },
  error: {
    title: "GitHub sign-in failed",
    body: "We could not read your handle from GitHub. Nothing was connected — run the command again.",
    tone: "stop",
  },
  unconfigured: {
    title: "This board cannot approve codes",
    body: "No GitHub app is configured here, so there is no way to prove who a handle belongs to.",
    tone: "stop",
  },
};

const TERMINAL_STATUSES = new Set<string>([
  "approved",
  "denied",
  "expired",
  "used",
  "unknown",
  "badhandle",
  "badstate",
  "error",
  "unconfigured",
]);

/** Which cap colour the tone maps to. Phosphor is the open-decision colour. */
const CAP_CLASS: Record<"wait" | "good" | "stop", string> = {
  wait: "claim-cap",
  good: "claim-cap claim-cap--good",
  stop: "claim-cap claim-cap--stop",
};

export default async function ClaimCodePage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { code } = await params;
  const query = await searchParams;

  const userCode = normalizeUserCode(decodeURIComponent(code));
  const claim = await getClaimStore().lookup(userCode);

  const requested = typeof query.status === "string" ? query.status : null;
  /**
   * The URL's status wins only when it reports an outcome the store cannot —
   * a failed GitHub round trip leaves the code pending, and the page has to say
   * what happened rather than silently offering the button again.
   */
  const screen: Screen =
    requested && requested in SCREENS && TERMINAL_STATUSES.has(requested)
      ? (requested as Screen)
      : (claim?.status ?? "unknown");

  const copy = SCREENS[screen];
  const minutes = claim ? Math.max(1, Math.ceil(claim.expiresInSeconds / 60)) : 0;

  return (
    <main className="brutal claim">
      <div className="claim-shell slab">
        <p className={CAP_CLASS[copy.tone]}>
          <span className="eyebrow">AO Wrapped</span>
          <span className="claim-cap-sep" aria-hidden="true" />
          <span className="eyebrow">device claim</span>
        </p>

        <div className="claim-body">
          <h1 className="claim-title">{copy.title}</h1>
          <p className="claim-lede">{copy.body}</p>

          <ClaimCode code={userCode} />

          {screen === "pending" && claim && (
            <>
              <p className="claim-meta">
                Expires in {minutes} minute{minutes === 1 ? "" : "s"}
                {claim.handleHint ? ` · your terminal reported ${claim.handleHint}` : ""}
              </p>

              {isGithubConfigured() ? (
                <a
                  className="claim-button"
                  href={`/api/claim/github?code=${encodeURIComponent(userCode)}`}
                >
                  Continue with GitHub
                </a>
              ) : isLocalApprovalAllowed() ? (
                <form className="claim-form" method="post" action="/api/claim/approve">
                  <input type="hidden" name="code" value={userCode} />
                  <p className="claim-meta">
                    No GitHub app is configured on this board, so this is running in local mode.
                    Approve as a handle to finish the flow.
                  </p>
                  <label className="claim-label" htmlFor="handle">
                    GitHub handle
                  </label>
                  <input
                    className="claim-input"
                    id="handle"
                    name="handle"
                    defaultValue={claim.handleHint ?? ""}
                    placeholder="octocat"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={39}
                    pattern="[A-Za-z0-9-]{1,39}"
                    required
                  />
                  <div className="claim-actions">
                    <button className="claim-button" type="submit" name="intent" value="approve">
                      Approve
                    </button>
                    <button className="claim-decline" type="submit" name="intent" value="deny">
                      Decline
                    </button>
                  </div>
                </form>
              ) : (
                <p className="claim-meta">{SCREENS.unconfigured.body}</p>
              )}

              {isGithubConfigured() && (
                <form method="post" action="/api/claim/approve">
                  <input type="hidden" name="code" value={userCode} />
                  <button className="claim-decline" type="submit" name="intent" value="deny">
                    I did not start this — decline
                  </button>
                </form>
              )}
            </>
          )}

          {screen === "approved" && claim?.handle && (
            <p className="claim-meta">
              Connected as <strong>{claim.handle}</strong>. Your card lives at{" "}
              <a href={`/w/${encodeURIComponent(claim.handle)}`}>/w/{claim.handle}</a>.
            </p>
          )}

          {screen !== "pending" && screen !== "approved" && (
            <div className="claim-retry">
              <code>npx ao-wrapped --publish</code>
              <p className="claim-retry-note">
                Run it again and your terminal prints a fresh code, good for another ten minutes.
              </p>
            </div>
          )}

          <section className="claim-terms" aria-label="What gets sent">
            <h2 className="claim-terms-title">What approving sends</h2>
            <ul className="claim-terms-list">
              <li className="claim-term">
                <span className="claim-tag claim-tag--sent eyebrow">Sent</span>
                <span className="claim-term-text">
                  Counts your collector derived on your machine — tasks, merges, CI recoveries,
                  interventions, tokens.
                </span>
              </li>
              <li className="claim-term">
                <span className="claim-tag claim-tag--never eyebrow">Never sent</span>
                <span className="claim-term-text">
                  Code, diffs, prompts, commit messages, repo names, branch names or file paths. The
                  ingest schema has no field that could hold one.
                </span>
              </li>
            </ul>
            <p className="claim-terms-note">
              Run <code>ao-wrapped --dry-run</code> to print the exact JSON before approving
              anything. The board only knows builders who ran the collector — there is no other way
              onto it.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}

/**
 * The code, grouped the way the CLI prints it.
 *
 * Split only for spacing — every character the terminal showed is still here,
 * separator included, because this string is going to be compared one character
 * at a time by somebody who is deciding whether to trust the page.
 */
function ClaimCode({ code }: { code: string }) {
  if (code === "") {
    return (
      <p className="claim-code claim-code--empty" aria-label="No claim code">
        ————
      </p>
    );
  }

  const groups = code.split("-");

  return (
    <p className="claim-code" aria-label={`Claim code ${code}`}>
      {groups.map((group, index) => (
        <Fragment key={group + String(index)}>
          {index > 0 && <span className="claim-code-sep">-</span>}
          <span className="claim-code-group">{group}</span>
        </Fragment>
      ))}
    </p>
  );
}
