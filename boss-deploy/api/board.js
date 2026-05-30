// /api/board — full briefing history with payload.
// Powers the cockpit's Ideas Board view. Public read (uses anon key).
// Optional ?limit=N (default 60, max 200).

export const config = { runtime: "nodejs" };

function sbUrl(){
  return process.env.SUPABASE_URL
      || process.env.NEXT_PUBLIC_SUPABASE_URL
      || null;
}
function sbKey(){
  return process.env.SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || null;
}

export default async function handler(req, res) {
  try {
    const url = sbUrl(), key = sbKey();
    if (!url || !key) {
      return res.status(200).json({ ok:false, reason:"Supabase not configured", board:[] });
    }
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit) || 60));

    // Pull every column including the full payload JSON.
    const r = await fetch(`${url}/rest/v1/briefings?order=date.desc&limit=${limit}`, {
      headers: { "apikey":key, "Authorization":`Bearer ${key}` }
    });
    if (!r.ok) {
      return res.status(200).json({ ok:false, reason:`Supabase ${r.status}`, board:[] });
    }
    const rows = await r.json();

    // Stats summary
    const stats = { total: rows.length, build:0, validate:0, watch:0, kill:0 };
    for (const row of rows) {
      const v = (row.top_verdict || "").toUpperCase();
      if (v === "BUILD")    stats.build++;
      if (v === "VALIDATE") stats.validate++;
      if (v === "WATCH")    stats.watch++;
      if (v === "KILL")     stats.kill++;
    }

    return res.status(200).json({
      ok: true,
      count: rows.length,
      stats,
      board: rows.map(row => ({
        id: row.id,
        date: row.date,
        vertical: row.vertical,
        top_name: row.top_name,
        top_verdict: row.top_verdict,
        top_score: row.top_score,
        sources_scouted: row.sources_scouted,
        generated_at: row.generated_at,
        payload: row.payload   // full briefing JSON for detail view
      }))
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message, board:[] });
  }
}
