// /api/shelf — past ideas BOSS shelved for later.
// Returns: every previous briefing's top idea + the #2 and #3 rankings,
// excluding KILL verdicts. Sorted newest first.
//
// Used by: the cockpit ("show me the shelf" intent) and by briefing.js's
// BOSS_FILTER so it doesn't re-pitch the same idea two weeks from now.

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
      return res.status(200).json({ ok:false, reason:"Supabase not configured", shelf:[] });
    }
    // Pull last 60 days of briefings (enough memory without bloating the prompt)
    const r = await fetch(`${url}/rest/v1/briefings?order=date.desc&limit=60`, {
      headers: { "apikey":key, "Authorization":`Bearer ${key}` }
    });
    if (!r.ok) return res.status(200).json({ ok:false, reason:`Supabase ${r.status}`, shelf:[] });
    const rows = await r.json();

    // Build the shelf — top idea + secondary rankings, exclude KILL.
    const shelf = [];
    for (const row of rows) {
      const payload = row.payload || {};
      // Top idea
      if (row.top_verdict && row.top_verdict !== "KILL") {
        shelf.push({
          name: row.top_name,
          verdict: row.top_verdict,
          score: row.top_score,
          date: row.date,
          vertical: row.vertical,
          one_line: payload.top?.one_line || "",
          sources: payload.top?.sources || []
        });
      }
      // #2 and #3
      for (const r2 of (payload.ranking || []).slice(1)) {
        if (r2.verdict && r2.verdict !== "KILL") {
          shelf.push({
            name: r2.name,
            verdict: r2.verdict,
            score: r2.score,
            date: row.date,
            vertical: row.vertical,
            one_line: r2.line || "",
            sources: r2.sources || []
          });
        }
      }
    }
    // Dedupe by lowercase name, keep newest occurrence
    const seen = new Set();
    const deduped = [];
    for (const item of shelf) {
      const k = (item.name||"").toLowerCase().trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      deduped.push(item);
    }
    return res.status(200).json({
      ok:true,
      shelf: deduped,
      count: deduped.length,
      builds:  deduped.filter(x=>x.verdict==="BUILD").length,
      validates: deduped.filter(x=>x.verdict==="VALIDATE").length,
      watches:   deduped.filter(x=>x.verdict==="WATCH").length
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message, shelf:[] });
  }
}
