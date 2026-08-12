import type { ReactNode } from "react";
import { ImageResponse } from "next/og";
import type { AgentStats } from "@ao-wrapped/shared";
import {
  CONNECT_COMMAND,
  formatCount,
  formatWindow,
  getWrappedCard,
  isWithheld,
  personalitiesFor,
  type ConnectedCard,
  type UnconnectedCard,
} from "../card-data.ts";

/**
 * TICKET C2 — the unfurl. TICKET 24 — in the shared system.
 *
 * The same card as the page, rendered as a PNG so X and LinkedIn have something
 * to show. `ImageResponse` ships with Next, so no dependency was added.
 *
 * Satori (behind ImageResponse) supports a subset of CSS, and three limits
 * shape everything below:
 *
 * - **No CSS variables.** The tokens from `app/brutal.css` are repeated here as
 *   literals. They are not new colours and must not become new colours: if a
 *   token changes there, it changes here, or the share image stops matching the
 *   page it links to.
 * - **Flexbox only, and `display: flex` must be explicit** on every container.
 *   No grid, no floats.
 * - **No scrolling or clipping.** Content taller than the frame overlaps rather
 *   than being cut, so every band carries an explicit height and the type is
 *   sized to fit inside it.
 *
 * Neo-brutalism happens to suit this renderer — flat fills, solid borders and
 * hard unblurred shadows are exactly the parts of CSS satori does well.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * `app/brutal.css`, inlined. Same names, same values, no additions — satori
 * cannot read the stylesheet, so this is a copy that has to be kept honest.
 */
const T = {
  paper: "#f4f2ed",
  ink: "#0e1116",
  ash: "#7e8794",
  phosphor: "#ffb454",
  signal: "#5fd4c4",
  ember: "#e0685a",
} as const;

/** The system's rules, as satori spellings. */
const EDGE = `3px solid ${T.ink}`;
const EDGE_THIN = `2px solid ${T.ink}`;
const DROP = `8px 8px 0 ${T.ink}`;
const DROP_SM = `6px 6px 0 ${T.ink}`;

const PAD_X = 44;
const PAD_Y = 40;
/** 630 − 2 × PAD_Y, split across the four bands, with the shadows' room left over. */
const BAND = { header: 46, identity: 104, main: 276, footer: 92 };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<Response> {
  const { handle } = await params;
  const card = await getWrappedCard(handle);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: T.paper,
        color: T.ink,
        fontFamily: "system-ui, sans-serif",
        padding: `${PAD_Y}px ${PAD_X}px`,
      }}
    >
      <div style={{ display: "flex", alignItems: "stretch", height: BAND.header }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            backgroundColor: T.ink,
            color: T.paper,
            fontSize: 20,
            letterSpacing: 4,
            border: EDGE,
          }}
        >
          AO WRAPPED
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            border: EDGE,
            borderLeft: "0",
            fontSize: 20,
            letterSpacing: 2,
          }}
        >
          {formatWindow(card.window).toUpperCase()}
        </div>
        <div style={{ display: "flex", flexGrow: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "0 18px",
            border: EDGE,
            backgroundColor: card.state === "connected" ? T.signal : T.paper,
            fontSize: 20,
            letterSpacing: 2,
          }}
        >
          {card.state === "connected" ? "COLLECTOR CONNECTED" : "NOT ON THE BOARD YET"}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          height: BAND.identity,
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: handleSize(card.handle),
            fontWeight: 800,
            letterSpacing: -2,
            textTransform: "uppercase",
          }}
        >
          {card.handle}
        </div>
      </div>

      {card.state === "connected" ? <ConnectedBody card={card} /> : <UnconnectedBody />}
    </div>,
    {
      ...size,
      headers: {
        "cache-control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
      },
    },
  );
}

/** Long GitHub handles get smaller rather than colliding with the band below. */
function handleSize(handle: string): number {
  if (handle.length > 26) return 40;
  if (handle.length > 18) return 52;
  return 64;
}

function ConnectedBody({ card }: { card: ConnectedCard }) {
  const { totals } = card;
  /**
   * Withheld categories are dropped, not printed empty. An award is a
   * comparison, and on 1200×630 there is no room to explain a blank — so the
   * row simply is not there, which is the honest shape of "no contest".
   */
  const awards = personalitiesFor(card).filter((award) => !isWithheld(award));
  const closer = awards.find((award) => award.award === "Closer");
  const chaotic = awards.find((award) => award.award === "Most chaotic");

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", height: BAND.main }}>
        <Figure
          value={formatCount(totals.merges)}
          note={`out of ${formatCount(totals.tasks)} tasks`}
        />
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, marginLeft: 20 }}>
          <div style={{ display: "flex" }}>
            <Stat label="CI RECOVERIES" value={formatCount(totals.ciRecoveries)} tone={T.signal} />
            <Stat label="PEAK PARALLEL" value={formatCount(totals.peakParallelism)} />
          </div>
          <div style={{ display: "flex", marginTop: 12 }}>
            <Stat label="HARNESSES" value={formatCount(totals.harnesses)} />
            <Stat label="INTERVENTIONS" value={formatCount(totals.interventions)} tone={T.ember} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 14 }}>
            {card.agents.slice(0, 3).map((agent) => (
              <CrewBar key={agent.harness} agent={agent} scale={barScale(card.agents)} />
            ))}
          </div>
        </div>
      </div>

      <Footer>
        {closer && <Award label="CLOSER" holder={closer.harness} cap={T.phosphor} />}
        {chaotic && <Award label="MOST CHAOTIC" holder={chaotic.harness} cap={T.ember} />}
        <Award
          label="GRAVEYARD"
          holder={`${formatCount(card.graveyard.length)} without a merge`}
          cap={T.paper}
        />
      </Footer>
    </div>
  );
}

