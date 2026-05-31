// GET /api/trading/quotes?symbols=SPY,QQQ,NVDA
// Returns current prices from Yahoo Finance chart endpoint (no API key).
// Used by the Trading Watchlist UI to show live $ on every card.

export const config = { runtime: "nodejs" };

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
      exchange: meta.exchangeName || null
    };
  } catch { return null; }
}

export default async function handler(req, res){
  try {
    const symbolsParam = req.query?.symbols || "";
    const symbols = String(symbolsParam).toUpperCase().split(",").map(s=>s.trim()).filter(Boolean).slice(0,60);
    if(!symbols.length) return res.status(200).json({ ok:true, quotes: {} });

    const out = {};
    const chunks = [];
    for(let i=0;i<symbols.length;i+=10) chunks.push(symbols.slice(i,i+10));
    for(const chunk of chunks){
      const results = await Promise.all(chunk.map(fetchYahooQuote));
      chunk.forEach((s,i)=>{ if(results[i]) out[s] = results[i]; });
    }
    // Cache 30s — quotes are stale anyway during regular hours
    res.setHeader("Cache-Control","public, max-age=15, s-maxage=15");
    return res.status(200).json({ ok:true, as_of: new Date().toISOString(), quotes: out });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
