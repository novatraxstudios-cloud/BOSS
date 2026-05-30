# B.O.S.S. — Deploy to Your Own URL

This folder is everything you need to put B.O.S.S. on a public URL with a custom domain. Fastest path is Vercel: free, gives HTTPS automatically (needed for the wake-word microphone), and runs a daily cron that fires the autonomous briefing.

```
boss-deploy/
├── index.html           ← the BOSS Command Nexus (frontend voice agent)
├── vercel.json          ← static config + daily cron at 13:00 UTC
├── package.json
├── api/
│   ├── briefing.js      ← serverless function: generates + emails the briefing
│   └── latest.js        ← lets the UI pull the most recent briefing
└── README-DEPLOY.md     ← this file
```

---

## Option A — Fastest (drag & drop, ~2 minutes)

1. Open <https://vercel.com/new>.
2. Drag the entire `boss-deploy` folder onto the page (or zip it first).
3. Click **Deploy**. You get a URL like `https://boss-command-nexus-xyz.vercel.app`.
4. Settings → **Domains** → add `boss.yourname.com` (or whatever). Vercel handles HTTPS.
5. Open Configure in the UI, paste your ElevenLabs key (voice ID already saved) and your OpenAI key, hit Save.
6. Click **Arm listener**, allow mic, say *"Hey BOSS."*

That's it for the voice cockpit. To get autonomous morning emails, do the env-var step below.

---

## Option B — Vercel CLI (one shot)

```bash
cd boss-deploy
npm i -g vercel
vercel login
vercel link        # create or link the project
vercel --prod
```

---

## Environment variables (for autonomous email)

In Vercel → Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-...` (your OpenAI key) |
| `RESEND_API_KEY` | `re_...` (free at https://resend.com — verify a sender domain first) |
| `REPORT_FROM` | `boss@yourdomain.com` (must be a verified Resend sender) |
| `REPORT_TO` | `meka.anyanwu@gmail.com` |
| `CRON_SECRET` | any random string. Vercel sends this header automatically to cron paths. |

Redeploy after saving env vars. Vercel Cron will hit `/api/briefing` daily at **13:00 UTC** (08:00 CDT / 07:00 CST during winter). BOSS generates the briefing via OpenAI and emails it via Resend.

Manual test — visit `https://YOUR-URL/api/briefing?secret=YOUR_CRON_SECRET` in the browser. You should see the JSON briefing returned and an email arrive.

---

## What's autonomous vs what needs the browser open

| Capability | Browser open required? |
|---|---|
| Daily 08:00 CT briefing email | **No** — runs server-side via Vercel Cron |
| Voice wake word "Hey BOSS" | Yes — speech recognition is browser-only |
| ElevenLabs voice playback | Yes — audio plays in browser |
| Conversational Q&A via OpenAI | Browser (your key) or server (env-var key) |
| Per-agent live status | Browser |
| Op-card animations / brain canvas | Browser |

For full Iron Man cockpit ↔ background brain split, leave the page pinned on a tab or run it on a kiosk display. The cron does its work regardless.

---

## Privacy notes

- Personal seed (Meka's identity, projects, trading style, etc.) is embedded in `index.html` JavaScript.
- **Highly sensitive fields are stripped before any cloud call**: street address, girlfriend's name, ex-relationship details. Toggle "Send sensitive memory to OpenAI" in Configure if you want to override (off by default).
- Your ElevenLabs + OpenAI keys live in the browser's `localStorage` for client-side calls, and in Vercel environment variables for the server-side cron. They never travel anywhere else.
- If you ever fork this repo public, **delete the seed block** from `index.html` first or move it to a server-side env var.

---

## Next phase upgrades

The mock briefing pipeline in `index.html` runs against canned `DATA`. To make the live UI pull from real OpenAI runs, swap the front-end's `runBriefing()` to `fetch("/api/latest")` after deploy and parse the returned JSON into `DATA.top` / `DATA.ranking` / `DATA.kills`. Ask me to wire it.

For real autonomous web research (Friday actually scraping Reddit / Product Hunt / App Store reviews), add a Tavily or Brave Search step to `api/briefing.js` before the OpenAI call and pass the search results in as context.

For persistent report history + dashboard, add Supabase: insert each briefing into a `daily_reports` table from `api/briefing.js`, then `/api/latest` reads from the table instead of regenerating.
