import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { INTERVENTION_PENALTY, OUTCOME_POINTS } from "@ao-wrapped/shared";
import {
  CONNECT_COMMAND,
  formatCount,
  getBoard,
  seasonDates,
  seasonLabel,
  type Board,
} from "./board/board-data.ts";
import "./brutal.css";
import "./landing.css";

/**
 * TICKET 21 — the landing page.
 *
 * People already flex on LinkedIn about how much AI ships for them, and nobody
 * can check any of it. This is the same flex with receipts: the numbers come off
 * the reader's own disk, and every merge is joined to the agent session that
 * produced it. That contrast is the page — hence a side-by-side hero rather than
 * a big number over three stat cards, which is the template answer and wastes
 * the idea.
 *
 * Two things are load-bearing and easy to break later.
 *
 * The example numbers are real. They come from an actual `ao-wrapped --dry-run`
 * against this project's own AO telemetry, so the page cannot be caught lying
 * about its own product. If they are ever refreshed, refresh them from a real
 * run and move the date with them.
 *
 * The scoring table imports its points from `@ao-wrapped/shared` instead of
 * printing prettier ones. The weights are the product's argument and they will
 * change; a hand-typed copy here would quietly start contradicting the board.
 */

/** The board section is live, so this page cannot be cached into staleness. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AO Wrapped · the AI flex, with receipts",
  description:
    "Everyone says AI made them 10x faster. AO Wrapped reads your own AO telemetry and prints what your agents actually did — merges, nudges, and the sessions that died.",
};

/**
 * The hosted board, so the command in the hero works pasted verbatim on a
 * machine that has never seen this repo. The base command comes from
 * `board-data.ts` rather than being retyped, so the two pages cannot drift.
 */
const API_ORIGIN = "https://ao-wrapped.vercel.app";
const PUBLISH_COMMAND = `${CONNECT_COMMAND} --api ${API_ORIGIN}`;

const REPO_URL = "https://github.com/dewansh-shukla/shipcast";

/**
 * The parody, kept as one string so an editor cannot accidentally lose the space
 * after the emoji. Exclamation marks are allowed here and nowhere else on the
 * page — they are the joke.
 */
const LINKEDIN_POST =
  "\u201cThrilled to share that I\u2019ve been leveraging AI to 10x my velocity. " +
  "The future of engineering is here \ud83d\ude80\u201d";

/**
 * One real week, measured by the collector against `~/.ao/data/ao.db` on the
 * machine that built this. Merges exceed tasks because a single agent session
 * can carry more than one pull request to a merge — 17 merges out of 11
 * sessions, not 17 out of 11 attempts.
 */
const RECEIPTS = {
  window: "Jul 13 — Aug 12",
  figures: [
    { value: 17, label: "merges", tone: "plain" },
    { value: 11, label: "tasks", tone: "plain" },
    { value: 14, label: "nudges", tone: "nudge" },
    { value: 5, label: "agents at once", tone: "plain" },
  ],
  /** Sessions that ended without a merge in that same window. */
  died: 1,
} as const;

/** Points, and the sentence each number is there to make. */
const SCORING_ROWS: ReadonlyArray<{ outcome: string; points: number; why: string }> = [
  {
    outcome: "Merge after a conflict",
    points: OUTCOME_POINTS.conflict_resolved,
    why: "hardest loop to close alone",
  },
  {
    outcome: "Merge after CI went red",
    points: OUTCOME_POINTS.ci_recovered,
    why: "the exact loop AO exists for",
  },
  {
    outcome: "Merge after a review round",
    points: OUTCOME_POINTS.review_resolved,
    why: "read the feedback, acted on it",
  },
  { outcome: "Clean merge, first pass", points: OUTCOME_POINTS.clean, why: "the baseline unit" },
  {
    outcome: "PR opened, never merged",
    points: OUTCOME_POINTS.opened_unmerged,
    why: "work happened and can be read",
  },
  { outcome: "Session died, no PR", points: OUTCOME_POINTS.died, why: "no penalty for trying" },
  {
    outcome: "You had to step in",
    points: -INTERVENTION_PENALTY,
    why: "charged to that session only",
  },
];

/** How many board rows the landing page shows before sending you to /board. */
const BOARD_PREVIEW_ROWS = 5;

export default async function HomePage() {
  const board = await getBoard();

  return (
    <main className="landing">
      <div className="landing-shell">
        <Hero />
        <WhatItReads />
        <Scoring />
        <ThisWeek board={board} />
        <Footer />
      </div>
      <CopyScript />
    </main>
  );
}

