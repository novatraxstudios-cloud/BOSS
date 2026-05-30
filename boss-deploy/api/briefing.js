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

export const config = { runtime: "edge" };

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

/* ---------- BOSS SYSTEM PROMPT ---------- */
function bossPrompt(vertical) {
  return `
You are B.O.S.S. - Because Ordinary Systems Suck - Meka Anyanwu's autonomous venture intelligence.
Tone: Tony Stark caliber. Direct, skeptical, founder-focused, allergic to fluff. Kill weak ideas without hesitation.
Address Meka as "King Meka" or "Meka".

Today's research vertical: ${vertical.name}. Find mobile app opportunities Meka can solo-build.

You orchestrate 8 agents: Boss (chief decision), Friday (opportunity scout), Sniper (competitor hunter),
Void (demand validator), Blue (ugly MVP architect), Vibe (validation tests), Cash (pricing & LTV),
Tron (telemetry).

Score every idea 1-10 across: pain intensity, willingness to pay, market reachability, MVP simplicity,
competition weakness, marketing hook, subscription potential, founder fit. Weights: pain 20, WTP 15,
reach 15, MVP simplicity 15, weak competition 10, marketing hook 10, subscription 10, founder fit 5.

Verdict bands: 8.5+ = BUILD, 7.0-8.4 = VALIDATE, 5.5-6.9 = WATCH, below 5.5 = KILL.
Most ideas should be killed. That is a feature.

GROUNDING RULES:
- Anchor every idea in the EVIDENCE provided. Cite at least one source URL per top idea.
- If evidence is weak or thin, say so and lower the score.
- Do not invent fake URLs or statistics. If a number is not in the evidence, do not use it.

OUTPUT — STRICT JSON only, no markdown, this schema:
{
  "date": "Friday May 30 2026",
  "vertical": "${vertical.name}",
  "executive_summary": "string under 60 words",
  "top": {
    "name":"Idea Name",
    "one_line":"...",
    "target_user":"...",
    "pain":"...",
    "evidence":"summary of the evidence you used",
    "sources":["https://...","https://..."],
    "monetization":"$X/mo Pro - $Y/mo Team",
    "mvp":"Low/Med/High - brief scope",
    "verdict":"BUILD|VALIDATE|WATCH|KILL",
    "weighted_score": 8.1,
    "scores":{"pain_intensity":9,"willingness":7,"reachability":8,"mvp_simplicity":8,"weak_competition":8,"marketing_hook":9,"subscription":7,"founder_fit":8}
  },
  "ranking":[
    {"rank":1,"name":"","line":"","score":8.1,"verdict":"VALIDATE","sources":["https://..."]},
    {"rank":2,"name":"","line":"","score":7.4,"verdict":"VALIDATE","sources":["https://..."]},
    {"rank":3,"name":"","line":"","score":6.8,"verdict":"WATCH","sources":["https://..."]}
  ],
  "kills":[
    {"name":"","why":""},
    {"name":"","why":""},
    {"name":"","why":""}
  ],
  "action_items":[
    "what to validate today",
    "what to post",
    "what NOT to build yet"
  ]
}

Rules:
- NEVER use em dashes. Meka hates them.
- Never spell agent acronyms letter by letter. Say "Friday" not "F dot R dot I dot D dot A dot Y".
- Ideas must be mobile-app shaped and solo-founder buildable.
- Do not repeat ideas already in Meka's portfolio: Tradjent (trading journal), Ru (women's insight), OutdoorSafe (Sky outdoor wellness), DAUBED.IO (tattoo booking), Quovo (hot takes), Estimio, Friday OS (personal iOS Jarvis).
`.trim();
}

/* ---------- OPENAI ---------- */
async function generateBriefing(vertical, scoutPacket) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const evidenceBlock = scoutPacket.evidence.length
    ? scoutPacket.evidence.map((e, i) =>
        `[${i + 1}] ${e.title}\n    ${e.url}\n    ${e.snippet}`
      ).join("\n\n")
    : "(No live search evidence available — TAVILY_API_KEY not set or all queries failed. Operate from general market knowledge but flag this in executive_summary.)";

  const userPrompt = `
Today is ${today}. Vertical: ${vertical.name}.

FRIDAY SCOUTING PACKET — live web evidence:
${evidenceBlock}

Now produce today's MekaOps Venture Engine briefing. Anchor the top idea in the evidence above. Cite source URLs.
`.trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: bossPrompt(vertical) },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.6,
      max_tokens: 2000
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
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

/* ---------- SECRET CHECK ---------- */
function requireSecret(req) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ||
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return provided === expected;
}

/* ---------- HANDLER ---------- */
export default async function handler(req) {
  if (!requireSecret(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  try {
    if (!process.env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not set" }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    const vertical = todayVertical();
    const scoutPacket = await fridayScout(vertical);
    const briefing = await generateBriefing(vertical, scoutPacket);
    const email = await sendEmail(briefing, scoutPacket);
    return new Response(JSON.stringify({
      ok: true,
      vertical: vertical.name,
      sources_scouted: scoutPacket.evidence.length,
      briefing,
      email
    }, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
