# Round 6 spec — automations that actually work (ManyChat-grade), credits + new pricing, Ask that sounds human, store-ready extension

Read `docs/dev/HOSTED-SPEC.md` and `docs/dev/ROUND5-SPEC.md` first (tenancy, plans/quotas, 402 shape, house rules). The ROUND5 house rules apply verbatim: TypeScript strict, `npm run typecheck` / `npm run build` must pass before you finish, never edit `server/src/db.ts` or `server/src/app.ts` (register migrations in `server/src/migrations/index.ts` and routes in `server/src/routes/extra.ts`, one line each), web agents put new types in `web/src/lib/types-<feature>.ts`, shared files get additive minimal edits with a re-read immediately before each edit, no `railway` / `git` / deploy, and copy is specific and calm — never "unlock", "supercharge", "seamless", "leverage", "empower", "journey", "elevate", "effortless", "revolutionize".

## Context: what the founder hit this morning

He connected Instagram, made a story-reply rule, replied to his own story from another account — nothing happened — then disconnected in Settings. Root cause: **Meta only delivers webhooks to a published (Live) app**; ours is in Development mode. The product never said so anywhere. So the theme of this round: the app must *say exactly why an automation cannot fire*, and the rule builder must feel like ManyChat — pick the actual reel, see the DM, test it, watch the log.

---

## 1. Automations: diagnostics + reliability (agent: server-automations)

Files you own: `server/src/services/automations.ts` (extend), `server/src/services/automations-diag.ts` (new), `server/src/routes/automations-extra.ts` (new, mounted with one line in `routes/extra.ts`), `server/src/migrations/007-automations.ts` (new + one line in `migrations/index.ts`). You may read anything.

**Migration 007** — `automation_rules` gains `media_ids TEXT` (JSON array of Instagram media ids; null/`[]` = every post), `once_per_person INTEGER NOT NULL DEFAULT 0`, `last_error TEXT`, `last_error_at INTEGER`. Reuse the round-5 `ig_media` table for the post picker (it already stores thumb/permalink/caption/type/timestamp/like_count/comments_count) — do not create a second media table.

**`GET /api/automations/diagnostics`** → `{ checks: Check[], summary: {ok,warn,fail}, lastInboundAt, lastOutboundAt, events24h, canFire }`, `Check = { id, label, status:'ok'|'warn'|'fail', detail, fix?: {label, href?, action?} }`. Checks in order:

