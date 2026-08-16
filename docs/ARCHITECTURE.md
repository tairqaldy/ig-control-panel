# Architecture

One Docker container. One SQLite file. No queues, no Redis, no Postgres, no serverless functions. The same image runs single-tenant (self-host, `HOSTED=false`, tenant 1 = you) and multi-tenant (resurfly.com, `HOSTED=true`: sign-up, plans, quotas, Paddle).

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Docker (node:22-bookworm-slim + ffmpeg)                                        │
│                                                                                │
│  Hono HTTP server (server/src)                                                 │
│   public (no session)                                                          │
│   ├─ /api/auth              login · signup (hosted) · me                       │
│   ├─ /api/webhooks/instagram Meta webhook (GET verify, POST events)            │
│   ├─ /api/webhooks/paddle   billing events (signature-verified)                │
│   ├─ /api/instagram/callback|deauthorize|delete   OAuth return + Meta callbacks│
│   ├─ /api/companion/pair · state · harvest · session   device-token (Bearer cmp_…) │
│   ├─ /api/plans · /api/health · /harvester.js · /api/import/harvest-form       │
│   session (cookie, tenant-scoped)                                              │
│   ├─ /api/items             list/filter/search, detail (+related), patch, bulk │
│   ├─ /api/import            harvester JSON · Instagram export ZIP · URLs       │
│   ├─ /api/jobs              status · pause · resume · queue · clear · reindex  │
│   ├─ /api/export            json · csv · md · obsidian(zip)                    │
│   ├─ /api/ask               SSE answer · conversations · suggestions · stats   │
│   ├─ /api/resurface         daily picks (deterministic per day) + notes        │
│   ├─ /api/graph             nodes/links for the knowledge graph                │
│   ├─ /api/automations       rules · events · contacts · test · send-test · starter │
│   ├─ /api/instagram         connect · account · analytics · status             │
│   ├─ /api/companion         pair-code · devices · runs · notice                │
│   ├─ /api/onboarding        checklist state + events                           │
│   ├─ /api/plan · /api/billing · DELETE /api/account   (hosted)                 │
│   ├─ /api/settings          editable settings, tests, storage                  │
│   ├─ /media/*               thumbnails & frames (cookie + tenant check)        │
│   └─ /*                     React SPA (web/dist)                               │
│                                                                                │
│  In-process jobs                                                               │
│   ├─ Worker: queue_state='queued' → media → transcribe → analyze → embed → neighbors │
│   │   (per-tenant concurrency, round-robin, plan quotas)                       │
│   ├─ Instagram: OAuth token refresh every 12 h; analytics refresh ≤ every 6 h  │
│   └─ Companion: every 30 min, server-side saved-feed harvest for opted-in      │
│       tenants whose last run is > 12 h old (SERVER_HARVEST_ENABLED)           │
│                                                                                │
│  SQLite (better-sqlite3, WAL) at $DATA_DIR/resurface.db                        │
│   tenants · users · usage                                   (hosted mode)      │
│   items · item_tags · item_neighbors · items_fts (FTS5) · imports              │
│   settings · meta (PK tenant_id,key; tenant 0 = global)                        │
│   automation_rules · automation_events · automation_contacts                   │
│   ig_accounts · ig_media · ig_insights_daily · ig_snapshots  (Connect + analytics) │
│   companion_devices · harvest_runs                          (Companion)        │
│   conversations · messages                                  (Ask v2)           │
│  Files: $DATA_DIR/media/<id>/thumb.webp, frame_N.jpg, slide_N.webp             │
└────────────────────────────────────────────────────────────────────────────────┘
```

Route registration for the round-5 features lives in `server/src/routes/extra.ts` (`mountPublicExtras` / `mountProtectedExtras`) so feature modules add one line each instead of touching `app.ts`. Migrations are files under `server/src/migrations/00N-*.ts` registered in `migrations/index.ts`.

## Pipeline per item (`server/src/services/pipeline.ts`)

1. **Media stage** — download the thumbnail (→ WebP 640px via sharp). Video: download → `ffmpeg` extracts 4 frames at 12/38/64/90% (640px JPEG) and a mono 16k mp3 → OpenAI transcription (`gpt-4o-mini-transcribe`) → video deleted (unless `KEEP_VIDEOS=true`). Carousel: up to 6 slides. URL-only items (from the Instagram export / pasted links) get enriched from the public embed page (`/p/<code>/embed/captioned/`, which server-renders for non-browser user agents and often includes a direct `video_url` for reels).
2. **Analysis stage** — one Responses API call with a strict JSON schema (`prompts/analysis.ts`), inputs: metadata + caption + alt text + transcript + images (`detail: low`) + the library's top existing tags ("preferred vocabulary"). Output normalized (tags kebab-cased/singularized, scores clamped), stored as JSON, tags exploded into `item_tags`, FTS row rebuilt.
3. **Embedding stage** — `text-embedding-3-small` (512 dims) over title/summary/key points/tags/entities/caption/transcript excerpt. Stored as a BLOB; an in-memory matrix (per tenant) serves semantic search. Top-8 neighbors per item are maintained incrementally (`item_neighbors`), including reverse edges — no O(N²) rebuild needed (but `POST /api/jobs/reindex` can rebuild everything).

Statuses are persisted per stage (`media_status`, `analysis_status`, `queue_state`) so the pipeline is idempotent and resumable across restarts. Concurrency is a setting (1–8). 429s trigger a short back-off. Every metered thing (analyze, ask, sends, harvests, rules) goes through `services/plans.ts` (`checkQuota` / `bumpUsage`) and answers HTTP 402 with `{ code: 'quota', metric, used, limit, plan }` when a plan is exhausted; the owner tenant is unlimited unless `OWNER_PLAN` says otherwise.

## Import paths (`services/importers.ts`)

All four sources produce `HarvestItem[]` and go through the same `upsertItems` + `afterImport`, so re-imports merge (links refresh, analyses/notes/favorites stay):

- **Companion** (`services/companion.ts`, `routes/companion.ts`) — the Chrome extension pairs with a 5-minute single-use code (`RSF-XXXX-XXXX`) and receives a device token `cmp_<48 hex>` (only its sha256 is stored in `companion_devices`). It calls `GET /api/companion/state` (newest 500 known Instagram ids, totals, today's harvest allowance) and posts chunks of ≤ 100 items to `POST /api/companion/harvest`; one run = one `harvests` quota unit; runs are logged in `harvest_runs` (`source` = companion | server | script | zip | urls). Optional opt-in: the extension sends the Instagram session (`sessionid`, `csrftoken`, `ds_user_id`, UA) to `POST /api/companion/session`; it is stored AES-256-GCM-encrypted and a 30-minute scheduler walks the saved feed server-side (`SERVER_HARVEST_ENABLED`). On 401/403/429 or a login page the session is marked invalid and a per-tenant notice (`meta.companion_notice`) tells the user to reconnect. Cookies are never logged.
- **Harvester script** — `harvester/harvester.js`, served at `/harvester.js`; the console/bookmarklet flow. `POST /api/import/harvest` (session) or `/api/import/harvest-form` (24-hour upload token from the Import page).
- **Instagram data export ZIP**, **pasted URLs** — `POST /api/import/instagram-export`, `/api/import/urls`.

`harvester/core.js` is the shared, dependency-free ESM module (endpoint paths, headers, `normalizeItem`, login-page heuristics) imported by the server's background harvester, copied into `extension/lib/core.js`, and inlined into `harvester.js` by `node harvester/build.mjs`.

## Instagram (`services/instagram.ts`, `services/ig-analytics.ts`, `services/automations.ts`)

- **Connect** — `GET /api/instagram/connect` redirects to `instagram.com/oauth/authorize` with an HMAC-signed `state` (tenant, user, 10-minute expiry) and the scopes `instagram_business_basic, …manage_messages, …manage_comments, …manage_insights`. The callback exchanges the code, upgrades to a long-lived token, loads the profile, upserts `ig_accounts` (token encrypted with `services/crypto.ts`, key = sha256(`SESSION_SECRET` + ':ig')), mirrors `ig_user_id` / `ig_access_token` into the tenant's settings so the automations engine works unchanged, subscribes webhooks, creates three disabled starter rules if the tenant has none, warms the analytics cache and redirects to `/automations?connected=1`. Tokens with < 10 days left are refreshed every 12 h. Env `IG_ACCESS_TOKEN`/`IG_USER_ID`/`META_*` still apply to tenant 1 when no OAuth row exists.
- **Meta callbacks** — `POST /api/instagram/deauthorize` and `/delete` parse Meta's `signed_request` (base64url HMAC-SHA256 with the app secret) and disconnect (delete additionally wipes automation contacts/events + analytics cache and returns a confirmation code).
- **Webhooks** — `/api/webhooks/instagram` routes each payload to the tenant whose `ig_user_id` matches, verifies `X-Hub-Signature-256` with that tenant's app secret (OAuth tenants inherit the server's), then evaluates rules (`handleIncoming`).
- **Analytics** — `refreshAnalytics(tid)`: profile counts → `ig_snapshots`; account insights (time-series `reach, follower_count` and `metric_type=total_value` totals) → `ig_insights_daily`; media (2 × 50) + per-media insights → `ig_media`. Sequential, ≤ 120 requests, at most every 6 h per tenant (forced refresh hourly, owner any time). `GET /api/instagram/analytics?range=7|30|90` derives best hours/days, content mix, engagement rate, top posts and hashtags server-side; when not connected it returns `demo: true` with `services/ig-analytics-demo.json`.

## Ask (`services/ask.ts`, `routes/ask.ts`)

`POST /api/ask` (SSE) takes `{ question, conversationId?, intent? }`. A cheap structured call (`gpt-5.4-nano`, regex fallback) picks one of six intents — `library` (hybrid retrieval, 12 sources, `[#n]` citations) · `stats` (a `statsSummary` of counts by category/creator/format/month, spend, evergreen, top tags) · `inspire` (evergreen high-usefulness saves + their `resurface_prompt`) · `create` (a content brief from `remix_idea`, `hook`, `format_notes`, `key_points`) · `analytics` (the 30-day Instagram payload when connected) · `chat`. The stream emits `meta` `{ conversationId, title, intent }` first, then `sources`, tokens, and `done` `{ conversationId, quota }`. Conversations and messages persist in `conversations` / `messages` (title improved by a nano call after the first answer); `GET /api/ask/suggestions` builds 8 prompts from the tenant's real data.

## Search

- Keyword: FTS5 (`unicode61`, diacritics removed) with weighted BM25 across title/summary/key points/tags/caption/transcript/author/entities; tokens are prefix-matched.
- Semantic: cosine over the in-memory embedding matrix (fine up to ~20k items).
- Library search combines both (semantic toggle); **Ask** fuses both with reciprocal-rank fusion, sends the top 12 as context, and streams the answer with `[#id]` citations that the UI turns into clickable chips.

## Frontend (`web/`)

React 19 + Vite + Tailwind v4 (design tokens as CSS variables, light/dark), Motion for animations, TanStack Query for data, react-router, cmdk (⌘K palette), sonner (toasts), react-force-graph-2d (canvas graph with custom node painting, thumbnails at zoom ≥1.6, hover-dim, focus mode). Pages: Overview (onboarding checklist / Ask hero), Library, Ask (conversation rail + streaming), Resurface, Graph, Import (Companion · script · advanced), Automations (connect card · quick start · rules · activity), Analytics, Settings (Integrations · Companion · Data), Welcome (3-screen first run), Billing (hosted), Landing / Pricing / Legal (public). Heavy pages are lazy-loaded.

Design: "bone / ink / jade" — warm paper background with a faint grain, Instrument Serif display type, Instrument Sans UI, Geist Mono for metadata, one jade accent used as punctuation.

## Extension (`extension/`)

Manifest V3, plain JavaScript, no bundler. `background.js` (service worker: 6-hour alarm → sync, resumable first run, badge), `popup.*` (pair, status, Sync now, the server-side opt-in switch), `options.*` (app URL for self-hosters via `chrome.permissions.request`, unpair), `lib/core.js` (copy of `harvester/core.js`), `lib/sync.js` (pagination, stop rules, chunked upload, login detection), `lib/api.js`, `lib/store.js`. Host permissions: `https://www.instagram.com/*` and `https://resurfly.com/*` only; `cookies` is optional and requested only for the background-harvest opt-in. Details: [COMPANION.md](COMPANION.md).

## Backups (`services/backup.ts`)

Optional, on when `R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY` are set (any S3-compatible bucket; we use Cloudflare R2). Once a day at `BACKUP_HOUR_UTC` (03:00 by default) the server runs `VACUUM INTO` (a consistent snapshot, safe with WAL), gzips it and PUTs `backups/resurface-YYYYMMDD-HHmm.db.gz` with a hand-rolled SigV4 request (no SDK), then prunes to `BACKUP_KEEP` (14). Owner endpoints: `GET /api/admin/backup` (status + object list) and `POST /api/admin/backup` (run now). Media (thumbnails/frames) is not included — it is re-fetchable and not needed to restore the notes; to restore, gunzip the file to `$DATA_DIR/resurface.db` while the server is stopped.

## Security model

- Session cookie `rs_session` = base64url(payload).HMAC-SHA256(secret); payload carries tenant + user; 30 days; `Secure` when behind HTTPS (`x-forwarded-proto`). Self-host: credentials from env; hosted: scrypt password hashes in `users`.
- All `/api/*` except the public list above require the session and are scoped to the session's tenant. `/media/*` checks the item belongs to that tenant.
- Webhook POSTs verified with `X-Hub-Signature-256`; Paddle with `Paddle-Signature`; Companion device calls with a hashed bearer token; Meta callbacks with `signed_request`.
- Instagram OAuth tokens and Companion sessions are AES-256-GCM-encrypted with keys derived from `SESSION_SECRET`. Other settings stored in SQLite are plaintext on the volume; env vars override them for tenant 1 and are shown as locked in the UI.

## Extending

- New import source → implement a `HarvestItem[]` producer in `services/importers.ts` and call `upsertItems` (+ `afterImport`).
- New analysis field → add it to `ANALYSIS_JSON_SCHEMA` + `Analysis` type; it flows into exports automatically (JSON/MD; add a CSV column in `exporters.ts`).
- New Ask mode → add the intent to `ASK_INTENTS`, its context builder in `services/ask.ts`, and a mode chip in `web/src/pages/Ask.tsx`.
- Different LLM provider → `services/openai.ts` is the only place that talks to OpenAI (`OPENAI_BASE_URL` works for compatible gateways).
- New feature routes → one line in `routes/extra.ts`; new tables → a new `migrations/00N-*.ts`.
