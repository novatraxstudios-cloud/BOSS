// /api/trading — Meka's daily trading game plan.
// Friday-Trader scouts overnight news + premarket movers via Tavily.
// Boss-Trader synthesizes a game plan using Meka's actual strategy from his seed:
//   - 2-min Trend Containment Candle (~61% win rate)
//   - SPY 0DTE focus, watchlist: SPY QQQ NVDA AMD TSLA PLTR GOOGL HOOD MRNA AMZN META AAPL SMCI
//   - Rules: Green is Sacred · Precision over Activity · Stop after two losses · No setup no trade
//   - Weakness: losses larger than winners, needs discipline reminders
// Sends a morning email. Saves to Supabase under vertical='trading'.
//
// Hit manually: /api/trading?secret=<CRON_SECRET>
// Or schedule a separate cron entry. For now triggered on-demand.

export const config = { runtime: "nodejs" };
export const maxDuration = 60;

const WATCHLIST = ["SPY","QQQ","NVDA","AMD","TSLA","PLTR","GOOGL","HOOD","MRNA","AMZN","META","AAPL","SMCI"];

function sbUrl(){return process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||null;}
function sbServiceKey(){return process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_KEY||null;}

function requireSecret(req){
  const provided = (req.query?.secret) || req.headers["x-cron-secret"] || "";
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return provided === expected;
}

async function tavilySearch(query, depth="basic", max_results=4){
  if (!process.env.TAVILY_API_KEY) return [];
  const r = await fetch("https://api.tavily.com/search", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query, search_depth: depth, max_results,
      include_answer:false, topic:"news"
    })
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results||[]).map(x=>({title:x.title, url:x.url, snippet:(x.content||"").slice(0,300)}));
}

async function fridayTraderScout(){
  const today = new Date().toLocaleDateString("en-US",{month:"long",day:"numeric"});
  const queries = [
    `SPY 0DTE options flow today ${today}`,
    `premarket movers stocks today highest gainers`,
    `NVDA AMD options unusual activity today`,
    `Federal Reserve economic calendar today catalysts`,
    `earnings reports today after hours pre market ${today}`
  ];
  const packs = await Promise.all(queries.map(q=>tavilySearch(q,"basic",4)));
  const evidence = [];
  const seen = new Set();
  for (const p of packs) {
    for (const item of p) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      evidence.push(item);
    }
  }
  return { queries, evidence: evidence.slice(0,15) };
}

