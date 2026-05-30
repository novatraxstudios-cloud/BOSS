// GET /api/files/list?project_id=...&dept_id=...
// Returns generated_files metadata (no content body for speed).

export const config = { runtime: "nodejs" };

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){
  return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

export default async function handler(req, res){
  try {
    const url = sbUrl(), key = sbKey();
    if(!url || !key) return res.status(500).json({ error: "Supabase not configured" });

    const params = [];
    if(req.query?.project_id) params.push(`project_id=eq.${req.query.project_id}`);
    if(req.query?.dept_id)    params.push(`dept_id=eq.${req.query.dept_id}`);
    if(req.query?.file_type)  params.push(`file_type=eq.${req.query.file_type}`);
    params.push("order=created_at.desc");
    params.push(`limit=${Math.min(200, parseInt(req.query?.limit) || 100)}`);
    params.push("select=id,project_id,file_name,file_type,dept_id,agent_id,download_count,created_at");

    const r = await fetch(`${url}/rest/v1/generated_files?${params.join("&")}`, {
      headers: { "apikey": key, "Authorization": `Bearer ${key}` }
    });
    if(!r.ok) throw new Error(`Supabase ${r.status}`);
    const rows = await r.json();
    return res.status(200).json({ ok: true, count: rows.length, files: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
