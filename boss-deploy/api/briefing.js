// /api/briefing  — Vercel serverless function
// Daily autonomous briefing. Hit by Vercel Cron at 13:00 UTC (08:00 CDT).
//
// Pipeline:
//   1. Pick today's vertical (rotates by day-of-week)
//   2. Friday runs 5 Tavily searches — Reddit complaints, App Store reviews,
//      Product Hunt launches, general pain, trend signals
//   3. Evidence is passed to OpenAI as grounded context
//   4. BOSS produces a JSON briefing with citations
//   5. Resend emails it to Meka
//
// Required env vars (Vercel → Settings → Environment Variables):
//   OPENAI_API_KEY        — OpenAI key
//   TAVILY_API_KEY        — Tavily key (tavily.com — free 1000/mo)
//   RESEND_API_KEY        — Resend.com key (free tier)
//   REPORT_TO             — recipient email
//   REPORT_FROM           — verified Resend sender (or onboarding@resend.dev)
//   CRON_SECRET           — random string; Vercel sends it automatically
//
// Manual test: hit /api/briefing?secret=<CRON_SECRET>

// Node.js runtime gives us 60s on Hobby (vs 25s for Edge).
// The 8-agent pipeline runs ~20-30s so we need the headroom.
export const config = { runtime: "nodejs" };
export const maxDuration = 60;

/* ---------- VERTICAL ROTATION ----------
   So BOSS doesn't pitch productivity apps every single day. */
const VERTICALS = [
  { day: "Sun", name: "parenting and family",          niche_terms: ["parents","baby","toddler","kids schedule"] },
  { day: "Mon", name: "productivity and focus",        niche_terms: ["focus","deep work","task manager","calendar"] },
  { day: "Tue", name: "personal finance and trading",  niche_terms: ["budget","saving","investing","options trading"] },
  { day: "Wed", name: "fitness and health",            niche_terms: ["workout","sleep","mental health","habit"] },
  { day: "Thu", name: "creator economy",               niche_terms: ["tiktok creator","newsletter","substack","podcaster"] },
  { day: "Fri", name: "small business and legal",      niche_terms: ["solopreneur","contracts","invoicing","compliance"] },
  { day: "Sat", name: "home, auto, neighborhood",      niche_terms: ["home maintenance","car","neighborhood","pet care"] }
];

function todayVertical() {
  const dayIdx = new Date().getUTCDay(); // 0..6
  return VERTICALS[dayIdx];
}

/* ---------- TAVILY SEARCH ---------- */
async function tavilySearch(query, depth = "basic", max_results = 5) {
  if (!process.env.TAVILY_API_KEY) return null;
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: depth,
      max_results,
      include_answer: false,
      include_raw_content: false,
      topic: "general"
    })
  });
  if (!res.ok) return { error: `Tavily ${res.status}: ${await res.text()}` };
  const j = await res.json();
  return (j.results || []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: (r.content || "").slice(0, 380),
    score: r.score
  }));
}

async function fridayScout(vertical) {
  const v = vertical.name;
  const queries = [
    `${v} mobile app complaints reviews this month`,
    `site:reddit.com ${v} app frustration "I wish there was"`,
    `App Store one star reviews ${vertical.niche_terms[0]} app`,
    `site:producthunt.com ${v} launches`,
    `Hacker News ${v} pain point startup idea`
  ];
  const results = await Promise.all(queries.map(q => tavilySearch(q, "basic", 4)));
  // Flatten, dedupe by URL, cap to 18 strongest
  const seen = new Set();
  const flat = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r || r.error) continue;
    for (const item of r) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      flat.push({ ...item, source_query: queries[i] });
    }
  }
  flat.sort((a, b) => (b.score || 0) - (a.score || 0));
  return { vertical: v, queries, evidence: flat.slice(0, 18) };
}

/* =========================================================================
   SPECIALIZED 8-AGENT PIPELINE
   Each agent gets its own OpenAI call with its own role-specific prompt.
   Chain:
     Friday (Tavily)
       → Boss_filter (cuts 17 → 5)
         → Void + Sniper (parallel, on top 5)
           → Boss_narrow (5 → 3)
             → Blue + Cash + Vibe (parallel, on top 3)
               → Boss_final (synthesizes briefing JSON)
   ========================================================================= */

