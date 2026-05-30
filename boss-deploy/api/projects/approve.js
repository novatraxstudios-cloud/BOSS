// POST /api/projects/approve
// Body: { briefing_id }   OR   { name, one_line, target_user, pain, vertical }
// Creates a project row from an approved idea. Also writes a TRON ops_logs row.

export const config = { runtime: "nodejs" };

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }

async function sbQuery(query){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${query}`, {
    headers: { "apikey": key, "Authorization": `Bearer ${key}` }
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0,180)}`);
  return await r.json();
}
async function sbInsert(table, row){
  const url = sbUrl(), key = sbKey();
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: JSON.stringify(row)
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0,180)}`);
  const arr = await r.json();
  return arr[0] || arr;
}

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const body = req.body || {};
    let project;

    if(body.briefing_id){
      // Pull the briefing, lift its top idea into a new project
      const rows = await sbQuery(`briefings?id=eq.${body.briefing_id}&limit=1`);
      if(!rows.length) return res.status(404).json({ error: "briefing not found" });
      const b = rows[0];
      const top = b.payload?.briefing?.top || {};
      project = {
        name: top.name || b.top_name || "Untitled",
        one_line: top.one_line || "",
        source_briefing_id: b.id,
        vertical: b.vertical || b.payload?.briefing?.vertical || null,
        status: "approved",
        current_phase: "pm",
        verdict: top.verdict || b.top_verdict || "VALIDATE",
        payload: {
          top,
          ranking: b.payload?.briefing?.ranking || [],
          agent_reports: b.payload?.briefing?.agent_reports || null,
          approved_at: new Date().toISOString()
        }
      };
    } else if(body.name){
      // Manual approval (no source briefing — Meka typed it in)
      project = {
        name: body.name,
        one_line: body.one_line || "",
        vertical: body.vertical || null,
        status: "approved",
        current_phase: "pm",
        verdict: body.verdict || "VALIDATE",
        payload: { manual: true, target_user: body.target_user, pain: body.pain }
      };
    } else {
      return res.status(400).json({ error: "briefing_id or name required" });
    }

    const inserted = await sbInsert("projects", project);

    // Log to ops_logs
    try {
      await sbInsert("ops_logs", {
        agent_id: "BOSS",
        dept_id: "exec",
        action: "project_approved",
        status: "completed",
        payload: { project_id: inserted.id, name: project.name }
      });
    } catch(_) {}

    return res.status(200).json({ ok: true, project: inserted });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
