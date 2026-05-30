// /api/deepdive — second-pass deep research on a single approved idea.
// Triggered when Meka clicks "Approve for deeper research" on a top opportunity.
// Runs deeper Tavily (10 queries) + harder competitor analysis + 4-week build plan.
//
// Hit: /api/deepdive?id=<briefing_uuid>&secret=<CRON_SECRET>

export const config = { runtime: "nodejs" };
export const maxDuration = 60;

function sbUrl(){
  return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null;
}
function sbServiceKey(){
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || null;
}
function sbAnonKey(){
  return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || null;
}

async function tavilySearch(query, depth="advanced", max_results=6) {
  if (!process.env.TAVILY_API_KEY) return [];
  const r = await fetch("https://api.tavily.com/search", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query, search_depth: depth, max_results,
      include_answer:false, topic:"general"
    })
  });
  if (!r.ok) return [];
  const j = await r.json();
  return (j.results||[]).map(x=>({title:x.title,url:x.url,snippet:(x.content||"").slice(0,400)}));
}

async function callOpenAI(systemPrompt, userPayload, model="gpt-4o-mini", maxTokens=1800) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body: JSON.stringify({
      model,
      messages:[
        {role:"system",content:systemPrompt},
        {role:"user",content:typeof userPayload==="string"?userPayload:JSON.stringify(userPayload)}
      ],
      response_format:{type:"json_object"},
      temperature:0.5,
      max_tokens:maxTokens
    })
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

function requireSecret(req){
  const provided = (req.query?.secret) || req.headers["x-cron-secret"] || "";
  const expected = process.env.CRON_SECRET;
  if (!expected) return true;
  return provided === expected;
}

