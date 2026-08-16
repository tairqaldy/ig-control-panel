# Resurfly hosted mode — implementation spec (contract between server and web work)

Goal: the SAME codebase runs as (a) the open-source single-tenant app (unchanged behaviour: `APP_USERNAME/APP_PASSCODE` login, unlimited) and (b) the hosted SaaS at resurfly.com when `HOSTED=true`: public signup, one tenant per account, **3-day free trial with limits**, Pro/Studio plans via **Paddle**, quotas enforced server-side, soft-wall upgrade prompts in the UI.

Non-negotiables: the owner's existing data (tenant 1) must keep working untouched; all queries scoped by tenant; no cross-tenant leaks (items, media, settings, automations, usage); everything typechecks (`npm run typecheck`) and builds; keep the current design system.

## 1. Data model (SQLite, migration id 3 in `server/src/db.ts`)

```sql
CREATE TABLE tenants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, plan TEXT NOT NULL DEFAULT 'trial', plan_status TEXT NOT NULL DEFAULT 'active',
  trial_ends_at INTEGER, plan_started_at INTEGER, plan_renews_at INTEGER, paddle_customer_id TEXT, paddle_subscription_id TEXT, paddle_price_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, cancelled_at INTEGER, deleted_at INTEGER);
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL REFERENCES tenants(id), email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT, is_owner INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_login_at INTEGER);
CREATE TABLE usage (tenant_id INTEGER NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, period, metric));
-- period: 'YYYY-MM' for monthly metrics, 'total' for lifetime metrics
```
- Migration inserts tenant 1 = `{ name: 'owner', plan: 'owner' }` and (if `APP_USERNAME` set) a user row for the owner (`email` = APP_USERNAME if it contains '@' else `${APP_USERNAME}@local`, password_hash NULL — owner authenticates via env passcode as before, `is_owner = 1`).
- Add `tenant_id INTEGER NOT NULL DEFAULT 1` (+ index) to: `items`, `imports`, `automation_rules`, `automation_events`, `automation_contacts`. Add it to `settings` and `meta` too: rebuild those two tables with PRIMARY KEY (tenant_id, key); tenant 0 = global (e.g. `worker_paused`, `worker_concurrency`, `worker_pause_reason`), everything else per tenant (`upload_token`, `ig_username`, `resurface_*`, `budget_reset_at`, `scope`, model settings, meta creds).
- `items.id` collisions across tenants: item ids are Instagram shortcodes. Keep tenant 1's ids as-is; for tenant_id ≥ 2 the id is `t{tenant_id}_{shortcode}` (importers `idFor()` prefixes when tenant ≠ 1). Add `UNIQUE INDEX idx_items_tenant_shortcode ON items(tenant_id, shortcode)`; the old unique index on `shortcode` alone must be dropped (SQLite: `DROP INDEX idx_items_shortcode`).
- `items_fts`: recreate with an extra `tenant_id UNINDEXED` column and re-index everything in the migration (call `reindexAll()` after migrating).
- Media: `itemDir()` already uses `safeName(id)`; prefixed ids therefore land in `media/t2_xxx/` — no change needed. Media route must check the item belongs to the session tenant (lookup by id → tenant_id) before serving.
- Embedding cache: `Map<tenantId, Map<id, Float32Array>>`; all functions in `services/neighbors.ts` take a `tenantId`.

## 2. Config (`server/src/config.ts`)
- `HOSTED` (bool, default false), `SIGNUPS_ENABLED` (default = HOSTED), `TRIAL_DAYS` (3), `PUBLIC_URL`.
- Paddle: `PADDLE_ENV` ('sandbox'|'production'), `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_PRICE_PRO_MONTH`, `PADDLE_PRICE_PRO_YEAR`, `PADDLE_PRICE_STUDIO_MONTH`, `PADDLE_PRICE_STUDIO_YEAR`.

