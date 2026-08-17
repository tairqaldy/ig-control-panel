# Costs, pricing & the hosted-version plan

Resurfly is open source (MIT). Anyone can self-host it for the price of a Railway container and their own OpenAI usage — this page tells you exactly what that costs, and how a paid **hosted** version would be priced so the margin is out in the open. We'd rather show the math than hide it.

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

Pricing that keeps a healthy margin and stays honest (these are the plans the hosted app enforces — see `PLANS` in `server/src/services/plans.ts` and `docs/dev/HOSTED-SPEC.md`):

| Plan | Price | Allowance | Our cost (typical user) | Gross margin |
|---|---|---|---|---|
| **Self-host** | $0 | this repo, your keys, your server | — | — |
| **Trial** | free, 3 days, card at signup (§3b) | newest **100** saves analyzed on Standard, 20 Ask questions, 1 automation rule, 100 sends | ≈ $0.90 once | acquisition cost |
| **Free** (after trial) | $0 | browse, search, export what was analyzed; no new analysis, 5 Ask/mo, automations paused | ≈ $0.03/mo | — |
| **Pro** | **$19 / mo** or **$144 / yr** ($12 / mo, 37% less) | up to **2,000** saves analyzed (300 new / mo), 300 Ask / mo, 10 rules, 5,000 sends / mo, 20 harvests / day, priority queue ×2 | month 1 ≈ $13 (1,500-save library on Standard) then ≈ $4.2 / mo | month 1 ≈ 32%, then ≈ 78% (annual: ≈ 59% over the year) |
| **Studio** | **$49 / mo** or **$348 / yr** ($29 / mo, 41% less) | up to **10,000** saves (2,000 new / mo), 1,500 Ask / mo, unlimited rules, 25,000 sends / mo, 50 harvests / day, priority queue ×4 | month 1 ≈ $38 (5,000-save library) then ≈ $8 / mo | month 1 ≈ 22%, then ≈ 84% |
| **Credits** (top-up, any plan) | **500 / $12 · 2,000 / $39 · 6,000 / $99** | 1 credit = 1 save analyzed = 1 Ask answer = 20 automated replies; spent only after the plan allowance, no expiry | ≈ $0.0076 per analyzed save, ≈ $0.006 per Ask answer | ≈ 68% at $0.024 / credit (higher on Ask and replies) |

Cost lines behind those numbers: analysis $0.0076/save (Standard), Ask ≈ $0.006/question, storage 200 KB/save on R2, ~$0.5–1 amortized compute, Paddle ≈ 5% + $0.50 per charge.

Notes:
- The initial dig is the only expensive moment. The trial deliberately caps it at 100 saves (≈ $0.90) so a tire-kicker costs less than a coffee, and the *newest* 100 are analyzed so the sample looks like the person's actual taste.
- Every plan is limited by an *allowance* rather than a hard "your account is broken" wall: hitting a limit returns HTTP 402 with the exact numbers, and the UI turns that into an Upgrade prompt with the plan cards.
- Worst case for Studio (someone with 10,000 saves analyzed in month 1 on Standard ≈ $76) is a −$27 month; recovered by month 2. If that becomes common, the cheap guard is: Standard for the first 2,000 saves of a library, Economy for the rest (quality on old saves matters less) — this is a one-line policy in the worker, not implemented yet.
- Show the cost table on the pricing page — "your $19 covers about $4 of API + storage in a normal month; the rest pays for the servers, the harvester upkeep, and the person answering support."
- Credits exist so a heavy month does not force an upgrade: when the allowance runs out the app offers both paths. They are prepaid, never expire, and are only spent on analysis, Ask answers and automated replies — never on imports, rule slots or the per-minute Ask rate limit, so a top-up can never look like a way around a rate limit.

## 3b. Card at signup (the trial is 3 days, not 3 days of guessing)

Since round 7 the hosted signup asks for a card **before** the free days start (`TRIAL_REQUIRES_CARD`, on whenever `HOSTED` is on; self-hosted installs never see it).

