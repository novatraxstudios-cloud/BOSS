// POST /api/marketing/generate
// Body: { project_id, doc_type }   doc_type ∈ { 'positioning' | 'acquisition' | 'community' | 'calendar' }
// Runs H.A.L.O. / A.U.R.A. / E.C.H.O. / D.A.S.H., persists marketing_documents + generated_files.

export const config = { runtime: "nodejs" };
export const maxDuration = 60;

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }

async function sbQuery(query){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${query}`, { headers: { "apikey": key, "Authorization": `Bearer ${key}` } });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  return await r.json();
}
async function sbInsert(table, row){
  const url = sbUrl(), key = sbKey();
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: { "apikey": key, "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Prefer": "return=representation" },
    body: JSON.stringify(row)
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0,180)}`);
  const arr = await r.json();
  return arr[0] || arr;
}

async function callOpenAI(systemPrompt, userPayload, maxTokens=2200){
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.55,
      max_tokens: maxTokens
    })
  });
  if(!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return { data: JSON.parse(j.choices[0].message.content), usage: j.usage };
}

const HOUSE = `NEVER use em dashes. Never spell acronyms. Plain prose. Strict JSON only.
NO BUDGET MARKETING ONLY: founder-led UGC, pain-based hooks, Reddit/community validation, waitlist, demo videos, direct response. No paid ads, no influencer spend before message-market fit.
Cannot post, DM, launch ads, or spend money without Meka's approval.`;

const PROMPTS = {
  positioning: {
    agent: "HALO", dept: "mkt", fileNum: "05a", filePrefix: "marketing_positioning",
    title: "Positioning & Offer",
    system: `You are H.A.L.O., Meka's Brand and Positioning agent. Create the sharpest market message. Target customer, main pain, main enemy, one-liner, tagline, launch offer, landing page headline, app store positioning, brand voice. Be opinionated.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "target_customer": {"primary":"","secondary":""},
  "main_pain": "",
  "main_enemy": "the frustration / competitor mindset users want to escape",
  "main_promise": "",
  "one_liner": "under 12 words",
  "tagline": "under 6 words",
  "positioning_statement": "for [X] who [need], [product] is [category] that [benefit] unlike [alternative] because [why]",
  "launch_offer": "",
  "landing_page_headline": "under 12 words",
  "landing_page_subhead": "under 20 words",
  "app_store_positioning": "",
  "brand_voice": {"tone":"","do":["",""],"do_not":["",""]},
  "why_switch": "the moment a user realizes they need this",
  "messaging_dos": [""],
  "messaging_donts": [""]
}`
  },
  acquisition: {
    agent: "AURA", dept: "mkt", fileNum: "05b", filePrefix: "marketing_acquisition",
    title: "Acquisition & Retention Plan",
    system: `You are A.U.R.A., Meka's Acquisition and Retention agent. No-budget growth plan. Find best organic channels, waitlist strategy, referral loops, activation moments, retention hooks, lifecycle ideas.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "channels": [{"channel":"","priority":1-5,"why":"","first_test":""}],
  "no_budget_growth_strategy": "one paragraph",
  "waitlist_strategy": {"goal":"","incentive":"","viral_hook":""},
  "referral_loop": "one paragraph",
  "activation_moment": "the specific event that means a user 'got it'",
  "retention_hooks": ["",""],
  "lifecycle_emails": [{"trigger":"","timing":"","subject":"","intent":""}],
  "growth_experiments": [{"hypothesis":"","test":"","success":"","kill":""}],
  "launch_funnel": ["",""]
}`
  },
  community: {
    agent: "ECHO", dept: "mkt", fileNum: "05c", filePrefix: "marketing_community_ugc",
    title: "Community & UGC Plan",
    system: `You are E.C.H.O., Meka's Community and Social Proof agent. Find relevant communities. Draft posts. Extract customer language. Generate UGC scripts.
GUARDRAIL: cannot post, comment, or DM real users without Meka's approval. Draft only.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "community_targets": [{"name":"e.g. r/HomeImprovement","platform":"reddit|facebook|discord|other","why":"","rules_risk":"low|medium|high"}],
  "reddit_posts": [{"subreddit":"","title":"","body":"under 200 words","approval_required":true,"question_hook":""}],
  "ugc_scripts": [{"slot":1,"hook":"under 25s","problem":"","personal_moment":"","app_reveal":"","demo":"","benefit":"","cta":"","caption":"","hashtags":["",""]}],
  "objections_to_handle": [{"objection":"","response":""}],
  "customer_language_bank": ["phrases real users say",""],
  "social_proof_angles": ["",""],
  "outcome_based_content_ideas": [""]
}`
  },
  calendar: {
    agent: "DASH", dept: "mkt", fileNum: "05d", filePrefix: "marketing_30day_calendar",
    title: "30-Day Launch Calendar & Analytics",
    system: `You are D.A.S.H., Meka's Marketing Analytics agent collaborating on the launch calendar. Build a 30-day plan in 4 weekly themes plus the KPI dashboard.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "calendar": [
    {"week":1,"theme":"awareness + validation","posts":[{"day":1,"channel":"","content_type":"","topic":"","cta":""}]},
    {"week":2,"theme":"waitlist + demo","posts":[]},
    {"week":3,"theme":"beta + proof","posts":[]},
    {"week":4,"theme":"launch + conversion","posts":[]}
  ],
  "kpis": [{"kpi":"","target":"","measurement":""}],
  "funnel_stages": [{"stage":"","metric":"","good":"","bad":""}],
  "kill_criteria": "concrete numbers for stopping a channel",
  "double_down_criteria": "concrete numbers for scaling a channel",
  "weekly_reporting_rhythm": "what to report each Friday"
}`
  }
};

