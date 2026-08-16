<p align="center">
  <img src="web/public/favicon.svg" width="64" height="64" alt="Resurfly" />
</p>
<h1 align="center">Resurfly</h1>
<p align="center"><b>Turn your Instagram Saves graveyard into structured, searchable, talkable inspiration.</b><br/>
Self-hosted · single user · open source (MIT) · one Docker container</p>

<p align="center">
  <a href="#quick-start-railway-10-minutes">Deploy on Railway</a> ·
  <a href="#run-it-locally">Run locally</a> ·
  <a href="docs/HARVESTER.md">Harvester</a> ·
  <a href="docs/AUTOMATIONS.md">DM automations</a> ·
  <a href="docs/ARCHITECTURE.md">Architecture</a> ·
  <a href="docs/BUSINESS.md">Costs & pricing</a> ·
  <a href="docs/FAQ.md">FAQ</a>
</p>

---

You saved 4,000 reels "for later". Later never came. Resurfly digs them all up and turns each one into clean, structured knowledge:

- **Every save, analyzed** — reels get transcribed (speech → text), key frames are read by a vision model, carousels are read slide by slide. Out comes a rephrased title, one-liner, summary, the actual key points (the 5 tips *are* the 5 tips), actionable takeaways, tags, category, entities (tools, people, brands, places), hook analysis, quotes, on-screen text, usefulness score, "why you probably saved this", and a remix idea for creators.
- **A dashboard you'll actually open** — a calm library with filters (category, tag, creator, format, collection, favorites, evergreen), full-text + semantic search, list/grid views, bulk actions, notes & your own tags.
- **Ask your Saves** *(the killer feature)* — chat with your entire library. Hybrid retrieval (embeddings + keywords) → answers with clickable citations. "What did I save about cold email?" actually works.
- **Resurface** — three deterministic daily picks from the depths, weighted toward useful, evergreen things you haven't looked at in a while, each with a one-line "why today".
- **Knowledge graph** — an interactive force-directed map of saves ↔ tags ↔ creators ↔ categories with similarity links, thumbnails on zoom, hover-highlighting and click-to-open.
- **Exports** — JSON, CSV (Notion/Sheets-ready), Markdown digest, and a full **Obsidian vault** zip (one note per save, frontmatter, tag notes, wikilinks).
- **Instagram DM automations ("ManyChat-lite")** — keyword auto-replies, comment→DM funnels and story-reply responders on Meta's official Instagram Messaging API. Rules, dry-run tester, activity log. No monthly bot platform.
- **Three ways to import** — the browser **harvester** (richest: captions, stats, media → transcripts & frames), the official **Instagram data export** ZIP, or **paste URLs**. Re-imports merge; nothing is duplicated.

> Built as a control center for one Instagram account. It is deliberately not multi-tenant.

## How it works (30-second version)

```
instagram.com ─(harvester, in your browser)─▶ JSON ─▶ Resurfly server ─▶ SQLite on a volume
                                                        │  downloads thumbs + video → ffmpeg frames + audio
                                                        │  OpenAI transcription (gpt-4o-mini-transcribe)
                                                        │  OpenAI structured analysis (vision, JSON schema)
                                                        │  OpenAI embeddings → semantic search / graph
                                                        ▼
                                          React dashboard (Library · Ask · Resurface · Graph · Import · Automations)
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
   | `PUBLIC_URL` | optional | your public URL; auto-detected on Railway |

4. **Generate a domain** (Settings → Networking → Generate Domain). Deploy. Open the URL, log in.
5. Go to **Import** → follow the harvester steps → drop the JSON. Analysis starts automatically and runs in the background (progress in the sidebar).

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

**Harvester (recommended).** Open instagram.com (logged in) → run the harvester (bookmarklet or paste into DevTools console — both copied from your Import page) → Start → it pages through *all* your saves (~1 request/second; a few thousand saves take 20–40 min, resumable) and maps your collections → click **Send to Resurfly** (token-gated direct upload) or download the JSON and drop it on the Import page. Media links inside expire in a few days, so don't wait. Details, privacy notes and troubleshooting: [docs/HARVESTER.md](docs/HARVESTER.md).

**Instagram data export.** Accounts Center → Download your information → *Saved* (JSON) → upload the ZIP. Gives links, save dates and collections; captions/thumbnails are fetched best-effort from public embed pages. Combine with the harvester for full media.

**Paste URLs.** Any post/reel links, one per line.

## The analysis contract

Every save becomes one JSON object (see [`server/src/prompts/analysis.ts`](server/src/prompts/analysis.ts)):

`title · one_liner · summary · key_points[] · category (19 fixed) · subcategory · tags[] · content_type · why_saved_guess · actionable_takeaways[] · action_type · entities{people,brands,tools,places,books_media,products} · hook{text,style} · format_notes · on_screen_text · quotes[] · language · vibe · usefulness_score 1-10 · is_evergreen · resurface_prompt · remix_idea · confidence`

Generated with OpenAI Structured Outputs (strict JSON schema) from: caption + alt text + audio title + transcript + 4 sampled video frames (or up to 6 carousel slides) + metadata. Existing tags are fed back into the prompt so your library converges on a shared vocabulary.

## Instagram DM automations

Comment-to-DM ("comment LINK and I'll DM you"), keyword auto-replies, story-reply responders. Uses the **Instagram API with Instagram Login** — no Facebook Page, no App Review for your own account. Setup takes ~15 minutes in the Meta developer dashboard: [docs/AUTOMATIONS.md](docs/AUTOMATIONS.md).

We evaluated [chatmany](https://github.com/ryanlaiyanip-ctrl/chatmany) and other open-source ManyChat alternatives; the verdict and comparison are in [docs/AUTOMATIONS.md#why-not-chatmany](docs/AUTOMATIONS.md#why-not-chatmany).

## Project layout

```
server/     Node 20+ · Hono · better-sqlite3 (FTS5) · sharp · ffmpeg · OpenAI SDK
web/        React 19 · Vite · Tailwind v4 · Motion · TanStack Query · react-force-graph
harvester/  the browser script (also served at /harvester.js and as a bookmarklet)
docs/       setup guides
Dockerfile  single image: build web + server, runtime with ffmpeg
```

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security notes

- Single user. Login = username + passcode from env, HMAC-signed httpOnly cookie, login rate-limited.
- Media files (`/media/*`) require the session cookie. The harvester script is public (it contains nothing secret).
- Secrets live in env vars or in the SQLite `settings` table on your volume — never in the repo. Rotate your OpenAI key if you ever paste it anywhere public.
- The harvester only talks to instagram.com from your own browser session; the server never logs into Instagram.

## License

MIT — do whatever you want, a link back is appreciated.
