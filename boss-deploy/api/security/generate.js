// POST /api/security/generate  (also called by the daily 7am UTC+5 cron)
// Runs V.A.U.L.T. + H.A.W.K. + M.A.C.E. analysis on ops_logs + auth activity.
// Writes one security_reports row + one .txt file. Emails Meka via Resend if configured.

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
      temperature:0.4,
      max_tokens:2400
    })
  });
  if(!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return { data: JSON.parse(j.choices[0].message.content), usage: j.usage };
}

const HOUSE = `NEVER use em dashes. Never spell acronyms. Plain prose. Strict JSON only.
You are reading real ops_logs from this system. Don't invent failures that aren't in the data. If everything is green, say so confidently.`;

const SYSTEM = `You are the Security & Reliability triumvirate for B.O.S.S. Operating System.

ROLES:
- V.A.U.L.T. owns Authentication & Access (failed logins, RLS policies, exposed secrets, role permissions)
- H.A.W.K. owns Anomaly Detection (API spikes, agent loops, cost anomalies, prompt injection attempts, abnormal traffic)
- M.A.C.E. owns Mitigation & Incident Response (recommended fixes, rate limits, validation, backup/recovery)

You receive the last 7 days of ops_logs and auth activity from Meka's system. Produce ONE unified security report.

${HOUSE}

Output schema:
{
  "overall_rating": "GREEN | YELLOW | RED",
  "health_score": 0-100,
  "safe_to_operate": true,
  "escalate_to_meka": false,
  "executive_summary": "under 80 words",
  "authentication": {
    "status": "GREEN|YELLOW|RED",
    "failed_logins_24h": 0,
    "suspicious_patterns": [],
    "rls_status": "enforced|partial|missing",
    "exposed_secrets_check": "clean|warning|critical",
    "notes": "one paragraph"
  },
  "api_anomalies": {
    "status": "GREEN|YELLOW|RED",
    "api_calls_24h": 0,
    "api_cost_estimate_usd": 0,
    "spikes_detected": [],
    "rate_limit_concerns": "none|some|many",
    "notes": "one paragraph"
  },
  "agent_workflow": {
    "status": "GREEN|YELLOW|RED",
    "runs_24h": 0,
    "failures_24h": 0,
    "stuck_or_looping": [],
    "low_confidence_outputs": 0,
    "notes": "one paragraph"
  },
  "infrastructure": {
    "status": "GREEN|YELLOW|RED",
    "database": "healthy|degraded|down",
    "email_delivery": "healthy|degraded|down",
    "cron_schedule": "healthy|degraded|down",
    "dashboard": "healthy|degraded|down",
    "notes": "one paragraph"
  },
  "threats": {
    "status": "GREEN|YELLOW|RED",
    "prompt_injection_attempts": 0,
    "suspicious_uploads": 0,
    "endpoint_abuse": 0,
    "unauthorized_access": 0,
    "notes": "one paragraph"
  },
  "bugs": {
    "status": "GREEN|YELLOW|RED",
    "broken_flows": [],
    "failed_exports": 0,
    "data_sync_issues": [],
    "notes": "one paragraph"
  },
  "recommended_fixes": [
    {"priority":"critical|high|medium|low","fix":"","owner":"MACE"}
  ],
  "incident_log": [
    {"status":"new|ongoing|resolved","title":"","detail":""}
  ],
  "final_verdict": "string under 40 words combining the above"
}`;