function Hero() {
  return (
    <header className="masthead">
      <div className="brand">
        <Image className="brand-mark" src="/logo.png" alt="" width={500} height={500} priority />
        <p className="eyebrow">AO Wrapped</p>
      </div>

      <h1 className="headline">
        Everyone says AI <span className="strike">10x&apos;d</span> them.{" "}
        <span className="lit">Show the receipts.</span>
      </h1>

      <p className="lede">
        AO Wrapped reads the Agent Orchestrator telemetry already sitting on your disk and prints
        what your agents actually did. Every merge is joined to the session that produced it, which
        is the one thing a screenshot cannot fake.
      </p>

      <div className="versus">
        <figure className="block post">
          <figcaption className="block-head">what you posted</figcaption>
          <div className="block-body post-body">
            <blockquote className="post-quote">{LINKEDIN_POST}</blockquote>
            <p className="post-meta">847 likes · unverifiable</p>
          </div>
        </figure>

        <figure className="block receipts">
          <figcaption className="block-head">what your disk says</figcaption>
          <div className="block-body receipts-body">
            <dl className="figures">
              {RECEIPTS.figures.map((figure) => (
                <div
                  key={figure.label}
                  className={figure.tone === "nudge" ? "figure figure--nudge" : "figure"}
                >
                  <dd className="figure-value">{formatCount(figure.value)}</dd>
                  <dt className="figure-label">{figure.label}</dt>
                </div>
              ))}
            </dl>
            <p className="receipts-meta">read from ~/.ao · {RECEIPTS.window} · mine, really</p>
          </div>
        </figure>
      </div>

      <div className="meme-block hero-meme">
        <Image
          className="meme"
          src="/memes/swap.webp"
          alt=""
          aria-hidden="true"
          width={860}
          height={968}
          sizes="(max-width: 640px) 60vw, 15rem"
        />
        <p className="meme-caption">the flex was never the post</p>
      </div>

      <p className="punchline">
        Your agents needed you <em>14 times</em> this week. That&apos;s not a flex. That&apos;s the
        point.
      </p>

      <Command />
    </header>
  );
}

/**
 * Click-to-copy without a client component. The page reads the board on the
 * server, and a `"use client"` boundary would have to live in a file this ticket
 * does not own — so the enhancement is a delegated listener instead. The command
 * is real text either way: with no JavaScript at all it stays selectable, and
 * the button is the shortcut rather than the only route.
 */
function Command() {
  return (
    <section className="command" aria-labelledby="command-heading">
      <h2 className="command-label" id="command-heading">
        One command. No account, no signup.
      </h2>
      <div className="command-row">
        <code className="command-code">{PUBLISH_COMMAND}</code>
        <button
          type="button"
          className="copy"
          data-copy={PUBLISH_COMMAND}
          aria-describedby="copy-status"
        >
          copy
        </button>
      </div>
      <p className="copy-status" id="copy-status" role="status" aria-live="polite" />
      <p className="command-note">
        Drop <code>--publish</code> and it never touches the network. Add <code>--dry-run</code> and
        it prints the exact JSON instead of sending it.
      </p>
    </section>
  );
}

function WhatItReads() {
  return (
    <section className="section" aria-labelledby="reads-heading">
      <h2 className="section-title" id="reads-heading">
        What it reads
      </h2>
      <div className="reads">
        <article className="block">
          <h3 className="block-head">your AO telemetry</h3>
          <div className="block-body read-body">
            <p className="read-title">Read-only, on your machine</p>
            <p>
              <code>~/.ao/data/ao.db</code> — sessions, pull requests, CI checks and the change log.
              Opened read-only, always. Nothing is written back.
            </p>
          </div>
        </article>

        <article className="block">
          <h3 className="block-head">never your code</h3>
          <div className="block-body read-body">
            <p className="read-title">No diffs. No prompts.</p>
            <p>
              Repo names, branch names, PR titles, file paths, commit messages and diffs are not
              read into the payload at all. There is no field they could travel in.
            </p>
          </div>
        </article>

        <article className="block">
          <h3 className="block-head">only numbers</h3>
          <div className="block-body read-body">
            <p className="read-title">Counters and closed enums</p>
            <p>
              Every field is a number, a date, or one of a fixed set of words. Run{" "}
              <code>--dry-run</code> to print the exact JSON before anything leaves.
            </p>
          </div>
        </article>
      </div>
    </section>
  );
}