const MEKA_PORTFOLIO = "Tradjent (trading journal), Ru (women's insight), OutdoorSafe / Sky (outdoor wellness), DAUBED.IO (tattoo booking), Quovo (hot takes), Estimio, Friday OS (personal iOS Jarvis), Evil Babysitter's Obby (Roblox)";

const HOUSE_RULES = `
HOUSE RULES (all agents):
- NEVER use em dashes. Use commas or periods.
- Never spell acronyms letter by letter. Say "Friday" not "F dot R dot I dot D dot A dot Y".
- Plain prose. No markdown, no bullets, no emojis in any string value.
- Reject anything that duplicates Meka's existing portfolio: ${MEKA_PORTFOLIO}.
- Ideas must be mobile-app shaped and solo-founder buildable in 30 days.
- Output STRICT JSON only, no commentary outside the JSON.
`.trim();

/* ---- Generic agent caller ---- */
async function callOpenAI(systemPrompt, userPayload, modelOverride) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: modelOverride || "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.55,
      max_tokens: 1500
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0,200)}`);
  const json = await res.json();
  return {
    data: JSON.parse(json.choices[0].message.content),
    usage: json.usage
  };
}

/* ---- BOSS · Filter (17 → 5) ---- */
async function agentBossFilter(vertical, scoutPacket) {
  const sys = `You are B.O.S.S., Meka Anyanwu's chief venture decision agent.
Friday scouted live web evidence in the ${vertical.name} vertical today.
Your job: filter aggressively to the TOP 5 candidate ideas that are
mobile-app shaped, solo-founder buildable, and show clear pain in the evidence.
Most signals should NOT make the cut. Kill content ideas, enterprise tools,
SaaS dashboards, and anything overlapping Meka's existing portfolio.
${HOUSE_RULES}

Output schema:
{"top5":[{"name":"","one_line":"","target_user":"","pain":"","sources":["url"],"signal_score":1-10}],"discarded":[{"name":"","reason":""}]}`;
  const userMsg = {
    vertical: vertical.name,
    portfolio_to_avoid: MEKA_PORTFOLIO,
    evidence: scoutPacket.evidence.slice(0,18).map(e => ({ title:e.title, url:e.url, snippet:e.snippet }))
  };
  return await callOpenAI(sys, userMsg);
}

/* ---- VOID · Demand validation (per candidate) ---- */
async function agentVoid(candidate, vertical) {
  const sys = `You are V.O.I.D., the demand validation agent.
Given one candidate app idea and its source evidence, score the actual demand.
Be skeptical. If evidence is thin, score LOW and flag validation_risk.
${HOUSE_RULES}

Output schema:
{"name":"","urgency":1-10,"frequency":1-10,"willingness":1-10,"reachability":1-10,"demand_evidence":"one paragraph citing what you saw in the sources","validation_risk":"one sentence","suggested_validation":"one concrete test"}`;
  return await callOpenAI(sys, { vertical: vertical.name, candidate });
}

/* ---- SNIPER · Competitor analysis (per candidate) ---- */
async function agentSniper(candidate, vertical) {
  const sys = `You are S.N.I.P.E.R., the competitor and weak-execution hunter.
Given one candidate app idea and its source URLs, identify existing competitors
mentioned in the evidence, what users hate about them, and the market gap.
Score competition_weakness 1-10 (10 = competitors are very weak).
If entrenched well-executed players (Apple, Google, big-tech) dominate, score LOW.
${HOUSE_RULES}

Output schema:
{"name":"","competitors":[{"name":"","weakness":""}],"poor_execution":"common review complaints","market_gap":"specific underserved wedge","differentiation":"how to win","competition_weakness":1-10,"niche_risk":"one sentence"}`;
  return await callOpenAI(sys, { vertical: vertical.name, candidate });
}

/* ---- BOSS · Narrow (5 → 3) ---- */
async function agentBossNarrow(top5, voidOutputs, sniperOutputs) {
  const sys = `You are B.O.S.S. Narrow the 5 candidates to the top 3 based on
Void's demand scores and Sniper's competition weakness scores. Kill the 2 weakest
with one-sentence reasons. Bias toward strong pain plus weak incumbents.
${HOUSE_RULES}

Output schema:
{"top3":[{"name":"","one_line":"","target_user":"","pain":"","sources":["url"]}],"kills":[{"name":"","why":""},{"name":"","why":""}]}`;
  return await callOpenAI(sys, {
    candidates: top5,
    void_scores: voidOutputs,
    sniper_scores: sniperOutputs
  });
}

/* ---- BLUE · Ugly MVP (per candidate) ---- */
async function agentBlue(candidate) {
  const sys = `You are B.L.U.E., the ugly MVP architect.
