# Costs, pricing & the hosted-version plan

Undig is open source (MIT). Anyone can self-host it for the price of a Railway container and their own OpenAI usage — this page tells you exactly what that costs, and how a paid **hosted** version would be priced so the margin is out in the open. We'd rather show the math than hide it.

## 1. What one save costs (measured, Aug 2026)

Measured on a real library (3,900 saves, 77% reels), default "Standard" plan (`gpt-5.4-mini`, 4 low-detail frames, `gpt-4o-mini-transcribe`, `text-embedding-3-small`):

| Step | Typical tokens / units | List price | Cost per save |
|---|---|---|---|
| Analysis input (metadata + caption + transcript + tag vocabulary + 4 frames) | ~3,800 tokens | $0.75 / 1M | $0.0029 |
| Analysis output (structured JSON incl. reasoning) | ~600 tokens | $4.50 / 1M | $0.0027 |
| Transcription of a 40 s reel | 0.67 min | $0.003 / min | $0.0020 |
| Embedding | ~900 tokens | $0.02 / 1M | $0.00002 |
| **Reel, Standard** | | | **≈ $0.0076** |
| Image / carousel, Standard (no transcription, 1–6 frames) | | | ≈ $0.005 |
| **Reel, Economy** (`gpt-5.4-nano`, 2 frames, transcript ≤ 3 min) | | | **≈ $0.0032** |
| Reel, Economy, no transcription | | | ≈ $0.0012 |

Rules of thumb: **~$7.5 per 1,000 saves** on Standard, **~$3 per 1,000** on Economy, **~$1.2 per 1,000** if you skip transcription. The app records real token counts per save and shows *Spent so far* / *To finish current scope* on the Import page, and pauses itself when a budget cap is hit or the OpenAI account runs dry.

Levers (all in the Analysis plan panel): only saves from the last N years (estimated save date), media types, transcribe all / short reels only / never, 4 / 2 / 0 frames, Standard vs Economy, budget cap, per-item or per-creator **Exclude**.

Other per-user costs: **Ask** ≈ $0.004–0.01 per question (12 sources in context); daily Resurface notes ≈ $0.001/day; hosting ≈ $5/mo Railway Hobby for one container (2 GB RAM is plenty); storage ≈ 200 KB/save (thumb + 4 frames as WebP/JPEG) → 1 GB per 5,000 saves.

## 2. Self-hosting bill (one person)

| | One-time | Monthly |
|---|---|---|
| Analyze 4,000 saves, Standard | ~$30 | |
| …or Economy | ~$12 | |
| Keep up with ~100 new saves/mo | | ~$0.75 |
| Ask ~40 questions/mo | | ~$0.30 |
| Railway Hobby (container + 5 GB volume) | | ~$5 |
| **Typical** | **$12–30** | **≈ $6** |

## 3. Hosted version — unit economics

Assumptions per paying user: 3,000 saves at signup, 100 new saves/month, 40 questions/month, media stored 200 KB/save in object storage (Cloudflare R2, $0.015/GB-mo, no egress fees), Postgres row footprint negligible, shared workers.

| Cost line | Month 1 | Steady state / month |
|---|---|---|
| Initial analysis (Standard) | $22.50 | — |
| Initial analysis (Economy) | $9.00 | — |
| New saves | $0.75 | $0.75 |
| Ask | $0.30 | $0.30 |
| Storage 600 MB (R2) | $0.01 | $0.01 |
| Compute (shared, amortized ~$40/mo across users) | $0.40 | $0.40 |
| Payment processing (Paddle ~5% + $0.50) | ~$1.00 | ~$1.00 |
| **Total** | **$25 (Std) / $11.5 (Eco)** | **≈ $2.50** |

Pricing that keeps a healthy margin and stays honest:

