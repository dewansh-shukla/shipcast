/**
 * TICKET C2 — the Wrapped card.
 *
 * Renders from stored counters, so it is always current. The PNG at
 * ./card.png (via @vercel/og) is what unfurls on X and LinkedIn — wire
 * openGraph and twitter metadata to it, or the share loop never starts.
 *
 * Seeded builders get a deliberately locked card: merges filled in, everything
 * else greyed. The gap is what makes connecting the collector worth doing.
 */
export default async function WrappedPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;

  return (
    <main>
      <h1>{handle}</h1>
      <p>TICKET C2: not implemented</p>
    </main>
  );
}