Reduce this idea to the smallest testable build. Must-have features only.
Define required screens, data model, third-party APIs, and a 7-day validation
version separate from the 30-day build version.
Score mvp_simplicity 1-10 (10 = trivially simple, 1 = needs a team).
${HOUSE_RULES}

Output schema:
{"name":"","must_have":["feature"],"features_to_avoid":["feature"],"screens":["screen name"],"data_model":"one paragraph","apis":["api name"],"stack_suggestion":"e.g. Swift + Supabase + RevenueCat","complexity":"Low|Medium|High","mvp_simplicity":1-10,"seven_day_version":"one paragraph","thirty_day_version":"one paragraph"}`;
  return await callOpenAI(sys, candidate);
}

/* ---- CASH · Pricing & LTV (per candidate) ---- */
async function agentCash(candidate, sniperData) {
  const sys = `You are C.A.S.H., the pricing and monetization agent.
Model how this app makes money. Reference competitor pricing if Sniper found any.
Suggest tiers, estimate LTV, identify monetization risk, recommend the best first offer.
Score subscription_potential 1-10 and willingness_to_pay 1-10.
${HOUSE_RULES}

Output schema:
{"name":"","revenue_model":"subscription|usage|one-time|B2B|hybrid","pricing_tiers":[{"tier":"Free|Pro|Team","price":"$X/mo or Free","includes":"one sentence"}],"competitor_pricing":"summary","willingness_to_pay":1-10,"revenue_upside":"e.g. $24K MRR at 1K paying users","monetization_risk":"one sentence","best_first_offer":"e.g. first 100 users get 50% off lifetime","subscription_potential":1-10}`;
  return await callOpenAI(sys, { candidate, sniper_context: sniperData });
}

/* ---- VIBE · 7-day validation (per candidate) ---- */
async function agentVibe(candidate) {
  const sys = `You are V.I.B.E., the pre-build validation agent.
Design a 7-day validation plan with concrete copy and kill criteria.
Score marketing_hook_strength 1-10.
${HOUSE_RULES}

Output schema:
{"name":"","landing_headline":"under 12 words","waitlist_copy":"under 80 words","tiktok_hooks":["hook under 25 seconds","hook 2","hook 3"],"reddit_posts":[{"subreddit":"r/...","title":"post title","angle":"one sentence"}],"survey_questions":["q1","q2","q3"],"success_criteria":"concrete numbers, e.g. 50 waitlist signups, 5 willing to pay","kill_criteria":"concrete numbers, e.g. under 20 signups in 7 days","marketing_hook_strength":1-10}`;
  return await callOpenAI(sys, candidate);
}

/* ---- BOSS · Final synthesis ---- */
async function agentBossFinal(vertical, top3, voidOut, sniperOut, blueOut, cashOut, vibeOut, kills, evidenceTitles) {
  const today = new Date().toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric" });
  const sys = `You are B.O.S.S. Synthesize the agent outputs into Meka's morning briefing.
For each of the top 3, compute the weighted score using:
pain 20%, willingness 15%, reachability 15%, mvp_simplicity 15%,
weak_competition 10%, marketing_hook 10%, subscription 10%, founder_fit 5%.

Verdict bands: 8.5+ BUILD, 7.0-8.4 VALIDATE, 5.5-6.9 WATCH, below 5.5 KILL.
You are direct, skeptical, founder-focused. Address Meka as "King Meka" or "Meka".
Most ideas should be killed. That is a feature.

Compute pain_intensity from Void's evidence (if pain was obvious, score high).
founder_fit reflects Meka's strengths: native iOS, solo-builder, AI-first,
project management background, options trader, creator. Score 1-10.

${HOUSE_RULES}