| Plan | Price | What's in it | Gross margin |
|---|---|---|---|
| **Free / self-host** | $0 | this repo, your keys, your server | — |
| **Dig** (one-time) | **$19** | one full library dig, Economy tier, 3,000 saves included (+$4 per extra 1,000), Ask for 30 days, full export | ~45% |
| **Undig Pro** | **$9 / mo** or **$79 / yr** | up to 5,000 saves analyzed on Standard (fair use), continuous harvests, Ask, graph, exports, DM automations | month 1 −$16 (Std) → **payback in month 3–4**, then ~72% |
| **Pro + Deep** add-on | +$15 one-time | re-run the whole library on Standard 4-frame + full transcripts | ~50% |

Notes: the initial dig is the only expensive moment, so either charge for it once (Dig) or amortize it over a subscription with an annual plan default. Show the per-plan cost table on the pricing page — "your $9 covers about $2.5 of API + storage; the rest pays for the servers, the harvester upkeep and the person answering support."

## 4. Data retention (hosted)

- Active subscription: everything kept; media & analyses can be re-exported (JSON/CSV/Obsidian) at any time.
- Cancelled / lapsed: read-only for **30 days** (export still works), then **all media, analyses and vectors are deleted**; the account row keeps only email + invoice history (legal minimum). A reminder email goes out at day 7 and day 27.
- The retention job is a nightly cron: `DELETE FROM items WHERE tenant_id IN (SELECT id FROM tenants WHERE status='cancelled' AND cancelled_at < now()-30d)` + purge the tenant's R2 prefix.
- Storage per lapsed user is ~600 MB → holding it forever would cost real money at scale, hence the 30-day rule. Say so on the pricing page.

## 5. Technical plan for the hosted version

The open-source app stays single-tenant (SQLite + local files). The hosted product is the same codebase behind adapters:

1. **Tenancy**: `tenants` table; every table gets `tenant_id`; all queries scoped by the session's tenant. Postgres (Neon or Railway Postgres) with `pgvector` for embeddings (drop the in-memory matrix), FTS via `tsvector`.
2. **Auth**: email magic links (Resend) + Google OAuth via Auth.js/Lucia; the OSS passcode login becomes an adapter.
3. **Storage**: thumbnails/frames to Cloudflare R2 (S3 API) under `tenant/<id>/…`; served through signed URLs or a Worker.
4. **Workers**: the same pipeline as a separate Railway service, pulling jobs from a Postgres queue (`FOR UPDATE SKIP LOCKED`), per-tenant fairness (round-robin) and per-tenant budgets.
5. **Billing**: Paddle (merchant of record → handles VAT/sales tax globally). Overlay checkout, webhooks (`subscription.created/updated/canceled`, `transaction.completed`) → `tenants.plan/status`; Paddle customer portal for cancellations/invoices; usage caps enforced by the worker.
6. **Harvester**: unchanged — it runs in the user's browser; the "Send to Undig" token is minted per tenant.
7. **Ops**: Sentry, structured logs, cost dashboards (sum of `cost_usd` per tenant/day), the retention cron, backups (Neon PITR / R2 versioning).

Estimated effort: ~2–3 weeks for one engineer to reach a billable beta. What's needed to start: Paddle account (sandbox first), Cloudflare account (R2 bucket + API token), Neon (or Railway Postgres) DB, a domain, Resend (email), Sentry (optional).

## 6. Things worth adding next (roadmap)

- **Collections / smart folders** ("Recipes", "Content ideas") built from filters, shareable read-only links.
- **Weekly digest e-mail** — 5 undigd saves + what you saved this week, one click to Ask.
- **Chrome extension** — save-and-analyze any reel while browsing; auto-harvest new saves nightly.
- **Content-idea studio** — remix a save into a script/hook set for your niche (the `remix_idea` field is the seed).
- **Sensitive-content filter** — auto-exclude categories you pick (personal, adult, memes, ads) *before* paying for analysis; a "private mode" that keeps some saves local-only and never sends them to OpenAI.
- **Multi-account** — several Instagram accounts in one dashboard (creator + personal).
- **Threads / TikTok / YouTube likes** as extra sources.
- **DM automations v2** — quick-reply buttons, multi-step flows, follow gate.
- **Local models** — Whisper + a local vision LLM for zero-API-cost self-hosting.
