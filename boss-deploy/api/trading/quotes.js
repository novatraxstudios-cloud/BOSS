// GET /api/trading/quotes?symbols=SPY,QQQ,NVDA
// Three-source price feed with automatic fallback + per-symbol diagnostics.
// Order:  Finnhub (cheap, 60/min free)  →  Alpha Vantage (when key set)  →  Yahoo (no key, last resort)
// Returns: { ok, as_of, sources:{<src>:count}, quotes:{<sym>:{price,...,source}}, diagnostics:{<sym>:[{source,status,...}]} }

export const config = { runtime: "nodejs" };

/* ---------- FINNHUB (primary) ---------- */
async function fetchFinnhubQuote(symbol){
  const key = process.env.FINNHUB_API_KEY;
  if(!key) return { ok:false, status:"no_key" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 4500);
    const r = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
      { signal: ctrl.signal, headers: { "Accept":"application/json" } }
    );
    clearTimeout(t);
    if(!r.ok) return { ok:false, status:`http_${r.status}` };
    const j = await r.json();
    // Finnhub returns 0s for unknown tickers — guard against that
    if(!j || j.c == null || (j.c === 0 && j.pc === 0)) return { ok:false, status:"empty_or_unknown" };
    const price     = Number(Number(j.c).toFixed(2));
    const prevClose = Number(Number(j.pc).toFixed(2));
    const change    = j.d  != null ? Number(Number(j.d).toFixed(2))  : Number((price - prevClose).toFixed(2));
    const changePct = j.dp != null ? Number(Number(j.dp).toFixed(2)) : (prevClose ? Number(((price-prevClose)/prevClose*100).toFixed(2)) : null);
    return {
      ok:true, status:"ok",
      data: {
        symbol, price, prev_close: prevClose, change, change_pct: changePct,
        day_open: j.o != null ? Number(Number(j.o).toFixed(2)) : null,
        day_high: j.h != null ? Number(Number(j.h).toFixed(2)) : null,
        day_low:  j.l != null ? Number(Number(j.l).toFixed(2)) : null,
        fifty_two_week_high: null,
        fifty_two_week_low:  null,
        source: "finnhub"
      }
    };
  } catch (e) { return { ok:false, status:`error:${e.name||"err"}` }; }
}

/* ---------- ALPHA VANTAGE (secondary) ---------- */
async function fetchAlphaVantageQuote(symbol){
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if(!key) return { ok:false, status:"no_key" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 5500);
    const r = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
      { signal: ctrl.signal, headers: { "Accept":"application/json" } }
    );
    clearTimeout(t);
    if(!r.ok) return { ok:false, status:`http_${r.status}` };
    const j = await r.json();
    if(j["Information"]) return { ok:false, status:"av_rate_limited" };
    if(j["Note"])        return { ok:false, status:"av_throttled" };
    if(j["Error Message"]) return { ok:false, status:"av_error" };
    const q = j["Global Quote"];
    if(!q || !q["05. price"]) return { ok:false, status:"av_empty" };
    const price     = Number(parseFloat(q["05. price"]).toFixed(2));
    const prevClose = Number(parseFloat(q["08. previous close"]).toFixed(2));
    const change    = Number(parseFloat(q["09. change"] || (price - prevClose)).toFixed(2));
    const changePct = Number(parseFloat((q["10. change percent"] || "0").replace("%","")).toFixed(2));
    return {
      ok:true, status:"ok",
      data: {
        symbol: q["01. symbol"] || symbol,
        price, prev_close: prevClose, change, change_pct: changePct,
        day_open: q["02. open"] ? Number(parseFloat(q["02. open"]).toFixed(2)) : null,
        day_high: q["03. high"] ? Number(parseFloat(q["03. high"]).toFixed(2)) : null,
        day_low:  q["04. low"]  ? Number(parseFloat(q["04. low"]).toFixed(2))  : null,
        fifty_two_week_high: null,
        fifty_two_week_low:  null,
        source: "alphavantage"
      }
    };
  } catch (e) { return { ok:false, status:`error:${e.name||"err"}` }; }
}