1. `connected` — an Instagram account is connected (fail → fix "Connect Instagram", href `/api/instagram/connect`).
2. `permissions` — the stored token still works and carries messages + comments scopes (call `GET https://graph.instagram.com/v23.0/me?fields=id,username`; surface any OAuthException verbatim in `detail`).
3. `webhook_subscribed` — live `GET /{ig_user_id}/subscribed_apps`; fail → fix action `resubscribe` backed by `POST /api/automations/resubscribe` (re-runs the subscription and returns Meta's raw response).
4. `app_published` — **warn** when no inbound webhook event has ever been recorded for this tenant and the account has been connected for more than 5 minutes: "Meta only delivers webhooks to apps that are Live. While the app is in Development mode, Instagram never sends us your DMs or comments." Fix link → `docs/AUTOMATIONS.md#live-mode`.
5. `rules_enabled` — at least one enabled rule (warn otherwise), plus per-rule notes: keyword-less non-story rules, rules pointing at media ids that no longer exist, rules with a recent `last_error`.
6. `sends_quota` — plan allowance and credits left this month.
7. `messaging_window` — always `ok`, `detail` explains that Instagram only allows a DM within 24 h of that person's last message, and that comment → DM uses the private-reply endpoint (7 days).

Every `detail` must read like a sentence a non-developer understands.

**`POST /api/automations/simulate`** body `{ kind:'dm'|'comment'|'story_reply', text, mediaId?, senderUsername? }` → runs the real matcher against the tenant's rules, no Instagram call: `{ matched: {ruleId,name}|null, wouldSend: {dm?,publicReply?}, skipped: [{ruleId,name,reason}] }`.

**`POST /api/automations/rules/:id/test-send`** body `{ recipient }` — a real send; on failure return Meta's error message verbatim in `error` and log the attempt.

**Engine changes** in `services/automations.ts`:
- Honour `media_ids` for comment triggers (the comment payload carries `media.id`).
- `once_per_person`: skip when this rule already replied to that sender (use `automation_contacts`).
- Log **every** inbound event, including ones that matched nothing, with `status='no_match'` and a short payload snippet — the activity log has to answer "why didn't it fire".
- On send failure write `last_error`/`last_error_at` on the rule and log Meta's message.
- New trigger `dm_first` (first message ever from that sender).

## 2. Automations UI like ManyChat (agent: web-automations)

Files you own: `web/src/pages/Automations.tsx`, `web/src/components/instagram/**` (new `RuleBuilder.tsx`, `PostPicker.tsx`, `HealthCard.tsx`, `ActivityLog.tsx`, `DmPreview.tsx`), `web/src/lib/types-automations.ts`.

- **Health card first**: the diagnostics checklist — green/amber/red rows, one-line explanation each, a fix button where there is one. When `app_published` warns, spell out the fix ("Meta dashboard → Publish. Until the app is Live, only accounts with a tester role receive automations").
- **Rule builder** replacing today's cramped form — three labelled steps: **When** (trigger chips: comment on a post · DM keyword · first DM · story reply), **Where** (post picker: a grid of the person's real reels/posts with thumbnails from `GET /api/instagram/media`, multi-select, default "any post"; only shown for comment triggers), **Then** (public reply + DM text + link, with a live phone-style **DM preview** that renders `{{username}}`), **Limits** (cooldown, once per person). Unsaved-changes guard.
- **Test panel** in the builder: "Simulate" (dry run via `/simulate`, shows matched and skipped with reasons) and "Send to…" (real send; show Meta's error verbatim).
- **Activity log**: avatar/username, inbound text, matched rule (or "no rule matched"), outbound text, status pill, error, relative time; filter by rule and status; an empty state that explains what will show up.
- Mobile: builder becomes a full-height sheet, post picker two columns.
- `GET /api/instagram/media` is being added by the server-automations agent; code against `{ media: [{id, caption, type, productType, thumb, permalink, timestamp, likes, comments}], refreshedAt }` and handle 404 gracefully.

## 3. Credits + new pricing (agents: server-credits, web-credits)

**Prices — change everywhere** (`server/src/services/plans.ts`, `docs/BUSINESS.md`, pricing page, landing, UpgradeModal):
- Pro **$19/month** or **$144/year** (= $12/month, "save 37%").
- Studio **$49/month** or **$348/year** (= $29/month).
- Trial unchanged: 3 days, newest 100 saves, 20 questions.

**Credits** — migration `008-credits.ts`: `tenants.credits INTEGER NOT NULL DEFAULT 0`, table `credit_ledger (id INTEGER PK, tenant_id, delta, balance_after, reason TEXT, ref TEXT, created_at)` + index on (tenant_id, id).
- 1 credit = **1 save analyzed** = **1 Ask answer** = **20 automated replies**.
- Credits are spent only after the plan allowance is exhausted, and only for `analyze`, `ask`, `sends`. `checkQuota` returns `creditsAvailable` and `wouldUseCredits`; a new `spendCredits(tid, metric, n, ref)` writes the ledger atomically and never goes negative.
- 402 bodies gain `credits: { balance, needed, packs }` so the UI can offer "buy credits" as well as "upgrade".
- Packs are Paddle one-time prices (env `PADDLE_PRICE_CREDITS_500`, `_2000`, `_6000`): **500 credits $12**, **2,000 credits $39**, **6,000 credits $99**. `GET /api/plans` exposes the catalog; `GET /api/plan` exposes `credits` + the last ~20 ledger rows.
- Paddle webhook: a `transaction.completed` whose items match a credit price id adds credits, idempotent on the transaction id (ledger `ref`), and logs it. Subscription handling stays as it is.
- The worker must not silently drop items: when an item would exceed both allowance and credits, leave it pending and report it in `jobs/status`.

**Web (web-credits)**: Billing page gains a balance card, "Buy credits" with the three packs (Paddle overlay, one-time), and a ledger table. UpgradeModal offers two paths when the 402 came from a metered action: upgrade (primary) or buy credits (secondary). Ask and the Analysis plan show "N credits left" once the allowance is gone. Pricing page and landing show the new prices plus a one-line "what a credit is".

## 4. Ask that sounds like a friend who knows social (agent: server-ask)

Files you own: `server/src/services/ask.ts`, `server/src/services/ig-content.ts` (new).

- **Voice**: a friend who happens to be a great social-media strategist and knows AI tools. Bake into the system prompt: answer in the first one or two lines; then at most 3–5 short bullets *only when they help*; no section headers unless the user asked for a document; never restate the question; never enumerate every source; contractions are good; no emoji unless the user used them; when the library has nothing, say so plainly and offer the nearest useful thing. Default answers ≈180 words or less; content briefs may run longer.
- **Own-content awareness**: `ig-content.ts` builds a compact profile from `ig_media` / `ig_insights_daily` / `ig_snapshots` — the last ~12 posts (type, date, caption gist ≤ 100 chars, reach, saves, comments, engagement rate), account averages, best hours/days, top hashtags. Inject it into the `create`, `analytics`, `inspire` and `stats` strategies (and into `chat` when the question is about the account). Ask must handle "does what I save match what I post?", "which of my reels is closest to what I keep saving?", "give me an idea that uses my best format".
- **Cross-reference**: when both sides exist, prefer answers that connect them ("you save three times more about hooks than you post about them; your best reel used the same open-loop pattern as [#id]"). Never invent numbers — only use injected data.
- `/api/ask/suggestions` gains cross-reference prompts when Instagram is connected.
- SSE events, conversations, quotas and citations stay exactly as they are.

## 5. Chrome Web Store readiness (agent: extension-store)

Files you own: `extension/**`, `docs/CHROME-STORE-GUIDE.md` (new), `docs/COMPANION.md`.

- **Store build**: `node extension/build-zip.mjs --store` produces a zip whose manifest drops the wildcard `optional_host_permissions` (`https://*/*` reads as "access every site" to a reviewer) and hides the App-URL field in Options; the unpacked/dev build keeps both for self-hosters. Document the difference.
- Re-check every reviewer-sensitive point: single-purpose sentence, permission justifications (alarms, storage, optional cookies, host permissions), remote code = none, data disclosure (website content + optional authentication info), privacy policy URL `https://resurfly.com/privacy/extension`.
- Small self-contained functionality: a context-menu item on instagram.com ("Sync my saves to Resurfly") and a popup line "N new since yesterday". Only the `contextMenus` permission may be added.
- `docs/CHROME-STORE-GUIDE.md`: the $5 developer account, uploading, every listing field filled with our copy, the exact answers to the Privacy-practices questionnaire, the common rejection reasons for extensions that read a logged-in site and how our justification answers each, review timeline, what to do if rejected, how to ship an update (version bump → validate → zip → upload).

## 6. Legal pages and trust (agent: web-legal)

Files you own: `web/src/pages/Legal.tsx`, `docs/legal/**`, `docs/PRIVACY.md`, plus the pricing copy in `web/src/components/marketing.tsx` / `web/src/components/Pricing.tsx` that mentions money (coordinate with web-credits: they own the numbers in `Pricing.tsx`; you own prose elsewhere).

- `/privacy/extension` — a Companion-specific privacy policy: what the extension reads, what leaves the browser, the optional session hand-off, retention, contact.
- `/security` — plain language: tokens and sessions encrypted at rest, scrypt password hashes, device tokens stored hashed, nightly database backups, nothing sold, how to delete everything.
- Update `/terms` and `/refunds` for credits (prepaid, non-refundable once used, no expiry, not transferable) and the new prices.

## 7. Everything else

Fix what you find inside your own files. The verifier runs `scripts/bugbash.mjs` and `scripts/flows.mjs` against production after the merge.

---

## 8. Findings from the live investigation (orchestrator, 17 Aug ~10:00)

1. **Why the founder's story-reply rule never fired**: the Meta app is in Development mode. Meta delivers Instagram webhooks only to **published (Live)** apps. Publishing is currently blocked by **Business verification** ("Подтверждение компании: Не подтверждено" on the app's Publish page) — the Publish button is disabled with "Невозможно опубликовать приложение, так как выполнены не все требования". All four permissions are already at Standard access ("Ready for testing"), and @tairqaldy is an accepted Instagram tester, so Live mode + tester role is enough — no App Review needed for his own account. The `app_published` diagnostics check must say this in those words and link to the verification page.
2. **Parser gap**: the Meta dashboard's webhook **Test** button for the `messages` field sends the `entry[].changes[{field:'messages', value:{…}}]` shape, while real Instagram messaging sends `entry[].messaging[]`. Our parser only reads `messaging` for DMs, so the test payload produced no event at all (the `comments` test worked because comments do arrive as `changes`). The webhook parser must accept **both** shapes for messages/story replies, and every inbound POST must leave a trace in the event log even when nothing parses (`type='system'`, `status='no_match'`, with a short payload snippet) — otherwise "nothing happened" is indistinguishable from "never arrived".
3. The owner's three starter rules are gone and Instagram is disconnected (he disconnected in Settings at 04:14 UTC while troubleshooting). Reconnect + starter rules must be one click from the Automations empty state.