## 3. Auth (`server/src/auth.ts`, `routes/auth.ts`)
- Cookie payload becomes `{ u: string, tid: number, uid: number, exp }`. Old cookies (no tid) → treat as tenant 1 owner (backward compatible). Helper `currentTenant(c): { tid, uid, u, isOwner }` used by every route via middleware that sets `c.set('tenant', …)`; a `tid(c)` accessor.
- `POST /api/auth/login { username|email, passcode|password }`: if matches env owner creds → tenant 1 owner session; else (HOSTED) look up users by email, verify scrypt hash (format `scrypt$N$salt$hash`, `crypto.scryptSync`, `timingSafeEqual`).
- `POST /api/auth/signup { email, password, name? }` (only when `SIGNUPS_ENABLED`): validate email, password ≥ 8; create tenant (plan 'trial', trial_ends_at = now + TRIAL_DAYS days) + user; set cookie; return `{ ok, tenant }`. Rate-limit 5/min/IP.
- `GET /api/auth/me` returns additionally: `hosted`, `signupsEnabled`, `plan` (see §5 payload), `email`, `tenantId`.
- Public routes (no session): `/api/auth/*`, `/api/webhooks/*`, `/api/health`, `/harvester.js`, `/api/import/harvest-form`, `/api/plans` (price catalog for the landing).

## 4. Plans, limits, quotas (`server/src/services/plans.ts`)
```ts
export type PlanId = 'owner' | 'trial' | 'free' | 'pro' | 'studio';
export interface Limits { analyzeTotal: number; analyzePerMonth: number; askPerMonth: number; askPerMinute: number; rules: number; sendsPerMonth: number; harvestsPerDay: number; graphNodes: number; concurrency: number; }
PLANS = {
  owner:  { analyzeTotal: Infinity, analyzePerMonth: Infinity, askPerMonth: Infinity, askPerMinute: 30, rules: Infinity, sendsPerMonth: Infinity, harvestsPerDay: Infinity, graphNodes: 6000, concurrency: 4 },
  trial:  { analyzeTotal: 100,  analyzePerMonth: 100,  askPerMonth: 20,  askPerMinute: 4,  rules: 1,  sendsPerMonth: 100,   harvestsPerDay: 3,  graphNodes: 300,  concurrency: 1 },
  free:   { analyzeTotal: 100,  analyzePerMonth: 0,    askPerMonth: 5,   askPerMinute: 2,  rules: 1,  sendsPerMonth: 0,     harvestsPerDay: 1,  graphNodes: 300,  concurrency: 1 }, // after trial expiry: browse + export only
  pro:    { analyzeTotal: 2000, analyzePerMonth: 300,  askPerMonth: 300, askPerMinute: 8,  rules: 10, sendsPerMonth: 5000,  harvestsPerDay: 20, graphNodes: 3000, concurrency: 2 },
  studio: { analyzeTotal: 10000, analyzePerMonth: 2000, askPerMonth: 1500, askPerMinute: 15, rules: Infinity, sendsPerMonth: 25000, harvestsPerDay: 50, graphNodes: 6000, concurrency: 4 },
}
```
- Effective plan: `plan` from tenants, but `trial` with `trial_ends_at < now` behaves as `free`; `pro/studio` with `plan_status in ('past_due','paused','canceled')` after grace (7 days from `plan_renews_at`) behaves as `free`.
- `checkQuota(tid, metric, n=1)` → `{ ok, used, limit, remaining, resetsAt }`; `bumpUsage(tid, metric, n)`. Metrics: `analyze` (total & month), `ask` (month + per-minute sliding window in memory), `sends` (month), `harvests` (day → period 'YYYY-MM-DD'), `rules` (count rows live).
- On quota exceeded, routes respond **HTTP 402** with JSON `{ error: string, code: 'quota', metric, used, limit, plan, upgrade: true }`.
- Enforcement points: `worker.enqueue` / `POST /api/jobs/queue` (only queue up to remaining `analyze` allowance — newest saves first — and tell the client how many were left out: `{ justQueued, leftOut, quota }`); `POST /api/ask` (402 before retrieval); `POST /api/automations/rules` (rules limit); outbound sends in `handleIncoming` (skip + log when over `sends`); harvest imports per day; graph `max_items` clamp; worker per-tenant concurrency + fair scheduling (round-robin across tenants; weight studio 3 : pro 2 : trial 1).
- Trial expiry / free: analysis queue is skipped for that tenant (items stay pending), Ask returns 402, automations paused (rules not evaluated; log a system event once/day).
- `GET /api/plan` → `{ plan, effectivePlan, status, trialEndsAt, renewsAt, limits, usage: { analyze: {used, limit}, analyzeMonth, ask, sends, rules, harvests }, paddle: { env, clientToken, prices: { proMonth, proYear, studioMonth, studioYear } }, canManage: bool }`.
- `GET /api/plans` (public) → catalog for the landing/pricing (names, prices in USD, limits, price ids).

