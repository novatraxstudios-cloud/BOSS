// /api/latest — public read endpoint for the most recent briefing.
// Reads the latest row from Supabase `briefings` table.
// CORS-open so the cockpit can fetch it from the same Vercel domain.

export const config = { runtime: "edge" };

function sbUrl() {
  return process.env.SUPABASE_URL
      || process.env.NEXT_PUBLIC_SUPABASE_URL
      || null;
}
function sbServiceKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_KEY
      || null;
}
function sbAnonKey() {
  return process.env.SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || null;
}

export default async function handler() {
  try {
    const url = sbUrl();
    // Anon key is enough for reads (RLS policy allows select on briefings)
    const key = sbAnonKey() || sbServiceKey();
    if (!url || !key) {
      return json({
        ok: false,
        reason: "Supabase not configured. Connect via Storage tab and add schema.",
        hasLive: false,
        debug_env: {
          has_supabase_url: !!process.env.SUPABASE_URL,
          has_next_public_supabase_url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
          has_service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
          has_anon_key: !!process.env.SUPABASE_ANON_KEY,
          has_next_public_anon_key: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
        }
      }, 200);
    }

    const res = await fetch(`${url}/rest/v1/briefings?order=generated_at.desc&limit=1`, {
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Accept": "application/json"
      }
    });

    if (!res.ok) {
      const errText = await res.text().catch(()=>"");
      return json({
        ok: false,
        reason: `Supabase ${res.status}: ${errText.slice(0,180)}`,
        hasLive: false
      }, 200);
    }

    const rows = await res.json();
    if (!rows || rows.length === 0) {
      return json({
        ok: false,
        reason: "No briefing has been generated yet. Hit /api/briefing?secret=... once.",
        hasLive: false
      }, 200);
    }

    const row = rows[0];
    const payload = row.payload || {};
    payload.hasLive = true;
    payload.row_date = row.date;
    payload.row_id = row.id;
    return json(payload, 200);
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