function divider(title){
  const line = "=".repeat(64);
  return `\n${line}\n${title.toUpperCase()}\n${line}\n`;
}
function fmtList(arr, prefix="- "){
  if(!Array.isArray(arr) || arr.length === 0) return "(none)";
  return arr.map(x => prefix + (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
}

function formatPositioning(project, c){
  const bv = c.brand_voice || {};
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · POSITIONING & OFFER
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      H.A.L.O. · Marketing & Growth
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Target Customer"),
`Primary:   ${c.target_customer?.primary || "—"}\nSecondary: ${c.target_customer?.secondary || "—"}`,
divider("Pain · Enemy · Promise"),
`Main pain:    ${c.main_pain || "—"}\nMain enemy:   ${c.main_enemy || "—"}\nMain promise: ${c.main_promise || "—"}`,
divider("One-liner"),
c.one_liner || "(none)",
divider("Tagline"),
c.tagline || "(none)",
divider("Positioning Statement"),
c.positioning_statement || "(none)",
divider("Launch Offer"),
c.launch_offer || "(none)",
divider("Landing Page"),
`Headline: ${c.landing_page_headline || "—"}\nSubhead:  ${c.landing_page_subhead || "—"}`,
divider("App Store Positioning"),
c.app_store_positioning || "(none)",
divider("Brand Voice"),
`Tone: ${bv.tone || "—"}\nDo:\n${fmtList(bv.do, "  • ")}\nDo NOT:\n${fmtList(bv.do_not, "  • ")}`,
divider("Why Switch"),
c.why_switch || "(none)",
divider("Messaging Dos"),
fmtList(c.messaging_dos),
divider("Messaging Don'ts"),
fmtList(c.messaging_donts),
`\n\n--- END OF POSITIONING ---\nGenerated by B.O.S.S. Operating System · H.A.L.O.`
  ].join("\n");
}

function formatAcquisition(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · ACQUISITION & RETENTION PLAN
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      A.U.R.A. · Marketing & Growth
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Channels (priority order)"),
(c.channels||[]).map(ch => `[P${ch.priority}] ${ch.channel}\n  Why: ${ch.why}\n  First test: ${ch.first_test}`).join("\n\n") || "(none)",
divider("No-Budget Growth Strategy"),
c.no_budget_growth_strategy || "(none)",
divider("Waitlist Strategy"),
`Goal:       ${c.waitlist_strategy?.goal || "—"}
Incentive:  ${c.waitlist_strategy?.incentive || "—"}
Viral hook: ${c.waitlist_strategy?.viral_hook || "—"}`,
divider("Referral Loop"),
c.referral_loop || "(none)",
divider("Activation Moment"),
c.activation_moment || "(none)",
divider("Retention Hooks"),
fmtList(c.retention_hooks),
divider("Lifecycle Emails"),
(c.lifecycle_emails||[]).map(e => `[${e.trigger}] (${e.timing})\n  Subject: ${e.subject}\n  Intent:  ${e.intent}`).join("\n\n") || "(none)",
divider("Growth Experiments"),
(c.growth_experiments||[]).map(g => `Hypothesis: ${g.hypothesis}\n  Test:    ${g.test}\n  Success: ${g.success}\n  Kill:    ${g.kill}`).join("\n\n") || "(none)",
divider("Launch Funnel"),
fmtList(c.launch_funnel),
`\n\n--- END OF ACQUISITION ---\nGenerated by B.O.S.S. Operating System · A.U.R.A.`
  ].join("\n");
}

