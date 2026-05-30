# B.O.S.S. → Your Own URL — Step-by-Step (Zero Prior Experience)

Total time: 15 minutes for Phase 1. Another 10 for Phase 2 (autonomous email).

Two phases. Do Phase 1 first. It gets BOSS on a live URL you can talk to.

---

## PHASE 1 — Get BOSS on a live URL (no terminal, no code)

### Step 1 — Find the `boss-deploy` folder on your Mac

1. Click the desktop, then in the top menu bar click **Go → Go to Folder…** (or press `Cmd + Shift + G`).
2. Paste this exact path and press Enter:
   ```
   ~/Library/Application Support/Claude/local-agent-mode-sessions
   ```
3. You'll see folders with long random IDs. Open the most recent one (sort by Date Modified).
4. Drill in: `<session-id>` → `<session-id>` → `local_<...>` → `outputs`.
5. Inside `outputs` you'll see `boss-deploy`. **Drag that folder to your Desktop** so it's easy to find.

### Step 2 — Make a free GitHub account

GitHub is just a place online to store the folder. Vercel reads from GitHub to publish your site.

1. Go to <https://github.com/signup>.
2. Sign up with your email. Choose a username (e.g. `mekatron`). Verify your email.

### Step 3 — Upload `boss-deploy` to GitHub

