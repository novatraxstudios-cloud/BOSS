// /api/trading/tickers — Watchlist CRUD
//   GET                 → list tickers (active by default; ?include_paused=1 for all)
//   POST { symbol, company_name, category, priority, options_enabled, earnings_watch, notes, ... }
//   PATCH ?id=<id> { ...fields }
//   DELETE ?id=<id>

export const config = { runtime: "nodejs" };

const CATS = new Set([
  "Core Watchlist","Options","Earnings","Momentum",
  "Long-Term","Avoid","High Risk","Custom"
]);
const PRIORITIES = new Set(["high","normal","low"]);
const FREQ = new Set(["daily","weekly","event-driven"]);

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbServiceKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }
function sbAnonKey(){ return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null; }

async function sbFetch(path, opts={}){
  const url = sbUrl(); const key = sbServiceKey() || sbAnonKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${path}`, {
    ...opts,
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": opts.method === "POST" || opts.method === "PATCH" ? "return=representation" :
                opts.method === "DELETE" ? "return=minimal" : "",
      ...(opts.headers||{})
    }
  });
  if(!r.ok){
    const text = await r.text().catch(()=>r.statusText);
    throw new Error(`Supabase ${r.status}: ${text}`);
  }
  if(opts.method === "DELETE") return null;
  return await r.json();
}

function readBody(req){
  return new Promise((resolve)=>{
    if(req.body && typeof req.body === "object") return resolve(req.body);
    let raw=""; req.on("data",c=>raw+=c); req.on("end",()=>{
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function normalize(input){
  const out = {};
  if(input.symbol != null) out.symbol = String(input.symbol).toUpperCase().trim().slice(0,12);
  if(input.company_name != null) out.company_name = String(input.company_name).slice(0,160);
  if(input.category != null){
    const c = String(input.category).trim();
    out.category = CATS.has(c) ? c : "Core Watchlist";
  }
  if(input.priority != null){
    const p = String(input.priority).toLowerCase().trim();
    out.priority = PRIORITIES.has(p) ? p : "normal";
  }
  if(input.active != null) out.active = !!input.active;
  if(input.options_enabled != null) out.options_enabled = !!input.options_enabled;
  if(input.earnings_watch != null) out.earnings_watch = !!input.earnings_watch;
  if(input.include_in_morning_report != null) out.include_in_morning_report = !!input.include_in_morning_report;
  if(input.report_frequency != null){
    const f = String(input.report_frequency).toLowerCase().trim();
    out.report_frequency = FREQ.has(f) ? f : "daily";
  }
  if(input.notes != null) out.notes = String(input.notes).slice(0,1000);
  if(input.strategy_relevance != null) out.strategy_relevance = String(input.strategy_relevance).slice(0,500);
  return out;
}

async function list(req, res){
  const includePaused = req.query?.include_paused === "1";
  const filter = includePaused ? "" : "active=eq.true&";
  const rows = await sbFetch(`trading_tickers?${filter}order=priority.asc,symbol.asc&limit=200`);
  return res.status(200).json({ ok: true, count: rows.length, tickers: rows });
}

async function create(req, res){
  const body = await readBody(req);
  const data = normalize(body);
  if(!data.symbol) return res.status(400).json({ error: "symbol required" });
  data.company_name = data.company_name || data.symbol;
  data.category = data.category || "Core Watchlist";
  data.priority = data.priority || "normal";
  data.active = data.active ?? true;
  data.options_enabled = data.options_enabled ?? false;
  data.earnings_watch = data.earnings_watch ?? false;
  data.include_in_morning_report = data.include_in_morning_report ?? true;
  data.report_frequency = data.report_frequency || "daily";
  const rows = await sbFetch("trading_tickers", { method:"POST", body: JSON.stringify(data) });
  return res.status(200).json({ ok: true, ticker: rows[0] });
}

async function patch(req, res){
  const id = req.query?.id;
  if(!id) return res.status(400).json({ error: "id required" });
  const body = await readBody(req);
  const data = normalize(body);
  if(!Object.keys(data).length) return res.status(400).json({ error: "no fields to update" });
  data.last_updated = new Date().toISOString();
  const rows = await sbFetch(`trading_tickers?id=eq.${id}`, { method:"PATCH", body: JSON.stringify(data) });
  return res.status(200).json({ ok: true, ticker: rows[0] || null });
}

async function remove(req, res){
  const id = req.query?.id;
  if(!id) return res.status(400).json({ error: "id required" });
  await sbFetch(`trading_tickers?id=eq.${id}`, { method:"DELETE" });
  return res.status(200).json({ ok: true });
}

export default async function handler(req, res){
  try {
    if(req.method === "GET") return await list(req, res);
    if(req.method === "POST") return await create(req, res);
    if(req.method === "PATCH") return await patch(req, res);
    if(req.method === "DELETE") return await remove(req, res);
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
