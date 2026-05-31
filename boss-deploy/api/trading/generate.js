// POST /api/trading/generate  (also called by the daily 8:15am CT cron)
// Runs P.I.V.O.T. + A.T.O.M. + Q.U.A.N.T. + E.D.G.E. analysis on Meka's active watchlist.
// Pulls market news via Tavily, runs OpenAI to produce per-ticker analysis,
// writes one trading_reports row + one .txt file. Emails Meka via Resend.
//
// EDUCATIONAL ANALYSIS ONLY. Never executes trades. Never advises buys.

export const config = { runtime: "nodejs" };
export const maxDuration = 60;

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }

async function sbQuery(query){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${query}`, { headers:{ "apikey":key, "Authorization":`Bearer ${key}` } });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  return await r.json();
}
async function sbInsert(table, row){
  const url = sbUrl(), key = sbKey();
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method:"POST",
    headers:{ "apikey":key, "Authorization":`Bearer ${key}`, "Content-Type":"application/json", "Prefer":"return=representation" },
    body: JSON.stringify(row)
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0,200)}`);
  const arr = await r.json();
  return arr[0] || arr;
}
async function sbPatch(table, filter, data){
  const url = sbUrl(), key = sbKey();
  await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method:"PATCH",
    headers:{ "apikey":key, "Authorization":`Bearer ${key}`, "Content-Type":"application/json", "Prefer":"return=minimal" },
    body: JSON.stringify(data)
  }).catch(()=>{});
}

