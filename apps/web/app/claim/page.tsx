import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { normalizeUserCode } from "../api/claim/store.ts";

/**
 * TICKET 10 — the bare /claim entry point.
 *
 * The CLI prints a URL with the code already in it, so most people never see
 * this page. It exists for the ones who type the domain from a screenshot, and
 * for the callback that fails before it knows which code it was for.
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
    <main className="entry">
      <style>{styles}</style>
      <form className="shell" method="get" action="/claim">
        <p className="eyebrow">
          <span className="mark">AO Wrapped</span>
          <span className="rule" aria-hidden="true" />
          <span>device claim</span>
        </p>

        <h1 className="title">Enter your code</h1>
        <p className="lede">
          Your terminal printed an eight-character code. Approving it connects that machine to your
          GitHub handle.
        </p>
        {note && <p className="note">{note}</p>}

        <label className="label" htmlFor="code">
          Claim code
        </label>
        <input
          className="input"
          id="code"
          name="code"
          placeholder="ABCD-EFGH"
          autoComplete="off"
          spellCheck={false}
          maxLength={9}
          required
        />
        <button className="button" type="submit">
          Continue
        </button>

        <p className="foot">
          No code yet? Run <code>npx ao-wrapped --publish</code>. The board only knows builders who
          ran the collector — there is no other way onto it.
        </p>
      </form>
    </main>
  );
}

const styles = `
.entry {
  --ink: #0b0e12;
  --slate: #12161c;
  --edge: #242d3a;
  --bone: #e8eaed;
  --ash: #8b95a5;
  --phosphor: #7ee787;
  --ember: #ffb454;
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
.entry *, .entry *::before, .entry *::after { box-sizing: border-box; }
.entry p, .entry h1 { margin: 0; padding: 0; }
.entry code { font-family: var(--mono); color: var(--phosphor); }

.shell {
  width: 100%;
  max-width: 30rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  padding: clamp(1.5rem, 4vw, 2.5rem);
  border: 1px solid var(--edge);
  border-radius: 2px;
  background: var(--slate);
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
  font-size: clamp(1.4rem, 5vw, 1.9rem);
  font-weight: 500;
  letter-spacing: -0.02em;
}
.lede { color: var(--bone); max-width: 42ch; }
.note { color: var(--ember); font-size: 0.88rem; max-width: 42ch; }
.label {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ash);
}
.input {
  padding: 0.8rem;
  border: 1px solid var(--edge);
  border-radius: 2px;
  background: var(--ink);
  color: var(--bone);
  font-family: var(--mono);
  font-size: 1.35rem;
  letter-spacing: 0.14em;
  text-align: center;
  text-transform: uppercase;
}
.input:focus { outline: 2px solid var(--phosphor); outline-offset: 1px; }
.button {
  padding: 0.8rem 1.2rem;
  border: 1px solid var(--phosphor);
  border-radius: 2px;
  background: rgba(126, 231, 135, 0.12);
  color: var(--phosphor);
  font-family: var(--mono);
  font-size: 0.95rem;
  cursor: pointer;
}
.button:hover { background: rgba(126, 231, 135, 0.2); }
.foot { color: var(--ash); font-size: 0.82rem; }
`;
