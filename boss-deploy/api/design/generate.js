// POST /api/design/generate
// Body: { project_id, doc_type }   doc_type ∈ { 'flow' | 'visual' | 'components' | 'screenshots' }
// Runs F.O.R.M. / L.E.N.S. / V.I.E.W. and persists design_documents + generated_files.

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

async function callOpenAI(systemPrompt, userPayload, maxTokens=2000){
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

const HOUSE = `NEVER use em dashes. Never spell acronyms letter by letter. Plain prose. Strict JSON only. Reject generic AI-app look. Prefer dark, premium, command-center aesthetics but design for the actual product, not the OS itself.`;

const PROMPTS = {
  flow: {
    agent: "FORM", dept: "ux", fileNum: "04a", filePrefix: "ux_user_flow",
    title: "UX User Flow & Structure",
    system: `You are F.O.R.M., Meka's UX Flow and Structure agent. Design the user flow, information architecture, navigation map, and onboarding for this product. Mobile-first. Reduce friction.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "user_flow": [{"step":1,"screen":"","user_action":"","system_response":""}],
  "navigation_map": {"primary":["",""],"secondary":["",""],"hidden":[""]},
  "screen_hierarchy": [{"screen":"","level":"primary|secondary|modal","purpose":""}],
  "onboarding_flow": [{"step":1,"goal":"","screen":"","cta":""}],
  "friction_points": [{"point":"","fix":""}],
  "ux_improvements": [""],
  "mobile_first_considerations": [""]
}`
  },
  visual: {
    agent: "LENS", dept: "ux", fileNum: "04b", filePrefix: "ux_visual_direction",
    title: "Visual Direction & Brand Styling",
    system: `You are L.E.N.S., Meka's Visual Direction agent. Define the product's visual style. Prevent generic AI-app look. Provide colors, typography, spacing, imagery direction, and screenshot direction.

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "mood": "one paragraph describing the visual mood",
  "color_palette": {"primary":"","secondary":"","accent":"","success":"","danger":"","background":"","surface":"","text_primary":"","text_muted":""},
  "typography": {"display_font":"","display_weight":"","body_font":"","body_weight":"","mono_font":""},
  "spacing": {"baseline_px":8,"section_gap":"24px","card_padding":"16px"},
  "imagery_direction": "string",
  "ui_components_style": "string",
  "generic_ui_warnings": ["watch out for","another"],
  "premium_design_critique": "what to push harder on",
  "app_store_screenshot_direction": [{"slot":1,"hook":"","caption":"","visual":""}],
  "claude_codex_style_rules": ["",""]
}`
  },
  components: {
    agent: "VIEW", dept: "ux", fileNum: "04c", filePrefix: "ux_component_system",
    title: "Component System & UI Widgets",
    system: `You are V.I.E.W., Meka's Components and UI Systems agent. Define the reusable component library, widgets, dashboard modules, card systems, and empty states. Each component should answer "what decision does this help the user make."

${HOUSE}

Output schema:
{
  "executive_summary": "under 80 words",
  "components": [{"name":"","purpose":"","props":["",""],"variants":[""]}],
  "widgets": [{"name":"","when_to_use":"","data_required":[""]}],
  "card_system": [{"name":"","purpose":"","sample_content":""}],
  "dashboard_modules": [""],
  "empty_states": [{"context":"","copy":"","cta":""}],
  "interaction_patterns": [""],
  "ui_pattern_library": ["buttons","forms","tables","modals","tabs","badges"],
  "component_quality_score": 1-10
}`
  },
  screenshots: {
    agent: "LENS", dept: "ux", fileNum: "04d", filePrefix: "ux_app_store_screenshots",
    title: "App Store Screenshot Direction",
    system: `You are L.E.N.S. designing the App Store + Play Store screenshot sequence. 5 to 8 frames. Each one hooks pain or shows a clear win. Hero screenshot is the trojan horse.

${HOUSE}

Output schema:
{
  "executive_summary": "under 60 words",
  "screenshots": [{"slot":1,"role":"hero|feature|proof|cta","hook_text":"under 7 words","subhook":"under 12 words","visual_description":"","mood":""}],
  "creative_principles": ["",""],
  "do": [""],
  "do_not": [""]
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

function formatFlow(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · UX USER FLOW
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      F.O.R.M. · Design & UX
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("User Flow"),
(c.user_flow||[]).map(s => `Step ${s.step}: ${s.screen}\n  User: ${s.user_action}\n  System: ${s.system_response}`).join("\n\n") || "(none)",
divider("Navigation Map"),
`Primary: ${(c.navigation_map?.primary||[]).join(", ")}
Secondary: ${(c.navigation_map?.secondary||[]).join(", ")}
Hidden: ${(c.navigation_map?.hidden||[]).join(", ")}`,
divider("Screen Hierarchy"),
(c.screen_hierarchy||[]).map(s => `[${s.level}] ${s.screen}: ${s.purpose}`).join("\n") || "(none)",
divider("Onboarding Flow"),
(c.onboarding_flow||[]).map(s => `Step ${s.step}: ${s.screen}\n  Goal: ${s.goal}\n  CTA: ${s.cta}`).join("\n\n") || "(none)",
divider("Friction Points"),
(c.friction_points||[]).map(f => `Issue: ${f.point}\n  Fix: ${f.fix}`).join("\n\n") || "(none)",
divider("UX Improvements"),
fmtList(c.ux_improvements),
divider("Mobile-First Considerations"),
fmtList(c.mobile_first_considerations),
`\n\n--- END OF UX FLOW ---\nGenerated by B.O.S.S. Operating System · F.O.R.M.`
  ].join("\n");
}

function formatVisual(project, c){
  const cp = c.color_palette || {};
  const t = c.typography || {};
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · VISUAL DIRECTION
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      L.E.N.S. · Design & UX
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Mood"),
c.mood || "(none)",
divider("Color Palette"),
`Primary:      ${cp.primary || "—"}
Secondary:    ${cp.secondary || "—"}
Accent:       ${cp.accent || "—"}
Success:      ${cp.success || "—"}
Danger:       ${cp.danger || "—"}
Background:   ${cp.background || "—"}
Surface:      ${cp.surface || "—"}
Text primary: ${cp.text_primary || "—"}
Text muted:   ${cp.text_muted || "—"}`,
divider("Typography"),
`Display: ${t.display_font || "—"} · ${t.display_weight || ""}
Body:    ${t.body_font || "—"} · ${t.body_weight || ""}
Mono:    ${t.mono_font || "—"}`,
divider("Spacing"),
`Baseline: ${c.spacing?.baseline_px || 8}px
Section gap: ${c.spacing?.section_gap || "24px"}
Card padding: ${c.spacing?.card_padding || "16px"}`,
divider("Imagery Direction"),
c.imagery_direction || "(none)",
divider("UI Components Style"),
c.ui_components_style || "(none)",
divider("Generic UI Warnings"),
fmtList(c.generic_ui_warnings),
divider("Premium Design Critique"),
c.premium_design_critique || "(none)",
divider("App Store Screenshot Direction"),
(c.app_store_screenshot_direction||[]).map(s => `[Slot ${s.slot}] ${s.hook}\n  Caption: ${s.caption}\n  Visual: ${s.visual}`).join("\n\n") || "(none)",
divider("Claude / Codex Style Rules"),
fmtList(c.claude_codex_style_rules),
`\n\n--- END OF VISUAL DIRECTION ---\nGenerated by B.O.S.S. Operating System · L.E.N.S.`
  ].join("\n");
}

function formatComponents(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · COMPONENT SYSTEM
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      V.I.E.W. · Design & UX
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Components"),
(c.components||[]).map(cm => `${cm.name}\n  Purpose: ${cm.purpose}\n  Props: ${(cm.props||[]).join(", ")}\n  Variants: ${(cm.variants||[]).join(", ")}`).join("\n\n") || "(none)",
divider("Widgets"),
(c.widgets||[]).map(w => `${w.name}\n  When to use: ${w.when_to_use}\n  Data: ${(w.data_required||[]).join(", ")}`).join("\n\n") || "(none)",
divider("Card System"),
(c.card_system||[]).map(cd => `${cd.name}\n  Purpose: ${cd.purpose}\n  Sample: ${cd.sample_content}`).join("\n\n") || "(none)",
divider("Dashboard Modules"),
fmtList(c.dashboard_modules),
divider("Empty States"),
(c.empty_states||[]).map(e => `Context: ${e.context}\n  Copy: ${e.copy}\n  CTA: ${e.cta}`).join("\n\n") || "(none)",
divider("Interaction Patterns"),
fmtList(c.interaction_patterns),
divider("UI Pattern Library"),
fmtList(c.ui_pattern_library),
divider("Quality Score"),
`${c.component_quality_score || "—"} / 10`,
`\n\n--- END OF COMPONENT SYSTEM ---\nGenerated by B.O.S.S. Operating System · V.I.E.W.`
  ].join("\n");
}

function formatScreenshots(project, c){
  return [
`================================================================
B.O.S.S. OPERATING SYSTEM · APP STORE SCREENSHOT DIRECTION
================================================================

Project:    ${project.name}
Date:       ${new Date().toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"})}
Agent:      L.E.N.S. · Design & UX
`,
divider("Executive Summary"),
c.executive_summary || "(none)",
divider("Screenshot Sequence"),
(c.screenshots||[]).map(s => `SLOT ${s.slot} [${s.role}]\n  Hook:    "${s.hook_text}"\n  Sub:     "${s.subhook}"\n  Visual:  ${s.visual_description}\n  Mood:    ${s.mood}`).join("\n\n") || "(none)",
divider("Creative Principles"),
fmtList(c.creative_principles),
divider("Do"),
fmtList(c.do),
divider("Do NOT"),
fmtList(c.do_not),
`\n\n--- END OF SCREENSHOT DIRECTION ---\nGenerated by B.O.S.S. Operating System · L.E.N.S.`
  ].join("\n");
}

const FORMATTERS = { flow: formatFlow, visual: formatVisual, components: formatComponents, screenshots: formatScreenshots };

export default async function handler(req, res){
  if(req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  try {
    if(!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not set" });
    const { project_id, doc_type } = req.body || {};
    if(!project_id) return res.status(400).json({ error: "project_id required" });
    if(!doc_type || !PROMPTS[doc_type]) return res.status(400).json({ error: "doc_type must be flow | visual | components | screenshots" });

    const rows = await sbQuery(`projects?id=eq.${project_id}&limit=1`);
    if(!rows.length) return res.status(404).json({ error: "project not found" });
    const project = rows[0];

    // Pull upstream PM docs so design can reference scope
    const upstreamPM = await sbQuery(`product_documents?project_id=eq.${project_id}&order=created_at.desc&limit=5`);
    const upstreamUX = await sbQuery(`design_documents?project_id=eq.${project_id}&order=created_at.desc&limit=10`);

    const prompt = PROMPTS[doc_type];
    const userPayload = {
      project: { name: project.name, one_line: project.one_line, vertical: project.vertical, verdict: project.verdict },
      briefing_top: project.payload?.top || {},
      product_management_outputs: upstreamPM.map(d => ({ doc_type: d.doc_type, content: d.content })),
      existing_design_outputs: upstreamUX.map(d => ({ doc_type: d.doc_type, content: d.content }))
    };

    const t0 = Date.now();
    const llm = await callOpenAI(prompt.system, userPayload);
    const elapsed = Date.now() - t0;

    const docRow = await sbInsert("design_documents", {
      project_id, doc_type, version: 1, content: llm.data,
      quality_score: llm.data.component_quality_score || null
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
      preview: txt.slice(0, 600) + (txt.length > 600 ? "..." : "")
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