function formatCommunity(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · COMMUNITY & UGC PLAN
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      E.C.H.O. · Marketing & Growth
GUARDRAIL:  All posts require Meka's approval before publishing.
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Community Targets"),
(c.community_targets||[]).map(t => `${t.name} [${t.platform}]\n  Why: ${t.why}\n  Rules risk: ${t.rules_risk}`).join("\n\n") || "(none)",
divider("Reddit Post Drafts"),
(c.reddit_posts||[]).map(p => `[${p.subreddit}] APPROVAL REQUIRED: ${p.approval_required ? "YES" : "no"}\n  Title: ${p.title}\n  Body:\n${p.body}\n  Engagement hook: ${p.question_hook}`).join("\n\n---\n\n") || "(none)",
divider("UGC Scripts"),
(c.ugc_scripts||[]).map(s => `SLOT ${s.slot}
  Hook:           "${s.hook}"
  Problem:        ${s.problem}
  Personal:       ${s.personal_moment}
  App reveal:     ${s.app_reveal}
  Demo:           ${s.demo}
  Benefit:        ${s.benefit}
  CTA:            ${s.cta}
  Caption:        ${s.caption}
  Hashtags:       ${(s.hashtags||[]).join(" ")}`).join("\n\n---\n\n") || "(none)",
divider("Objections to Handle"),
(c.objections_to_handle||[]).map(o => `Objection: ${o.objection}\n  Response: ${o.response}`).join("\n\n") || "(none)",
divider("Customer Language Bank"),
fmtList(c.customer_language_bank),
divider("Social Proof Angles"),
fmtList(c.social_proof_angles),
divider("Outcome-Based Content Ideas"),
fmtList(c.outcome_based_content_ideas),
`\n\n--- END OF COMMUNITY & UGC ---\nGenerated by B.O.S.S. Operating System · E.C.H.O.`
  ].join("\n");
}

function formatCalendar(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · 30-DAY LAUNCH CALENDAR
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      D.A.S.H. · Marketing & Growth
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Calendar"),
(c.calendar||[]).map(w => `WEEK ${w.week} · ${w.theme}\n${(w.posts||[]).map(p => `  Day ${p.day} · ${p.channel} · ${p.content_type} · ${p.topic}\n    CTA: ${p.cta}`).join("\n")}`).join("\n\n") || "(none)",
divider("KPIs"),
(c.kpis||[]).map(k => `${k.kpi}\n  Target: ${k.target}\n  Measure: ${k.measurement}`).join("\n\n") || "(none)",
divider("Funnel Stages"),
(c.funnel_stages||[]).map(s => `${s.stage}: ${s.metric}\n  Good: ${s.good}\n  Bad:  ${s.bad}`).join("\n\n") || "(none)",
divider("Kill Criteria"),
c.kill_criteria || "(none)",
divider("Double Down Criteria"),
c.double_down_criteria || "(none)",
divider("Weekly Reporting Rhythm"),
c.weekly_reporting_rhythm || "(none)",
`\n\n--- END OF LAUNCH CALENDAR ---\nGenerated by B.O.S.S. Operating System · D.A.S.H.`
  ].join("\n");
}