## 5. Paddle (`server/src/routes/billing.ts`, `services/paddle.ts`)
- `POST /api/webhooks/paddle` (public): verify `Paddle-Signature` header (`ts=…;h1=…`, HMAC-SHA256 over `${ts}:${rawBody}` with `PADDLE_WEBHOOK_SECRET`, reject if |now−ts| > 5 min); events: `subscription.created|updated|activated|canceled|past_due|paused|resumed`, `transaction.completed`. Map `custom_data.tenant_id` (set at checkout) → tenant; price id → plan (pro/studio); set `plan`, `plan_status`, `plan_started_at`, `plan_renews_at` (from `current_billing_period.ends_at`), `paddle_customer_id`, `paddle_subscription_id`, `paddle_price_id`; on cancel: `plan_status='canceled'`, `cancelled_at`, keep access until period end. Idempotent by `event_id` (store last 500 ids in meta tenant 0).
- `POST /api/billing/portal` → Paddle API `POST /customers/{id}/portal-sessions` → `{ url }` (needs `PADDLE_API_KEY`; base URL sandbox `https://sandbox-api.paddle.com`, prod `https://api.paddle.com`).
- Checkout is client-side (Paddle.js overlay) — server only provides `clientToken`, price ids, and `customData: { tenant_id }` via `/api/plan`.

## 6. Web (`web/src`)
- `useAuth()` exposes `hosted`, `plan` (payload of §4), `email`, `tenantId`; `api.ts` turns HTTP 402 into a global event `rs:quota` with the JSON body → an `<UpgradeModal>` mounted in the Shell opens with a contextual message ("You've used all 20 questions of your trial…"), the pricing cards, and a **Paddle overlay checkout** (`@paddle/paddle-js`: `initializePaddle({ environment, token })`, `Paddle.Checkout.open({ items:[{priceId, quantity:1}], customData:{tenant_id}, customer:{email} })`); after `checkout.completed` poll `/api/plan` until the plan changes, then toast + close.
- Landing page at `/` for unauthenticated visitors when `hosted` (else the current Login page): sections — hero (specific, no buzzwords), "how it works" (harvester → analysis → ask/graph/resurface), "open source AND hosted" (n8n-style explanation: MIT repo, self-host free with your own keys; or pay us to run it, keys/servers/upkeep included, instant results, cancel anytime, export always), pricing (Trial 3 days free · Pro $12/mo or $99/yr · Studio $34/mo or $290/yr — read from `/api/plans`), transparent cost note ("what your money pays for"), FAQ, footer (GitHub, docs, privacy). Real UI components (e.g. a static demo of 3 analyzed save cards using bundled sample JSON) instead of stock imagery. `/login` and `/signup` pages; `/pricing` route shows the same pricing section.
- Shell: trial banner ("Trial · 2 days left · 87/100 saves analyzed · Upgrade"), plan badge in sidebar; `/billing` page: current plan, usage meters (analyze total/month, Ask, sends, rules), Upgrade / Manage subscription (portal), invoices link.
- Import page (hosted): the Analysis plan shows the plan allowance ("Trial: 100 saves — the newest 100 will be analyzed"), and "Analyze eligible" is capped accordingly with the leftover count + Upgrade CTA.
- Ask: quota meter next to the composer when hosted; 402 → upgrade modal.
- Automations: rule limit + sends meter; creating an 11th rule on Pro → 402 → modal.
- Library cards for un-analyzed saves beyond the allowance show a subtle "Upgrade to analyze" pill (only hosted, only when the tenant is out of allowance).