async function callOpenAI(systemPrompt, userPayload){
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{"Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({
      model:"gpt-4o-mini",
      messages:[{role:"system",content:systemPrompt},{role:"user",content:JSON.stringify(userPayload)}],
      response_format:{type:"json_object"},
      temperature:0.4,
      max_tokens:1800
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

async function buildGamePlan(scout){
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"});
  const sys = `You are B.O.S.S. running TRADING MODE for Meka Anyanwu.

You are NOT a financial advisor. You produce a daily trading game plan based on
Meka's own rules and the overnight news evidence Friday-Trader provided.

MEKA'S TRADING IDENTITY (memorize this):
- Day trades options, focus SPY 0DTE
- Watchlist: ${WATCHLIST.join(", ")}
- Primary strategy: 2-minute Trend Containment Candle - identify trend, wait for
  pullback candle smaller than previous, enter on break. ~61% win rate but his
  losses are larger than his winners. Strict risk management is his #1 weakness.
- Key tools and confluence: VWAP, opening range breakout 5/15/30 min, prev day
  high/low, premarket high/low, 200 SMA, fair value gaps, liquidity sweeps,
  delta absorption, structure breaks, retests.
- Discipline rules: "Green is Sacred" · "Precision over Activity" · "No setup,
  no trade" · "Don't chase" · "Respect stops" · "Stop after two losses".
- Likes KISS - keep it simple. Avoids theory dumps.

YOUR JOB TODAY (${today}):
1. Identify the market context (Fed events, earnings, major catalysts).
2. Pick the strongest 2-3 setups for his watchlist based on evidence + his strategy.
3. Define key levels he should watch (premarket high/low, VWAP, prev day high/low).
4. Issue one of these verdicts on each setup: HUNT (clean setup, take it if rules
   align), WAIT (clean but not yet), PASS (skip).
5. Give 2 discipline reminders specific to today's risk environment.

NEVER use em dashes. NEVER use sensational language. KISS.

You are NOT giving financial advice. Frame as a game plan he reviews. He decides.

Output STRICT JSON:
{
  "date":"${today}",
  "market_context":"3-sentence summary of overnight / premarket / today's catalysts",
  "verdict_today":"GREEN|YELLOW|RED",
  "verdict_reason":"one sentence",
  "setups":[
    {"ticker":"SPY","direction":"long|short","setup_type":"e.g. ORB breakout long over premarket high","entry_zone":"specific level or trigger","stop_loss":"specific level","targets":["R1","R2"],"confluence":["VWAP reclaim","prev day high"],"verdict":"HUNT|WAIT|PASS","time_window":"e.g. 9:30-10:30 ET"}
  ],
  "key_levels":{"SPY":{"premarket_high":"if known from evidence","premarket_low":"","prev_day_high":"","prev_day_low":""}},
  "catalysts":["e.g. CPI 8:30 ET","Fed minutes 2 ET"],
  "discipline_reminders":["specific to today","another"],
  "sources":["https://..."],
  "kill_switch":"Meka's rule for today, e.g. 'Stop after two losses regardless of P&L'"
}`;
  return await callOpenAI(sys, scout);
}

function htmlBriefing(plan){
  const safe = s => String(s||"").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c]);
  const verdictColor = ({GREEN:"#4dffc2",YELLOW:"#ffb34d",RED:"#ff3d67"})[plan.verdict_today]||"#1ce8ff";
  return `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:24px;max-width:720px;margin:auto">
<div style="border:1px solid #1ce8ff;padding:22px">
  <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;color:#1ce8ff">B.O.S.S. TRADING GAME PLAN</div>
  <h1 style="margin:8px 0 4px;font-size:22px">${safe(plan.date)}</h1>
  <div style="margin-top:10px"><span style="background:${verdictColor};color:#021018;padding:5px 12px;font-family:ui-monospace,monospace;font-weight:900;letter-spacing:.18em">${safe(plan.verdict_today||"YELLOW")}</span> <span style="color:#7f9daf;margin-left:10px">${safe(plan.verdict_reason)}</span></div>

  <h2 style="margin-top:22px;font-size:14px;letter-spacing:.2em;color:#1ce8ff;text-transform:uppercase">Market Context</h2>
  <div style="color:#e6fbff;line-height:1.55">${safe(plan.market_context)}</div>

  <h2 style="margin-top:22px;font-size:14px;letter-spacing:.2em;color:#ffb34d;text-transform:uppercase">Today's Setups</h2>
  ${(plan.setups||[]).map(s=>{
    const vColor = s.verdict==="HUNT"?"#4dffc2":s.verdict==="WAIT"?"#ffb34d":"#ff3d67";
    return `<div style="border:1px solid rgba(28,232,255,.2);padding:12px;margin-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div><b style="font-size:16px">${safe(s.ticker)} ${safe(s.direction||"").toUpperCase()}</b> <span style="color:#7f9daf">${safe(s.setup_type||"")}</span></div>
        <span style="background:${vColor};color:#021018;padding:3px 10px;font-family:ui-monospace,monospace;font-weight:900;letter-spacing:.15em">${safe(s.verdict)}</span>
      </div>
      <div style="margin-top:6px;font-size:13px"><b>Entry:</b> ${safe(s.entry_zone)}</div>
      <div style="font-size:13px"><b>Stop:</b> ${safe(s.stop_loss)} · <b>Targets:</b> ${(s.targets||[]).join(" / ")}</div>
      <div style="font-size:13px;color:#7f9daf"><b>Confluence:</b> ${(s.confluence||[]).join(", ")}</div>
      <div style="font-size:12px;color:#425c6d">Window: ${safe(s.time_window)}</div>
    </div>`;
  }).join("")}

  <h2 style="margin-top:22px;font-size:14px;letter-spacing:.2em;color:#4dffc2;text-transform:uppercase">Catalysts</h2>
  ${(plan.catalysts||[]).map(c=>`<div style="padding:3px 0">→ ${safe(c)}</div>`).join("")}

  <h2 style="margin-top:22px;font-size:14px;letter-spacing:.2em;color:#ff3d67;text-transform:uppercase">Discipline Reminders</h2>
  ${(plan.discipline_reminders||[]).map(d=>`<div style="padding:4px 0;color:#ffb34d">⚠ ${safe(d)}</div>`).join("")}

  <div style="margin-top:18px;padding:10px;border:1px dashed rgba(255,61,103,.3);background:rgba(255,61,103,.05);font-size:12px;color:#ff3d67;font-family:ui-monospace,monospace">
    KILL SWITCH: ${safe(plan.kill_switch||"Stop after two losses")}
  </div>

  <div style="margin-top:22px;padding-top:14px;border-top:1px solid #1c3d4f;color:#425c6d;font-family:ui-monospace,monospace;font-size:10px">
    Not financial advice. Your setup, your call. Boss only points. You pull the trigger.
  </div>
</div></body></html>`;
}

async function sendEmail(plan){
  if (!process.env.RESEND_API_KEY||!process.env.REPORT_TO||!process.env.REPORT_FROM) return {sent:false,reason:"Resend not configured"};
  const r = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({
      from: process.env.REPORT_FROM,
      to: process.env.REPORT_TO,
      subject: `B.O.S.S. Trading Game Plan — ${plan.date}`,
      html: htmlBriefing(plan)
    })
  });
  if (!r.ok) return {sent:false,reason:`Resend ${r.status}`};
  return {sent:true};
}

async function persistTrading(plan, scout){
  const url = sbUrl(), key = sbServiceKey();
  if (!url || !key) return false;
  const row = {
    date: new Date().toISOString().slice(0,10),
    vertical: "trading",
    top_name: `Game Plan ${plan.date}`,
    top_verdict: plan.verdict_today || "YELLOW",
    top_score: null,
    sources_scouted: scout.evidence.length,
    sources: scout.evidence.map(e=>({url:e.url,title:e.title})),
    payload: { ok:true, mode:"trading", scout, briefing:{ trading_plan: plan }, vertical:"trading" },
    generated_at: new Date().toISOString()
  };
  const r = await fetch(`${url}/rest/v1/briefings`, {
    method:"POST",
    headers:{apikey:key, Authorization:`Bearer ${key}`,"Content-Type":"application/json","Prefer":"return=minimal"},
    body: JSON.stringify(row)
  });
  return r.ok;
}

export default async function handler(req,res){
  if (!requireSecret(req)) return res.status(401).json({error:"unauthorized"});
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:"OPENAI_API_KEY not set"});
    const scout = await fridayTraderScout();
    const plan = await buildGamePlan(scout);
    const email = await sendEmail(plan);
    const persisted = await persistTrading(plan, scout);
    return res.status(200).json({ok:true, plan, email, persisted, sources_scouted:scout.evidence.length});
  } catch (e) {
    return res.status(500).json({error:e.message});
  }
}
