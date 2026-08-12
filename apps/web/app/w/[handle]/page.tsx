import type { Metadata } from "next";
import type { AgentStats } from "@ao-wrapped/shared";
import {
  CONNECT_COMMAND,
  deathCauseLabel,
  formatCount,
  formatWindow,
  getWrappedCard,
  graveyardByCause,
  PALETTE,
  personalitiesFor,
  type ConnectedCard,
  type UnconnectedCard,
  type WrappedCard,
} from "./card-data.ts";

/**
 * TICKET C2 — the Wrapped card.
 *
 * Renders from stored counters, so it is always current. The PNG at
 * ./card.png is what unfurls on X and LinkedIn; the metadata below is the only
 * thing that makes the share loop start, so it is the acceptance criterion.
 *
 * A handle nobody has published for gets a locked card with no numbers on it
 * at all. There is nothing to fall back to and inventing one would be a lie —
 * the empty card is the pitch, and the gap is what makes connecting worth it.
 */

function siteUrl(): URL {
  const configured = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!configured) return new URL("http://localhost:3000");
  return new URL(configured.startsWith("http") ? configured : `https://${configured}`);
}

function summarize(card: WrappedCard): string {
  if (card.state === "connected") {
    const { merges, ciRecoveries, peakParallelism, harnesses } = card.totals;
    return `${formatCount(merges)} merges, ${formatCount(ciRecoveries)} CI recoveries, ${peakParallelism} agents at once across ${harnesses} harnesses.`;
  }
  return `${card.handle} is not on the board yet. Only builders who connected the AO collector are ranked — one command puts them here.`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const card = await getWrappedCard(handle);
  const path = `/w/${encodeURIComponent(card.handle)}`;
  const title = `${card.handle} · AO Wrapped`;
  const description = summarize(card);
  const images = [
    {
      url: `${path}/card.png`,
      width: 1200,
      height: 630,
      alt: `${card.handle}'s AO Wrapped card: ${description}`,
    },
  ];

  return {
    metadataBase: siteUrl(),
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: "AO Wrapped",
      url: path,
      title,
      description,
      images,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images,
    },
  };
}

export default async function WrappedPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const card = await getWrappedCard(handle);

  return (
    <main className="card">
      <style>{styles}</style>
      <div className="card-shell">
        <header className="masthead">
          <p className="eyebrow">
            <span className="mark">AO Wrapped</span>
            <span className="rule" aria-hidden="true" />
            <span>{formatWindow(card.window)}</span>
          </p>
          <h1 className="handle">{card.handle}</h1>
          <p className="standing">
            {card.state === "connected"
              ? "Collector connected · every number below was measured on this machine"
              : "Not on the board yet · only collector-reported work is ranked"}
          </p>
        </header>

        {card.state === "connected" ? <Connected card={card} /> : <NotConnected card={card} />}

        <footer className="footer">
          <p>
            Counters come from a local AO database, read-only. No code, diffs, repo names or prompts
            ever leave the machine.
          </p>
        </footer>
      </div>
    </main>
  );
}

