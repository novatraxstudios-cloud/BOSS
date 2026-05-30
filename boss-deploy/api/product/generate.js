// POST /api/product/generate
// Body: { project_id, doc_type }   where doc_type ∈ { 'prd' | 'sprint' | 'phase' | 'release' }
// Runs the relevant Product agent (SCOPE / PACE / SHIP), writes to product_documents,
// and writes a formatted .txt to generated_files.

export const config = { runtime: "nodejs" };
export const maxDuration = 60;

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){ return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null; }

async function sbQuery(query){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${query}`, {
    headers: { "apikey": key, "Authorization": `Bearer ${key}` }
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  return await r.json();
}
async function sbInsert(table, row){
  const url = sbUrl(), key = sbKey();
  const r = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "apikey": key, "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json", "Prefer": "return=representation"
    },
    body: JSON.stringify(row)
  });
  if(!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0,180)}`);
  const arr = await r.json();
  return arr[0] || arr;
}

async function callOpenAI(systemPrompt, userPayload, maxTokens=2200){
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: typeof userPayload === "string" ? userPayload : JSON.stringify(userPayload) }
      ],
      response_format: { type: "json_object" },
      temperature: 0.5,
      max_tokens: maxTokens
    })
  });
  if(!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return { data: JSON.parse(j.choices[0].message.content), usage: j.usage };
}

const HOUSE = `NEVER use em dashes. Never spell acronyms letter by letter. Plain prose. Strict JSON only. Keep entries crisp. Number lists where helpful. Always include risks + assumptions.`;

/* ---- AGENT PROMPTS ---- */
const PROMPTS = {
  prd: {
    agent: "SCOPE", dept: "pm", fileNum: "02", filePrefix: "prd_scope_user_stories",
    title: "Product Requirements Document",
    system: `You are S.C.O.P.E., Meka's PRD and Requirements agent. Generate a focused product requirements document for the project. Be opinionated about scope. Keep MVP boundaries tight.

${HOUSE}

Output schema:
{
  "executive_summary": "under 100 words",
  "problem_statement": "1-2 paragraphs",
  "target_user": {"primary":"","secondary":"","use_case":""},
  "user_stories": [{"id":"US1","as_a":"","i_want":"","so_that":""}],
  "acceptance_criteria": [{"story_id":"US1","criteria":["",""]}],
  "functional_requirements": ["","",""],
  "non_functional_requirements": ["performance","accessibility","privacy","reliability"],
  "in_scope": [""],
  "out_of_scope_for_mvp": [""],
  "assumptions": [""],
  "risks": [{"risk":"","mitigation":""}],
  "dependencies": [""],
  "success_metrics": ["concrete numbers like 50 waitlist in 7 days"]
}`
  },
  sprint: {
    agent: "PACE", dept: "pm", fileNum: "03", filePrefix: "sprint_phase_breakdown",
    title: "Sprint and Phase Breakdown",
    system: `You are P.A.C.E., Meka's Sprint Planning and Execution agent. Break the project into a focused 4-sprint plan plus phase breakdown. Each sprint is 7 days. Solo founder pace with AI tooling.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "sprints": [
    {"sprint":1,"goal":"","duration":"7 days","key_features":["",""],"tasks":["",""],"acceptance":["",""],"dependencies":[""],"risks":[""],"definition_of_done":[""],"export_needed":["prd.txt","build_walkthrough.txt"],"next_trigger":""}
  ],
  "phases": [
    {"phase":"0 · validation","goal":"","deliverables":[""]},
    {"phase":"1 · ugly MVP","goal":"","deliverables":[""]},
    {"phase":"2 · private beta","goal":"","deliverables":[""]},
    {"phase":"3 · public launch","goal":"","deliverables":[""]},
    {"phase":"4 · monetization","goal":"","deliverables":[""]}
  ],
  "weekly_priorities": [{"week":1,"priorities":[""]}],
  "blockers": [""],
  "execution_risks": [""]
}`
  },
  release: {
    agent: "SHIP", dept: "pm", fileNum: "10", filePrefix: "launch_checklist",
    title: "Release Readiness Checklist",
    system: `You are S.H.I.P., Meka's Release Readiness agent. Produce a hard launch checklist that names every cross-team dependency, every go-live blocker, and a ship/no-ship recommendation.

${HOUSE}

Output schema:
{
  "executive_summary": "under 60 words",
  "release_readiness": {"product":"green|yellow|red","design":"green|yellow|red","marketing":"green|yellow|red","security":"green|yellow|red","ops":"green|yellow|red"},
  "checklist": [{"category":"product","items":[{"name":"","done":false,"owner":""}]}],
  "go_live_blockers": [{"blocker":"","owner":"","resolution":""}],
  "cross_team_dependencies": [{"from":"","to":"","what":""}],
  "release_notes_draft": "string",
  "ship_recommendation": "SHIP | DELAY | NO-SHIP",
  "ship_reason": "string"
}`
  },
  phase: {
    agent: "PACE", dept: "pm", fileNum: "03b", filePrefix: "phase_roadmap",
    title: "Phase Roadmap",
    system: `You are P.A.C.E. extending the sprint plan into a 90-day phase roadmap with clear milestone gates. Pragmatic, executable, solo-founder pace.
${HOUSE}
Output schema:
{
  "executive_summary": "under 80 words",
  "horizon": "90 days",
  "phases": [{"phase":"","start_day":1,"end_day":14,"goal":"","milestones":["",""],"exit_criteria":["",""]}],
  "biggest_risk": "",
  "first_30_days_focus": ""
}`
  }
};

