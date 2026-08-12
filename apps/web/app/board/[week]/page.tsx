import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BoardView } from "../page.tsx";
import { getBoard, seasonDates } from "../board-data.ts";

/**
 * TICKET 06 — one past season.
 *
 * `/board/2026-W32` renders the week that key names, from the same store read
 * and the same view as the live board. A season nobody published in is an empty
 * board, not a 404 — the week existed either way. A key that names no week at
 * all (`2026-W99`, `last-tuesday`) is a 404, because there is nothing to show
 * and pretending otherwise invents a season.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ week: string }>;
}): Promise<Metadata> {
  const { week } = await params;
  const board = await getBoard(week);
  if (board === null) return { title: "Unknown season · AO Wrapped" };

  return {
    title: `${board.week.key} · AO Wrapped`,
    description: `Builders ranked by merges for ${seasonDates(board.week)}.`,
  };
}

export default async function SeasonBoardPage({ params }: { params: Promise<{ week: string }> }) {
  const { week } = await params;
  const board = await getBoard(week);
  if (board === null) notFound();

  return <BoardView board={board} />;
}
