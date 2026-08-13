import type { ReactNode } from "react";
import Image from "next/image";
import type { Metadata } from "next";
import type { AgentStats } from "@ao-wrapped/shared";
import {
  CONNECT_COMMAND,
  deathCauseLabel,
  formatCount,
  formatWindow,
  getWrappedCard,
  graveyardByCause,
  isWithheld,
  personalitiesFor,
  type ConnectedCard,
  type UnconnectedCard,
  type WrappedCard,
} from "./card-data.ts";
import "../../brutal.css";
import "./card.css";

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
 *
 * TICKET 24 — moved onto the shared neo-brutalist system. Every colour, border,
 * shadow and face comes from `brutal.css`; `card.css` carries layout and not one
 * hex value. The PNG beside this file repeats the same palette as literals,
 * because satori has no CSS variables — the two have to stay in step by hand,
 * which is why both name the same tokens in their comments.
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
  const connected = card.state === "connected";

  return (
    <main className="brutal">
      <div className="card-shell">
        <header className="card-masthead">
          <p className="card-strip">
            <span className="card-mark eyebrow">AO Wrapped</span>
            <span className="card-window">{formatWindow(card.window)}</span>
          </p>
          <h1 className="card-handle">{card.handle}</h1>
          <p className="card-standing">
            <span
              className={connected ? "card-pip card-pip--live" : "card-pip card-pip--empty"}
              aria-hidden="true"
            />
            {connected
              ? "Collector connected · every number below was measured on this machine"
              : "Not on the board yet · only collector-reported work is ranked"}
          </p>
        </header>

        {connected ? (
          <div className="meme-block card-meme">
            <Image
              className="meme"
              src="/memes/flex.webp"
              alt=""
              aria-hidden="true"
              width={500}
              height={375}
              sizes="(max-width: 640px) 45vw, 11rem"
            />
            <p className="meme-caption">receipts attached</p>
          </div>
        ) : null}

        {card.state === "connected" ? <Connected card={card} /> : <NotConnected card={card} />}

        <footer className="card-footer">
          <p>
            Counters come from local AO telemetry, read-only. No code, diffs, repo names or prompts
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
      <section className="card-hero" aria-label="Totals">
        <div className="card-figure">
          <p className="eyebrow">Merges</p>
          <p className="card-figure-value">{formatCount(totals.merges)}</p>
          <p className="card-figure-note">
            out of {formatCount(totals.tasks)} tasks your agents were handed
          </p>
        </div>
        <dl className="card-stats">
          <Stat label="CI recoveries" value={formatCount(totals.ciRecoveries)} tone="signal" />
          <Stat label="Peak parallelism" value={formatCount(totals.peakParallelism)} />
          <Stat label="Harnesses" value={formatCount(totals.harnesses)} />
          <Stat label="Interventions" value={formatCount(totals.interventions)} tone="ember" />
        </dl>
      </section>

      <Panel title="The crew" id="roster-heading">
        <ul className="card-legend">
          <li>
            <span className="card-chip card-chip--merges" aria-hidden="true" />
            Merges
          </li>
          <li>
            <span className="card-chip card-chip--recoveries" aria-hidden="true" />
            CI recoveries
          </li>
          <li>
            <span className="card-chip card-chip--died" aria-hidden="true" />
            Died without a merge
          </li>
        </ul>
        <ul className="card-roster">
          {card.agents.map((agent) => (
            <RosterRow key={agent.harness} agent={agent} maxTasks={maxTasks(card.agents)} />
          ))}
        </ul>
      </Panel>

      {awards.length > 0 && (
        <Panel title="Awards" id="awards-heading">
          <ul className="card-awards">
            {awards.map((award) => (
              <li
                key={award.award}
                className={isWithheld(award) ? "card-award card-award--withheld" : "card-award"}
              >
                <p className="card-award-name">{award.award}</p>
                <div className="card-award-body">
                  <p className="card-award-holder">{award.harness}</p>
                  <p className="card-award-detail">{award.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <Panel title="Graveyard" id="graveyard-heading">
        <p className="card-note">
          {formatCount(deaths)} sessions ended without a merge. None of them cost points — punishing
          failure punishes trying.
        </p>
        {graveyard.length > 0 && (
          <ul className="card-graves">
            {graveyard.map((group) => (
              <li key={group.cause} className="card-grave">
                <span className="card-grave-count">{formatCount(group.count)}</span>
                <span className="card-grave-cause">{deathCauseLabel(group.cause)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}

function NotConnected({ card }: { card: UnconnectedCard }) {
  return (
    <>
      <section className="card-hero" aria-label="Totals">
        <div className="card-figure card-figure--empty">
          <p className="eyebrow">Merges</p>
          <p className="card-figure-value" aria-label="No merges recorded yet">
            —
          </p>
          <p className="card-figure-note">
            nothing has been published for {card.handle} — this card fills in the first time the
            collector runs
          </p>
        </div>
        <dl className="card-stats">
          <LockedStat label="CI recoveries" />
          <LockedStat label="Peak parallelism" />
          <LockedStat label="Harnesses" />
          <LockedStat label="Interventions" />
        </dl>
      </section>

      <Panel title="The crew" id="locked-heading">
        <ul className="card-roster">
          {[0, 1, 2, 3].map((row) => (
            <li key={row} className="card-locked-row">
              <Redaction width={`${34 - row * 4}%`} label="Locked agent" />
              <Redaction width={`${52 - row * 6}%`} label="Locked counters" />
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Not on the board yet" id="unlock-heading">
        <div className="card-unlock">
          <p className="card-copy">
            Only builders who connected the collector are ranked. Nothing here is guessed from
            public activity: from outside, a merged pull request looks the same whether an agent
            opened it or a person typed it, so it cannot measure agent work. AO can tell the
            difference, which is why it is the only source.
          </p>
          <p className="card-copy">One command puts {card.handle} on the board:</p>
          <p className="card-command">
            <code>{CONNECT_COMMAND}</code>
          </p>
          <p className="card-copy card-award-detail">
            Reads <code>~/.ao</code> read-only, prints the whole card offline first, and publishes
            counters only — no code, diffs, repo names or prompts.
          </p>
        </div>
      </Panel>
    </>
  );
}

/** One slab with an ink cap. Every section below the hero is one of these. */
function Panel({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="card-panel" aria-labelledby={id}>
      <div className="card-panel-head">
        <h2 id={id} className="card-panel-title">
          {title}
        </h2>
      </div>
      <div className="card-panel-body">{children}</div>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "signal" | "ember" }) {
  return (
    <div className={tone ? `card-stat card-stat--${tone}` : "card-stat"}>
      <dt className="eyebrow">{label}</dt>
      <dd className="card-stat-value num">{value}</dd>
    </div>
  );
}

/**
 * A metric with no source is an em dash and the reason for it. Printing a zero
 * would be a measurement nobody took.
 */
function LockedStat({ label }: { label: string }) {
  return (
    <div className="card-stat">
      <dt className="eyebrow">{label}</dt>
      <dd className="card-stat-value card-stat-value--none">—</dd>
      <p className="card-stat-why">not published yet</p>
    </div>
  );
}

function Redaction({ width, label }: { width: string; label: string }) {
  return <span className="card-redaction" style={{ width }} role="img" aria-label={label} />;
}

function maxTasks(agents: readonly AgentStats[]): number {
  return agents.reduce((max, agent) => Math.max(max, agent.tasks), 1);
}

function RosterRow({ agent, maxTasks: peak }: { agent: AgentStats; maxTasks: number }) {
  const share = (count: number) => `${(count / peak) * 100}%`;

  return (
    <li className="card-crew">
      <p className="card-crew-name">{agent.harness}</p>
      <div className="card-bar" aria-hidden="true">
        <span className="card-bar-merges" style={{ width: share(agent.merges) }} />
        <span className="card-bar-recoveries" style={{ width: share(agent.recoveries) }} />
        <span className="card-bar-died" style={{ width: share(agent.died) }} />
      </div>
      <dl className="card-crew-stats">
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
