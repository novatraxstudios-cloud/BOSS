// /api/digest — weekly venture digest.
// Cron fires Sunday 14:00 UTC. Aggregates last 7 days of briefings, synthesizes
// a weekly review via OpenAI, emails it via Resend.

export const config = { runtime: "nodejs" };
export const maxDuration = 60;

function sbUrl(){return process.env.SUPABASE_URL||process.env.NEXT_PUBLIC_SUPABASE_URL||null;}
function sbKey(){return process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_ANON_KEY||process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY||null;}

function requireSecret(req){
  const provided = (req.query?.secret) || req.headers["x-cron-secret"] || "";
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return provided === expected;
}

async function callOpenAI(systemPrompt, userPayload) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({
      model:"gpt-4o-mini",
      messages:[
        {role:"system",content:systemPrompt},
        {role:"user",content:JSON.stringify(userPayload)}
      ],
      response_format:{type:"json_object"},
      temperature:0.5,
      max_tokens:1800
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

function digestHtml(d){
  const safe = s => String(s||"").replace(/[<>&]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;"})[c]);
  const pill = v => ({BUILD:"#4dffc2",VALIDATE:"#ffb34d",WATCH:"#1ce8ff",KILL:"#ff3d67"})[v]||"#ccc";
  return `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:24px;max-width:680px;margin:auto">
<div style="border:1px solid #1ce8ff;padding:22px">
  <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;color:#1ce8ff">B.O.S.S. WEEKLY VENTURE DIGEST</div>
  <h1 style="margin:8px 0 4px;font-size:22px">${safe(d.week_of||"This Week")}</h1>
  <p style="color:#7f9daf;line-height:1.6">${safe(d.executive_summary)}</p>

  <h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#1ce8ff;text-transform:uppercase">Best of the Week</h2>
  <div style="border:1px solid rgba(255,179,77,.4);padding:14px;background:rgba(255,179,77,.06);margin-top:10px">
    <div style="font-size:18px;font-weight:900">${safe(d.best_of_week?.name)}</div>
    <div style="color:#7f9daf;margin:4px 0">${safe(d.best_of_week?.why)}</div>
    <span style="background:${pill(d.best_of_week?.verdict)};color:#021018;padding:4px 10px;font-family:ui-monospace,monospace;font-weight:900;letter-spacing:.15em">${safe(d.best_of_week?.verdict)}</span>
  </div>

  <h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#4dffc2;text-transform:uppercase">Patterns &amp; Themes</h2>
  ${(d.patterns||[]).map(p=>`<div style="padding:6px 0"><b>${safe(p.theme)}</b>: <span style="color:#7f9daf">${safe(p.detail)}</span></div>`).join("")}

  <h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#ff3d67;text-transform:uppercase">What Got Killed</h2>
  ${(d.killed||[]).map(k=>`<div style="padding:4px 0;color:#7f9daf">✕ ${safe(k.name)}</div>`).join("")}

  <h2 style="margin-top:24px;font-size:14px;letter-spacing:.2em;color:#ffb34d;text-transform:uppercase">Next Week's Plays</h2>
  ${(d.next_week_actions||[]).map(a=>`<div style="padding:4px 0">→ ${safe(a)}</div>`).join("")}

  <div style="margin-top:24px;padding-top:14px;border-top:1px solid #1c3d4f;color:#425c6d;font-family:ui-monospace,monospace;font-size:10px">
    ${d.stats?.total||0} briefings · ${d.stats?.build||0} BUILD · ${d.stats?.validate||0} VALIDATE · ${d.stats?.watch||0} WATCH · ${d.stats?.kill||0} KILL
  </div>
</div></body></html>`;
}

async function sendEmail(d){
  if (!process.env.RESEND_API_KEY||!process.env.REPORT_TO||!process.env.REPORT_FROM) return {sent:false,reason:"Resend not configured"};
  const r = await fetch("https://api.resend.com/emails", {
    method:"POST",
    headers:{"Authorization":`Bearer ${process.env.RESEND_API_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({
      from: process.env.REPORT_FROM,
      to: process.env.REPORT_TO,
      subject: `B.O.S.S. Weekly Venture Digest — ${d.week_of||"This Week"}`,
      html: digestHtml(d)
    })
  });
  if (!r.ok) return {sent:false,reason:`Resend ${r.status}`};
  return {sent:true};
}

export default async function handler(req,res){
  if (!requireSecret(req)) return res.status(401).json({error:"unauthorized"});
  try {
    const url = sbUrl(), key = sbKey();
    if (!url || !key) return res.status(500).json({error:"Supabase not configured"});
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:"OPENAI_API_KEY not set"});

    // Pull last 7 days of briefings
    const sinceDate = new Date(Date.now() - 7*86400_000).toISOString().slice(0,10);
    const r = await fetch(`${url}/rest/v1/briefings?date=gte.${sinceDate}&order=generated_at.desc&limit=50`, {
      headers:{apikey:key, Authorization:`Bearer ${key}`}
    });
    if (!r.ok) throw new Error(`Supabase ${r.status}`);
    const rows = await r.json();
    if (!rows.length) return res.status(200).json({ok:true,reason:"no briefings this week",rows:0});

    const stats = {total:rows.length,build:0,validate:0,watch:0,kill:0};
    for (const row of rows) {
      const v = (row.top_verdict||"").toUpperCase();
      if (v==="BUILD") stats.build++;
      if (v==="VALIDATE") stats.validate++;
      if (v==="WATCH") stats.watch++;
      if (v==="KILL") stats.kill++;
    }

    const summary = rows.map(row=>{
      const br = row.payload?.briefing || {};
      return {
        date: row.date,
        vertical: row.vertical,
        top: row.top_name,
        verdict: row.top_verdict,
        score: row.top_score,
        one_line: br.top?.one_line,
        kills: (br.kills||[]).map(k=>k.name)
      };
    });

    const sys = `You are B.O.S.S. running the WEEKLY DIGEST.
After 7 days of daily venture briefings, synthesize the patterns Meka should see.
Pick the single strongest opportunity of the week. Identify cross-cutting themes.
Recommend 3 concrete actions for next week.

NEVER use em dashes. Plain prose. Strict JSON.

Output: {"week_of":"e.g. May 24 to May 30","executive_summary":"under 80 words","best_of_week":{"name":"","why":"","verdict":""},"patterns":[{"theme":"","detail":""},{"theme":"","detail":""},{"theme":"","detail":""}],"killed":[{"name":""}],"next_week_actions":["","",""],"stats":{"total":0,"build":0,"validate":0,"watch":0,"kill":0}}`;

    const digest = await callOpenAI(sys, { briefings: summary, stats });
    digest.stats = stats;
    const email = await sendEmail(digest);

    return res.status(200).json({ok:true,stats,digest,email,briefings_analyzed:rows.length});
  } catch (e) {
    return res.status(500).json({error:e.message});
  }
}