function Connected({ card }: { card: ConnectedCard }) {
  const { totals } = card;
  const awards = personalitiesFor(card);
  const graveyard = graveyardByCause(card.graveyard);
  const deaths = card.graveyard.length;

  return (
    <>
      <section className="hero" aria-label="Totals">
        <div className="headline">
          <p className="figure-label">Merges</p>
          <p className="figure">{formatCount(totals.merges)}</p>
          <p className="figure-note">
            out of {formatCount(totals.tasks)} tasks your agents were handed
          </p>
        </div>
        <dl className="satellites">
          <Satellite label="CI recoveries" value={formatCount(totals.ciRecoveries)} tone="signal" />
          <Satellite label="Peak parallelism" value={formatCount(totals.peakParallelism)} />
          <Satellite label="Harnesses" value={formatCount(totals.harnesses)} />
          <Satellite label="Interventions" value={formatCount(totals.interventions)} tone="ember" />
        </dl>
      </section>

      <section className="panel" aria-labelledby="roster-heading">
        <h2 id="roster-heading" className="panel-title">
          The crew
        </h2>
        <ul className="legend">
          <li>
            <span className="chip chip--merges" aria-hidden="true" />
            Merges
          </li>
          <li>
            <span className="chip chip--recoveries" aria-hidden="true" />
            CI recoveries
          </li>
          <li>
            <span className="chip chip--died" aria-hidden="true" />
            Died without a merge
          </li>
        </ul>
        <ul className="roster">
          {card.agents.map((agent) => (
            <RosterRow key={agent.harness} agent={agent} maxTasks={maxTasks(card.agents)} />
          ))}
        </ul>
      </section>

      {awards.length > 0 && (
        <section className="panel" aria-labelledby="awards-heading">
          <h2 id="awards-heading" className="panel-title">
            Awards
          </h2>
          <ul className="awards">
            {awards.map((award) => (
              <li key={award.award} className="award">
                <p className="award-name">{award.award}</p>
                <p className="award-holder">{award.harness}</p>
                <p className="award-detail">{award.detail}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel" aria-labelledby="graveyard-heading">
        <h2 id="graveyard-heading" className="panel-title">
          Graveyard
        </h2>
        <p className="panel-note">
          {formatCount(deaths)} sessions ended without a merge. None of them cost points — punishing
          failure punishes trying.
        </p>
        <ul className="graves">
          {graveyard.map((group) => (
            <li key={group.cause} className="grave">
              <span className="grave-count">{formatCount(group.count)}</span>
              <span className="grave-cause">{deathCauseLabel(group.cause)}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function NotConnected({ card }: { card: UnconnectedCard }) {
  return (
    <>
      <section className="hero" aria-label="Totals">
        <div className="headline">
          <p className="figure-label">Merges</p>
          <p className="figure figure--empty" aria-label="No merges recorded yet">
            —
          </p>
          <p className="figure-note">
            nothing has been published for {card.handle} — this card fills in the first time the
            collector runs
          </p>
        </div>
        <dl className="satellites">
          <LockedSatellite label="CI recoveries" />
          <LockedSatellite label="Peak parallelism" />
          <LockedSatellite label="Harnesses" />
          <LockedSatellite label="Interventions" />
        </dl>
      </section>

      <section className="panel" aria-labelledby="locked-heading">
        <h2 id="locked-heading" className="panel-title">
          The crew
        </h2>
        <ul className="roster">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="roster-row roster-row--locked">
              <Redaction width={`${34 - row * 4}%`} label="Locked agent" />
              <Redaction width={`${52 - row * 6}%`} label="Locked counters" />
            </li>
          ))}
        </ul>
      </section>

      <section className="panel unlock" aria-labelledby="unlock-heading">
        <h2 id="unlock-heading" className="panel-title">
          Not on the board yet
        </h2>
        <p className="unlock-copy">
          Only builders who connected the collector are ranked. Nothing here is guessed from public
          activity: from outside, a merged pull request looks the same whether an agent opened it or
          a person typed it, so it cannot measure agent work. AO can tell the difference, which is
          why it is the only source.
        </p>
        <p className="unlock-copy">One command puts {card.handle} on the board:</p>
        <p className="unlock-command">
          <code>{CONNECT_COMMAND}</code>
        </p>
        <p className="unlock-note">
          Reads <code>~/.ao</code> read-only, prints the whole card offline first, and publishes
          counters only — no code, diffs, repo names or prompts.
        </p>
      </section>
    </>
  );
}

function Satellite({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "signal" | "ember";
}) {
  return (
    <div className="satellite">
      <dt className="satellite-label">{label}</dt>
      <dd className={tone ? `satellite-value satellite-value--${tone}` : "satellite-value"}>
        {value}
      </dd>
    </div>
  );
}

function LockedSatellite({ label }: { label: string }) {
  return (
    <div className="satellite">
      <dt className="satellite-label">{label}</dt>
      <dd className="satellite-value">
        <Redaction width="3.5rem" label={`${label}: locked`} />
      </dd>
    </div>
  );
}

function Redaction({ width, label }: { width: string; label: string }) {
  return <span className="redaction" style={{ width }} role="img" aria-label={label} />;
}

function maxTasks(agents: readonly AgentStats[]): number {
  return agents.reduce((max, agent) => Math.max(max, agent.tasks), 1);
}

function RosterRow({ agent, maxTasks: peak }: { agent: AgentStats; maxTasks: number }) {
  const share = (count: number) => `${(count / peak) * 100}%`;

  return (
    <li className="roster-row">
      <p className="roster-name">{agent.harness}</p>
      <div className="roster-bar" aria-hidden="true">
        <span className="bar bar--merges" style={{ width: share(agent.merges) }} />
        <span className="bar bar--recoveries" style={{ width: share(agent.recoveries) }} />
        <span className="bar bar--died" style={{ width: share(agent.died) }} />
      </div>
      <dl className="roster-stats">
        <div>
          <dt>Tasks</dt>
          <dd>{formatCount(agent.tasks)}</dd>
        </div>
        <div>
          <dt>Merges</dt>
          <dd>{formatCount(agent.merges)}</dd>
        </div>
        <div>
          <dt>Recovered</dt>
          <dd>{formatCount(agent.recoveries)}</dd>
        </div>
        <div>
          <dt>Died</dt>
          <dd>{formatCount(agent.died)}</dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd>{agent.medianMinutes} min</dd>
        </div>
      </dl>
    </li>
  );
}

const styles = `
.card {
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
  padding: clamp(1.5rem, 4vw, 4rem) clamp(1rem, 4vw, 3rem);
  background: var(--ink);
  color: var(--bone);
  font-family: var(--sans);
  line-height: 1.5;
}
.card *, .card *::before, .card *::after { box-sizing: border-box; }
.card p, .card h1, .card h2, .card dl, .card dd, .card ul { margin: 0; padding: 0; }
.card ul { list-style: none; }
.card code {
  font-family: var(--mono);
  color: var(--phosphor);
}
.card-shell {
  max-width: 62rem;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: clamp(1.25rem, 2.5vw, 2rem);
}

.masthead { display: flex; flex-direction: column; gap: 0.5rem; }
.eyebrow {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-family: var(--mono);
  font-size: 0.7rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ash);
}
.mark { color: var(--phosphor); }
.rule { flex: 1; height: 1px; background: var(--edge); }
.handle {
  font-family: var(--mono);
  font-size: clamp(2rem, 7vw, 3.5rem);
  font-weight: 500;
  letter-spacing: -0.03em;
  line-height: 1.05;
  word-break: break-all;
}
.standing { color: var(--ash); font-size: 0.9rem; }

.hero {
  display: flex;
  flex-wrap: wrap;
  gap: clamp(1.5rem, 4vw, 3rem);
  align-items: flex-end;
  padding: clamp(1.25rem, 3vw, 2rem);
  border: 1px solid var(--edge);
  border-radius: 2px;
  background:
    radial-gradient(120% 140% at 0% 0%, rgba(255, 180, 84, 0.09), transparent 60%),
    var(--slate);
}
.headline { flex: 1 1 14rem; }
.figure-label,
.satellite-label,
.panel-title {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ash);
}
.figure {
  font-family: var(--mono);
  font-size: clamp(4rem, 16vw, 7.5rem);
  font-weight: 500;
  line-height: 0.9;
  letter-spacing: -0.05em;
  color: var(--phosphor);
  font-variant-numeric: tabular-nums;
  animation: rise 420ms ease-out both;
}
.figure--empty { color: var(--edge); }
.figure-note { margin-top: 0.75rem; color: var(--ash); font-size: 0.9rem; max-width: 22ch; }
.satellites {
  flex: 1 1 18rem;
  display: grid;
  grid-template-columns: repeat(2, minmax(7rem, 1fr));
  gap: 1rem 1.5rem;
}
.satellite { display: flex; flex-direction: column; gap: 0.35rem; }
.satellite-value {
  font-family: var(--mono);
  font-size: clamp(1.5rem, 4vw, 2rem);
  line-height: 1;
  font-variant-numeric: tabular-nums;
  min-height: 1.4rem;
  display: flex;
  align-items: center;
}
.satellite-value--signal { color: var(--signal); }
.satellite-value--ember { color: var(--ember); }

.panel {
  padding: clamp(1.25rem, 3vw, 1.75rem);
  border: 1px solid var(--edge);
  border-radius: 2px;
  background: var(--slate);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.panel-note { color: var(--ash); font-size: 0.9rem; max-width: 58ch; }

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.5rem;
  font-size: 0.78rem;
  color: var(--ash);
}
.legend li { display: flex; align-items: center; gap: 0.5rem; }
.chip { display: inline-block; width: 0.75rem; height: 0.45rem; border-radius: 1px; }
.chip--merges { background: var(--phosphor); }
.chip--recoveries { background: var(--signal); }
.chip--died { background: var(--edge); }

.roster { display: flex; flex-direction: column; gap: 1.25rem; }
.roster-row {
  display: grid;
  grid-template-columns: minmax(7rem, 9rem) 1fr;
  gap: 0.5rem 1rem;
  align-items: center;
}
.roster-name {
  font-family: var(--mono);
  font-size: 0.95rem;
  letter-spacing: -0.01em;
}
.roster-bar { display: flex; height: 0.5rem; gap: 2px; }
.bar { display: block; height: 100%; border-radius: 1px; min-width: 2px; }
.bar--merges { background: var(--phosphor); }
.bar--recoveries { background: var(--signal); }
.bar--died { background: var(--edge); }
.roster-stats {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.5rem;
  font-size: 0.8rem;
}
.roster-stats div { display: flex; gap: 0.4rem; align-items: baseline; }
.roster-stats dt { color: var(--ash); }
.roster-stats dd { font-family: var(--mono); font-variant-numeric: tabular-nums; }

.awards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  gap: 1rem;
}
.award {
  border-left: 2px solid var(--phosphor);
  padding-left: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.award-name {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--phosphor);
}
.award-holder { font-family: var(--mono); font-size: 1.15rem; }
.award-detail { color: var(--ash); font-size: 0.85rem; }

.graves { display: flex; flex-direction: column; gap: 0.5rem; }
.grave {
  display: flex;
  align-items: baseline;
  gap: 0.9rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--edge);
}
.grave:last-child { border-bottom: none; padding-bottom: 0; }
.grave-count {
  font-family: var(--mono);
  font-size: 1.1rem;
  color: var(--ember);
  font-variant-numeric: tabular-nums;
  min-width: 2ch;
}
.grave-cause { color: var(--bone); font-size: 0.9rem; }

.redaction {
  display: inline-block;
  height: 0.85rem;
  border-radius: 1px;
  background: repeating-linear-gradient(
    -45deg,
    var(--edge) 0 5px,
    rgba(36, 45, 58, 0.45) 5px 10px
  );
}
.roster-row--locked {
  grid-template-columns: minmax(7rem, 9rem) 1fr;
  align-items: center;
}
.roster-row--locked .redaction { height: 0.75rem; }

.unlock { border-color: rgba(255, 180, 84, 0.35); }
.unlock-copy { max-width: 54ch; }
.unlock-command {
  align-self: flex-start;
  font-size: clamp(1.1rem, 3vw, 1.5rem);
  padding: 0.75rem 1rem;
  border: 1px dashed rgba(255, 180, 84, 0.4);
  border-radius: 2px;
  background: rgba(255, 180, 84, 0.06);
}
.unlock-note { color: var(--ash); font-size: 0.85rem; max-width: 54ch; }

.footer {
  color: var(--ash);
  font-size: 0.8rem;
  max-width: 62ch;
  padding-top: 0.5rem;
  border-top: 1px solid var(--edge);
}

@keyframes rise {
  from { opacity: 0; transform: translateY(0.35rem); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .figure { animation: none; }
}
@media (max-width: 30rem) {
  .roster-row { grid-template-columns: 1fr; }
  .roster-stats { grid-column: 1; }
}
`;
