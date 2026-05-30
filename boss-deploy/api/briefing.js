// /api/briefing  — Vercel serverless function
// Runs autonomously every day at 13:00 UTC (08:00 CDT / 07:00 CST).
// Generates B.O.S.S.'s morning venture briefing via OpenAI and emails it via Resend.
//
// Env vars required (set in Vercel → Settings → Environment Variables):
//   OPENAI_API_KEY        — OpenAI key
//   RESEND_API_KEY        — Resend.com key (free tier)
//   REPORT_TO             — recipient email (e.g. meka.anyanwu@gmail.com)
//   REPORT_FROM           — verified Resend sender (e.g. boss@yourdomain.com)
//   CRON_SECRET           — random string; Vercel sends this automatically to cron path
//
// Manual run from browser: hit /api/briefing?secret=<CRON_SECRET>

export const config = { runtime: "edge" };

const BOSS_SYSTEM = `
You are B.O.S.S. — Because Ordinary Systems Suck — Meka Anyanwu's autonomous venture intelligence.
Tone: Tony Stark caliber. Direct, skeptical, founder-focused, allergic to fluff. Kill weak ideas without hesitation.
Address Meka as "King Meka" or "Meka".

Today, your job is to produce Meka's MekaOps Venture Engine morning report.

You orchestrate 8 agents: Boss (chief decision), Friday (opportunity scout), Sniper (competitor hunter),
Void (demand validator), Blue (ugly MVP architect), Vibe (validation tests), Cash (pricing & LTV),
Tron (telemetry).

Score every idea 1-10 across: pain intensity, willingness to pay, market reachability, MVP simplicity,
competition weakness, marketing hook, subscription potential, founder fit. Weights: pain 20, WTP 15,
reach 15, MVP simplicity 15, weak competition 10, marketing hook 10, subscription 10, founder fit 5.

Verdict bands: 8.5+ = BUILD, 7.0–8.4 = VALIDATE, 5.5–6.9 = WATCH, below 5.5 = KILL.
Most ideas should be killed. That's a feature.

Output STRICT JSON only. No commentary, no markdown. Schema:
{
  "date": "Friday May 30 2026",
  "executive_summary": "string under 60 words",
  "top": {
    "name":"Idea Name",
    "one_line":"...",
    "target_user":"...",
    "pain":"...",
    "evidence":"...",
    "monetization":"$X/mo Pro · $Y/mo Team",
    "mvp":"Low/Med/High - brief scope",
    "verdict":"BUILD|VALIDATE|WATCH|KILL",
    "weighted_score": 8.1,
    "scores":{"pain_intensity":9,"willingness":7,"reachability":8,"mvp_simplicity":8,"weak_competition":8,"marketing_hook":9,"subscription":7,"founder_fit":8}
  },
  "ranking":[
    {"rank":1,"name":"","line":"","score":8.1,"verdict":"VALIDATE"},
    {"rank":2,"name":"","line":"","score":7.4,"verdict":"VALIDATE"},
    {"rank":3,"name":"","line":"","score":6.8,"verdict":"WATCH"}
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
- Never spell out agent acronyms. Say "Friday" not "F dot R dot I dot D dot A dot Y".
- Ideas should be mobile-app shaped, solo-founder buildable, pain-evidenced.
- Don't repeat ideas already in his portfolio (Tradjent, Ru, OutdoorSafe, DAUBED, Quovo, Estimio, Friday OS).
`.trim();

function requireSecret(req) {
  const url = new URL(req.url);
  const provided =
    url.searchParams.get("secret") ||
    req.headers.get("x-cron-secret") ||
    (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const expected = process.env.CRON_SECRET;
  if (!expected) return true; // not configured = open (dev mode)
  return provided === expected;
}

async function generateBriefing() {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const userPrompt = `Generate today's MekaOps Venture Engine briefing for ${today}. Find one painful mobile app problem worth solo-founder validation, two runners-up, and three kills. Be ruthless.`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: BOSS_SYSTEM },
        { role: "user", content: userPrompt }
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 1400
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

function htmlBriefing(b) {
  const pill = v => ({ BUILD:"#4dffc2", VALIDATE:"#ffb34d", WATCH:"#1ce8ff", KILL:"#ff3d67" }[v] || "#ccc");
  const safe = s => String(s||"").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c]);
  return `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:24px;max-width:680px;margin:auto">
<div style="border:1px solid #1ce8ff;padding:20px;border-radius:6px">
<div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;color:#1ce8ff">B.O.S.S. MORNING VENTURE REPORT</div>
<h1 style="margin:8px 0 4px;font-size:22px">${safe(b.date)}</h1>
<p style="color:#7f9daf;line-height:1.6">${safe(b.executive_summary)}</p>

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
</div>

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#1ce8ff;text-transform:uppercase">Top 3 Ranking</h2>
${(b.ranking||[]).map(r=>`<div style="padding:8px 0;border-bottom:1px solid #1c3d4f"><b>#${r.rank} ${safe(r.name)}</b> · ${safe(r.score)} / 10 · <span style="color:${pill(r.verdict)}">${safe(r.verdict)}</span><div style="color:#7f9daf;font-size:13px">${safe(r.line)}</div></div>`).join("")}

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#ff3d67;text-transform:uppercase">Kill List</h2>
${(b.kills||[]).map(k=>`<div style="padding:6px 0;color:#7f9daf"><b style="color:#ff3d67">${safe(k.name)}</b>: ${safe(k.why)}</div>`).join("")}

<h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#4dffc2;text-transform:uppercase">Meka Action Items</h2>
${(b.action_items||[]).map(a=>`<div style="padding:4px 0">→ ${safe(a)}</div>`).join("")}

<div style="margin-top:24px;color:#425c6d;font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.1em">Generated autonomously by B.O.S.S. · MekaOps Venture Engine</div>
</div></body></html>`;
}

async function sendEmail(briefing) {
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
      html: htmlBriefing(briefing)
    })
  });
  if (!res.ok) {
    return { sent: false, reason: `Resend ${res.status}: ${await res.text()}` };
  }
  return { sent: true };
}

export default async function handler(req) {
  if (!requireSecret(req)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "Content-Type": "application/json" }});
  }
  try {
    if (!process.env.OPENAI_API_KEY) {
      return new Response(JSON.stringify({ error: "OPENAI_API_KEY not set" }), { status: 500, headers: { "Content-Type": "application/json" }});
    }
    const briefing = await generateBriefing();
    const email = await sendEmail(briefing);
    return new Response(JSON.stringify({ ok: true, briefing, email }, null, 2), {
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