const FORMATTERS = { positioning: formatPositioning, acquisition: formatAcquisition, community: formatCommunity, calendar: formatCalendar };

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    if(!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    const { project_id, doc_type } = req.body || {};
    if(!project_id) return res.status(400).json({ error: "project_id required" });
    if(!doc_type || !PROMPTS[doc_type]) return res.status(400).json({ error: "doc_type must be positioning | acquisition | community | calendar" });

    const rows = await sbQuery(`projects?id=eq.${project_id}&limit=1`);
    if(!rows.length) return res.status(404).json({ error: "project not found" });
    const project = rows[0];

    // Marketing reads PM + UX upstream so it doesn't guess the product
    const upstreamPM = await sbQuery(`product_documents?project_id=eq.${project_id}&order=created_at.desc&limit=5`);
    const upstreamUX = await sbQuery(`design_documents?project_id=eq.${project_id}&order=created_at.desc&limit=5`);
    const upstreamMKT = await sbQuery(`marketing_documents?project_id=eq.${project_id}&order=created_at.desc&limit=10`);

    const prompt = PROMPTS[doc_type];
    const userPayload = {
      project: { name: project.name, one_line: project.one_line, vertical: project.vertical, verdict: project.verdict },
      briefing_top: project.payload?.top || {},
      product_management_outputs: upstreamPM.map(d => ({ doc_type: d.doc_type, content: d.content })),
      design_outputs: upstreamUX.map(d => ({ doc_type: d.doc_type, content: d.content })),
      existing_marketing_outputs: upstreamMKT.map(d => ({ doc_type: d.doc_type, content: d.content }))
    };

    const t0 = Date.now();
    const llm = await callOpenAI(prompt.system, userPayload);
    const elapsed = Date.now() - t0;

    const requiresApproval = (doc_type === "community");  // community drafts need Meka approval before publishing
    const docRow = await sbInsert("marketing_documents", {
      project_id, doc_type, version: 1, content: llm.data,
      approval_required: requiresApproval
    });

    const formatter = FORMATTERS[doc_type];
    const txt = formatter(project, llm.data);
    const fileName = `${prompt.fileNum}_${prompt.filePrefix}_${project.name.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,40)}.txt`;
    const fileRow = await sbInsert("generated_files", {
      project_id, file_name: fileName, file_type: doc_type,
      content: txt, dept_id: prompt.dept, agent_id: prompt.agent
    });

    try {
      await sbInsert("agent_reports", {
        project_id, agent_id: prompt.agent, dept_id: prompt.dept,
        report_type: doc_type, title: prompt.title + " · " + project.name,
        confidence: "high", content: llm.data, export_file: fileName
      });
      await sbInsert("ops_logs", {
        agent_id: prompt.agent, dept_id: prompt.dept,
        action: `generate_${doc_type}`, status: "completed",
        duration_ms: elapsed, tokens_used: llm.usage?.total_tokens || 0,
        api_cost_estimate: ((llm.usage?.total_tokens || 0) / 1e6) * 0.15,
        payload: { project_id, doc_id: docRow.id, file_id: fileRow.id }
      });
    } catch(_) {}

    return res.status(200).json({
      ok: true, doc_type,
      document_id: docRow.id, file_id: fileRow.id, file_name: fileName,
      tokens: llm.usage?.total_tokens || 0, elapsed_ms: elapsed,
      requires_approval: requiresApproval,
      preview: txt.slice(0, 600) + (txt.length > 600 ? "..." : "")
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
