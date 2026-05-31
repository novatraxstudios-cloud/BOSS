// GET /api/trading/quotes?symbols=SPY,QQQ,NVDA
// Primary:  Alpha Vantage GLOBAL_QUOTE (if ALPHA_VANTAGE_API_KEY set)
// Fallback: Yahoo Finance chart endpoint (no key) — fills gaps + 52w range
// Used by the Trading Watchlist UI to show live $ on every card.

export const config = { runtime: "nodejs" };

async function fetchAlphaVantageQuote(symbol){
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if(!key) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), 5000);
    const r = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`,
      { signal: ctrl.signal, headers: { "Accept":"application/json" } }
    );
    clearTimeout(t);
    if(!r.ok) return null;
    const j = await r.json();
    if(j["Information"] || j["Note"] || j["Error Message"]) return null;
    const q = j["Global Quote"];
    if(!q || !q["05. price"]) return null;
    const price     = Number(parseFloat(q["05. price"]).toFixed(2));
    const prevClose = Number(parseFloat(q["08. previous close"]).toFixed(2));
    const change    = Number(parseFloat(q["09. change"] || (price - prevClose)).toFixed(2));
    const changePct = Number(parseFloat((q["10. change percent"] || "0").replace("%","")).toFixed(2));
    return {
      symbol: q["01. symbol"] || symbol,
      price, prev_close: prevClose, change, change_pct: changePct,
      day_open: q["02. open"]  ? Number(parseFloat(q["02. open"]).toFixed(2))  : null,
      day_high: q["03. high"]  ? Number(parseFloat(q["03. high"]).toFixed(2))  : null,
      day_low:  q["04. low"]   ? Number(parseFloat(q["04. low"]).toFixed(2))   : null,
      volume:   q["06. volume"]? Number(q["06. volume"]) : null,
      latest_trading_day: q["07. latest trading day"] || null,
      fifty_two_week_high: null,
      fifty_two_week_low:  null,
      source: "alphavantage"
    };
  } catch { return null; }
}

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
    if(!r.ok) return null;
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if(!res) return null;
    const meta = res.meta || {};
    const closes = res.indicators?.quote?.[0]?.close || [];
    const price     = Number((meta.regularMarketPrice ?? closes.filter(Boolean).slice(-1)[0])?.toFixed?.(2)) || null;
    const prevClose = Number((meta.chartPreviousClose ?? meta.previousClose)?.toFixed?.(2)) || null;
    const change    = (price != null && prevClose != null) ? Number((price - prevClose).toFixed(2)) : null;
    const changePct = (price != null && prevClose != null && prevClose !== 0) ? Number(((price - prevClose) / prevClose * 100).toFixed(2)) : null;
    return {
      symbol: meta.symbol || symbol,
      price, prev_close: prevClose, change, change_pct: changePct,
      day_high: meta.regularMarketDayHigh != null ? Number(meta.regularMarketDayHigh.toFixed(2)) : null,
      day_low:  meta.regularMarketDayLow  != null ? Number(meta.regularMarketDayLow.toFixed(2))  : null,
      fifty_two_week_high: meta.fiftyTwoWeekHigh != null ? Number(meta.fiftyTwoWeekHigh.toFixed(2)) : null,
      fifty_two_week_low:  meta.fiftyTwoWeekLow  != null ? Number(meta.fiftyTwoWeekLow.toFixed(2))  : null,
      market_state: meta.marketState || null,
      exchange: meta.exchangeName || null,
      source: "yahoo"
    };
  } catch { return null; }
}

async function fetchQuotes(symbols){
  const out = {};
  const haveAV = !!process.env.ALPHA_VANTAGE_API_KEY;

  if(haveAV){
    const avResults = await Promise.all(symbols.map(fetchAlphaVantageQuote));
    symbols.forEach((s,i)=>{ if(avResults[i]) out[s] = avResults[i]; });
  }

  const need52w = Object.keys(out).filter(s => out[s].fifty_two_week_high == null);
  const missing = symbols.filter(s => !out[s]);
  const yahooTargets = [...new Set([...missing, ...need52w])];
  if(yahooTargets.length){
    const yResults = await Promise.all(yahooTargets.map(fetchYahooQuote));
    yahooTargets.forEach((s,i)=>{
      const y = yResults[i];
      if(!y) return;
      if(out[s]){
        out[s].fifty_two_week_high = y.fifty_two_week_high;
        out[s].fifty_two_week_low  = y.fifty_two_week_low;
        if(!out[s].market_state) out[s].market_state = y.market_state;
        if(!out[s].exchange)     out[s].exchange = y.exchange;
      } else {
        out[s] = y;
      }
    });
  }
  return out;
}

export default async function handler(req, res){
  try {
    const symbolsParam = req.query?.symbols || "";
    const symbols = String(symbolsParam).toUpperCase().split(",").map(s=>s.trim()).filter(Boolean).slice(0,60);
    if(!symbols.length) return res.status(200).json({ ok:true, quotes: {} });

    const out = await fetchQuotes(symbols);
    const sourceCount = Object.values(out).reduce((acc,q)=>{ acc[q.source||"?"]=(acc[q.source||"?"]||0)+1; return acc; }, {});
    res.setHeader("Cache-Control","public, max-age=15, s-maxage=15");
    return res.status(200).json({ ok:true, as_of: new Date().toISOString(), sources: sourceCount, quotes: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