## 7. Prices (USD) — a bit more margin than the internal doc
Pro **$12/mo** or **$99/yr**; Studio **$34/mo** or **$290/yr**. Trial: 3 days, then browse-only Free until upgrade (data retained 30 days after trial end, then deletable — retention job out of scope for this pass, but add `tenants.deleted_at` and a `DELETE /api/account` that wipes the tenant's items/media).

## 7b. Server implementation notes (what actually ships — read this when wiring the web)
- **Unlimited limits are `null` in JSON** (JSON has no `Infinity`): `limits.*`, `usage.*.limit`, `quota.limit/remaining` in every payload. Treat `null` as "unlimited".
- `GET /api/auth/me` → `{ authenticated, username, email, tenantId, tenantName, isOwner, hosted, signupsEnabled, plan (= GET /api/plan payload | null), setupIssues, loginEnabled }`.
- `POST /api/auth/login` accepts `{ username|email, passcode|password }` → `{ ok, username, tenantId, isOwner }`. `POST /api/auth/signup { email, password, name? }` → `{ ok, tenant: {id,name,plan,trialEndsAt}, tenantId, email }` (404 when signups are disabled, 409 duplicate email, 429 rate-limited).
- `GET /api/plan` → `{ tenantId, plan, effectivePlan, planName, status, trialEndsAt, trialDaysLeft, renewsAt, cancelledAt, limits, usage: { analyze, analyzeMonth, ask, sends, rules, harvests } (each `{used, limit}`), resets: { month, day } (epoch s), paddle: { env, clientToken, prices: { proMonth, proYear, studioMonth, studioYear }, customData: { tenant_id } }, canManage, hosted }`.
- `GET /api/plans` (public) → `{ currency:'USD', trialDays, hosted, signupsEnabled, paddle: { env, clientToken }, plans: [{ id, name, tagline, priceMonth, priceYear, priceIds: { month, year }, limits }] }` for trial, pro, studio, free (in that order).
- 402 body: `{ error, code:'quota', metric, used, limit, remaining, resetsAt, plan, upgrade:true }` — from `POST /api/ask`, `POST /api/automations/rules`, `POST /api/automations/send-test`, `POST /api/import/{harvest,instagram-export,urls}` (metric `harvests`, per day). The harvester's direct upload (`/api/import/harvest-form`) answers with an HTML page (status 402) instead.
- `POST /api/jobs/queue` → `{ ...jobs status, justQueued, leftOut, quota: { metric, plan, used, limit, remaining, resetsAt } | null }`. Import endpoints return `{ ..., queued, leftOut, quota }` the same way. `GET /api/jobs/status` additionally has `plan`, `quota: {used,limit,remaining,resetsAt,ok} | null`, `planBlocked` (true = expired trial / free: nothing will be analyzed until upgrade). `POST /api/ask` ends its SSE stream with `event: done` `{ ok, quota }`.
- `GET /api/automations/status` additionally has `planPaused` (free plan → rules not evaluated) and `limits: { rules: {used,limit}, sends: {used,limit} }`. `GET /api/graph` meta has `maxItems, capped, planCap, totalAnalyzed`.
- Worker pause/resume/concurrency: the owner's pause and the concurrency setting are global (as before); a hosted tenant's pause/resume only affects itself; a tenant's budget cap only pauses that tenant (`pauseReason: 'budget'`).
- `POST /api/billing/portal` → `{ url, cancelUrl, paymentMethodUrl }` (503 when `PADDLE_API_KEY` is missing, 404 when the tenant has no Paddle customer yet). `DELETE /api/account` → `{ ok, deletedItems, note? }` and clears the cookie (403 for the owner).
- Automations webhook (`/api/webhooks/instagram`) is routed to the tenant whose `ig_user_id` setting matches the payload's entry/recipient id (falls back to the owner tenant) and verified with that tenant's app secret; env Meta creds apply to the owner tenant only. `automation_contacts` was rebuilt with `PRIMARY KEY (tenant_id, ig_id)`.
- Upload tokens are `"{tenantId}.{secret}"` (legacy unprefixed tokens keep working for tenant 1 until they expire).
- Hosted tenants cannot set their own OpenAI key/models in Settings (the server key is used); Meta credentials are per tenant.

## 8. File ownership for the parallel work
- SERVER agent: everything under `server/src/**` and `docs/dev/HOSTED-SPEC.md` notes; may add npm deps to `server/package.json`.
- WEB agent: everything under `web/src/**` and `web/package.json` (add `@paddle/paddle-js`); do NOT touch server files. If the web needs an endpoint not listed here, mock its shape exactly as specified and note it in the final report.
- Both: run `npm run typecheck` in your workspace before finishing; do not run `railway`, `git commit`, or deploy.