/**
 * No counters, because there are none — a handle only has numbers once its
 * owner published them. An em dash where the figure goes says that without
 * inventing anything to put there.
 */
function UnconnectedBody() {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", height: BAND.main }}>
        <Figure value="—" note="nothing published yet" empty />
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, marginLeft: 20 }}>
          <div style={{ display: "flex" }}>
            <Stat label="CI RECOVERIES" value="—" muted />
            <Stat label="PEAK PARALLEL" value="—" muted />
          </div>
          <div style={{ display: "flex", marginTop: 12 }}>
            <Stat label="HARNESSES" value="—" muted />
            <Stat label="INTERVENTIONS" value="—" muted />
          </div>
          {/*
            No placeholder bars where the crew goes. Blocks shaped like data are
            still shaped like data on a card whose whole argument is that it only
            shows what it measured — and beside an em dash they read as one more
            redacted number rather than as an empty state.
          */}
          <div style={{ display: "flex", marginTop: 22, fontSize: 21, color: T.ash }}>
            No agents reported yet
          </div>
        </div>
      </div>

      <Footer>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            border: EDGE,
            boxShadow: DROP_SM,
            backgroundColor: T.phosphor,
            padding: "12px 20px",
            fontSize: 26,
            fontWeight: 700,
          }}
        >
          {CONNECT_COMMAND}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginLeft: 22,
            fontSize: 21,
            color: T.ink,
            width: 360,
          }}
        >
          Measured on your machine, never guessed from GitHub
        </div>
      </Footer>
    </div>
  );
}

/** The one number the card exists to carry, on the system's primary block. */
function Figure({ value, note, empty }: { value: string; note: string; empty?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        width: 430,
        padding: "0 26px",
        border: EDGE,
        boxShadow: DROP,
        backgroundColor: empty ? T.paper : T.phosphor,
      }}
    >
      <div style={{ display: "flex", fontSize: 19, letterSpacing: 4, fontWeight: 700 }}>MERGES</div>
      <div
        style={{
          display: "flex",
          fontSize: empty ? 96 : 150,
          lineHeight: 1,
          fontWeight: 800,
          letterSpacing: empty ? 0 : -6,
          color: empty ? T.ash : T.ink,
        }}
      >
        {value}
      </div>
      <div style={{ display: "flex", fontSize: 23, marginTop: 12 }}>{note}</div>
    </div>
  );
}

/**
 * The hero block's 8px shadow lands in this band, so the footer starts below it
 * rather than under it — a shadow crossing a bordered box reads as a rendering
 * fault rather than as depth.
 */
function Footer({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", height: BAND.footer, paddingTop: 16, alignItems: "flex-end" }}>
      {children}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  muted,
}: {
  label: string;
  value: string;
  tone?: string;
  muted?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 234,
        marginRight: 14,
        padding: "10px 14px",
        border: EDGE_THIN,
        backgroundColor: T.paper,
      }}
    >
      <div style={{ display: "flex", fontSize: 16, letterSpacing: 3, color: T.ash }}>{label}</div>
      <div
        style={{
          display: "flex",
          fontSize: 40,
          fontWeight: 800,
          marginTop: 2,
          color: muted ? T.ash : (tone ?? T.ink),
        }}
      >
        {value}
      </div>
    </div>
  );
}

/** An award: a coloured cap over the harness that earned it. */
function Award({ label, holder, cap }: { label: string; holder: string; cap: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 340,
        marginRight: 18,
        border: EDGE_THIN,
        backgroundColor: T.paper,
      }}
    >
      <div
        style={{
          display: "flex",
          padding: "4px 12px",
          backgroundColor: cap,
          borderBottom: EDGE_THIN,
          fontSize: 16,
          letterSpacing: 3,
          fontWeight: 700,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", padding: "8px 12px", fontSize: 25, fontWeight: 700 }}>
        {holder}
      </div>
    </div>
  );
}

/**
 * Fixed track width. Satori does not shrink flex children, so a bar sized
 * against anything but its own track runs off the canvas — which it did, at
 * 1200px wide, with the longest bar leaving the frame entirely.
 */
const TRACK = 330;
const TRACK_INNER = TRACK - 16;

/**
 * One scale for every row, against the busiest agent's total, so the rows stay
 * comparable with each other and none of them can overflow the track.
 */
function barScale(agents: readonly AgentStats[]): (count: number) => number {
  const peak = agents.reduce(
    (max, agent) => Math.max(max, agent.merges + agent.recoveries + agent.died),
    1,
  );
  return (count) => (count === 0 ? 0 : Math.max(6, Math.round((count / peak) * TRACK_INNER)));
}

/** Merges, recoveries and deaths as one bar, scaled against the busiest agent. */
function CrewBar({ agent, scale }: { agent: AgentStats; scale: (count: number) => number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", height: 24, marginBottom: 4 }}>
      <div style={{ display: "flex", width: 150, fontSize: 18, fontWeight: 700 }}>
        {agent.harness}
      </div>
      <div style={{ display: "flex", width: TRACK, height: 18, border: EDGE_THIN, padding: 2 }}>
        <div
          style={{
            display: "flex",
            width: scale(agent.merges),
            marginRight: 3,
            backgroundColor: T.phosphor,
          }}
        />
        <div
          style={{
            display: "flex",
            width: scale(agent.recoveries),
            marginRight: 3,
            backgroundColor: T.signal,
          }}
        />
        <div style={{ display: "flex", width: scale(agent.died), backgroundColor: T.ink }} />
      </div>
    </div>
  );
}
