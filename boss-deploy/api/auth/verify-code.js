// POST /api/auth/verify-code
// Body: { email, code }
// Verifies the code, marks it used, returns a signed session token (30 day expiry).

import { createHash, createHmac } from "node:crypto";

export const config = { runtime: "nodejs" };

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }

async function sbQuery(query){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${query}`, {
    headers: { "apikey": key, "Authorization": `Bearer ${key}` }
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  return await r.json();
}
async function sbUpdate(table, filter, patch){
  const url = sbUrl(), key = sbKey();
  const r = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(patch)
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0,180)}`);
}

// Compact signed token: base64url(JSON).base64url(HMAC-SHA256)
function signToken(payload, secret){
  const json = JSON.stringify(payload);
  const body = Buffer.from(json).toString("base64url");
  const sig  = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const secret = process.env.AUTH_SECRET;
    if(!secret) return res.status(500).json({ error: "AUTH_SECRET env var not set in Vercel" });

    const body = req.body || {};
    const email = (body.email || "").toLowerCase().trim();
    const code  = String(body.code || "").trim();
    if(!email || !code) return res.status(400).json({ error: "email and code required" });
    if(!/^\d{6}$/.test(code)) return res.status(400).json({ error: "code must be 6 digits" });

    const codeHash = createHash("sha256").update(code).digest("hex");
    const rows = await sbQuery(`auth_codes?email=eq.${encodeURIComponent(email)}&used=eq.false&order=created_at.desc&limit=1`);
    if(!rows || rows.length === 0) return res.status(401).json({ error: "invalid code" });
    const row = rows[0];

    if(new Date(row.expires_at) < new Date()){
      return res.status(401).json({ error: "code expired, request a new one" });
    }
    if(row.code_hash !== codeHash){
      return res.status(401).json({ error: "invalid code" });
    }

    // Mark used
    await sbUpdate("auth_codes", `id=eq.${row.id}`, { used: true, used_at: new Date().toISOString() });

    // Issue token, 30 day expiry
    const exp = Date.now() + 30*86400_000;
    const token = signToken({ email, exp, iat: Date.now() }, secret);

    // Optional: record session
    try {
      await sbUpdate("auth_sessions", `token_hash=eq.never_matches`, {}); // no-op to keep one query path warm
    } catch(_) {}

    return res.status(200).json({ ok: true, token, expires_at: new Date(exp).toISOString(), email });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
