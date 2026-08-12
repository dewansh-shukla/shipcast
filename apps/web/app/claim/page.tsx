import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { normalizeUserCode } from "../api/claim/store.ts";
import "../brutal.css";
import "./claim.css";

/**
 * TICKET 10 — the bare /claim entry point. TICKET 25 — in the shared system.
 *
 * The CLI prints a URL with the code already in it, so most people never see
 * this page. It exists for the ones who type the domain from a screenshot, and
 * for the callback that fails before it knows which code it was for.
 *
 * Styling only in ticket 25: the redirect, the field names and the statuses
 * below are unchanged, and every colour and face comes from `brutal.css`.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect a machine · AO Wrapped",
  robots: { index: false, follow: false },
};

const NOTES: Record<string, string> = {
  badstate: "That sign-in did not match a code we issued. Enter the code from your terminal.",
  unconfigured: "This board has no GitHub app configured, so codes cannot be approved here.",
  error: "GitHub sign-in failed. Nothing was connected — enter your code and try again.",
};

export default async function ClaimEntryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;

  const submitted = typeof query.code === "string" ? normalizeUserCode(query.code) : "";
  if (submitted.length === 9) redirect(`/claim/${encodeURIComponent(submitted)}`);

  const status = typeof query.status === "string" ? query.status : null;
  const note = status ? (NOTES[status] ?? null) : null;

  return (
    <main className="brutal claim">
      <div className="claim-shell slab">
        {/* Ember only when something already went wrong; phosphor otherwise. */}
        <p className={note ? "claim-cap claim-cap--stop" : "claim-cap"}>
          <span className="eyebrow">AO Wrapped</span>
          <span className="claim-cap-sep" aria-hidden="true" />
          <span className="eyebrow">device claim</span>
        </p>

        <form className="claim-body" method="get" action="/claim">
          <h1 className="claim-title">Enter your code</h1>
          <p className="claim-lede">
            Your terminal printed an eight-character code. Approving it connects that machine to
            your GitHub handle.
          </p>
          {note && <p className="claim-note">{note}</p>}

          <label className="claim-label" htmlFor="code">
            Claim code
          </label>
          <input
            className="claim-input claim-input--code"
            id="code"
            name="code"
            placeholder="ABCD-EFGH"
            autoComplete="off"
            spellCheck={false}
            maxLength={9}
            required
          />
          <button className="claim-button" type="submit">
            Continue
          </button>

          <div className="claim-retry">
            <code>npx ao-wrapped --publish</code>
            <p className="claim-retry-note">
              No code yet? Run that. The board only knows builders who ran the collector — there is
              no other way onto it.
            </p>
          </div>
        </form>
      </div>
    </main>
  );
}