1. After logging in, click the green **New** button (or go to <https://github.com/new>).
2. **Repository name:** `boss` (or anything you want).
3. Leave it **Public** (or Private if you prefer — either works).
4. **Don't** check "Add a README." Just click **Create repository**.
5. On the next page, look for the link that says **"uploading an existing file"** (it's in the middle of the page). Click it.
6. Open Finder, navigate to the `boss-deploy` folder on your Desktop, open it, and select **everything inside** (not the folder itself — the files inside: `index.html`, `vercel.json`, `package.json`, `README-DEPLOY.md`, `WALKTHROUGH.md`, and the `api` folder).
7. Drag all selected items into the GitHub upload box.
8. At the bottom, in the **Commit changes** box, type "first commit" and click the green **Commit changes** button.
9. Wait 10 seconds. You should see your files listed.

### Step 4 — Make a free Vercel account (sign in with GitHub)

1. Go to <https://vercel.com/signup>.
2. Click **Continue with GitHub**. Authorize.
3. When asked about a plan, pick **Hobby (Free)**.
4. When asked for a team name, use whatever you want (e.g. `mekatron`).

### Step 5 — Deploy

1. After signup you'll be at the Vercel dashboard. Click **Add New… → Project** (top right).
2. You'll see your GitHub repos. Find `boss` and click **Import**.
3. Vercel will detect it as a static project. **Don't change anything.** Just click the big **Deploy** button at the bottom.
4. Wait 30–60 seconds. You'll see a confetti animation.
5. Click **Continue to Dashboard**, then click the URL Vercel gave you (something like `https://boss-xyz.vercel.app`).

**You now have BOSS live on a public HTTPS URL.** That's the foundation.

### Step 6 — Open BOSS and paste your keys

1. On the live URL, click the **System → Configure** button (bottom right of the footer).
2. Paste your **ElevenLabs key** in the `ElevenLabs key` field. (Voice ID is already pre-filled.)
3. Paste your **OpenAI key** in the `OpenAI key (reasoning brain)` field.
4. Leave the rest at defaults.
5. Click **Save configuration**.

### Step 7 — Arm the listener and talk to BOSS

1. Click **Wake word → Arm listener**.
2. Your browser will pop up "boss-xyz.vercel.app wants to use your microphone." Click **Allow**.
3. Say **"Hey BOSS"** out loud.
4. BOSS should greet you with your time-of-day greeting and your voice.
5. Try: *"What is Friday doing right now?"* / *"Run the briefing"* / *"Explain that"*.

**Phase 1 done.** You have BOSS on a URL. You can stop here for now, or continue to Phase 2 for autonomous morning emails.

---

## PHASE 2 — Autonomous morning email at 8am (optional, ~10 min)

This makes BOSS generate a real briefing every morning and email it to you, *even when your browser is closed.*

### Step 8 — Make a free Resend account (email sender)

1. Go to <https://resend.com/signup>. Sign up with your email.
2. After login, on the left sidebar click **API Keys → Create API Key**.
3. Name it `boss`. Permission: **Full access**. Click **Add**.
4. **Copy the key now** (`re_...`). You won't see it again. Paste it into a temporary note.

### Step 9 — Verify a sender domain (or use Resend's test address for now)

Easiest path for first run — use Resend's onboarding sandbox:

1. In Resend dashboard go to **Domains**.
2. You'll see `onboarding@resend.dev` as a verified sandbox sender. **You can only send to your own login email with this**, which is perfect for testing.
3. For real use, click **Add Domain** → use any domain you own → follow the DNS instructions (one-time, ~3 min).

For now, just use `onboarding@resend.dev` as the sender and send to your own email.

### Step 10 — Add environment variables to Vercel

1. Go to your Vercel project dashboard.
2. Click **Settings** (top tab) → **Environment Variables** (left menu).
3. Add each of these one by one, clicking **Save** after each:

   | Name | Value |
   |---|---|
   | `OPENAI_API_KEY` | Your OpenAI key (`sk-...`) |
   | `RESEND_API_KEY` | Your Resend key (`re_...`) |
   | `REPORT_FROM` | `onboarding@resend.dev` (or your verified domain) |
   | `REPORT_TO` | `meka.anyanwu@gmail.com` |
   | `CRON_SECRET` | Any random string you make up. Example: `bossKingMeka2026` |

4. After adding all five, click **Deployments** (top tab), find the latest deployment, click the **⋯** menu → **Redeploy**. (Env vars only apply after redeploy.)

### Step 11 — Test the autonomous briefing manually

1. In your browser, go to:
   ```
   https://YOUR-VERCEL-URL/api/briefing?secret=YOUR_CRON_SECRET
   ```
   (Replace with your actual URL and the secret you made up.)
2. You'll see a JSON response — that's BOSS's full briefing.
3. **Check your email** — the same briefing should arrive at the address in `REPORT_TO` within a minute.

If it worked, the daily 8am cron is now active. Vercel fires it at 13:00 UTC every day (= 8am CDT, 7am CST). It runs whether your browser is open or not.

### Step 12 — Add a custom domain (optional, ~5 min)

Want `boss.yourname.com` instead of `boss-xyz.vercel.app`?

1. In Vercel project → **Settings → Domains** → enter your domain.
2. Vercel shows you a DNS record to add at your domain registrar (GoDaddy, Cloudflare, Namecheap, etc.).
3. Add the record in your registrar's DNS panel. Wait 1–10 minutes for it to propagate.
4. Vercel automatically issues HTTPS. Done.

---

## Troubleshooting cheat sheet

| What you see | What to do |
|---|---|
| Mic icon never prompts | Make sure URL is HTTPS (Vercel URLs are). Reload page, click Arm listener again. |
| BOSS says nothing after wake word | Open the live feed panel on the right — check what error logged. Most likely no ElevenLabs key or no OpenAI key. |
| ElevenLabs 401 | Wrong key. Re-paste in Configure. |
| OpenAI 401 | Wrong key. Re-paste in Configure. |
| Cron didn't fire at 8am | Check Vercel → Project → Logs → Functions. You should see a `/api/briefing` invocation at ~13:00 UTC. |
| Resend "domain not verified" | Use `onboarding@resend.dev` as `REPORT_FROM` and send to your own email, or verify a domain. |
| Page looks broken on phone | The cockpit is desktop-first. Open on Mac/iPad for the full HUD. |

---

## What changes vs what stays the same

- **You edit anything in the code:** push changes to GitHub (commit), Vercel auto-deploys in 30 seconds.
- **You add a new env var:** in Vercel → Settings → Environment Variables → Save → Redeploy.
- **You want to change your wake word, voice ID, or schedule time:** do it in the live UI's Configure drawer. It saves in your browser. (Server-side defaults can be updated in `api/briefing.js` if you want them baked in.)

You're live.
