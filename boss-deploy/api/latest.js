// /api/latest — returns the most recent cron-generated briefing.
// MVP: regenerates on demand. For a persisted version, swap to Vercel KV
// or Supabase by storing the briefing JSON inside the cron run.

export const config = { runtime: "edge" };

export default async function handler(req) {
  // Re-use the briefing generator so the UI can pull a fresh report on-demand.
  // In production, persist the last briefing to KV and return it here without
  // re-spending OpenAI tokens on every page load.
  const url = new URL(req.url);
  const proxyUrl = `${url.origin}/api/briefing`;
  const r = await fetch(proxyUrl, {
    headers: { "x-cron-secret": process.env.CRON_SECRET || "" }
  });
  const body = await r.text();
  return new Response(body, {
    status: r.status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=900, stale-while-revalidate=3600"
    }
  });
}