function divider(t){ return `\n${"=".repeat(64)}\n${t.toUpperCase()}\n${"=".repeat(64)}\n`; }
function fmtList(arr, prefix="- "){
  if(!Array.isArray(arr) || arr.length === 0) return "(none)";
  return arr.map(x => prefix + (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
}
function colorWord(s){ return ({GREEN:"●",YELLOW:"◐",RED:"○",healthy:"●",degraded:"◐",down:"○",enforced:"●",clean:"●"})[s] || "·"; }

function formatTxt(c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · SECURITY & RELIABILITY REPORT
================================================================

Date:           ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Generated:      ${new Date().toISOString()}
Overall:        ${colorWord(c.overall_rating)} ${c.overall_rating}
Health score:   ${c.health_score} / 100
Safe to op:     ${c.safe_to_operate ? "YES" : "NO"}
Escalate Meka:  ${c.escalate_to_meka ? "YES" : "no"}
Compiled by:    T.R.O.N. with V.A.U.L.T. · H.A.W.K. · M.A.C.E.
`,
divider("Executive Security Summary"),
c.executive_summary || "(none)",
divider("1. Authentication & Access · V.A.U.L.T."),
`Status: ${colorWord(c.authentication?.status)} ${c.authentication?.status}
Failed logins 24h:  ${c.authentication?.failed_logins_24h ?? 0}
RLS:                ${c.authentication?.rls_status || "—"}
Secret exposure:    ${c.authentication?.exposed_secrets_check || "—"}
Suspicious:         ${fmtList(c.authentication?.suspicious_patterns, "  • ")}
${c.authentication?.notes || ""}`,
divider("2. API & Cost Anomalies · H.A.W.K."),
`Status: ${colorWord(c.api_anomalies?.status)} ${c.api_anomalies?.status}
API calls 24h:      ${c.api_anomalies?.api_calls_24h ?? 0}
Cost estimate:      $${(c.api_anomalies?.api_cost_estimate_usd ?? 0).toFixed(3)}
Rate limit:         ${c.api_anomalies?.rate_limit_concerns || "—"}
Spikes:             ${fmtList(c.api_anomalies?.spikes_detected, "  • ")}
${c.api_anomalies?.notes || ""}`,
divider("3. Agent Workflow Health · H.A.W.K."),
`Status: ${colorWord(c.agent_workflow?.status)} ${c.agent_workflow?.status}
Runs 24h:           ${c.agent_workflow?.runs_24h ?? 0}
Failures 24h:       ${c.agent_workflow?.failures_24h ?? 0}
Stuck/looping:      ${fmtList(c.agent_workflow?.stuck_or_looping, "  • ")}
Low confidence:     ${c.agent_workflow?.low_confidence_outputs ?? 0}
${c.agent_workflow?.notes || ""}`,
divider("4. Infrastructure Health"),
`Status: ${colorWord(c.infrastructure?.status)} ${c.infrastructure?.status}
Database:           ${c.infrastructure?.database || "—"}
Email delivery:     ${c.infrastructure?.email_delivery || "—"}
Cron schedule:      ${c.infrastructure?.cron_schedule || "—"}
Dashboard:          ${c.infrastructure?.dashboard || "—"}
${c.infrastructure?.notes || ""}`,
divider("5. Threats & Suspicious Behavior · H.A.W.K."),
`Status: ${colorWord(c.threats?.status)} ${c.threats?.status}
Prompt injection:   ${c.threats?.prompt_injection_attempts ?? 0}
Suspicious uploads: ${c.threats?.suspicious_uploads ?? 0}
Endpoint abuse:     ${c.threats?.endpoint_abuse ?? 0}
Unauthorized:       ${c.threats?.unauthorized_access ?? 0}
${c.threats?.notes || ""}`,
divider("6. Bugs & Glitches"),
`Status: ${colorWord(c.bugs?.status)} ${c.bugs?.status}
Broken flows:       ${fmtList(c.bugs?.broken_flows, "  • ")}
Failed exports:     ${c.bugs?.failed_exports ?? 0}
Data sync issues:   ${fmtList(c.bugs?.data_sync_issues, "  • ")}
${c.bugs?.notes || ""}`,
divider("7. Recommended Fixes · M.A.C.E."),
(c.recommended_fixes||[]).length
  ? c.recommended_fixes.map(f => `[${f.priority.toUpperCase()}] ${f.fix} (owner: ${f.owner})`).join("\n")
  : "(no fixes recommended — system is clean)",
divider("8. Incident Log"),
(c.incident_log||[]).length
  ? c.incident_log.map(i => `[${i.status}] ${i.title}\n  ${i.detail}`).join("\n\n")
  : "(no open incidents)",
divider("9. Final Verdict"),
c.final_verdict || "(none)",
`\n\n--- END OF SECURITY REPORT ---\nGenerated by B.O.S.S. Operating System · V.A.U.L.T. · H.A.W.K. · M.A.C.E.`
  ].join("\n");
}

async function sendEmail(report){
  if(!process.env.RESEND_API_KEY || !process.env.REPORT_TO || !process.env.REPORT_FROM) return { sent:false };
  const ratingColor = { GREEN:"#4dffc2", YELLOW:"#ffb34d", RED:"#ff3d67" }[report.overall_rating] || "#1ce8ff";
  const html = `<!doctype html><html><body style="font-family:Inter,system-ui,sans-serif;background:#02040b;color:#e6fbff;padding:24px;max-width:680px;margin:auto">
<div style="border:1px solid #1ce8ff;padding:22px">
  <div style="font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.2em;color:#1ce8ff">B.O.S.S. SECURITY & RELIABILITY REPORT · 7AM CT</div>
  <h1 style="margin:8px 0 4px;font-size:22px">${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric"})}</h1>
  <div style="margin-top:10px"><span style="background:${ratingColor};color:#021018;padding:5px 14px;font-family:ui-monospace,monospace;font-weight:900;letter-spacing:.18em">${report.overall_rating}</span> <span style="margin-left:12px;color:#fff">${report.health_score}/100</span></div>
  <p style="margin-top:14px;color:#e6fbff;line-height:1.55">${report.executive_summary||""}</p>
  <h2 style="margin-top:18px;font-size:13px;letter-spacing:.18em;color:#ffb34d;text-transform:uppercase">Recommended fixes</h2>
  ${(report.recommended_fixes||[]).map(f=>`<div style="padding:5px 0;color:#7f9daf;font-size:13px">[${f.priority}] ${f.fix}</div>`).join("") || "<div style='color:#7f9daf'>(none — system clean)</div>"}
  <h2 style="margin-top:18px;font-size:13px;letter-spacing:.18em;color:#ff3d67;text-transform:uppercase">Open incidents</h2>
  ${(report.incident_log||[]).filter(i=>i.status!=="resolved").map(i=>`<div style="padding:5px 0;color:#7f9daf;font-size:13px">${i.title}</div>`).join("") || "<div style='color:#7f9daf'>(none)</div>"}
  <div style="margin-top:18px;padding-top:14px;border-top:1px solid #1c3d4f;font-style:italic;color:#7f9daf;font-size:12px">${report.final_verdict||""}</div>
</div></body></html>`;
  const r = await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{ "Authorization":`Bearer ${process.env.RESEND_API_KEY}`, "Content-Type":"application/json" },
    body: JSON.stringify({
      from: process.env.REPORT_FROM,
      to: process.env.REPORT_TO,
      subject: `B.O.S.S. Security ${report.overall_rating} · ${new Date().toLocaleDateString("en-US",{month:"short",day:"numeric"})}`,
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

export default async function handler(req, res){
  if(!requireSecret(req)) return res.status(401).json({ error:"unauthorized" });
  try {
    if(!process.env.OPENAI_API_KEY) return res.status(500).json({ error:"OPENAI_API_KEY not set" });

    // Gather real ops data the agents will analyze
    const since = new Date(Date.now() - 7*86400_000).toISOString();
    const [opsLogs, recentAuth, briefingCount, projectCount] = await Promise.all([
      sbQuery(`ops_logs?run_date=gte.${since}&order=run_date.desc&limit=200`).catch(()=>[]),
      sbQuery(`auth_codes?created_at=gte.${since}&order=created_at.desc&limit=50&select=email,used,expires_at,created_at,ip`).catch(()=>[]),
      sbQuery(`briefings?date=gte.${since.slice(0,10)}&select=id,date,top_verdict`).catch(()=>[]),
      sbQuery(`projects?created_at=gte.${since}&select=id,name,status`).catch(()=>[])
    ]);

    const failures = opsLogs.filter(l => l.status === "failed");
    const totalTokens = opsLogs.reduce((s,l)=> s + (l.tokens_used||0), 0);
    const totalCost = opsLogs.reduce((s,l)=> s + Number(l.api_cost_estimate||0), 0);
    const failedAuth = recentAuth.filter(a => !a.used && new Date(a.expires_at) < new Date()).length;

    const payload = {
      window: "last 7 days",
      ops_logs_count: opsLogs.length,
      ops_failures: failures.length,
      recent_actions: [...new Set(opsLogs.slice(0,30).map(l => l.action))],
      total_tokens_7d: totalTokens,
      total_api_cost_estimate_usd: Number(totalCost.toFixed(4)),
      auth_attempts_7d: recentAuth.length,
      failed_or_expired_codes: failedAuth,
      briefings_generated_7d: briefingCount.length,
      projects_created_7d: projectCount.length,
      sample_failure_messages: failures.slice(0,5).map(f => f.error_message).filter(Boolean)
    };

    const t0 = Date.now();
    const llm = await callOpenAI(SYSTEM, payload);
    const elapsed = Date.now() - t0;
    const report = llm.data;

    // Persist
    const row = await sbInsert("security_reports", {
      report_date: new Date().toISOString().slice(0,10),
      overall_rating: report.overall_rating,
      health_score: report.health_score,
      exec_summary: report.executive_summary,
      authentication: report.authentication,
      api_anomalies: report.api_anomalies,
      agent_workflow: report.agent_workflow,
      infrastructure: report.infrastructure,
      threats: report.threats,
      bugs: report.bugs,
      recommended_fixes: report.recommended_fixes,
      incident_log: report.incident_log,
      safe_to_operate: !!report.safe_to_operate,
      escalate_to_meka: !!report.escalate_to_meka,
      full_payload: report
    });

    // Generate .txt
    const txt = formatTxt(report);
    const fileName = `06_security_reliability_${new Date().toISOString().slice(0,10)}.txt`;
    const fileRow = await sbInsert("generated_files", {
      file_name: fileName,
      file_type: "security",
      content: txt,
      dept_id: "sec",
      agent_id: "VAULT"
    });

    // Email
    const email = await sendEmail(report);

    // Ops log
    try {
      await sbInsert("ops_logs", {
        agent_id: "VAULT", dept_id: "sec",
        action: "security_report", status: "completed",
        duration_ms: elapsed, tokens_used: llm.usage?.total_tokens || 0,
        api_cost_estimate: ((llm.usage?.total_tokens || 0) / 1e6) * 0.15,
        payload: { report_id: row.id, file_id: fileRow.id, rating: report.overall_rating }
      });
    } catch(_) {}

    return res.status(200).json({
      ok: true,
      report_id: row.id,
      file_id: fileRow.id,
      file_name: fileName,
      rating: report.overall_rating,
      health_score: report.health_score,
      email,
      summary: report.executive_summary,
      tokens: llm.usage?.total_tokens || 0
    });
  } catch(e){
    return res.status(500).json({ error: e.message });
  }
}