function Scoring() {
  return (
    <section className="section" aria-labelledby="scoring-heading">
      <h2 className="section-title" id="scoring-heading">
        Autonomy over volume
      </h2>
      <p className="lede">
        Merges earn points and every interruption subtracts them, so a workforce that shipped less
        while asking you nothing beats one that shipped more and needed a babysitter.
      </p>

      <table className="scoring">
        <caption>Points per session, before size and parallelism factors.</caption>
        <thead>
          <tr>
            <th scope="col">Outcome</th>
            <th scope="col" className="drop-narrow">
              Why
            </th>
            <th scope="col" className="points">
              Points
            </th>
          </tr>
        </thead>
        <tbody>
          {SCORING_ROWS.map((row) => (
            <tr key={row.outcome} className={row.points < 0 ? "penalty" : undefined}>
              <th scope="row">{row.outcome}</th>
              <td className="drop-narrow">{row.why}</td>
              <td className={`points ${pointsTone(row.points)}`}>{formatPoints(row.points)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="caption">
        {RECEIPTS.died} session died in the week above. No points deducted — we&apos;re not
        monsters.
      </p>

      <div className="meme-block score-meme">
        <Image
          className="meme"
          src="/memes/miracle.webp"
          alt=""
          aria-hidden="true"
          width={500}
          height={261}
          sizes="(max-width: 640px) 60vw, 15rem"
        />
        <p className="meme-caption">an agent turning its own red build green, +18</p>
      </div>
    </section>
  );
}

function ThisWeek({ board }: { board: Board | null }) {
  // `getBoard()` with no key derives the season from the clock, so it is never
  // null. The check keeps the type honest rather than asserting.
  if (board === null) return null;
  const rows = board.rows.slice(0, BOARD_PREVIEW_ROWS);

  return (
    <section className="section" aria-labelledby="board-heading">
      <h2 className="section-title" id="board-heading">
        This week&apos;s board
      </h2>
      <p className="season">
        {seasonLabel(board)} · {seasonDates(board.week)}
      </p>

      {rows.length === 0 ? (
        <p className="empty-board">
          <strong>Nobody has published this season yet.</strong>
          <span>Be the first. It&apos;s one command, and the board empties again on Monday.</span>
        </p>
      ) : (
        <table className="standings">
          <thead>
            <tr>
              <th scope="col" className="rank">
                #
              </th>
              <th scope="col">Builder</th>
              <th scope="col" className="count">
                Merges
              </th>
              <th scope="col" className="count drop-narrow">
                Tasks
              </th>
              <th scope="col" className="count">
                Nudges
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.handle}>
                <td className="rank">{row.rank}</td>
                <th scope="row" className="builder">
                  <Link href={`/w/${encodeURIComponent(row.handle)}`}>{row.handle}</Link>
                </th>
                <td className="count">{formatCount(row.merges)}</td>
                <td className="count drop-narrow">{formatCount(row.tasks)}</td>
                <td className="count">{formatCount(row.interventions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="more-link">
        <Link href="/board">See the whole board →</Link>
      </p>
    </section>
  );
}

function Footer() {
  return (
    <footer className="landing-footer">
      <p>
        No 🚀. No &ldquo;humbled to announce&rdquo;. Just counters, off your own disk, published
        only when you ask for it.
      </p>
      <p>
        The collector never sends code, diffs, repo names, branch names, file paths, commit messages
        or prompts — they are never read into the payload in the first place.
      </p>
      <p>
        <a href={REPO_URL}>Source on GitHub</a>
      </p>
    </footer>
  );
}

function pointsTone(points: number): string {
  if (points > 0) return "points--plus";
  if (points < 0) return "points--minus";
  return "points--zero";
}

function formatPoints(points: number): string {
  if (points > 0) return `+${points}`;
  /** A real minus sign, not a hyphen, so it reads as arithmetic. */
  if (points < 0) return `−${Math.abs(points)}`;
  return "0";
}

/**
 * Delegated so it does not care when the button renders, and tolerant of every
 * way clipboard access fails: an insecure origin, a denied permission, an old
 * browser. When it cannot copy it says so rather than pretending it worked.
 */
const COPY_SCRIPT = `
(function () {
  function say(message) {
    var status = document.getElementById("copy-status");
    if (status) status.textContent = message;
  }
  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }
    document.body.removeChild(area);
    return copied;
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    var button = target && target.closest ? target.closest("[data-copy]") : null;
    if (!button) return;
    var text = button.getAttribute("data-copy") || "";
    var settle = function (copied) {
      say(copied ? "Copied. Paste it into a terminal." : "Could not copy — select the command above.");
      button.textContent = copied ? "copied" : "copy";
      window.setTimeout(function () {
        button.textContent = "copy";
      }, 2400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          settle(true);
        },
        function () {
          settle(legacyCopy(text));
        }
      );
    } else {
      settle(legacyCopy(text));
    }
  });
})();
`;

function CopyScript() {
  return <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />;
}
