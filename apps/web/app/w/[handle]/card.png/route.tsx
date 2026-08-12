import type { ReactNode } from "react";
import { ImageResponse } from "next/og";
import type { AgentStats } from "@ao-wrapped/shared";
import {
  CONNECT_COMMAND,
  formatCount,
  formatWindow,
  getWrappedCard,
  PALETTE,
  personalitiesFor,
  type ConnectedCard,
  type UnconnectedCard,
} from "../card-data.ts";

/**
 * TICKET C2 — the unfurl.
 *
 * The same card as the page, rendered as a PNG so X and LinkedIn have something
 * to show. `ImageResponse` ships with Next, so no dependency was added.
 *
 * Satori (behind ImageResponse) supports a subset of CSS: flexbox only, no
 * grid, and no font stack beyond the bundled default. It also does not scroll —
 * content taller than the frame overlaps instead of clipping — so every band
 * below carries an explicit height and the numbers are sized to fit inside it.
 */

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const PAD_X = 56;
const PAD_Y = 48;
/** 630 − 2 × PAD_Y, split across the four bands below. */
const BAND = { header: 40, identity: 118, main: 282, footer: 94 };

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
        backgroundColor: PALETTE.ink,
        color: PALETTE.bone,
        fontFamily: "system-ui, sans-serif",
        padding: `${PAD_Y}px ${PAD_X}px`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: BAND.header,
          fontSize: 21,
        }}
      >
        <div style={{ display: "flex", color: PALETTE.phosphor, letterSpacing: 6 }}>AO WRAPPED</div>
        <div
          style={{
            display: "flex",
            flexGrow: 1,
            height: 1,
            margin: "0 22px",
            backgroundColor: PALETTE.edge,
          }}
        />
        <div style={{ display: "flex", color: PALETTE.ash, letterSpacing: 2 }}>
          {formatWindow(card.window)}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          height: BAND.identity,
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", fontSize: handleSize(card.handle), letterSpacing: -2 }}>
          {card.handle}
        </div>
        <div style={{ display: "flex", fontSize: 24, color: PALETTE.ash, marginTop: 12 }}>
          {card.state === "connected"
            ? "Collector connected"
            : "Not on the board yet · only collector-reported work is ranked"}
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
  if (handle.length > 26) return 38;
  if (handle.length > 18) return 48;
  return 56;
}

function ConnectedBody({ card }: { card: ConnectedCard }) {
  const { totals } = card;
  const awards = personalitiesFor(card);
  const closer = awards.find((award) => award.award === "Closer");
  const chaotic = awards.find((award) => award.award === "Most chaotic");

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", height: BAND.main, paddingTop: 12 }}>
        <Headline
          value={formatCount(totals.merges)}
          note={`out of ${formatCount(totals.tasks)} tasks`}
        />
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ display: "flex" }}>
            <Stat label="CI recoveries" value={totals.ciRecoveries} color={PALETTE.signal} />
            <Stat label="Peak parallelism" value={totals.peakParallelism} />
          </div>
          <div style={{ display: "flex", marginTop: 20 }}>
            <Stat label="Harnesses" value={totals.harnesses} />
            <Stat label="Interventions" value={totals.interventions} color={PALETTE.ember} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
            {card.agents.slice(0, 4).map((agent) => (
              <CrewBar key={agent.harness} agent={agent} peak={peakTasks(card.agents)} />
            ))}
          </div>
        </div>
      </div>

      <Footer>
        {closer && <Award label="Closer" holder={closer.harness} color={PALETTE.phosphor} />}
        {chaotic && <Award label="Most chaotic" holder={chaotic.harness} color={PALETTE.ember} />}
        <Award label="Graveyard" holder={`${formatCount(card.graveyard.length)} sessions`} />
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
      <div style={{ display: "flex", height: BAND.main, paddingTop: 12 }}>
        <Headline value="—" note="nothing published yet" color={PALETTE.edge} />
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ display: "flex" }}>
            <LockedStat label="CI recoveries" />
            <LockedStat label="Peak parallelism" />
          </div>
          <div style={{ display: "flex", marginTop: 20 }}>
            <LockedStat label="Harnesses" />
            <LockedStat label="Interventions" />
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 26 }}>
            {[300, 244, 188, 148].map((width) => (
              <div
                key={width}
                style={{
                  display: "flex",
                  width,
                  height: 12,
                  marginBottom: 8,
                  backgroundColor: PALETTE.edge,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      <Footer>
        <div style={{ display: "flex", alignItems: "center", fontSize: 25 }}>
          <div style={{ display: "flex", color: PALETTE.ash }}>
            Measured on your machine, never guessed from GitHub
          </div>
          <div
            style={{
              display: "flex",
              marginLeft: 24,
              padding: "8px 18px",
              color: PALETTE.phosphor,
              border: `1px solid ${PALETTE.edge}`,
            }}
          >
            {CONNECT_COMMAND}
          </div>
        </div>
      </Footer>
    </div>
  );
}

function Headline({ value, note, color }: { value: string; note: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 420 }}>
      <Label>MERGES</Label>
      <div
        style={{
          display: "flex",
          fontSize: 150,
          lineHeight: 1,
          letterSpacing: -6,
          color: color ?? PALETTE.phosphor,
        }}
      >
        {value}
      </div>
      <div style={{ display: "flex", fontSize: 24, color: PALETTE.ash, marginTop: 14 }}>{note}</div>
    </div>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: BAND.footer }}>
      <div
        style={{ display: "flex", height: 1, backgroundColor: PALETTE.edge, marginBottom: 26 }}
      />
      <div style={{ display: "flex" }}>{children}</div>
    </div>
  );
}