/* ---------- STOOQ (fourth fallback — no key, CSV) ---------- */
async function fetchStooqQuote(symbol){
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 4500);
    // Stooq uses lowercase + .us suffix for US tickers; f=sd2t2ohlcvp = symbol,date,time,o,h,l,c,vol,prevclose
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(symbol.toLowerCase())}.us&f=sd2t2ohlcvp&h&e=csv`;
    const r = await fetch(url, { signal: ctrl.signal, headers:{ "User-Agent":"Mozilla/5.0", "Accept":"text/csv,*/*" } });
    clearTimeout(t);
    if(!r.ok) return { ok:false, status:`stooq_http_${r.status}` };
    const text = (await r.text()).trim();
    const lines = text.split(/\r?\n/);
    if(lines.length < 2) return { ok:false, status:"stooq_empty" };
    const headerCols = lines[0].split(",").map(s=>s.trim().toLowerCase());
    const valueCols  = lines[1].split(",").map(s=>s.trim());
    const get = (name)=>{ const i = headerCols.indexOf(name); return i>=0 ? valueCols[i] : null; };
    const closeRaw = get("close");
    if(!closeRaw || closeRaw === "N/D") return { ok:false, status:"stooq_no_data" };
    const price = Number(parseFloat(closeRaw).toFixed(2));
    const prevRaw = get("prevclose") || get("close.1");
    const prevClose = prevRaw && prevRaw !== "N/D" ? Number(parseFloat(prevRaw).toFixed(2)) : null;
    const open  = get("open");  const high = get("high"); const low = get("low"); const vol = get("volume");
    const change    = (prevClose != null) ? Number((price - prevClose).toFixed(2)) : null;
    const changePct = (prevClose != null && prevClose !== 0) ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : null;
    return {
      ok:true, status:"ok",
      data: {
        symbol, price, prev_close: prevClose, change, change_pct: changePct,
        day_open: open && open !== "N/D" ? Number(parseFloat(open).toFixed(2)) : null,
        day_high: high && high !== "N/D" ? Number(parseFloat(high).toFixed(2)) : null,
        day_low:  low  && low  !== "N/D" ? Number(parseFloat(low).toFixed(2))  : null,
        volume:   vol  && vol  !== "N/D" ? Number(vol) : null,
        fifty_two_week_high: null,
        fifty_two_week_low:  null,
        source: "stooq"
      }
    };
  } catch (e) { return { ok:false, status:`error:${e.name||"err"}` }; }
}

/* ---------- YAHOO (tertiary fallback) ---------- */
async function fetchYahooQuote(symbol){
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 4000);
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "Accept": "application/json"
        }
      }
    );
    clearTimeout(t);
    if(!r.ok) return { ok:false, status:`yahoo_http_${r.status}` };
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if(!res) return { ok:false, status:"yahoo_empty" };
    const meta = res.meta || {};
    const closes = res.indicators?.quote?.[0]?.close || [];
    const price     = Number((meta.regularMarketPrice ?? closes.filter(Boolean).slice(-1)[0])?.toFixed?.(2)) || null;
    const prevClose = Number((meta.chartPreviousClose ?? meta.previousClose)?.toFixed?.(2)) || null;
    if(price == null) return { ok:false, status:"yahoo_no_price" };
    const change    = (prevClose != null) ? Number((price - prevClose).toFixed(2)) : null;
    const changePct = (prevClose != null && prevClose !== 0) ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : null;
    return {
      ok:true, status:"ok",
      data: {
        symbol: meta.symbol || symbol,
        price, prev_close: prevClose, change, change_pct: changePct,
        day_high: meta.regularMarketDayHigh != null ? Number(meta.regularMarketDayHigh.toFixed(2)) : null,
        day_low:  meta.regularMarketDayLow  != null ? Number(meta.regularMarketDayLow.toFixed(2))  : null,
        fifty_two_week_high: meta.fiftyTwoWeekHigh != null ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : null,
        fifty_two_week_low:  meta.fiftyTwoWeekLow  != null ? Number(meta.fiftyTwoWeekLow.toFixed(2))  : null,
        market_state: meta.marketState || null,
        exchange: meta.exchangeName || null,
        source: "yahoo"
      }
    };
  } catch (e) { return { ok:false, status:`error:${e.name||"err"}` }; }
}

/* ---------- COMBINED ----------
   Walks Finnhub → Alpha Vantage → Yahoo. First success wins.
   Yahoo also fills 52w range when the winner doesn't have it. */
async function fetchQuoteWithFallback(symbol){
  const trail = [];
  const sources = [
    { name:"finnhub",      fn: fetchFinnhubQuote },
    { name:"alphavantage", fn: fetchAlphaVantageQuote },
    { name:"stooq",        fn: fetchStooqQuote },
    { name:"yahoo",        fn: fetchYahooQuote }
  ];

  let winner = null;
  for(const s of sources){
    const r = await s.fn(symbol);
    trail.push({ source: s.name, status: r.status });
    if(r.ok){ winner = r.data; break; }
  }

  // 52w enrichment from Yahoo if missing
  if(winner && winner.fifty_two_week_high == null && winner.source !== "yahoo"){
    const y = await fetchYahooQuote(symbol);
    if(y.ok){
      winner.fifty_two_week_high = y.data.fifty_two_week_high;
      winner.fifty_two_week_low  = y.data.fifty_two_week_low;
      if(!winner.market_state) winner.market_state = y.data.market_state;
      if(!winner.exchange)     winner.exchange     = y.data.exchange;
      trail.push({ source: "yahoo_52w", status: "ok" });
    } else {
      trail.push({ source: "yahoo_52w", status: y.status });
    }
  }

  return { data: winner, trail };
}

export default async function handler(req, res){
  try {
    const symbolsParam = req.query?.symbols || "";
    const symbols = String(symbolsParam).toUpperCase().split(",").map(s=>s.trim()).filter(Boolean).slice(0,60);
    if(!symbols.length) return res.status(200).json({ ok:true, quotes: {}, diagnostics: {}, sources: {} });

    const results = await Promise.all(symbols.map(fetchQuoteWithFallback));
    const quotes = {}; const diagnostics = {};
    symbols.forEach((s,i)=>{
      diagnostics[s] = results[i].trail;
      if(results[i].data) quotes[s] = results[i].data;
    });

    const sourceCount = Object.values(quotes).reduce((acc,q)=>{ acc[q.source||"?"]=(acc[q.source||"?"]||0)+1; return acc; }, {});
    const failedSymbols = symbols.filter(s => !quotes[s]);

    res.setHeader("Cache-Control","public, max-age=15, s-maxage=15");
    return res.status(200).json({
      ok: true,
      as_of: new Date().toISOString(),
      sources: sourceCount,
      failed_symbols: failedSymbols,
      env: {
        finnhub: !!process.env.FINNHUB_API_KEY,
        alphavantage: !!process.env.ALPHA_VANTAGE_API_KEY,
        yahoo: true
      },
      quotes,
      diagnostics
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
