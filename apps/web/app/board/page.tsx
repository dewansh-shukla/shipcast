import type { Metadata } from "next";
import Link from "next/link";
import { PALETTE } from "../w/[handle]/card-data.ts";
import {
  CONNECT_COMMAND,
  formatCount,
  formatFreshness,
  getBoard,
  isoStamp,
  previousSeasonKey,
  seasonDates,
  seasonLabel,
  type Board,
  type BoardRow,
} from "./board-data.ts";

/**
 * TICKET 06 — the leaderboard.
 *
 * Builders who published this season, ranked by merges. `/board` is the live
 * season; `/board/2026-W32` is a closed one, and both render this same view from
 * the same store read.
 *
 * Ranking is merges, then fewer interventions, then handle — explainable in one
 * sentence and stable across renders. There is no weighted score here on
 * purpose: ticket 05 owns that, and the columns below already tell the story a
 * single number would hide.
 *
 * The view lives in this file rather than beside it because ticket 06 owns four
 * files and this is the one that can hold JSX for both routes.
 */

/** Freshness is a column, so the page cannot be cached into staleness. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "This week · AO Wrapped",
  description: "Builders ranked by what their AI workforce merged this week.",
};

export default async function BoardPage() {
  const board = await getBoard();
  // `getBoard()` with no key derives the season from the clock, so it is never
  // null. The check keeps the type honest rather than asserting.
  if (board === null) return null;
  return <BoardView board={board} />;
}

export function BoardView({ board }: { board: Board }) {
  const previous = previousSeasonKey(board.week);

  return (
    <main className="board">
      <style>{styles}</style>
      <div className="board-shell">
        <header className="masthead">
          <p className="eyebrow">
            <span className="mark">AO Wrapped</span>
            <span className="rule" aria-hidden="true" />
            <span>{seasonDates(board.week)}</span>
          </p>
          <h1 className="season">{seasonLabel(board)}</h1>
          <p className="standing">
            {board.live
              ? "Ranked by merges this week. Every Monday 00:00 UTC the board empties and everyone starts level."
              : "A closed season. These numbers are final — the live board has moved on."}
          </p>
          <nav className="seasons" aria-label="Seasons">
            {board.live ? (
              <Link href={`/board/${previous}`}>← {previous}</Link>
            ) : (
              <>
                <Link href={`/board/${previous}`}>← {previous}</Link>
                <Link href="/board">this week →</Link>
              </>
            )}
          </nav>
        </header>

        {board.rows.length === 0 ? <EmptySeason board={board} /> : <Standings board={board} />}

        <footer className="footer">
          <p>
            Every row is a builder who ran the collector and published counters. Nothing is seeded
            from public activity: from outside, a merged pull request looks the same whether an
            agent opened it or a person typed it.
          </p>
        </footer>
      </div>
    </main>
  );
}

function Standings({ board }: { board: Board }) {
  return (
    <section className="panel" aria-labelledby="standings-heading">
      <h2 id="standings-heading" className="panel-title">
        {formatCount(board.rows.length)} {board.rows.length === 1 ? "builder" : "builders"}
      </h2>
      <p className="panel-note">
        Merges first. Ties go to whoever needed fewer interventions to get there.
      </p>

      <table className="table">
        <thead>
          <tr>
            <th scope="col" className="col-rank">
              #
            </th>
            <th scope="col" className="col-handle">
              Builder
            </th>
            <th scope="col" className="num">
              Merges
            </th>
            <th scope="col" className="num">
              Tasks
            </th>
            <th scope="col" className="num">
              CI saves
            </th>
            <th scope="col" className="num">
              Peak
            </th>
            <th scope="col" className="num">
              Nudges
            </th>
            <th scope="col" className="num">
              Harnesses
            </th>
            <th scope="col" className="col-fresh">
              Published
            </th>
          </tr>
        </thead>
        <tbody>
          {board.rows.map((row) => (
            <Row key={row.handle} row={row} asOf={board.asOf} />
          ))}
        </tbody>
      </table>

      <dl className="legend">
        <div>
          <dt>CI saves</dt>
          <dd>red builds an agent turned green without being asked</dd>
        </div>
        <div>
          <dt>Peak</dt>
          <dd>most agents working at the same moment</dd>
        </div>
        <div>
          <dt>Nudges</dt>
          <dd>times a session stopped and waited for a human</dd>
        </div>
      </dl>
    </section>
  );
}

function Row({ row, asOf }: { row: BoardRow; asOf: Date }) {
  return (
    <tr>
      <td className="col-rank">{row.rank}</td>
      <th scope="row" className="col-handle">
        <Link href={`/w/${encodeURIComponent(row.handle)}`}>{row.handle}</Link>
      </th>
      {/* data-label carries the column name into the stacked mobile layout,
          where the table header is hidden. */}
      <td className="num strong" data-label="Merges">
        {formatCount(row.merges)}
      </td>
      <td className="num" data-label="Tasks">
        {formatCount(row.tasks)}
      </td>
      <td className="num signal" data-label="CI saves">
        {formatCount(row.ciRecoveries)}
      </td>
      <td className="num" data-label="Peak">
        {formatCount(row.peakParallelism)}
      </td>
      <td className="num ember" data-label="Nudges">
        {formatCount(row.interventions)}
      </td>
      <td className="num" data-label="Harnesses">
        {formatCount(row.harnesses)}
      </td>
      <td className="col-fresh">
        <time dateTime={isoStamp(row.publishedAt)}>{formatFreshness(row.publishedAt, asOf)}</time>
      </td>
    </tr>
  );
}