function Label({ children }: { children: string }) {
  return (
    <div
      style={{
        display: "flex",
        fontSize: 19,
        letterSpacing: 5,
        color: PALETTE.ash,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 250 }}>
      <div style={{ display: "flex", fontSize: 18, letterSpacing: 4, color: PALETTE.ash }}>
        {label.toUpperCase()}
      </div>
      <div style={{ display: "flex", fontSize: 42, marginTop: 4, color: color ?? PALETTE.bone }}>
        {formatCount(value)}
      </div>
    </div>
  );
}

function LockedStat({ label }: { label: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: 250 }}>
      <div style={{ display: "flex", fontSize: 18, letterSpacing: 4, color: PALETTE.ash }}>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          display: "flex",
          width: 104,
          height: 28,
          marginTop: 12,
          backgroundColor: PALETTE.edge,
        }}
      />
    </div>
  );
}

function Award({ label, holder, color }: { label: string; holder: string; color?: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: 300,
        borderLeft: `2px solid ${color ?? PALETTE.edge}`,
        paddingLeft: 16,
      }}
    >
      <div style={{ display: "flex", fontSize: 18, letterSpacing: 4, color: color ?? PALETTE.ash }}>
        {label.toUpperCase()}
      </div>
      <div style={{ display: "flex", fontSize: 28, marginTop: 6 }}>{holder}</div>
    </div>
  );
}

function peakTasks(agents: readonly AgentStats[]): number {
  return agents.reduce((max, agent) => Math.max(max, agent.tasks), 1);
}

/** Merges, recoveries and deaths as one bar, scaled against the busiest agent. */
function CrewBar({ agent, peak }: { agent: AgentStats; peak: number }) {
  const scale = (count: number) =>
    count === 0 ? 0 : Math.max(4, Math.round((count / peak) * 330));

  return (
    <div style={{ display: "flex", alignItems: "center", height: 18, marginBottom: 2 }}>
      <div style={{ display: "flex", width: 148, fontSize: 19, color: PALETTE.ash }}>
        {agent.harness}
      </div>
      <div style={{ display: "flex", height: 12 }}>
        <div
          style={{
            display: "flex",
            width: scale(agent.merges),
            marginRight: 3,
            backgroundColor: PALETTE.phosphor,
          }}
        />
        <div
          style={{
            display: "flex",
            width: scale(agent.recoveries),
            marginRight: 3,
            backgroundColor: PALETTE.signal,
          }}
        />
        <div style={{ display: "flex", width: scale(agent.died), backgroundColor: PALETTE.edge }} />
      </div>
    </div>
  );
}