export default async function handler(req, res) {
  if (!requireSecret(req)) return res.status(401).json({error:"unauthorized"});
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:"OPENAI_API_KEY not set"});
  const id = req.query?.id;
  if (!id) return res.status(400).json({error:"id query param required"});

  const url = sbUrl();
  const key = sbServiceKey() || sbAnonKey();
  if (!url || !key) return res.status(500).json({error:"Supabase not configured"});

  try {
    // 1. Fetch the original briefing
    const r1 = await fetch(`${url}/rest/v1/briefings?id=eq.${id}&limit=1`, {
      headers: { apikey:key, Authorization:`Bearer ${key}` }
    });
    if (!r1.ok) throw new Error(`Supabase fetch ${r1.status}`);
    const rows = await r1.json();
    if (!rows.length) return res.status(404).json({error:"briefing not found"});

    const row = rows[0];
    const orig = row.payload?.briefing || {};
    const top = orig.top || {};
    if (!top.name) return res.status(400).json({error:"no top idea on this briefing"});

    // 2. Run DEEPER Tavily — 7 targeted queries about the idea + competitors
    const ideaName = top.name;
    const targetUser = top.target_user || row.vertical;
    const queries = [
      `"${ideaName}" alternative app launch`,
      `${targetUser} "I wish there was" app`,
      `${ideaName} competitor reviews complaints`,
      `${targetUser} pain point startup`,
      `site:reddit.com ${targetUser} app frustration`,
      `mobile app ${row.vertical} 2026 launch waitlist`,
      `${ideaName} ${row.vertical} feature gap`
    ];
    const results = await Promise.all(queries.map(q => tavilySearch(q, "advanced", 6)));
    const evidence = [];
    const seen = new Set();
    for (const r of results) {
      for (const item of r) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        evidence.push(item);
      }
    }
    const deepEvidence = evidence.slice(0, 30);

    // 3. Two specialist deep dives in parallel
    const HOUSE = `NEVER use em dashes. NEVER spell acronyms. Plain prose. Strict JSON.`;

    const sniperDeepPrompt = `You are S.N.I.P.E.R. running a DEEP competitor sweep on "${ideaName}".
Find every meaningful competitor in the evidence and rank by threat level.
Identify the 3 strongest competitors and what would beat them.
${HOUSE}
Output: {"idea_name":"","competitors":[{"name":"","positioning":"","weakness":"","threat_level":1-10}],"top_3_threats":[{"name":"","why":"","how_to_beat":""}],"strongest_wedge":"single sentence","competition_density":"sparse|moderate|crowded|dominated"}`;

    const buildDeepPrompt = `You are B.L.U.E. designing a 30-day build plan for "${ideaName}".
Break it into 4 weekly milestones. Each week has 3-5 concrete deliverables.
Identify the 3 biggest technical risks. Suggest the smallest paid offer to test willingness-to-pay.
${HOUSE}
Output: {"idea_name":"","week_1":{"goal":"","deliverables":["",""]},"week_2":{"goal":"","deliverables":[""]},"week_3":{"goal":"","deliverables":[""]},"week_4":{"goal":"","deliverables":[""]},"technical_risks":[{"risk":"","mitigation":""}],"first_paid_offer":"specific price + what's included","launch_channel_priority":["channel 1","channel 2","channel 3"]}`;

    const vibeDeepPrompt = `You are V.I.B.E. designing an aggressive 7-day validation sprint for "${ideaName}".
Day-by-day plan, concrete copy, kill thresholds.
${HOUSE}
Output: {"idea_name":"","landing_headline":"","subhead":"under 25 words","days":[{"day":1,"action":"","success":""},{"day":2,"action":"","success":""},{"day":3,"action":"","success":""},{"day":4,"action":"","success":""},{"day":5,"action":"","success":""},{"day":6,"action":"","success":""},{"day":7,"action":"","success":""}],"tiktok_hooks":["","","","","",""],"reddit_posts":[{"subreddit":"","title":"","angle":""},{"subreddit":"","title":"","angle":""},{"subreddit":"","title":"","angle":""},{"subreddit":"","title":"","angle":""}],"email_outreach_template":"under 80 words","success_criteria":"hard numbers","kill_criteria":"hard numbers"}`;

    const userPayload = { idea: top, original_score: top.weighted_score, deep_evidence: deepEvidence };
    const [sniper, blue, vibe] = await Promise.all([
      callOpenAI(sniperDeepPrompt, userPayload).catch(e=>({error:e.message})),
      callOpenAI(buildDeepPrompt, userPayload).catch(e=>({error:e.message})),
      callOpenAI(vibeDeepPrompt, userPayload).catch(e=>({error:e.message}))
    ]);

    // 4. Boss issues the deep-dive verdict
    const bossPrompt = `You are B.O.S.S. After deeper research on "${ideaName}", issue a final go/no-go.
Refresh the verdict. State concrete next 7-day actions. Be unambiguous.
${HOUSE}
Output: {"idea_name":"","refreshed_verdict":"BUILD|VALIDATE|WATCH|KILL","refreshed_score":1-10,"why_changed":"if same as original say 'confirmed'","seven_day_actions":["","",""],"thirty_day_north_star":"single sentence","kill_switch":"specific metric, e.g. 'kill if under 30 waitlist in 7 days'"}`;
    const bossOut = await callOpenAI(bossPrompt, { idea:top, sniper, blue, vibe });

    // 5. Write back to Supabase as a NEW row linked to original
    const deepRow = {
      date: row.date,
      vertical: row.vertical,
      top_name: top.name + " (deep dive)",
      top_verdict: bossOut.refreshed_verdict || top.verdict,
      top_score: bossOut.refreshed_score || top.weighted_score,
      sources_scouted: deepEvidence.length,
      sources: deepEvidence.map(e=>({url:e.url, title:e.title})),
      payload: {
        ok:true,
        deep_dive_of: id,
        original_top: top,
        vertical: row.vertical,
        sources_scouted: deepEvidence.length,
        sources: deepEvidence,
        briefing: {
          date: row.date,
          vertical: row.vertical,
          executive_summary: bossOut.why_changed || "Deep dive completed.",
          top: {
            name: top.name,
            one_line: top.one_line,
            target_user: top.target_user,
            pain: top.pain,
            evidence: `Deep-dive scouted ${deepEvidence.length} additional sources. Verdict: ${bossOut.refreshed_verdict}`,
            verdict: bossOut.refreshed_verdict,
            weighted_score: bossOut.refreshed_score,
            sources: deepEvidence.slice(0,5).map(e=>e.url),
            scores: top.scores
          },
          deep_dive: { sniper, blue, vibe, boss: bossOut }
        }
      },
      generated_at: new Date().toISOString()
    };

    const r2 = await fetch(`${url}/rest/v1/briefings`, {
      method:"POST",
      headers:{
        apikey:key, Authorization:`Bearer ${key}`,
        "Content-Type":"application/json", "Prefer":"return=representation"
      },
      body: JSON.stringify(deepRow)
    });
    const inserted = r2.ok ? await r2.json() : null;

    return res.status(200).json({
      ok:true,
      deep_dive_of: id,
      idea: top.name,
      sources_scouted: deepEvidence.length,
      refreshed_verdict: bossOut.refreshed_verdict,
      refreshed_score: bossOut.refreshed_score,
      sniper, blue, vibe, boss: bossOut,
      saved_to_supabase: !!inserted
    });
  } catch (e) {
    return res.status(500).json({error:e.message, stack:(e.stack||"").split("\n").slice(0,3).join(" | ")});
  }
}
