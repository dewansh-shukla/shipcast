import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  CONNECT_COMMAND,
  formatCount,
  formatFreshness,
  getBoard,
  isoStamp,
  previousSeasonKey,
  seasonDates,
  seasonLabel,
  withVerification,
  type Board,
  type BoardRow,
} from "./board-data.ts";
import "../brutal.css";
import "./board.css";

/**
 * TICKET 06 — the leaderboard. TICKET 23 — in the shared system.
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
 * Presentation comes from `brutal.css` and `board.css`; no colour, border,
 * shadow or face is declared in this file. The view lives here rather than
 * beside it because this is the one owned file that can hold JSX for both
 * routes.
 *
 * TICKET 28 — a verified handle gets a quiet signal-coloured tick. Unverified
 * is the ordinary case for anyone working in private repositories, so it is not
 * marked at all: only the corroborated rows say anything, and nothing on the
 * page reads as suspicion.
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
  /**
   * Cache-first and time-boxed, and it returns the board untouched when there is
   * no `GITHUB_TOKEN`. Nothing here is in the publish path.
   */
  return <BoardView board={await withVerification(board)} />;
}

/**
 * The season label carries two facts — which week, and what happens to it. The
 * key is the headline and the fate is a block beside it, because "resets
 * Monday" is the reason to come back and a comma would bury it.
 */
function splitSeason(board: Board): { key: string; fate: string } {
  const [key, fate] = seasonLabel(board).split(" · ");
  return { key: key ?? board.week.key, fate: fate ?? "" };
}

export function BoardView({ board }: { board: Board }) {
  const previous = previousSeasonKey(board.week);
  const { key, fate } = splitSeason(board);

  return (
    <main className="brutal board">
      <div className="board-shell">
        <header className="masthead">
          <div className="masthead-cap">
            <span className="eyebrow">AO Wrapped</span>
            <span className="eyebrow">{seasonDates(board.week)}</span>
          </div>
          <div className="masthead-body">
            <h1 className="season">{key}</h1>
            <p className={board.live ? "resets" : "resets resets--closed"}>{fate}</p>
            <p className="standing">
              {board.live
                ? "Ranked by merges this week. Every Monday 00:00 UTC the board empties and everyone starts level."
                : "A closed season. These numbers are final — the live board has moved on."}
            </p>
            <nav className="seasons" aria-label="Seasons">
              <Link href={`/board/${previous}`}>← {previous}</Link>
              {board.live ? null : <Link href="/board">this week →</Link>}
            </nav>
          </div>

          <div className="meme-block board-meme">
            <Image
              className="meme"
              src="/memes/jali-na.webp"
              alt=""
              aria-hidden="true"
              width={300}
              height={161}
              sizes="(max-width: 720px) 45vw, 13rem"
            />
            <p className="meme-caption">
              {board.rows.length === 0
                ? "nobody to be jealous of yet"
                : `rank 1 is ${board.rows[0]?.handle ?? "taken"}`}
            </p>
          </div>
        </header>

        {board.rows.length === 0 ? <EmptySeason board={board} /> : <Standings board={board} />}

        {board.live ? null : (
          <div className="meme-block closed-meme">
            <Image
              className="meme"
              src="/memes/zamana.webp"
              alt=""
              aria-hidden="true"
              width={300}
              height={148}
              sizes="(max-width: 720px) 55vw, 14rem"
            />
            <p className="meme-caption">a closed season. we were all rank 1 once.</p>
          </div>
        )}

        <footer className="board-footer">
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
      <div className="panel-cap">
        <h2 id="standings-heading" className="eyebrow">
          {formatCount(board.rows.length)} {board.rows.length === 1 ? "builder" : "builders"}
        </h2>
        <p className="panel-note">merges first · ties go to fewer nudges</p>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col" className="col-rank">
                #
              </th>
              <th scope="col" className="col-builder">
                Builder
              </th>
              <th scope="col" className="col-num">
                Merges
              </th>
              <th scope="col" className="col-num shed-2">
                Tasks
              </th>
              <th scope="col" className="col-num shed-2">
                CI saves
              </th>
              <th scope="col" className="col-num shed-1">
                Peak
              </th>
              <th scope="col" className="col-num shed-3">
                Nudges
              </th>
              <th scope="col" className="col-num shed-1">
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
      </div>

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
        <div>
          <dt>
            <VerifiedMark /> Verified
          </dt>
          <dd>
            public GitHub activity is consistent with what was reported — private work will not show
            up here
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Row({ row, asOf }: { row: BoardRow; asOf: Date }) {
  const leader = row.rank === 1;

  return (
    <tr className={leader ? "leader" : undefined}>
      <td className="col-rank">
        {leader ? <span className="rank-mark">{row.rank}</span> : row.rank}
      </td>
      <th scope="row" className="col-builder">
        <Link href={`/w/${encodeURIComponent(row.handle)}`}>{row.handle}</Link>
        {row.verification.state === "verified" && <VerifiedMark />}
      </th>
      <td className="col-num col-merges">{formatCount(row.merges)}</td>
      <td className="col-num shed-2">{formatCount(row.tasks)}</td>
      <td className="col-num col-saves shed-2">{formatCount(row.ciRecoveries)}</td>
      <td className="col-num shed-1">{formatCount(row.peakParallelism)}</td>
      <td className="col-num col-nudges shed-3">{formatCount(row.interventions)}</td>
      <td className="col-num shed-1">{formatCount(row.harnesses)}</td>
      <td className="col-fresh">
        <time dateTime={isoStamp(row.publishedAt)}>{formatFreshness(row.publishedAt, asOf)}</time>
      </td>
    </tr>
  );
}

/**
 * The tick, and the whole of the verified treatment.
 *
 * `--signal` is a `brutal.css` token; the colour is referenced, never declared.
 * It would be better placed in `board.css` beside the other column rules, but
 * that file belongs to another ticket and a cross-ticket edit costs more than
 * it saves.
 *
 * `role="img"` with a label rather than a bare glyph: a tick read aloud as
 * "check mark" beside a username says nothing about what was checked.
 */
function VerifiedMark() {
  return (
    <span
      className="verified-mark"
      style={{ color: "var(--signal)" }}
      role="img"
      aria-label="verified against public GitHub"
      title="Public GitHub activity is consistent with what was reported"
    >
      ✓
    </span>
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
      <h2 id="empty-heading" className="empty-headline">
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
