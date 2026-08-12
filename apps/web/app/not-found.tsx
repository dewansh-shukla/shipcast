import Link from "next/link";
import "./brutal.css";
import "./claim/claim.css";

/**
 * TICKET 25 — the 404.
 *
 * Root `not-found.tsx` catches every unmatched URL in the app, so without one a
 * mistyped claim link drops somebody onto Next's unstyled default in the middle
 * of connecting a machine. It reuses the claim shell because that is where
 * people arrive from a terminal and mistype a URL.
 *
 * No `metadata` export: it is only honoured by `global-not-found`, which needs a
 * config flag in a file this ticket does not own. Next injects `noindex` on a
 * 404 response by itself.
 *
 * Every colour and face here is a token from `brutal.css`.
 */
export default function NotFound() {
  return (
    <main className="brutal claim">
      <div className="claim-shell slab">
        <p className="claim-cap claim-cap--stop">
          <span className="eyebrow">AO Wrapped</span>
          <span className="claim-cap-sep" aria-hidden="true" />
          <span className="eyebrow">404</span>
        </p>

        <div className="claim-body">
          <h1 className="claim-title">No page here</h1>
          <p className="claim-lede">
            That URL does not match anything on this board. If you were connecting a machine, the
            code from your terminal goes in on the claim page — codes last ten minutes, so a slow
            copy-paste is usually all that went wrong.
          </p>

          <div className="claim-links">
            <Link href="/claim">Enter a claim code →</Link>
            <Link href="/board">This week&apos;s board →</Link>
            <Link href="/">What this is →</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