/* ---------- LIVE PRICE FEED (Yahoo Finance chart endpoint, no API key) ---------- */
async function fetchYahooQuote(symbol){
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 4000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=10d`,
      {
        signal: ctrl.signal,
        headers: {
          // Yahoo blocks the default node UA; pretend to be a browser.
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept": "application/json"
        }
      }
    );
    clearTimeout(t);
    if(!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if(!res) return null;
    const meta = res.meta || {};
    const ts = res.timestamp || [];
    const q  = res.indicators?.quote?.[0] || {};
    const opens  = q.open  || [];
    const highs  = q.high  || [];
    const lows   = q.low   || [];
    const closes = q.close || [];
    const vols   = q.volume|| [];
    const last5 = ts.map((t,i)=>({
      date: new Date(t*1000).toISOString().slice(0,10),
      o: opens[i]  != null ? Number(opens[i].toFixed(2))  : null,
      h: highs[i]  != null ? Number(highs[i].toFixed(2))  : null,
      l: lows[i]   != null ? Number(lows[i].toFixed(2))   : null,
      c: closes[i] != null ? Number(closes[i].toFixed(2)) : null,
      v: vols[i]   || null
    })).filter(d => d.c != null).slice(-7);
    const price     = Number((meta.regularMarketPrice ?? closes.filter(Boolean).slice(-1)[0])?.toFixed?.(2)) || null;
    const prevClose = Number((meta.chartPreviousClose ?? meta.previousClose)?.toFixed?.(2)) || null;
    const change    = (price != null && prevClose != null) ? Number((price - prevClose).toFixed(2)) : null;
    const changePct = (price != null && prevClose != null && prevClose !== 0) ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : null;
    return {
      symbol: meta.symbol || symbol,
      price,
      prev_close: prevClose,
      change, change_pct: changePct,
      day_high: meta.regularMarketDayHigh != null ? Number(meta.regularMarketDayHigh.toFixed(2)) : null,
      day_low:  meta.regularMarketDayLow  != null ? Number(meta.regularMarketDayLow.toFixed(2))  : null,
      fifty_two_week_high: meta.fiftyTwoWeekHigh != null ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : null,
      fifty_two_week_low:  meta.fiftyTwoWeekLow  != null ? Number(meta.fiftyTwoWeekLow.toFixed(2))  : null,
      volume: meta.regularMarketVolume || null,
      currency: meta.currency || "USD",
      exchange: meta.exchangeName || null,
      market_state: meta.marketState || null, // PRE, REGULAR, POST, CLOSED
      as_of: new Date().toISOString(),
      ohlc_recent: last5
    };
  } catch { return null; }
}

async function fetchYahooQuotes(symbols){
  const out = {};
  // Parallel but cap concurrency by chunks of 10 to be polite
  const chunks = [];
  for(let i=0;i<symbols.length;i+=10) chunks.push(symbols.slice(i,i+10));
  for(const chunk of chunks){
    const results = await Promise.all(chunk.map(s => fetchYahooQuote(s)));
    chunk.forEach((s,i)=>{ if(results[i]) out[s] = results[i]; });
  }
  return out;
}

async function tavilySearch(query, depth="basic", max_results=4){
  if (!process.env.TAVILY_API_KEY) return [];
  try {
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
    return (j.results||[]).map(x=>({title:x.title, url:x.url, snippet:(x.content||"").slice(0,260)}));
  } catch { return []; }
}

async function callOpenAI(systemPrompt, userPayload){
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      model:"gpt-4o-mini",
      messages:[
        { role:"system", content:systemPrompt },
        { role:"user", content: JSON.stringify(userPayload) }
      ],
      response_format:{ type:"json_object" },
      temperature:0.45,
      max_tokens:3200
    })
  });
  if(!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return { data: JSON.parse(j.choices[0].message.content), usage: j.usage };
}

const HOUSE = `NEVER use em dashes. Never spell acronyms. Plain prose. Strict JSON only.
EDUCATIONAL ANALYSIS ONLY. You DO NOT place trades. You DO NOT give buy/sell recommendations. You DO NOT guarantee outcomes.
Frame every signal as "for educational consideration." Always include invalidation. Always include risk.
You are reading Meka's actual trading style: 2-min Trend Containment Candle, ~61% win rate, SPY 0DTE focus.
Meka's rules: Green is Sacred · Precision over Activity · Stop after two losses · No setup no trade.
Meka's known weakness: losses larger than winners, needs discipline reminders. Surface this when relevant.

CRITICAL: The payload contains a "live_quotes" object with REAL prices pulled seconds before this call.
You MUST anchor every key_levels, pivot, support, resistance, and invalidation to the live_quotes prices.
NEVER invent price levels. NEVER use prices from your training data. If live_quotes is missing for a ticker, say "price feed unavailable" in that ticker's notes and skip numeric levels for it.
Every per_ticker entry MUST include current_price and previous_close copied exactly from live_quotes.`;

const SYSTEM = `You are the Trading Intelligence quartet for B.O.S.S. Operating System.

ROLES:
- P.I.V.O.T. owns Premarket & Macro (overnight catalysts, futures, key levels, market regime read)
- A.T.O.M. owns Options Context (IV, unusual flow, expected move, 0DTE conditions)
- Q.U.A.N.T. owns Multi-Timeframe Structure (trend containment candle, 2min/5min/daily alignment, key support/resistance)
- E.D.G.E. owns Discipline & Risk (setup quality grade, invalidation, position sizing reminder, stop-after-two-losses reminder)

You receive: today's market news, Meka's active watchlist with categories and notes, and his trading style profile.
Produce ONE unified watchlist report with per-ticker analysis.

${HOUSE}

Output schema:
{
  "market_session": "premarket|open|midday|close|overnight",
  "regime": "trend-day|chop|reversal|news-driven|range",
  "executive_summary": "under 90 words. Today's read.",
  "pivot_macro": {
    "spy_bias": "bullish|bearish|neutral|chop",
    "key_levels": ["e.g. SPY 590/588/585 cluster"],
    "catalysts_today": [{"time":"9:30 ET","event":"","impact":"high|med|low"}],
    "futures_read": "one paragraph",
    "notes": "one paragraph"
  },
  "atom_options": {
    "iv_environment": "rising|falling|flat",
    "zero_dte_conditions": "favorable|caution|avoid",
    "unusual_flow": [{"ticker":"","note":""}],
    "expected_move_spy": "string like ±0.8%",
    "notes": "one paragraph"
  },
  "quant_structure": {
    "trend_containment_seen_on": [],
    "alignment_2min_5min_daily": "aligned|split|disjoint",
    "notes": "one paragraph"
  },
  "edge_discipline": {
    "setup_quality_overall": "A|B|C|D",
    "max_trades_today": 2,
    "stop_rules_reminder": "Green is sacred. Stop after two losses. No setup no trade.",
    "weakness_watch": "losses larger than winners — protect green, take profits earlier",
    "notes": "one paragraph"
  },
  "per_ticker": [
    {
      "symbol": "",
      "category": "",
      "priority": "high|normal|low",
      "current_price": 0,
      "previous_close": 0,
      "change_pct": 0,
      "setup_quality": "A|B|C|D",
      "directional_read": "long-bias|short-bias|neutral|avoid-today",
      "key_levels": {"support":[], "resistance":[], "pivot":""},
      "trend_containment_read": "string",
      "invalidation": "string — the level/condition that kills the thesis",
      "risk_notes": "string",
      "catalysts": [],
      "discipline_note": "string — Meka rule reminder relevant to THIS ticker",
      "educational_summary": "2-4 sentences. Frame as for educational consideration only."
    }
  ],
  "discipline_reminders": [
    "Stop after two losses.",
    "Green is sacred. Bank it.",
    "No setup, no trade."
  ],
  "final_verdict": "string under 50 words. Today's discipline call.",
  "not_a_recommendation": "All analysis is educational only. Meka makes every trade decision."
}`;

function divider(t){ return `\n${"=".repeat(64)}\n${t.toUpperCase()}\n${"=".repeat(64)}\n`; }
function fmtList(arr, prefix="- "){
  if(!Array.isArray(arr) || arr.length === 0) return "(none)";
  return arr.map(x => prefix + (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
}

function formatTxt(c){
  const today = new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});
  const lines = [
`================================================================
B.O.S.S. OPERATING SYSTEM · TRADING WATCHLIST REPORT
================================================================

Date:           ${today}
Generated:      ${new Date().toISOString()}
Session:        ${c.market_session || "—"}
Regime read:    ${c.regime || "—"}
Compiled by:    P.I.V.O.T. · A.T.O.M. · Q.U.A.N.T. · E.D.G.E.

EDUCATIONAL ANALYSIS ONLY. NOT FINANCIAL ADVICE.
NO TRADES ARE PLACED BY THIS SYSTEM.
`,
divider("Today's Read · Executive Summary"),
c.executive_summary || "(none)",
divider("1. Premarket & Macro · P.I.V.O.T."),
`SPY bias:           ${c.pivot_macro?.spy_bias || "—"}
Key levels:         ${fmtList(c.pivot_macro?.key_levels, "  • ")}
Catalysts today:    ${fmtList(c.pivot_macro?.catalysts_today, "  • ")}
${c.pivot_macro?.futures_read || ""}
${c.pivot_macro?.notes || ""}`,
divider("2. Options Context · A.T.O.M."),
`IV environment:     ${c.atom_options?.iv_environment || "—"}
0DTE conditions:    ${c.atom_options?.zero_dte_conditions || "—"}
SPY expected move:  ${c.atom_options?.expected_move_spy || "—"}
Unusual flow:       ${fmtList(c.atom_options?.unusual_flow, "  • ")}
${c.atom_options?.notes || ""}`,
divider("3. Multi-Timeframe Structure · Q.U.A.N.T."),
`2/5/Daily align:    ${c.quant_structure?.alignment_2min_5min_daily || "—"}
TC candles seen on: ${fmtList(c.quant_structure?.trend_containment_seen_on, "  • ")}
${c.quant_structure?.notes || ""}`,
divider("4. Discipline & Risk · E.D.G.E."),
`Setup quality:      ${c.edge_discipline?.setup_quality_overall || "—"}
Max trades today:   ${c.edge_discipline?.max_trades_today ?? 2}
Stop rules:         ${c.edge_discipline?.stop_rules_reminder || ""}
Weakness watch:     ${c.edge_discipline?.weakness_watch || ""}
${c.edge_discipline?.notes || ""}`,
divider("5. Per-Ticker Analysis")
  ];

  for(const t of (c.per_ticker||[])){
    const px  = t.current_price != null ? `$${Number(t.current_price).toFixed(2)}` : "—";
    const pc  = t.previous_close != null ? `$${Number(t.previous_close).toFixed(2)}` : "—";
    const chg = t.change_pct != null ? `${Number(t.change_pct) >= 0 ? "+" : ""}${Number(t.change_pct).toFixed(2)}%` : "—";
    lines.push(`
${t.symbol || "?"} · ${t.category || ""} · priority ${t.priority || "normal"} · setup ${t.setup_quality || "—"}
  Live price:     ${px}   (prev close ${pc} · ${chg})
  Bias:           ${t.directional_read || "—"}
  Pivot:          ${t.key_levels?.pivot || "—"}
  Support:        ${(t.key_levels?.support||[]).join(", ") || "—"}
  Resistance:     ${(t.key_levels?.resistance||[]).join(", ") || "—"}
  TC read:        ${t.trend_containment_read || "—"}
  Invalidation:   ${t.invalidation || "—"}
  Risk:           ${t.risk_notes || "—"}
  Catalysts:      ${(t.catalysts||[]).join(", ") || "—"}
  Discipline:     ${t.discipline_note || "—"}
  Summary:        ${t.educational_summary || "—"}
----------------------------------------------------------------`);
  }

  lines.push(divider("6. Discipline Reminders · E.D.G.E."));
  lines.push((c.discipline_reminders||[]).map(s => "  • " + s).join("\n") || "(none)");
  lines.push(divider("7. Final Verdict"));
  lines.push(c.final_verdict || "(none)");
  lines.push(divider("Disclaimer"));
  lines.push(c.not_a_recommendation || "All analysis is educational only. Meka makes every trade decision.");
  lines.push(`\n--- END OF TRADING REPORT ---\nGenerated by B.O.S.S. Operating System · P.I.V.O.T. · A.T.O.M. · Q.U.A.N.T. · E.D.G.E.`);
  return lines.join("\n");
}

async function sendEmail(report, fileName){
  if(!process.env.RESEND_API_KEY || !process.env.REPORT_TO || !process.env.REPORT_FROM) return { sent:false };
  const regimeColor = ({ "trend-day":"#4dffc2", "chop":"#ffb34d", "reversal":"#ff3d67", "news-driven":"#ffb34d", "range":"#1ce8ff" })[report.regime] || "#1ce8ff";
  const top = (report.per_ticker||[]).filter(t => ["A","B"].includes(t.setup_quality)).slice(0,5);
  const html = `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:24px;max-width:680px;margin:auto">
<div style="border:1px solid #1ce8ff;padding:22px">
  <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;color:#1ce8ff">B.O.S.S. TRADING WATCHLIST · 8:15AM CT · EDUCATIONAL ONLY</div>
  <h1 style="margin:8px 0 4px;font-size:22px">${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</h1>
  <div style="margin-top:10px">
    <span style="background:${regimeColor};color:#021018;padding:5px 14px;font-family:ui-monospace,monospace;font-weight:900;letter-spacing:.18em">${(report.regime||"—").toUpperCase()}</span>
    <span style="margin-left:12px;color:#fff">${report.market_session||""}</span>
  </div>
  <p style="margin-top:14px;color:#e6fbff;line-height:1.55">${report.executive_summary||""}</p>
  <h2 style="margin-top:18px;font-size:13px;letter-spacing:.18em;color:#4dffc2;text-transform:uppercase">Highest-grade setups (A/B)</h2>
  ${top.length ? top.map(t=>`<div style="padding:8px 0;border-bottom:1px solid #122b3a">
    <div style="font-family:ui-monospace,monospace;color:#1ce8ff;font-weight:700">${t.symbol} · ${t.setup_quality} · ${t.directional_read}</div>
    <div style="color:#7f9daf;font-size:12px;margin-top:2px">${t.educational_summary||""}</div>
    <div style="color:#ff3d67;font-size:11px;margin-top:4px">Invalidation: ${t.invalidation||"—"}</div>
  </div>`).join("") : "<div style='color:#7f9daf'>No A or B setups today. Sit out and protect green.</div>"}
  <h2 style="margin-top:18px;font-size:13px;letter-spacing:.18em;color:#ffb34d;text-transform:uppercase">Discipline</h2>
  ${(report.discipline_reminders||[]).map(s=>`<div style="padding:3px 0;color:#7f9daf;font-size:12px">• ${s}</div>`).join("")}
  <div style="margin-top:18px;padding:10px 12px;border:1px dashed #ff3d67;background:#1a0710;color:#ffb34d;font-size:11px;font-style:italic">${report.not_a_recommendation||"Educational only. Not financial advice."}</div>
  <div style="margin-top:14px;color:#7f9daf;font-size:11px">${fileName}</div>
</div></body></html>`;
  const r = await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.RESEND_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      from: process.env.REPORT_FROM,
      to: process.env.REPORT_TO,
      subject: `B.O.S.S. Watchlist · ${(report.regime||"").toUpperCase()} · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}`,
      html
    })
  });
  return { sent: r.ok };
}

function requireSecret(req){
  const provided = (req.query?.secret) || req.headers["x-cron-secret"] || "";
  const expected = process.env.CRON_SECRET;
  if(!expected) return true;
  return provided === expected;
}

async function scoutMarketNews(symbols){
  const today = new Date().toLocaleDateString("en-US",{month:"long",day:"numeric"});
  const globalQueries = [
    `SPY premarket today ${today}`,
    `stock market futures today ${today}`,
    `Federal Reserve economic calendar today catalysts`,
    `earnings reports today before bell after hours`,
    `SPY QQQ 0DTE options flow today`
  ];
  const tickerQueries = symbols.slice(0,8).map(s => `${s} stock news today premarket movers`);
  const packs = await Promise.all([...globalQueries, ...tickerQueries].map(q => tavilySearch(q, "basic", 3)));
  const seen = new Set();
  const evidence = [];
  for(const p of packs){
    for(const item of p){
      if(!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      evidence.push(item);
    }
  }
  return evidence.slice(0, 36);
}

export default async function handler(req, res){
  if(!requireSecret(req)) return res.status(401).json({ error:"unauthorized" });
  try {
    if(!process.env.OPENAI_API_KEY) return res.status(500).json({ error:"OPENAI_API_KEY not set" });

    // 1. Pull active tickers from watchlist
    const tickers = await sbQuery("trading_tickers?active=eq.true&order=priority.asc,symbol.asc&limit=60");
    if(!tickers.length) return res.status(200).json({ ok:false, error:"no active tickers in watchlist. Add tickers first." });

    const symbols = tickers.map(t => t.symbol);

    // 2. Live price feed + Tavily news (parallel)
    const [liveQuotes, evidence] = await Promise.all([
      fetchYahooQuotes(symbols),
      scoutMarketNews(symbols)
    ]);

    // 3. Run quartet analysis (single OpenAI call)
    const payload = {
      generated_at: new Date().toISOString(),
      meka_style: {
        primary_setup: "2-min Trend Containment Candle",
        win_rate_pct: 61,
        focus: "SPY 0DTE",
        rules: ["Green is Sacred","Precision over Activity","Stop after two losses","No setup no trade"],
        weakness: "losses larger than winners"
      },
      active_watchlist: tickers.map(t => ({
        symbol: t.symbol,
        category: t.category,
        priority: t.priority,
        options_enabled: t.options_enabled,
        earnings_watch: t.earnings_watch,
        notes: t.notes,
        strategy_relevance: t.strategy_relevance
      })),
      live_quotes: liveQuotes,          // <-- the authoritative price source
      market_evidence: evidence
    };

    const t0 = Date.now();
    const llm = await callOpenAI(SYSTEM, payload);
    const elapsed = Date.now() - t0;
    const report = llm.data;

    // Defensive post-processor: force live_quotes prices into every per_ticker entry
    // so the model can never drift back to its training-data prices.
    if(Array.isArray(report.per_ticker)){
      for(const pt of report.per_ticker){
        const q = liveQuotes[pt.symbol];
        if(q){
          pt.current_price  = q.price;
          pt.previous_close = q.prev_close;
          pt.change_pct     = q.change_pct;
        }
      }
    }

    // 4. Persist trading_reports row
    const row = await sbInsert("trading_reports", {
      report_date: new Date().toISOString().slice(0,10),
      report_type: "daily_watchlist",
      ticker_symbol: null,
      market_session: report.market_session || null,
      context: { regime: report.regime, executive_summary: report.executive_summary },
      per_ticker: report.per_ticker || [],
      options_context: report.atom_options || {},
      multi_timeframe: report.quant_structure || {},
      risk_notes: report.edge_discipline || {},
      edge_review: { final_verdict: report.final_verdict, discipline_reminders: report.discipline_reminders },
      full_payload: report
    });

    // 5. Generate .txt file (with a live-prices header block prepended)
    const quoteRows = Object.values(liveQuotes)
      .sort((a,b)=>(a.symbol||"").localeCompare(b.symbol||""))
      .map(q => `  ${(q.symbol||"").padEnd(6)} $${(q.price ?? 0).toFixed(2).padStart(9)}   prev $${(q.prev_close ?? 0).toFixed(2).padStart(9)}   ${(q.change_pct >= 0 ? "+" : "")}${(q.change_pct ?? 0).toFixed(2)}%   52w ${q.fifty_two_week_low ?? "—"} / ${q.fifty_two_week_high ?? "—"}`)
      .join("\n");
    const missing = symbols.filter(s => !liveQuotes[s]);
    const quoteHeader = `\n================================================================
LIVE PRICE FEED (Yahoo) · as of ${new Date().toISOString()}
================================================================
${quoteRows || "(no live quotes — Yahoo unavailable)"}
${missing.length ? `\nMissing from feed: ${missing.join(", ")}` : ""}
`;
    const txt = formatTxt(report).replace("EDUCATIONAL ANALYSIS ONLY. NOT FINANCIAL ADVICE.\nNO TRADES ARE PLACED BY THIS SYSTEM.", `EDUCATIONAL ANALYSIS ONLY. NOT FINANCIAL ADVICE.\nNO TRADES ARE PLACED BY THIS SYSTEM.\n${quoteHeader}`);
    const fileName = `07_trading_watchlist_${new Date().toISOString().slice(0,10)}.txt`;
    const fileRow = await sbInsert("generated_files", {
      file_name: fileName,
      file_type: "trading",
      content: txt,
      dept_id: "trd",
      agent_id: "PIVOT"
    });

    // 6. Bump last_report_date on every covered ticker (fire-and-forget)
    const now = new Date().toISOString();
    const coveredSymbols = new Set((report.per_ticker||[]).map(t => t.symbol));
    for(const t of tickers){
      if(coveredSymbols.has(t.symbol)){
        await sbPatch("trading_tickers", `id=eq.${t.id}`, { last_report_date: now });
      }
    }

    // 7. Email
    const email = await sendEmail(report, fileName);

    // 8. Ops log
    try {
      await sbInsert("ops_logs", {
        agent_id: "PIVOT", dept_id: "trd",
        action: "trading_report", status: "completed",
        duration_ms: elapsed, tokens_used: llm.usage?.total_tokens || 0,
        api_cost_estimate: ((llm.usage?.total_tokens || 0) / 1e6) * 0.15,
        payload: { report_id: row.id, file_id: fileRow.id, regime: report.regime, tickers_covered: coveredSymbols.size }
      });
    } catch(_) {}

    return res.status(200).json({
      ok: true,
      report_id: row.id,
      file_id: fileRow.id,
      file_name: fileName,
      regime: report.regime,
      market_session: report.market_session,
      tickers_covered: coveredSymbols.size,
      tickers_in_watchlist: tickers.length,
      email,
      summary: report.executive_summary,
      tokens: llm.usage?.total_tokens || 0
    });
  } catch(e){
    return res.status(500).json({ error: e.message });
  }
}
