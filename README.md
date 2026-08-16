<p align="center">
  <img src="web/public/favicon.svg" width="64" height="64" alt="Resurfly" />
</p>
<h1 align="center">Resurfly</h1>
<p align="center"><b>Turn your Instagram Saves graveyard into structured, searchable, talkable inspiration.</b><br/>
Open source (MIT) · one Docker container · <a href="https://resurfly.com">resurfly.com</a> if you'd rather not host it</p>

<p align="center">
  <a href="https://resurfly.com">Hosted (3-day trial)</a> ·
  <a href="#quick-start-railway-10-minutes">Deploy on Railway</a> ·
  <a href="#run-it-locally">Run locally</a> ·
  <a href="docs/COMPANION.md">Companion</a> ·
  <a href="docs/HARVESTER.md">Harvester</a> ·
  <a href="docs/AUTOMATIONS.md">Connect Instagram & DM automations</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/BUSINESS.md">Costs & pricing</a> ·
  <a href="docs/FAQ.md">FAQ</a>
</p>

---

You saved 4,000 reels "for later". Later never came. Resurfly digs them all up and turns each one into clean, structured knowledge:

- **Every save, analyzed** — reels get transcribed (speech → text), key frames are read by a vision model, carousels are read slide by slide. Out comes a rephrased title, one-liner, summary, the actual key points (the 5 tips *are* the 5 tips), actionable takeaways, tags, category, entities (tools, people, brands, places), hook analysis, quotes, on-screen text, usefulness score, "why you probably saved this", and a remix idea for creators.
- **A dashboard you'll actually open** — a calm library with filters (category, tag, creator, format, collection, favorites, evergreen), full-text + semantic search, list/grid views, bulk actions, notes & your own tags.
- **Ask your Saves** *(the killer feature)* — conversations with your entire library, saved and resumable. Each question is routed to one of six modes: search your saves (hybrid retrieval, citations), your taste and patterns, ideas worth revisiting, a **content brief** built from what you save, your Instagram analytics, or plain chat. Suggested prompts come from your real data.
- **Resurface** — three deterministic daily picks from the depths, weighted toward useful, evergreen things you haven't looked at in a while, each with a one-line "why today".
- **Knowledge graph** — an interactive force-directed map of saves ↔ tags ↔ creators ↔ categories with similarity links, thumbnails on zoom, hover-highlighting and click-to-open.
- **Exports** — JSON, CSV (Notion/Sheets-ready), Markdown digest, and a full **Obsidian vault** zip (one note per save, frontmatter, tag notes, wikilinks).
- **Connect Instagram** — one click on the hosted version (Meta "Instagram API with Instagram Login" OAuth); self-hosters bring their own Meta app or paste a token. Tokens are stored encrypted and refreshed automatically; webhooks are subscribed for you.
- **Instagram DM automations ("ManyChat-lite")** — comment→DM funnels, keyword auto-replies and story-reply responders on Meta's official Messaging API. Three starter rules are created (off) the moment you connect; rules editor, dry-run tester, activity log. No monthly bot platform.
- **Instagram analytics** — followers and reach over 7/30/90 days, profile views, interactions, saves, best hours and days to post, content mix, top posts, hashtags — from the official Insights API, refreshed every 6 hours. Sample data until you connect, so the page is never blank.
- **Companion** (Chrome extension) — pairs with a one-time code and syncs new saves every 6 hours from your own logged-in browser. Optional: hand it your Instagram session (encrypted) so syncing continues while the browser is closed. See [docs/COMPANION.md](docs/COMPANION.md).
- **Onboarding** — a three-screen first run (bring your saves → watch the first notes appear → ask something) and a checklist on the overview with real progress numbers.
- **Four ways to import** — the Companion (recommended), the one-time browser **harvester** script (same data), the official **Instagram data export** ZIP, or **paste URLs**. Re-imports merge; nothing is duplicated.

## Self-host it, or let us run it

