// GET /api/projects/list
// Returns: { projects: [...] } with each project's existing documents counted.

export const config = { runtime: "nodejs" };

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){
  return process.env.SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY
      || null;
}

async function sbQuery(query){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${query}`, {
    headers: { "apikey": key, "Authorization": `Bearer ${key}` }
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  return await r.json();
}

export default async function handler(req, res){
  try {
    const projects = await sbQuery(`projects?order=created_at.desc&limit=100`);
    // Pull all product_documents and generated_files in two more queries (much faster than N+1).
    const productDocs = await sbQuery(`product_documents?select=id,project_id,doc_type,approved,created_at&order=created_at.desc&limit=500`);
    const files       = await sbQuery(`generated_files?select=id,project_id,file_name,file_type,dept_id,created_at&order=created_at.desc&limit=500`);

    const docByProject = {};
    for(const d of productDocs){
      (docByProject[d.project_id] = docByProject[d.project_id] || []).push(d);
    }
    const filesByProject = {};
    for(const f of files){
      (filesByProject[f.project_id] = filesByProject[f.project_id] || []).push(f);
    }

    const enriched = projects.map(p => ({
      ...p,
      product_documents: docByProject[p.id] || [],
      generated_files:   filesByProject[p.id] || []
    }));

    return res.status(200).json({
      ok: true,
      count: enriched.length,
      projects: enriched
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
