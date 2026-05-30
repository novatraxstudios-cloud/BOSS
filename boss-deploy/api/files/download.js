// GET /api/files/download?id=<file_id>
// Returns the raw .txt content with Content-Disposition: attachment.

export const config = { runtime: "nodejs" };

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){
  return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

export default async function handler(req, res){
  try {
    const id = req.query?.id;
    if(!id) return res.status(400).json({ error: "id required" });

    const url = sbUrl(), key = sbKey();
    if(!url || !key) return res.status(500).json({ error: "Supabase not configured" });

    const r = await fetch(`${url}/rest/v1/generated_files?id=eq.${id}&limit=1`, {
      headers: { "apikey": key, "Authorization": `Bearer ${key}` }
    });
    if(!r.ok) return res.status(500).json({ error: `Supabase ${r.status}` });
    const rows = await r.json();
    if(!rows.length) return res.status(404).json({ error: "file not found" });
    const file = rows[0];

    // Bump download_count (fire-and-forget)
    try {
      await fetch(`${url}/rest/v1/generated_files?id=eq.${id}`, {
        method: "PATCH",
        headers: {
          "apikey": (process.env.SUPABASE_SERVICE_ROLE_KEY || key),
          "Authorization": `Bearer ${(process.env.SUPABASE_SERVICE_ROLE_KEY || key)}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({ download_count: (file.download_count || 0) + 1 })
      });
    } catch(_) {}

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${file.file_name}"`);
    return res.status(200).send(file.content);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