- **What is collected**: a card, through Paddle's checkout overlay. Paddle stores it; we never see the number. Nothing is charged during the free days.
- **How long is free**: 3 days (`TRIAL_DAYS`). The free period lives on the Paddle *price* (`trial_period`), so Paddle — not our clock — decides when the first charge happens. There are four trial-enabled prices (`PADDLE_PRICE_*_TRIAL`) alongside the four plain ones; signup checkout buys the trial price, an in-app upgrade buys the plain one, because those days have already been used.
- **First charge**: day 3, for the plan and period chosen at signup. The exact date is on the signup screen before confirming and on the Billing page while the trial runs; it comes from Paddle's `next_billed_at`, not from our own arithmetic.
- **Cancelling**: one click in Billing (the Paddle portal's cancel URL, surfaced directly — no e-mail, no support ticket). Cancel before the first charge and nothing is ever charged. Cancel later and access runs to the end of the period already paid for.
- **After cancellation**: the account falls back to Free — browse, search and export everything already analyzed — under the 30-day retention rule in §4. The paywall does not come back: once a card has been on file the account is never walled off again.
- **Accounts that predate the rule are grandfathered.** Migration 009 backfills every existing tenant to `requires_payment = 0` and nothing ever sets it back to 1; only a signup made while the flag is on starts locked. Somebody who joined under the old rules must never meet a wall.
- **Why it fails open**: locking somebody out is only safe if they can actually pay and actually get back in. If any of the four trial price ids, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET` or `PADDLE_API_KEY` is missing, the flag turns itself off, logs why once, and lists the missing variables in the owner's setup issues. (The API key is on that list because it is what opens the customer portal: without it the Billing page shows no cancel control at all, and "cancel any time, one click" would be a promise made to somebody whose card we had just taken.) A half-configured deploy loses a card, not its customers.
- **The trade this makes**: fewer signups, far fewer tire-kickers, and the ≈$0.90 of analysis a trial costs is spent on people who have at least decided to pay. The honest cost is that some people will not hand over a card to try software, which is why the free days, the exact charge date and the one-click cancel are all stated on the same screen as the button.

## 4. Data retention (hosted)

- Active subscription: everything kept; media & analyses can be re-exported (JSON/CSV/Obsidian) at any time.
- Cancelled / lapsed: read-only for **30 days** (export still works), then **all media, analyses and vectors are deleted**; the account row keeps only email + invoice history (legal minimum). A reminder email goes out at day 7 and day 27.
- The retention job is a nightly cron: `DELETE FROM items WHERE tenant_id IN (SELECT id FROM tenants WHERE status='cancelled' AND cancelled_at < now()-30d)` + purge the tenant's R2 prefix.
- Storage per lapsed user is ~600 MB → holding it forever would cost real money at scale, hence the 30-day rule. Say so on the pricing page.

## 5. How the hosted version is built

It is this repository with `HOSTED=true`. The design is in [docs/dev/HOSTED-SPEC.md](dev/HOSTED-SPEC.md); the short version:

1. **Tenancy**: `tenants` / `users` / `usage` tables in the same SQLite file; every row carries `tenant_id`; the owner account (the passcode login of the OSS build) is tenant 1, so a self-hoster's database upgrades in place. Per-tenant worker fairness (round-robin, weighted Studio 3 : Pro 2 : Trial 1) and per-tenant concurrency.
2. **Auth**: e-mail + password (scrypt) sign-up when `SIGNUPS_ENABLED=true`; the OSS passcode login keeps working for the owner.
3. **Plans & quotas**: `PLANS` table in code (trial / free / pro / studio / owner) → HTTP 402 `{ code: 'quota', metric, used, limit, plan }` from any limited route; the web turns that into an Upgrade modal.
4. **Billing**: Paddle (merchant of record → VAT/sales tax handled). Overlay checkout from the web, webhooks (`subscription.*`, `transaction.completed`) update `tenants.plan/plan_status`, customer portal for cancellations/invoices. Sandbox first, then flip `PADDLE_ENV=live`.
5. **Storage**: local volume today; the R2 adapter (thumbnails/frames under `tenant/<id>/…`) is the next step when the volume gets close to full.
6. **Harvester**: unchanged — runs in the user's browser; the "Send to Resurfly" token is minted per tenant.
7. **Retention**: `DELETE /api/account` wipes a tenant; the nightly 30-days-after-cancel job is on the list.

Later, if it outgrows one box: Postgres (Neon) with `pgvector`, a separate worker service, Sentry, cost dashboards per tenant/day.

## 6. Things worth adding next (roadmap)

- **Collections / smart folders** ("Recipes", "Content ideas") built from filters, shareable read-only links.
- **Weekly digest e-mail** — 5 resurfaced saves + what you saved this week, one click to Ask.
- **Chrome extension** — save-and-analyze any reel while browsing; auto-harvest new saves nightly.
- **Content-idea studio** — remix a save into a script/hook set for your niche (the `remix_idea` field is the seed).
- **Sensitive-content filter** — auto-exclude categories you pick (personal, adult, memes, ads) *before* paying for analysis; a "private mode" that keeps some saves local-only and never sends them to OpenAI.
- **Multi-account** — several Instagram accounts in one dashboard (creator + personal).
- **Threads / TikTok / YouTube likes** as extra sources.
- **DM automations v2** — quick-reply buttons, multi-step flows, follow gate.
- **Local models** — Whisper + a local vision LLM for zero-API-cost self-hosting.