/**
 * The board starts empty and will be empty on camera. It says what is true —
 * nobody has published this season — and then the one command that changes it,
 * because "no data" with no way forward reads as broken rather than as new.
 */
function EmptySeason({ board }: { board: Board }) {
  return (
    <section className="panel empty" aria-labelledby="empty-heading">
      <h2 id="empty-heading" className="panel-title">
        {board.live ? "Nobody has published this season yet" : "Nobody published this season"}
      </h2>
      {board.live ? (
        <>
          <p className="empty-copy">
            The board opened on {seasonDates(board.week).split(" — ")[0]} and resets Monday. First
            publish takes the top of it.
          </p>
          <p className="empty-command">
            <code>{CONNECT_COMMAND}</code>
          </p>
          <p className="empty-note">
            Reads <code>~/.ao</code> read-only, prints your whole Wrapped card in the terminal
            first, and publishes counters only — no code, diffs, repo names or prompts.
          </p>
        </>
      ) : (
        <p className="empty-copy">
          This week closed with no publishes. <Link href="/board">The live board</Link> is where
          anything new lands.
        </p>
      )}
    </section>
  );
}

const styles = `
.board {
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
.board *, .board *::before, .board *::after { box-sizing: border-box; }
.board p, .board h1, .board h2, .board dl, .board dd, .board table { margin: 0; padding: 0; }
.board code { font-family: var(--mono); color: var(--phosphor); }
.board a { color: inherit; }
.board-shell {
  max-width: 68rem;
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
.season {
  font-family: var(--mono);
  font-size: clamp(1.6rem, 5vw, 2.6rem);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.1;
}
.standing { color: var(--ash); font-size: 0.9rem; max-width: 46rem; }
.seasons {
  display: flex;
  gap: 1.25rem;
  margin-top: 0.25rem;
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--ash);
}
.seasons a { text-decoration: none; border-bottom: 1px solid var(--edge); padding-bottom: 2px; }
.seasons a:hover { color: var(--phosphor); border-bottom-color: var(--phosphor); }

.panel {
  background: var(--slate);
  border: 1px solid var(--edge);
  border-radius: 14px;
  padding: clamp(1rem, 2.5vw, 1.75rem);
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.panel-title {
  font-family: var(--mono);
  font-size: 0.78rem;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--phosphor);
  font-weight: 500;
}
.panel-note { color: var(--ash); font-size: 0.85rem; }

.table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.table th, .table td {
  padding: 0.6rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid var(--edge);
  font-weight: 400;
}
.table thead th {
  font-family: var(--mono);
  font-size: 0.68rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ash);
  white-space: nowrap;
}
.table tbody tr:last-child th, .table tbody tr:last-child td { border-bottom: none; }
.table tbody tr:hover { background: rgba(255, 255, 255, 0.03); }
.num { text-align: right; font-family: var(--mono); }
.strong { color: var(--bone); font-size: 1.05rem; }
.signal { color: var(--signal); }
.ember { color: var(--ember); }
.col-rank { width: 2.5rem; color: var(--ash); font-family: var(--mono); }
.col-handle { font-family: var(--mono); }
.col-handle a { text-decoration: none; border-bottom: 1px solid var(--edge); }
.col-handle a:hover { color: var(--phosphor); border-bottom-color: var(--phosphor); }
.col-fresh { color: var(--ash); font-size: 0.82rem; white-space: nowrap; text-align: right; }

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 1.5rem;
  color: var(--ash);
  font-size: 0.78rem;
}
.legend div { display: flex; gap: 0.4rem; }
.legend dt { font-family: var(--mono); color: var(--bone); }

.empty { gap: 1rem; }
.empty-copy { color: var(--bone); max-width: 42rem; }
.empty-command {
  font-family: var(--mono);
  font-size: clamp(0.95rem, 2.5vw, 1.2rem);
  background: var(--ink);
  border: 1px solid var(--edge);
  border-radius: 10px;
  padding: 0.85rem 1rem;
}
.empty-note { color: var(--ash); font-size: 0.85rem; max-width: 42rem; }

.footer { color: var(--ash); font-size: 0.8rem; max-width: 46rem; }

@media (max-width: 46rem) {
  .table thead { display: none; }
  .table tbody tr {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.15rem 0.6rem;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--edge);
  }
  .table th, .table td { border-bottom: none; padding: 0.1rem 0; }
  .table tbody .num::before {
    content: attr(data-label);
    float: left;
    color: var(--ash);
    font-family: var(--sans);
    font-size: 0.75rem;
  }
}
`;
