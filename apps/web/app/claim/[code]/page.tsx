import type { Metadata } from "next";
import {
  getClaimStore,
  isGithubConfigured,
  isLocalApprovalAllowed,
  normalizeUserCode,
  type ClaimStatus,
} from "../../api/claim/store.ts";

/**
 * TICKET 10 — the approval page.
 *
 * The one screen a person who has never seen this repo has to understand. It
 * says what is being connected, what will be sent, and what will not, then
 * offers a single button. No account to create, nothing to configure.
 *
 * Codes live ten minutes and work once, so every terminal state here is a state
 * a real user will hit — an expired code is routine, not an error page.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect a machine · AO Wrapped",
  robots: { index: false, follow: false },
};

/**
 * Copied rather than imported from the card so the two pages can be restyled
 * independently — this one is a utility screen, not a share artifact.
 */
const PALETTE = {
  ink: "#0b0e12",
  slate: "#12161c",
  edge: "#242d3a",
  bone: "#e8eaed",
  ash: "#8b95a5",
  phosphor: "#7ee787",
  signal: "#58a6ff",
  ember: "#ffb454",
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
    <main className="claim">
      <style>{styles}</style>
      <div className="shell">
        <p className="eyebrow">
          <span className="mark">AO Wrapped</span>
          <span className="rule" aria-hidden="true" />
          <span>device claim</span>
        </p>

        <h1 className={`title title--${copy.tone}`}>{copy.title}</h1>
        <p className="lede">{copy.body}</p>

        <p className="code" aria-label={`Claim code ${userCode}`}>
          {userCode || "————————"}
        </p>

        {screen === "pending" && claim && (
          <>
            <p className="meta">
              Expires in {minutes} minute{minutes === 1 ? "" : "s"}
              {claim.handleHint ? ` · your terminal reported ${claim.handleHint}` : ""}
            </p>

            {isGithubConfigured() ? (
              <a className="button" href={`/api/claim/github?code=${encodeURIComponent(userCode)}`}>
                Continue with GitHub
              </a>
            ) : isLocalApprovalAllowed() ? (
              <form className="local" method="post" action="/api/claim/approve">
                <input type="hidden" name="code" value={userCode} />
                <p className="local-note">
                  No GitHub app is configured on this board, so this is running in local mode.
                  Approve as a handle to finish the flow.
                </p>
                <label className="label" htmlFor="handle">
                  GitHub handle
                </label>
                <input
                  className="input"
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
                <div className="actions">
                  <button className="button" type="submit" name="intent" value="approve">
                    Approve
                  </button>
                  <button className="button button--quiet" type="submit" name="intent" value="deny">
                    Decline
                  </button>
                </div>
              </form>
            ) : (
              <p className="meta">{SCREENS.unconfigured.body}</p>
            )}

            {isGithubConfigured() && (
              <form className="deny" method="post" action="/api/claim/approve">
                <input type="hidden" name="code" value={userCode} />
                <button className="link" type="submit" name="intent" value="deny">
                  I did not start this — decline
                </button>
              </form>
            )}
          </>
        )}

        {screen === "approved" && claim?.handle && (
          <p className="meta">
            Connected as <strong>{claim.handle}</strong>. Your card lives at{" "}
            <a className="inline-link" href={`/w/${encodeURIComponent(claim.handle)}`}>
              /w/{claim.handle}
            </a>
            .
          </p>
        )}

        {screen !== "pending" && screen !== "approved" && (
          <p className="retry">
            <code>npx ao-wrapped --publish</code>
          </p>
        )}

        <section className="terms" aria-label="What gets sent">
          <h2 className="terms-title">What approving sends</h2>
          <ul className="terms-list">
            <li>
              <span className="yes">Sent</span> counts your collector derived on your machine —
              tasks, merges, CI recoveries, interventions, tokens.
            </li>
            <li>
              <span className="no">Never sent</span> code, diffs, prompts, commit messages, repo
              names, branch names or file paths. The ingest schema has no field that could hold one.
            </li>
          </ul>
          <p className="terms-note">
            Run <code>ao-wrapped --dry-run</code> to print the exact JSON before approving anything.
            The board only knows builders who ran the collector — there is no other way onto it.
          </p>
        </section>
      </div>
    </main>
  );
}

