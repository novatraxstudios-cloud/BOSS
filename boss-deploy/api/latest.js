// /api/latest — public read endpoint for the most recent briefing.
// Reads from Vercel KV. Cron writes daily, this just returns it.
// CORS-open so the cockpit can fetch it from the same Vercel domain.

export const config = { runtime: "edge" };

async function kvCmd(cmd) {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const res = await fetch(process.env.KV_REST_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(cmd)
  });
  if (!res.ok) return null;
  const j = await res.json();
  return j.result;
}

export default async function handler() {
  try {
    if (!process.env.KV_REST_API_URL) {
      return json({
        ok: false,
        reason: "KV not configured. Add Vercel KV via Storage tab. See WALKTHROUGH-KV.md.",
        hasLive: false
      }, 200);
    }
    const raw = await kvCmd(["GET", "briefing:latest"]);
    if (!raw) {
      return json({
        ok: false,
        reason: "No briefing has been generated yet today. Wait for the 8am cron or hit /api/briefing?secret=... manually.",
        hasLive: false
      }, 200);
    }
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    data.hasLive = true;
    return json(data, 200);
  } catch (e) {
    return json({ ok: false, error: e.message, hasLive: false }, 500);
  }
}

function json(payload, status) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
