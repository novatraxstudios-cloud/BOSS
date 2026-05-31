// GET /api/tron/summary
// Aggregates ops_logs into the T.R.O.N. Operations view:
//   - last_24h + last_7d totals (runs, successes, failures, tokens, cost)
//   - per-agent matrix (runs, last_run, success_rate)
//   - per-action breakdown (briefing, security_report, trading_report, product_doc_gen, etc.)
//   - cron health (when did each cron last fire, is it on schedule?)
//   - recent failures (last 15 failed rows)

export const config = { runtime: "nodejs" };

function sbUrl(){ return process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || null; }
function sbKey(){
  return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
      || process.env.SUPABASE_SERVICE_ROLE_KEY || null;
}

async function sbQuery(q){
  const url = sbUrl(), key = sbKey();
  if(!url || !key) throw new Error("Supabase not configured");
  const r = await fetch(`${url}/rest/v1/${q}`, { headers:{ "apikey":key, "Authorization":`Bearer ${key}` } });
  if(!r.ok) throw new Error(`Supabase ${r.status}`);
  return await r.json();
}

// Cron schedule expectations (matches vercel.json)
const EXPECTED_CRONS = [
  { action: "security_report", label: "Security · V.A.U.L.T.", schedule: "0 12 * * *",   max_hours_between: 27 }, // daily
  { action: "briefing",        label: "Ventures · F.R.I.D.A.Y.", schedule: "0 13 * * *", max_hours_between: 27 }, // daily
  { action: "trading_report",  label: "Trading · P.I.V.O.T.",    schedule: "15 13 * * 1-5", max_hours_between: 80 }, // weekdays (skip weekend)
  { action: "digest",          label: "Weekly Digest",           schedule: "0 14 * * 0",   max_hours_between: 192 }  // weekly
];

function rollup(rows){
  let runs = 0, succ = 0, fail = 0, tokens = 0, cost = 0;
  const byAgent = {};
  const byAction = {};
  const byStatus = {};
  for(const r of rows){
    runs++;
    if(r.status === "completed" || r.status === "ok" || r.status === "success") succ++;
    else if(r.status === "failed" || r.status === "error") fail++;
    tokens += Number(r.tokens_used || 0);
    cost += Number(r.api_cost_estimate || 0);

    const aid = r.agent_id || "—";
    if(!byAgent[aid]) byAgent[aid] = { runs:0, successes:0, failures:0, tokens:0, cost:0, last_run:null, last_action:null, last_status:null };
    byAgent[aid].runs++;
    if(r.status === "completed") byAgent[aid].successes++;
    if(r.status === "failed") byAgent[aid].failures++;
    byAgent[aid].tokens += Number(r.tokens_used || 0);
    byAgent[aid].cost   += Number(r.api_cost_estimate || 0);
    if(!byAgent[aid].last_run || new Date(r.run_date) > new Date(byAgent[aid].last_run)){
      byAgent[aid].last_run = r.run_date;
      byAgent[aid].last_action = r.action;
      byAgent[aid].last_status = r.status;
    }

    const act = r.action || "—";
    if(!byAction[act]) byAction[act] = { runs:0, successes:0, failures:0, tokens:0, cost:0, last_run:null };
    byAction[act].runs++;
    if(r.status === "completed") byAction[act].successes++;
    if(r.status === "failed") byAction[act].failures++;
    byAction[act].tokens += Number(r.tokens_used || 0);
    byAction[act].cost   += Number(r.api_cost_estimate || 0);
    if(!byAction[act].last_run || new Date(r.run_date) > new Date(byAction[act].last_run)){
      byAction[act].last_run = r.run_date;
    }

    byStatus[r.status || "unknown"] = (byStatus[r.status || "unknown"] || 0) + 1;
  }
  return {
    runs, successes: succ, failures: fail,
    success_rate: runs ? Number((succ / runs).toFixed(3)) : null,
    tokens, cost: Number(cost.toFixed(4)),
    by_agent: byAgent, by_action: byAction, by_status: byStatus
  };
}

export default async function handler(req, res){
  try {
    const now = new Date();
    const since24h = new Date(now - 86_400_000).toISOString();
    const since7d  = new Date(now - 7*86_400_000).toISOString();

    // Pull a generous window so we can compute both 24h and 7d from one query
    const rows7d = await sbQuery(`ops_logs?run_date=gte.${since7d}&order=run_date.desc&limit=500`);
    const rows24h = rows7d.filter(r => new Date(r.run_date) >= new Date(since24h));

    const last_24h = rollup(rows24h);
    const last_7d  = rollup(rows7d);

    // Cron health
    const cron_health = EXPECTED_CRONS.map(c => {
      const acts = rows7d.filter(r => r.action === c.action).sort((a,b)=>new Date(b.run_date)-new Date(a.run_date));
      const lastRun = acts[0] || null;
      const hoursSince = lastRun ? Math.round((now - new Date(lastRun.run_date)) / 3600_000 * 10) / 10 : null;
      const onSchedule = hoursSince != null && hoursSince <= c.max_hours_between;
      return {
        action: c.action,
        label: c.label,
        schedule_cron: c.schedule,
        last_run: lastRun?.run_date || null,
        last_status: lastRun?.status || null,
        hours_since_last_run: hoursSince,
        on_schedule: onSchedule,
        runs_7d: acts.length
      };
    });

    // Recent failures
    const recent_failures = rows7d
      .filter(r => r.status === "failed" || r.status === "error")
      .slice(0, 15)
      .map(r => ({
        run_date: r.run_date,
        agent_id: r.agent_id,
        dept_id: r.dept_id,
        action: r.action,
        duration_ms: r.duration_ms,
        error_message: (r.error_message || "").slice(0, 200)
      }));

    // Overall health score (0-100)
    const failPenalty = Math.min(40, last_24h.failures * 5);
    const stalePenalty = cron_health.filter(c => !c.on_schedule).length * 12;
    const health_score = Math.max(0, 100 - failPenalty - stalePenalty);

    res.setHeader("Cache-Control","public, max-age=10, s-maxage=10");
    return res.status(200).json({
      ok: true,
      as_of: now.toISOString(),
      health_score,
      last_24h,
      last_7d,
      cron_health,
      recent_failures,
      total_rows_in_window: rows7d.length
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