Output schema:
{"date":"${today}","vertical":"${vertical.name}","executive_summary":"under 60 words","top":{"name":"","one_line":"","target_user":"","pain":"","evidence":"","sources":["url","url"],"monetization":"","mvp":"","verdict":"BUILD|VALIDATE|WATCH|KILL","weighted_score":1-10,"scores":{"pain_intensity":1-10,"willingness":1-10,"reachability":1-10,"mvp_simplicity":1-10,"weak_competition":1-10,"marketing_hook":1-10,"subscription":1-10,"founder_fit":1-10}},"ranking":[{"rank":1,"name":"","line":"","score":1-10,"verdict":"","sources":["url"]},{"rank":2,"name":"","line":"","score":1-10,"verdict":"","sources":["url"]},{"rank":3,"name":"","line":"","score":1-10,"verdict":"","sources":["url"]}],"kills":[{"name":"","why":""}],"action_items":["validate this today","post this","do NOT build this yet"]}`;
  const userPayload = {
    vertical: vertical.name,
    top3, void: voidOut, sniper: sniperOut,
    mvp: blueOut, pricing: cashOut, validation: vibeOut,
    kills_so_far: kills,
    evidence_titles: evidenceTitles
  };
  return await callOpenAI(sys, userPayload, "gpt-4o-mini");
}

/* ---- ORCHESTRATOR ---- */
async function generateBriefing(vertical, scoutPacket) {
  if (!scoutPacket.evidence.length) {
    throw new Error("Friday scout packet is empty. Check TAVILY_API_KEY.");
  }

  const usage = {};
  const log = [];
  const evidenceTitles = scoutPacket.evidence.map(e => `${e.title} (${e.url})`);

  // 1. BOSS filters 17 → 5
  log.push("BOSS_FILTER → cutting 17 signals to top 5");
  const filterResp = await agentBossFilter(vertical, scoutPacket);
  usage.boss_filter = filterResp.usage;
  const top5 = filterResp.data.top5 || [];
  if (top5.length === 0) throw new Error("Boss filter returned zero candidates.");

  // 2. PARALLEL: Void + Sniper on each of the top 5
  log.push(`VOID + SNIPER → analyzing ${top5.length} candidates in parallel`);
  const [voidResults, sniperResults] = await Promise.all([
    Promise.all(top5.map(c => agentVoid(c, vertical).catch(e => ({ data:{ name:c.name, error:e.message }})))),
    Promise.all(top5.map(c => agentSniper(c, vertical).catch(e => ({ data:{ name:c.name, error:e.message }}))))
  ]);
  const voidData = voidResults.map(r => r.data);
  const sniperData = sniperResults.map(r => r.data);
  usage.void = voidResults.reduce((s,r) => s + (r.usage?.total_tokens||0), 0);
  usage.sniper = sniperResults.reduce((s,r) => s + (r.usage?.total_tokens||0), 0);

  // 3. BOSS narrows 5 → 3
  log.push("BOSS_NARROW → narrowing 5 to top 3");
  const narrowResp = await agentBossNarrow(top5, voidData, sniperData);
  usage.boss_narrow = narrowResp.usage;
  const top3 = narrowResp.data.top3 || [];
  const earlyKills = narrowResp.data.kills || [];
  if (top3.length === 0) throw new Error("Boss narrow returned zero candidates.");

  // 4. PARALLEL: Blue + Cash + Vibe on each of the top 3
  log.push(`BLUE + CASH + VIBE → engineering and pricing ${top3.length} finalists in parallel`);
  const top3Sniper = top3.map(t => sniperData.find(s => s.name === t.name) || {});
  const [blueResults, cashResults, vibeResults] = await Promise.all([
    Promise.all(top3.map(c => agentBlue(c).catch(e => ({ data:{ name:c.name, error:e.message }})))),
    Promise.all(top3.map((c,i) => agentCash(c, top3Sniper[i]).catch(e => ({ data:{ name:c.name, error:e.message }})))),
    Promise.all(top3.map(c => agentVibe(c).catch(e => ({ data:{ name:c.name, error:e.message }}))))
  ]);
  const blueData = blueResults.map(r => r.data);
  const cashData = cashResults.map(r => r.data);
  const vibeData = vibeResults.map(r => r.data);
  usage.blue = blueResults.reduce((s,r) => s + (r.usage?.total_tokens||0), 0);
  usage.cash = cashResults.reduce((s,r) => s + (r.usage?.total_tokens||0), 0);
  usage.vibe = vibeResults.reduce((s,r) => s + (r.usage?.total_tokens||0), 0);

  // 5. BOSS final synthesis
  log.push("BOSS_FINAL → synthesizing morning briefing");
  const top3Void = top3.map(t => voidData.find(v => v.name === t.name) || {});
  const finalResp = await agentBossFinal(vertical, top3, top3Void, top3Sniper, blueData, cashData, vibeData, earlyKills, evidenceTitles);
  usage.boss_final = finalResp.usage;
  const briefing = finalResp.data;

  // Attach the per-agent reports so the cockpit dossiers / Supabase get the full chain
  briefing.agent_reports = {
    friday: { sources_scouted: scoutPacket.evidence.length, queries_run: scoutPacket.queries.length },
    boss_filter: filterResp.data,
    void: voidData,
    sniper: sniperData,
    boss_narrow: narrowResp.data,
    blue: blueData,
    cash: cashData,
    vibe: vibeData
  };
  briefing.run_log = log;
  briefing.usage = usage;
  briefing.usage_total_tokens = Object.values(usage).reduce((s,v) => s + (typeof v === "number" ? v : (v?.total_tokens||0)), 0);

  return briefing;
}

/* ---------- EMAIL ---------- */
function htmlBriefing(b, scoutPacket) {
  const pill = v => ({ BUILD: "#4dffc2", VALIDATE: "#ffb34d", WATCH: "#1ce8ff", KILL: "#ff3d67" }[v] || "#ccc");
  const safe = s => String(s || "").replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  const sources = (b.top?.sources || []).map(u => `<a href="${safe(u)}" style="color:#1ce8ff;font-size:11px;display:block;padding:2px 0">${safe(u)}</a>`).join("");
  return `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:24px;max-width:680px;margin:auto">