const styles = `
.claim {
  --ink: ${PALETTE.ink};
  --slate: ${PALETTE.slate};
  --edge: ${PALETTE.edge};
  --bone: ${PALETTE.bone};
  --ash: ${PALETTE.ash};
  --phosphor: ${PALETTE.phosphor};
  --signal: ${PALETTE.signal};
  --ember: ${PALETTE.ember};
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", "Cascadia Mono", Menlo, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;

  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(1.5rem, 5vw, 4rem) clamp(1rem, 4vw, 3rem);
  background: var(--ink);
  color: var(--bone);
  font-family: var(--sans);
  line-height: 1.5;
}
.claim *, .claim *::before, .claim *::after { box-sizing: border-box; }
.claim p, .claim h1, .claim h2, .claim ul { margin: 0; padding: 0; }
.claim ul { list-style: none; }
.claim code { font-family: var(--mono); color: var(--phosphor); }

.shell {
  width: 100%;
  max-width: 34rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: clamp(1.5rem, 4vw, 2.5rem);
  border: 1px solid var(--edge);
  border-radius: 2px;
  background:
    radial-gradient(120% 140% at 0% 0%, rgba(126, 231, 135, 0.07), transparent 60%),
    var(--slate);
}

.eyebrow {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ash);
}
.mark { color: var(--phosphor); }
.rule { flex: 1; height: 1px; background: var(--edge); }

.title {
  font-family: var(--mono);
  font-size: clamp(1.5rem, 5vw, 2rem);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.title--good { color: var(--phosphor); }
.title--stop { color: var(--ember); }
.lede { color: var(--bone); max-width: 46ch; }

.code {
  font-family: var(--mono);
  font-size: clamp(2rem, 9vw, 3rem);
  letter-spacing: 0.14em;
  color: var(--phosphor);
  padding: 0.75rem 0;
  border-top: 1px solid var(--edge);
  border-bottom: 1px solid var(--edge);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.meta { color: var(--ash); font-size: 0.9rem; }
.retry {
  align-self: flex-start;
  padding: 0.6rem 0.9rem;
  border: 1px dashed rgba(126, 231, 135, 0.35);
  border-radius: 2px;
  background: rgba(126, 231, 135, 0.05);
}

.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.8rem 1.2rem;
  border: 1px solid var(--phosphor);
  border-radius: 2px;
  background: rgba(126, 231, 135, 0.12);
  color: var(--phosphor);
  font-family: var(--mono);
  font-size: 0.95rem;
  text-decoration: none;
  cursor: pointer;
}
.button:hover { background: rgba(126, 231, 135, 0.2); }
.button--quiet {
  border-color: var(--edge);
  background: transparent;
  color: var(--ash);
}
.button--quiet:hover { background: rgba(36, 45, 58, 0.5); }

.local { display: flex; flex-direction: column; gap: 0.6rem; }
.local-note { color: var(--ember); font-size: 0.85rem; max-width: 46ch; }
.label {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ash);
}
.input {
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--edge);
  border-radius: 2px;
  background: var(--ink);
  color: var(--bone);
  font-family: var(--mono);
  font-size: 1rem;
}
.input:focus { outline: 2px solid var(--signal); outline-offset: 1px; }
.actions { display: flex; flex-wrap: wrap; gap: 0.6rem; }

.deny { margin-top: -0.25rem; }
.link {
  padding: 0;
  border: none;
  background: none;
  color: var(--ash);
  font-family: var(--sans);
  font-size: 0.85rem;
  text-decoration: underline;
  cursor: pointer;
}
.inline-link { color: var(--signal); }

.terms {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding-top: 1rem;
  border-top: 1px solid var(--edge);
}
.terms-title {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ash);
  font-weight: 500;
}
.terms-list { display: flex; flex-direction: column; gap: 0.5rem; font-size: 0.85rem; }
.terms-list li { color: var(--bone); }
.yes, .no {
  display: inline-block;
  margin-right: 0.5rem;
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}
.yes { color: var(--phosphor); }
.no { color: var(--ember); }
.terms-note { color: var(--ash); font-size: 0.82rem; }
`;