/* ---- TXT FORMATTERS ---- */
function fmtList(arr, prefix="- "){
  if(!Array.isArray(arr) || arr.length === 0) return "(none)";
  return arr.map(x => prefix + (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
}
function divider(title){
  const line = "=".repeat(64);
  return `\n${line}\n${title.toUpperCase()}\n${line}\n`;
}

function formatPRD(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · PRODUCT REQUIREMENTS DOCUMENT
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Version:    1
Owner:      Meka Anyanwu
Agent:      S.C.O.P.E. · Product Management
Vertical:   ${project.vertical || "n/a"}
Verdict:    ${project.verdict || "VALIDATE"}
`,
divider("1. Executive Summary"),
c.executive_summary || "(none)",
divider("2. Problem Statement"),
c.problem_statement || "(none)",
divider("3. Target User"),
`Primary:     ${c.target_user?.primary || "—"}
Secondary:   ${c.target_user?.secondary || "—"}
Use case:    ${c.target_user?.use_case || "—"}`,
divider("4. User Stories"),
(c.user_stories||[]).map(s => `${s.id || "US"}: As a ${s.as_a}, I want ${s.i_want}, so that ${s.so_that}`).join("\n\n") || "(none)",
divider("5. Acceptance Criteria"),
(c.acceptance_criteria||[]).map(a => `${a.story_id}:\n${(a.criteria||[]).map(x => "  • "+x).join("\n")}`).join("\n\n") || "(none)",
divider("6. Functional Requirements"),
fmtList(c.functional_requirements),
divider("7. Non-Functional Requirements"),
fmtList(c.non_functional_requirements),
divider("8. In Scope (MVP)"),
fmtList(c.in_scope),
divider("9. Out of Scope (MVP)"),
fmtList(c.out_of_scope_for_mvp),
divider("10. Assumptions"),
fmtList(c.assumptions),
divider("11. Risks & Mitigations"),
(c.risks||[]).map(r => `Risk: ${r.risk}\n  Mitigation: ${r.mitigation}`).join("\n\n") || "(none)",
divider("12. Dependencies"),
fmtList(c.dependencies),
divider("13. Success Metrics"),
fmtList(c.success_metrics),
`\n\n--- END OF PRD ---\nGenerated by B.O.S.S. Operating System · S.C.O.P.E.`
  ].join("\n");
}

function formatSprintPlan(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · SPRINT AND PHASE BREAKDOWN
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      P.A.C.E. · Product Management
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Sprint Plan"),
(c.sprints||[]).map((s,i) =>
`SPRINT ${s.sprint || i+1} (${s.duration || "7 days"})
Goal: ${s.goal}

Key features:
${fmtList(s.key_features, "  • ")}

Tasks:
${fmtList(s.tasks, "  • ")}

Acceptance:
${fmtList(s.acceptance, "  ✓ ")}

Dependencies: ${(s.dependencies||[]).join(", ") || "(none)"}
Risks: ${(s.risks||[]).join(", ") || "(none)"}
Definition of done:
${fmtList(s.definition_of_done, "  ☐ ")}

Export needed: ${(s.export_needed||[]).join(", ") || "(none)"}
Next trigger: ${s.next_trigger || "—"}
`).join("\n----------------------------------------------------------------\n"),
divider("Phase Breakdown"),
(c.phases||[]).map(p => `${p.phase}\n  Goal: ${p.goal}\n  Deliverables:\n${fmtList(p.deliverables, "    • ")}`).join("\n\n"),
divider("Weekly Priorities"),
(c.weekly_priorities||[]).map(w => `Week ${w.week}:\n${fmtList(w.priorities, "  • ")}`).join("\n\n"),
divider("Blockers"),
fmtList(c.blockers),
divider("Execution Risks"),
fmtList(c.execution_risks),
`\n\n--- END OF SPRINT PLAN ---\nGenerated by B.O.S.S. Operating System · P.A.C.E.`
  ].join("\n");
}

function formatRelease(project, c){
  const greenYellowRed = v => ({green:"●",yellow:"◐",red:"○"})[v] || "?";
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · RELEASE READINESS CHECKLIST
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      S.H.I.P. · Product Management
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Department Readiness"),
Object.entries(c.release_readiness || {}).map(([k,v]) => `  ${greenYellowRed(v).padEnd(3)} ${k.toUpperCase()}: ${v}`).join("\n"),
divider("Launch Checklist"),
(c.checklist||[]).map(cat =>
  `[${cat.category.toUpperCase()}]\n` +
  (cat.items||[]).map(item => `  ${item.done?"[x]":"[ ]"} ${item.name}${item.owner?" · owner: "+item.owner:""}`).join("\n")
).join("\n\n"),
divider("Go-Live Blockers"),
(c.go_live_blockers||[]).map(b => `Blocker: ${b.blocker}\n  Owner: ${b.owner}\n  Resolution: ${b.resolution}`).join("\n\n") || "(none — all clear)",
divider("Cross-Team Dependencies"),
(c.cross_team_dependencies||[]).map(d => `  ${d.from} → ${d.to}: ${d.what}`).join("\n"),
divider("Release Notes Draft"),
c.release_notes_draft || "(none)",
divider("Ship Decision"),
`Recommendation: ${c.ship_recommendation || "—"}\nReason: ${c.ship_reason || "—"}`,
`\n\n--- END OF RELEASE CHECKLIST ---\nGenerated by B.O.S.S. Operating System · S.H.I.P.`
  ].join("\n");
}

function formatPhase(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · 90-DAY PHASE ROADMAP
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      P.A.C.E.
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Horizon"),
c.horizon || "90 days",
divider("Phases"),
(c.phases||[]).map(p => `${p.phase} (days ${p.start_day}-${p.end_day})
  Goal: ${p.goal}
  Milestones:
${fmtList(p.milestones, "    • ")}
  Exit criteria:
${fmtList(p.exit_criteria, "    ✓ ")}`).join("\n\n"),
divider("Biggest Risk"),
c.biggest_risk || "(none)",
divider("First 30 Days Focus"),
c.first_30_days_focus || "(none)",
`\n\n--- END OF PHASE ROADMAP ---\nGenerated by B.O.S.S. Operating System · P.A.C.E.`
  ].join("\n");
}

const FORMATTERS = { prd: formatPRD, sprint: formatSprintPlan, release: formatRelease, phase: formatPhase };

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    if(!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set" });

    const { project_id, doc_type } = req.body || {};
    if(!project_id) return res.status(400).json({ error: "project_id required" });
    if(!doc_type || !PROMPTS[doc_type]) return res.status(400).json({ error: "doc_type must be prd | sprint | phase | release" });

    // Pull the project
    const rows = await sbQuery(`projects?id=eq.${project_id}&limit=1`);
    if(!rows.length) return res.status(404).json({ error: "project not found" });
    const project = rows[0];

    // For PRD, see if there are upstream agent reports (boss_filter, void, sniper) we can feed in
    // For other doc types, feed in any existing product_documents so PACE/SHIP can reference them
    const upstream = await sbQuery(`product_documents?project_id=eq.${project_id}&order=created_at.desc&limit=10`);
    const briefingTop = project.payload?.top || {};

    const prompt = PROMPTS[doc_type];
    const userPayload = {
      project: {
        name: project.name,
        one_line: project.one_line,
        vertical: project.vertical,
        verdict: project.verdict
      },
      briefing_top: briefingTop,
      existing_documents: upstream.map(d => ({ doc_type: d.doc_type, content: d.content }))
    };

    const t0 = Date.now();
    const llm = await callOpenAI(prompt.system, userPayload);
    const elapsed = Date.now() - t0;

    // Persist to product_documents
    const docRow = await sbInsert("product_documents", {
      project_id,
      doc_type,
      version: 1,
      content: llm.data
    });

    // Format as .txt + persist to generated_files
    const formatter = FORMATTERS[doc_type];
    const txt = formatter(project, llm.data);
    const fileName = `${prompt.fileNum}_${prompt.filePrefix}_${project.name.toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_|_$/g,"").slice(0,40)}.txt`;
    const fileRow = await sbInsert("generated_files", {
      project_id,
      file_name: fileName,
      file_type: doc_type,
      content: txt,
      dept_id: prompt.dept,
      agent_id: prompt.agent
    });

    // Persist an agent_reports row for the dossier feed
    try {
      await sbInsert("agent_reports", {
        project_id,
        agent_id: prompt.agent,
        dept_id: prompt.dept,
        report_type: doc_type,
        title: prompt.title + " · " + project.name,
        confidence: "high",
        content: llm.data,
        export_file: fileName
      });
      await sbInsert("ops_logs", {
        agent_id: prompt.agent,
        dept_id: prompt.dept,
        action: `generate_${doc_type}`,
        status: "completed",
        duration_ms: elapsed,
        tokens_used: llm.usage?.total_tokens || 0,
        api_cost_estimate: ((llm.usage?.total_tokens || 0) / 1e6) * 0.15,
        payload: { project_id, doc_id: docRow.id, file_id: fileRow.id }
      });
    } catch(_) {}

    return res.status(200).json({
      ok: true,
      doc_type,
      document_id: docRow.id,
      file_id: fileRow.id,
      file_name: fileName,
      tokens: llm.usage?.total_tokens || 0,
      elapsed_ms: elapsed,
      preview: txt.slice(0, 600) + (txt.length > 600 ? "..." : "")
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