<div style="border:1px solid #1ce8ff;padding:20px;border-radius:6px">
<div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;color:#1ce8ff">B.O.S.S. MORNING VENTURE REPORT</div>
<h1 style="margin:8px 0 4px;font-size:22px">${safe(b.date)}</h1>
<div style="color:#7f9daf;font-size:12px;text-transform:uppercase;letter-spacing:.15em">Vertical: ${safe(b.vertical || "")}</div>
<p style="color:#7f9daf;line-height:1.6;margin-top:10px">${safe(b.executive_summary)}</p>

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#1ce8ff;text-transform:uppercase">Top Opportunity</h2>
<div style="border:1px solid rgba(255,179,77,.35);padding:14px;background:rgba(255,179,77,.06)">
  <div style="font-size:18px;font-weight:900">${safe(b.top.name)}</div>
  <div style="color:#7f9daf;margin:6px 0">${safe(b.top.one_line)}</div>
  <div style="margin-top:8px;font-size:13px"><b>Pain:</b> ${safe(b.top.pain)}</div>
  <div style="font-size:13px"><b>Evidence:</b> ${safe(b.top.evidence)}</div>
  <div style="font-size:13px"><b>Monetization:</b> ${safe(b.top.monetization)}</div>
  <div style="font-size:13px"><b>MVP:</b> ${safe(b.top.mvp)}</div>
  <div style="margin-top:10px">
    <span style="background:${pill(b.top.verdict)};color:#021018;padding:4px 10px;font-family:ui-monospace,monospace;font-weight:900;letter-spacing:.16em">${safe(b.top.verdict)}</span>
    <span style="margin-left:10px;font-family:ui-monospace,monospace;color:#fff">${safe(b.top.weighted_score)} / 10</span>
  </div>
  ${sources ? `<div style="margin-top:12px;padding-top:10px;border-top:1px dashed #1c3d4f"><div style="font-size:10px;color:#425c6d;letter-spacing:.15em;text-transform:uppercase">Sources</div>${sources}</div>` : ""}
</div>

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#1ce8ff;text-transform:uppercase">Top 3 Ranking</h2>
${(b.ranking || []).map(r => `<div style="padding:8px 0;border-bottom:1px solid #1c3d4f"><b>#${r.rank} ${safe(r.name)}</b> - ${safe(r.score)} / 10 - <span style="color:${pill(r.verdict)}">${safe(r.verdict)}</span><div style="color:#7f9daf;font-size:13px">${safe(r.line)}</div></div>`).join("")}

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#ff3d67;text-transform:uppercase">Kill List</h2>
${(b.kills || []).map(k => `<div style="padding:6px 0;color:#7f9daf"><b style="color:#ff3d67">${safe(k.name)}</b>: ${safe(k.why)}</div>`).join("")}

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#4dffc2;text-transform:uppercase">Meka Action Items</h2>
${(b.action_items || []).map(a => `<div style="padding:4px 0">→ ${safe(a)}</div>`).join("")}

