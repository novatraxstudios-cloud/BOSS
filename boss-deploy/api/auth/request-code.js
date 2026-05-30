// POST /api/auth/request-code
// Body: { email }
// Generates a 6-digit code, stores its hash in Supabase, emails the user.
// Silently no-ops if the email isn't in ALLOWED_EMAILS so we never leak who is whitelisted.

import { createHash, randomInt } from "node:crypto";

export const config = { runtime: "nodejs" };

function allowedEmails(){
  const raw = (process.env.ALLOWED_EMAILS || process.env.REPORT_TO || "").toLowerCase();
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }

async function sbInsert(table, row){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const res = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "return=minimal"
    },
    body: JSON.stringify(row)
  });
  if(!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0,180)}`);
}

async function sendCodeEmail(email, code){
  if(!process.env.RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  const from = process.env.REPORT_FROM || "onboarding@resend.dev";
  const html = `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:32px;margin:0">
<div style="max-width:520px;margin:0 auto;border:1px solid #1ce8ff;padding:28px;text-align:center">
  <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.28em;color:#1ce8ff">B.O.S.S. OPERATING SYSTEM</div>
  <h1 style="margin:14px 0 8px;font-size:20px;color:#fff;font-weight:700">Access code</h1>
  <p style="color:#7f9daf;margin:0 0 22px;font-size:13px">Enter this code to unlock becauseoss.cc:</p>
  <div style="font-family:ui-monospace,monospace;font-size:42px;letter-spacing:.22em;color:#fff;font-weight:900;padding:22px 28px;border:1px solid rgba(28,232,255,.5);background:rgba(28,232,255,.05);margin:0 auto;display:inline-block">${code}</div>
  <p style="margin-top:22px;color:#7f9daf;font-size:11px;line-height:1.6">Expires in 10 minutes. Single use. If you didn't request this, ignore the email.</p>
  <div style="margin-top:18px;font-family:ui-monospace,monospace;font-size:10px;color:#425c6d;letter-spacing:.15em">B.O.S.S. · because ordinary systems suck</div>
</div></body></html>`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from, to: email,
      subject: `B.O.S.S. access code · ${code}`,
      html
    })
  });
  if(!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0,200)}`);
}

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    const body = req.body || {};
    const email = (body.email || "").toLowerCase().trim();
    if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){
      return res.status(400).json({ error: "valid email required" });
    }
    const allow = allowedEmails();
    // Silent rejection — always return "sent" to avoid leaking who's whitelisted.
    if(!allow.includes(email)){
      // Small artificial delay so timing doesn't leak either
      await new Promise(r => setTimeout(r, 400 + Math.floor(Math.random()*300)));
      return res.status(200).json({ ok: true, sent: true });
    }
    const code = String(randomInt(100000, 999999));
    const codeHash = createHash("sha256").update(code).digest("hex");
    const expiresAt = new Date(Date.now() + 10*60*1000).toISOString();
    await sbInsert("auth_codes", {
      email,
      code_hash: codeHash,
      expires_at: expiresAt,
      ip: req.headers["x-forwarded-for"] || null,
      user_agent: (req.headers["user-agent"] || "").slice(0, 200)
    });
    await sendCodeEmail(email, code);
    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