Same code, two ways to use it — the n8n model:

| | **Self-hosted** (this repo) | **Hosted** ([resurfly.com](https://resurfly.com)) |
|---|---|---|
| Price | Free (MIT). You pay Railway ~$5/mo + your own OpenAI usage (≈ $7.5 per 1,000 saves once). | 3-day trial, then **Pro $12/mo** or **Studio $34/mo** ([pricing](https://resurfly.com/pricing)). OpenAI is included. |
| Setup | ~10 minutes: Railway + a volume + an OpenAI key. | Sign up, install the Companion (or run the harvester once), done. |
| Who's it for | You like owning your data and your bill. | You want the result today and don't want to babysit a server. |
| Data | Your volume, your key, nothing leaves your box except the OpenAI calls. | Deleted 30 days after you cancel. Same privacy notes as [docs/PRIVACY.md](docs/PRIVACY.md). |
| Instagram (automations, analytics) | Bring your own Meta app (guide included) or paste a token. | One click: **Connect Instagram** on the Automations page. |
| Companion background sync | Optional (`SERVER_HARVEST_ENABLED`, off by default). | On. |

The hosted version runs this exact repository with `HOSTED=true` (multi-tenant mode: sign-up, plans, quotas, Paddle billing). Everything else — the harvester, the analysis, the graph — is identical. Costs and margins are published in [docs/BUSINESS.md](docs/BUSINESS.md); we'd rather you know what a reel costs to analyze than guess.

## How it works (30-second version)

```
instagram.com ─(Companion extension or harvester script, in your browser)─▶ JSON ─▶ Resurfly server ─▶ SQLite on a volume
                                                        │  downloads thumbs + video → ffmpeg frames + audio
                                                        │  OpenAI transcription (gpt-4o-mini-transcribe)
                                                        │  OpenAI structured analysis (vision, JSON schema)
                                                        │  OpenAI embeddings → semantic search / graph
graph.instagram.com ─(OAuth: Connect Instagram)─▶ webhooks (DMs, comments) + Insights (analytics)
                                                        ▼
            React dashboard (Overview · Library · Ask · Resurface · Graph · Import · Automations · Analytics · Settings)
```

Costs (OpenAI, measured): **≈ $0.0076 per reel on Standard, ≈ $0.003 on Economy** — roughly $7.5 (or $3) per 1,000 saves. You control the spend from the **Analysis plan** panel: only saves from the last N years, media types, transcription policy, frames, quality tier, a budget cap, and per-item / per-creator **Exclude**. Real per-save costs are tracked from token counts. Full breakdown, self-hosting bill and the hosted-version pricing math: [docs/BUSINESS.md](docs/BUSINESS.md).

## Quick start (Railway, ~10 minutes)

You need: a [Railway](https://railway.com) account, an [OpenAI API key](https://platform.openai.com/api-keys), and this repo forked/cloned.

1. **Create a project & service** in Railway (Empty service), connect it to your fork of this repo (or `railway up` from a clone — see below). Railway detects the `Dockerfile`.
2. **Add a Volume** to the service, mount path **`/data`** (Settings → Volumes). This is where the SQLite DB, thumbnails and frames live.
3. **Set variables** (Settings → Variables):

   | Variable | Required | What |
   |---|---|---|
   | `APP_USERNAME` | ✅ | your login |
   | `APP_PASSCODE` | ✅ | your passcode |
   | `OPENAI_API_KEY` | ✅ | for analysis / transcription / Ask (can also be set later in Settings) |
   | `DATA_DIR` | ✅ | `/data` |
   | `SESSION_SECRET` | recommended | any long random string (auto-generated if omitted) |
   | `OPENAI_MODEL` | optional | default `gpt-5.4-mini` |
   | `ANALYSIS_CONCURRENCY` | optional | `1`–`8`, default `3` |
   | `PUBLIC_URL` | optional | your public URL; auto-detected on Railway. Needed for the OAuth redirect and webhook URLs |
   | `META_APP_ID` / `META_APP_SECRET` | optional | your Meta app → enables **Connect Instagram** (OAuth) for automations + analytics; the secret also verifies webhooks. Without them, paste a token instead ([docs/AUTOMATIONS.md](docs/AUTOMATIONS.md)) |
   | `META_VERIFY_TOKEN` | optional | any string; the webhook handshake token you also enter in the Meta dashboard |
   | `IG_ACCESS_TOKEN` / `IG_USER_ID` | optional | manual alternative to OAuth (long-lived token + professional account id) |
   | `SERVER_HARVEST_ENABLED` | optional | `true` lets the Companion hand over an encrypted Instagram session so saves sync while the browser is closed. Default `false` self-hosted, `true` hosted |
   | `OWNER_PLAN` | optional | `owner` (unlimited, default) or `studio`/`pro`/`trial`/`free` to run your own account under a plan's limits |
   | `HOSTED` | optional | `true` turns on multi-tenant mode: sign-up, trial, plans, quotas, Paddle billing (`PADDLE_*`, `SIGNUPS_ENABLED`, `TRIAL_DAYS` — see `.env.example`). Leave unset to self-host |

   The full list with defaults and comments is in [`.env.example`](.env.example).

4. **Generate a domain** (Settings → Networking → Generate Domain). Deploy. Open the URL, log in.
5. Go to **Import** → install the Companion and pair it (or run the one-time harvester script). Analysis starts automatically and runs in the background (progress in the sidebar).

<details>
<summary><b>CLI version of the same</b> (from a clone of this repo)</summary>

```bash
npm i -g @railway/cli && railway login
railway init --name resurfly
railway add --service resurfly
railway volume add --mount-path /data
railway variables --set APP_USERNAME=you --set APP_PASSCODE=secret --set OPENAI_API_KEY=sk-... --set DATA_DIR=/data --skip-deploys
railway up --service resurfly --detach
railway domain --service resurfly
```
</details>

## Run it locally

```bash
git clone https://github.com/tairqaldy/resurfly.git resurfly && cd resurfly
cp .env.example .env            # set APP_USERNAME, APP_PASSCODE, OPENAI_API_KEY
npm install
npm run dev                     # API on :8080, Vite dev server on :5173 (proxied)
```

Or the production build in one process: `npm run build && npm start` → http://localhost:8080. Data lands in `./data` at the repo root (a relative `DATA_DIR` always resolves against the repo root, whichever directory you start from).
`ffmpeg` is bundled via `ffmpeg-static` for local dev; the Docker image installs it via apt.

Docker: `docker build -t resurfly . && docker run -p 8080:8080 --env-file .env -v resurfly-data:/data resurfly` — inside a container the data dir is always `/data` (a relative `DATA_DIR` from your `.env` is ignored there), so mount your volume at `/data`.

## Importing your saves

**Companion (recommended).** A small Chrome extension (`extension/`, Manifest V3, no bundler). Import → **Get pairing code** → paste it into the extension. The first sync walks your whole saved feed from your own logged-in browser (a few thousand saves ≈ 5–6 minutes); after that it checks the top of the feed every 6 hours and sends only new saves. Optional opt-in: hand Resurfly your Instagram session (encrypted) so it keeps syncing while the browser is closed. Install, pairing, what is sent: [docs/COMPANION.md](docs/COMPANION.md).

**Harvester script (one-time).** Same data, no extension: open instagram.com (logged in) → run the script (bookmarklet or DevTools console — both copied from your Import page) → Start → it pages through *all* your saves (~1 request/second; a few thousand saves take 20–40 min, resumable) and maps your collections → **Send to Resurfly** (token-gated direct upload) or download the JSON and drop it on the Import page. Media links inside expire in a few days, so don't wait. Details: [docs/HARVESTER.md](docs/HARVESTER.md).

**Instagram data export.** Accounts Center → Download your information → *Saved* (JSON) → upload the ZIP. Gives links, save dates and collections; captions/thumbnails are fetched best-effort from public embed pages. Combine with the Companion or harvester for full media.

**Paste URLs.** Any post/reel links, one per line.

Every import path goes through the same upsert, so re-importing merges: links refresh, analyses, notes and favorites stay.

## The analysis contract

Every save becomes one JSON object (see [`server/src/prompts/analysis.ts`](server/src/prompts/analysis.ts)):

`title · one_liner · summary · key_points[] · category (19 fixed) · subcategory · tags[] · content_type · why_saved_guess · actionable_takeaways[] · action_type · entities{people,brands,tools,places,books_media,products} · hook{text,style} · format_notes · on_screen_text · quotes[] · language · vibe · usefulness_score 1-10 · is_evergreen · resurface_prompt · remix_idea · confidence`

Generated with OpenAI Structured Outputs (strict JSON schema) from: caption + alt text + audio title + transcript + 4 sampled video frames (or up to 6 carousel slides) + metadata. Existing tags are fed back into the prompt so your library converges on a shared vocabulary.

## Connect Instagram: automations and analytics

Both features use Meta's **Instagram API with Instagram Login** (Graph API v23.0) — no Facebook Page needed. Two ways to connect:

- **Hosted / any server with `META_APP_ID` + `META_APP_SECRET`** — Automations → **Connect Instagram** → approve on Instagram → back in Resurfly with webhooks subscribed, three starter rules created (off) and analytics warming up. Tokens are stored encrypted (AES-256-GCM) and refreshed every 12 hours; Disconnect wipes them.
- **Bring your own Meta app** (self-host) — either set the two env vars above and use the same Connect button, or generate a long-lived token in the Meta dashboard and paste it in Settings → Integrations. ~15 minutes: [docs/AUTOMATIONS.md](docs/AUTOMATIONS.md).

Automations: comment→DM ("comment LINK and I'll DM you"), keyword auto-replies, story-reply responders; rules with cooldowns and priorities, a dry-run tester, an activity log. Analytics: followers/reach series, totals (profile views, interactions, saves, …), best time to post, content mix, top posts, hashtags — from the Insights API, cached and refreshed at most every 6 hours per account.

We evaluated [chatmany](https://github.com/ryanlaiyanip-ctrl/chatmany) and other open-source ManyChat alternatives; the verdict and comparison are in [docs/AUTOMATIONS.md#why-not-chatmany](docs/AUTOMATIONS.md#why-not-chatmany).

## Project layout

```
server/     Node 20+ · Hono · better-sqlite3 (FTS5) · sharp · ffmpeg · OpenAI SDK
web/        React 19 · Vite · Tailwind v4 · Motion · TanStack Query · react-force-graph
harvester/  core.js (shared Instagram feed normalizer, ESM) + the console/bookmarklet script built from it (served at /harvester.js)
extension/  Resurfly Companion — Chrome extension (Manifest V3, plain JS, imports harvester/core.js)
docs/       setup guides · docs/legal/ terms + refunds · docs/dev/ internal specs
Dockerfile  single image: build web + server, runtime with ffmpeg
```

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security notes

- Self-hosted: single user. Login = username + passcode from env, HMAC-signed httpOnly cookie, login rate-limited. Hosted: one tenant per account, every query scoped by tenant.
- Media files (`/media/*`) require the session cookie. The harvester script is public (it contains nothing secret).
- Secrets live in env vars or in the SQLite `settings` table on your volume — never in the repo. Instagram OAuth tokens and Companion sessions are encrypted at rest with a key derived from `SESSION_SECRET`. Rotate your OpenAI key if you ever paste it anywhere public.
- The Companion and the harvester talk to instagram.com from your own browser session. The server only touches Instagram through the official Graph API — or, only if you opt in from the Companion, through the session you handed it.

## License

MIT — do whatever you want, a link back is appreciated.