<div style="margin-top:24px;padding-top:16px;border-top:1px solid #1c3d4f;color:#425c6d;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em">Friday scouted ${scoutPacket?.evidence?.length || 0} sources from ${scoutPacket?.queries?.length || 0} live web queries. Generated autonomously by B.O.S.S. MekaOps Venture Engine.</div>
</div></body></html>`;
}

async function sendEmail(briefing, scoutPacket) {
  if (!process.env.RESEND_API_KEY || !process.env.REPORT_TO || !process.env.REPORT_FROM) {
    return { sent: false, reason: "Resend not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.REPORT_FROM,
      to: process.env.REPORT_TO,
      subject: `B.O.S.S. Morning Venture Report — ${briefing.date}`,
      html: htmlBriefing(briefing, scoutPacket)
    })
  });
  if (!res.ok) return { sent: false, reason: `Resend ${res.status}: ${await res.text()}` };
  return { sent: true };
}

/* ---------- SUPABASE STORAGE (auto-detect env naming) ----------
   Vercel-Supabase integration in 2025 may inject env vars under several
   prefixes depending on when the project was connected. Try them all. */
function sbUrl(){
  return process.env.SUPABASE_URL
      || process.env.NEXT_PUBLIC_SUPABASE_URL
      || process.env.POSTGRES_URL && null  // postgres direct URL won't work for REST
      || null;
}
function sbServiceKey(){
  return process.env.SUPABASE_SERVICE_ROLE_KEY
      || process.env.SUPABASE_SERVICE_KEY
      || process.env.SUPABASE_KEY
      || null;
}
function sbAnonKey(){
  return process.env.SUPABASE_ANON_KEY
      || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || null;
}

function todayDateUTC(){
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth()+1).padStart(2,"0");
  const day = String(d.getUTCDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}

async function persistBriefing(payload){
  const url = sbUrl();
  const key = sbServiceKey();
  if (!url || !key) return { ok:false, reason:"Supabase URL or service key not set" };

  const briefing = payload.briefing || {};
  const row = {
    date: todayDateUTC(),
    vertical: payload.vertical || briefing.vertical || null,
    top_name: briefing.top?.name || null,
    top_verdict: briefing.top?.verdict || null,
    top_score: briefing.top?.weighted_score || null,
    sources_scouted: payload.sources_scouted || 0,
    sources: payload.sources || [],
    payload: payload,
    generated_at: payload.generated_at || new Date().toISOString()
  };

  // Upsert on date so re-running the same day overwrites instead of erroring
  const res = await fetch(`${url}/rest/v1/briefings?on_conflict=date`, {
    method: "POST",
    headers: {
      "apikey": key,
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal"
    },
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    const errText = await res.text().catch(()=>"");
    return { ok:false, reason:`Supabase ${res.status}: ${errText.slice(0,180)}` };
  }
  return { ok:true };
}

/* ---------- SECRET CHECK (Node.js style) ---------- */
function requireSecret(req) {
  const provided =
    (req.query && req.query.secret) ||
    req.headers["x-cron-secret"] ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // not configured = open
  return provided === expected;
}

/* ---------- HANDLER (Node.js runtime) ---------- */
export default async function handler(req, res) {
  if (!requireSecret(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    }
    const vertical = todayVertical();
    const scoutPacket = await fridayScout(vertical);
    const briefing = await generateBriefing(vertical, scoutPacket);
    const email = await sendEmail(briefing, scoutPacket);
    const payload = {
      ok: true,
      vertical: vertical.name,
      sources_scouted: scoutPacket.evidence.length,
      sources: (scoutPacket.evidence || []).map(e => ({ url: e.url, title: e.title })),
      pipeline_log: briefing.run_log || [],
      usage_total_tokens: briefing.usage_total_tokens || 0,
      briefing,
      email,
      generated_at: new Date().toISOString()
    };
    const persisted = await persistBriefing(payload);
    payload.persisted_to_supabase = persisted.ok;
    if (!persisted.ok) payload.persist_reason = persisted.reason;
    payload.debug_env = {
      has_supabase_url: !!process.env.SUPABASE_URL,
      has_next_public_supabase_url: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      has_service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      has_service_key: !!process.env.SUPABASE_SERVICE_KEY,
      has_anon_key: !!process.env.SUPABASE_ANON_KEY,
      resolved_url: sbUrl() ? "found" : "MISSING",
      resolved_service_key: sbServiceKey() ? "found" : "MISSING"
    };
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, stack: (e.stack||"").split("\n").slice(0,3).join(" | ") });
  }
}
