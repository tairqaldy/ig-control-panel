# Round 7 spec — a stranger can sign up, pay, connect and get value without thinking

Read `docs/dev/HOSTED-SPEC.md`, `ROUND5-SPEC.md` and `ROUND6-SPEC.md` first. **The ROUND5/6 house rules apply verbatim**: TypeScript strict; `npm run typecheck`, `npm run build` and `npm test` must all pass before you finish; never edit `server/src/db.ts` or `server/src/app.ts` (register migrations in `server/src/migrations/index.ts` and routes in `server/src/routes/extra.ts`, one line each); web agents put new types in `web/src/lib/types-<feature>.ts`; shared files get additive minimal edits with a re-read immediately before each edit; no `railway` / `git` / deploy commands; copy is specific and calm — never "unlock", "supercharge", "seamless", "leverage", "empower", "journey", "elevate", "effortless", "revolutionize".

## The event that defines this round

The founder's father tried the product. He could not connect Instagram (the Meta app is in Development mode — a platform gate, not our bug). Then he got lost in onboarding, gave up on the setup, and ended up just chatting with the AI, which kept telling him to connect Instagram. He never reached anything of value.

So: **every screen must have exactly one obvious next action, and the product must never advise something the person cannot currently do.** If Instagram cannot be connected, do not tell anyone to connect Instagram — say what is possible instead.

---

## 1. Hard paywall: card at signup (agents: server-paywall, web-paywall)

The founder wants a card collected before the 3-day trial starts, cancellable at any time, charged when the trial ends. Also the entry point for upgrading and for buying credits.

**Paddle shape.** Paddle Billing puts the free period on the *price* (`trial_period`). `scripts/paddle-setup.mjs` gains four trial-enabled prices — keys `pro_month_trial`, `pro_year_trial`, `studio_month_trial`, `studio_year_trial` — identical to the paid ones plus `trial_period: { interval: 'day', frequency: 3 }`, exposed as `PADDLE_PRICE_*_TRIAL`. Signup checkout uses the trial price; an in-app upgrade uses the plain price (the person already had their free days). Credit packs are unchanged one-time prices. **Do not call the Paddle API** — the orchestrator runs the script; just write it and read the env vars, tolerating absence (see fallback below).

**Server (owner: `server/src/routes/paywall.ts` new, `server/src/migrations/009-paywall.ts` new, minimal additive edits to `services/plans.ts` and `routes/auth.ts`).**

- Migration 009: `tenants.requires_payment INTEGER NOT NULL DEFAULT 0`, `tenants.paywall_cleared_at INTEGER`. **Backfill every existing tenant to 0** — people who signed up under the old rules are grandfathered and must never hit a wall. New signups get 1 when `TRIAL_REQUIRES_CARD` is on.
- Config flag `TRIAL_REQUIRES_CARD` (default **on** when `HOSTED`, off otherwise; self-hosters never see a paywall). If the trial price ids are missing from env, the flag **forces itself off** and logs once — a misconfigured deploy must not lock everyone out.
- A tenant with `requires_payment = 1` and no active subscription is *locked*: `GET /api/paywall` → `{ locked, reason, plans, trialDays, priceIds, credits }`. Every other `/api/*` route except auth, `/api/plan`, `/api/plans`, `/api/paywall`, `/api/billing/*`, logout and account deletion answers **402** `{ code: 'payment_required' }`. Implement as one middleware mounted from `routes/extra.ts` — do not touch `app.ts`.
- Paddle webhook: `subscription.created` / `subscription.updated` with status `trialing` or `active` clears the lock (`requires_payment = 0`, `paywall_cleared_at`, plan from the price id, `trial_ends_at` from Paddle's `next_billed_at` when trialing). `subscription.canceled` → plan `free` at period end, never mid-period. Purchasing a **credit pack** also clears the lock (a card is on file) without granting a plan.
- Cancellation must be one click from Billing: reuse `createPortalSession`, and surface `cancelUrl` directly.

**Web (owner: `web/src/pages/Paywall.tsx` new, `web/src/lib/types-paywall.ts` new, additive edits to `App.tsx` routing and `lib/api.ts`'s 402 handling).**

- A 402 `payment_required` anywhere redirects to `/start` (the paywall screen), never a toast loop.
- `/start`: one sentence of what they get, the two plans with monthly/yearly toggle, **"Start 3 days free"** as the only primary button, and under it in small text: *"Card required. Nothing is charged for 3 days. Cancel any time from Billing — one click, no e-mail."* Show the exact date of the first charge, computed client-side. A "What happens on day 3" expander answering the three questions everyone has: what am I charged, how do I cancel, what happens to my data if I do.
- After `checkout.completed`, poll `/api/plan` until the webhook lands (up to ~60 s) with an honest "confirming with Paddle…" state, then continue into onboarding. Never leave a spinner with no exit: after 60 s, show "Payment went through — activation is taking longer than usual. Reload, or write to hello@resurfly.com" and keep polling in the background.

**Write it down** in `docs/BUSINESS.md` and `docs/legal/TERMS.md`: card at signup, 3 free days, first charge date, cancel any time, what happens to data after cancellation.

## 2. Onboarding a distracted person can finish (agent: web-onboarding)

Owner: `web/src/pages/Welcome.tsx`, `web/src/components/Onboarding.tsx`, `web/src/components/onboarding/**` (new), `web/src/lib/types-onboarding.ts`.

Rebuild as a **linear wizard**, not a checklist of options. One screen at a time, one primary button per screen, a 5-dot progress rail, Back always available, "I'll do this later" always available as *quiet* text (never a button competing with the primary one). State survives reload and lives server-side (reuse the round-6 onboarding meta keys; add new ones rather than repurposing).

Screens, in order:

1. **Bring your saves in.** The only decision: "Install the Companion" (primary, opens the store/release link and then *waits and detects* the pairing automatically) or "Upload an Instagram export" (secondary). While waiting, show what will happen, not a spinner alone. Auto-advance the moment the first save lands.
2. **Watch it work.** Live count of saves analyzed with three real cards from *their* library appearing as they finish. This is the payoff screen — do not skip it even if analysis is slow; show the first three and let them continue.
3. **Ask your first question.** Three ready-made questions built from their actual library (reuse `/api/ask/suggestions`). Clicking one runs it inline, right there. No empty text box as the first thing they see.
4. **Instagram (optional, honest).** If connecting is currently impossible — `GET /api/instagram/availability` (new, from the server-instagram-availability agent) says the app is not Live or the person is not a tester — then **do not offer a button that fails**. Say plainly: "Connecting Instagram accounts is waiting on Meta's review of our app. Everything above works without it, and we'll e-mail you the moment it opens." Offer a one-click "tell me when it's ready" that stores the intent. When it *is* possible, this is the normal Connect step.
5. **Done.** What they can do now, three links, and the trial/charge date restated.

Rules: never more than ~25 words of body copy per screen; every button says what happens ("Install the Companion", not "Continue"); nothing on these screens can 404, 402 or dead-end. Mobile is the primary layout — full-height sheets, thumb-reachable buttons.

## 3. Never recommend the impossible (agent: server-instagram-availability)

Owner: `server/src/services/ig-availability.ts` (new), `server/src/routes/instagram-availability.ts` (new, one line in `extra.ts`), plus a minimal additive edit to `services/ask.ts` to inject the resulting sentence into every system prompt.

`GET /api/instagram/availability` → `{ canConnect, mode: 'live'|'development'|'unconfigured', reason, waitlist: boolean }`. Determine it from: `META_APP_ID`/secret present; whether the app is Live (cache a daily probe of `GET /{app-id}?fields=…` with the app token, and let `META_APP_LIVE` override); and whether this tenant already has a connection. Cache 10 minutes.

Then **every AI prompt gets a one-line capability note** — "Instagram connection is currently unavailable (our Meta app is awaiting review), so never tell the user to connect Instagram; suggest what they can do with their library instead." The father's session ended with the assistant repeatedly recommending the one thing he could not do; that must be structurally impossible now.

Also: the Automations and Analytics pages must lead with this state instead of a Connect button that cannot work, and `POST /api/instagram/waitlist` records interest (email + tenant, one row, idempotent).

## 4. Instagram Profile Score — new tab (agents: server-profile-score, web-profile-score)

The founder's idea, verbatim intent: score the account and say how to improve **bio, profile photo, name, positioning and the settings that matter**, driven by a short questionnaire about where they want to take the account.

**Server** — owner: `server/src/services/profile-score.ts`, `server/src/routes/profile-score.ts` (new, one line in `extra.ts`), `server/src/migrations/010-profile-score.ts` (new).

- Migration 010: `profile_goals (tenant_id PK, goal TEXT, niche TEXT, audience TEXT, offer TEXT, tone TEXT, updated_at)` and `profile_scores (id PK, tenant_id, created_at, overall INTEGER, json TEXT)` + index on (tenant_id, id).
- `GET /api/profile/questions` → 5–6 questions, single-select with an "other" free text: what this account is for (personal brand / business / creator / community), the niche, who should follow, what you sell or want people to do, the tone. Prefill every answer from what we already know — their saved categories, their own posts' captions, their bio — so the person confirms rather than composes.
- `POST /api/profile/goals` saves them. `POST /api/profile/score` runs the analysis; `GET /api/profile/score` returns the latest.
- Input to the model: their IG profile (username, name, bio, category, link, followers, posting cadence, content mix from `ig_media`), the goals, and the top themes of their library. **Never invent numbers.** When Instagram is not connected, accept a manual paste (`{ username, name, bio, link }`) so the feature works for everyone — this is the one place that must not require a connection.
- Output (structured, forced JSON schema): `overall` 0–100 and five dimensions — `name_handle`, `bio`, `photo`, `positioning`, `settings` — each with `score`, one-line `verdict`, and 1–3 `fixes` `{ what, why, effort: 'minute'|'hour'|'project', example? }`. Plus `bio_rewrites`: three complete alternative bios in their voice, each ≤150 characters, ready to paste. Plus `next_three`: the three highest-impact actions in order.
- Costs 1 credit (metric `ask`) through `chargeMetered`; re-scoring is rate-limited to once per 10 minutes. When OpenAI is unavailable, return the cached score with `stale: true` — never a bare 500.

**Web** — owner: `web/src/pages/ProfileScore.tsx` (new), `web/src/components/profile/**` (new), `web/src/lib/types-profile.ts`, plus the nav entry in `Shell.tsx` (one line, under Instagram, label **"Profile score"**).

The questionnaire is 5 taps, one question per card, prefilled. Then the report: a large overall number with a ring, the five dimensions as rows that expand into fixes, the three bio rewrites each with a copy button, and "the next three things" pinned at the top. Empty state explains what it does in one sentence and starts the questionnaire. This page must be worth visiting weekly — show the delta against the previous score when there is one.

## 5. Automations: closer to ManyChat (agent: web-automations-2)

Owner: `web/src/pages/Automations.tsx`, `web/src/components/instagram/**`.

Round 6 shipped the builder. What is still missing:

- **A rule list that reads like a list of behaviours**, not database rows: one line each — *"When someone comments **link** on **3 posts** → DM them"* — with an on/off switch, last-fired time, sends this week, and a duplicate action. Reordering by priority via drag or up/down buttons.
- **Templates gallery** as the empty state: 6 named templates with a one-line description and a thumbnail-ish icon (comment→DM link, story reply→thanks, first DM→welcome, keyword→discount code, price question→answer, giveaway entry). One click creates the rule pre-filled and opens the builder at step "Then".
- **Post picker upgrades**: search by caption, filter by reels/carousels/posts, sort newest/most-commented, "select all reels", and a chip row of the chosen posts with thumbnails and an × on each.
- **Live activity feed** on the rules page (not only inside the builder): last 20 events with avatar, what came in, which rule answered, what went out — auto-refreshing while the tab is visible.
- Keep everything working when Instagram is not connected: the builder, templates and simulator all function; only real sending is disabled, with the reason from §3.

## 6. Production readiness sweep (agents: qa-sweep, then fix-pass)

- Extend `scripts/flows.mjs` with the **new-user path end to end**: signup → paywall (Paddle sandbox test card via the overlay is out of scope; assert the paywall renders, the price and date are right, and that a locked tenant gets 402 with the right shape) → onboarding screens 1–5 → profile score questionnaire → first Ask. Add mobile variants of the whole path.
- Extend `scripts/bugbash.mjs` with `/start` and `/profile-score`, and a **locked-tenant** persona alongside owner and trial.
- Every new endpoint gets in-process tests in the `npm test` style already established (`server/src/services/*.test.ts`, no runner): paywall lock/unlock/grandfathering, profile score shape and credit charge, availability caching.
- Fix everything found. A finding that cannot be fixed inside this round gets written into `docs/dev/ROUND7-FINDINGS.md` with its reason.

## 7. Approval-grade policy pages (agent: legal-approvals)

Owner: `docs/legal/**`, `web/src/pages/Legal.tsx`, `docs/PRIVACY.md`.

We are applying to Meta (business verification, App Review) and to the Chrome Web Store. Reviewers reject vague pages. Make each of these complete, dated, specific about **what data, why, where it lives, how long, and how to delete it**:

- `/privacy` — must name Instagram data explicitly (profile, media, insights, messages we process for automations), OpenAI as a subprocessor, Railway (EU-West) as the host, Cloudflare R2 for backups, Paddle as merchant of record, retention periods, and the deletion path (in-app, plus Meta's signed-request deletion callback).
- `/terms`, `/refunds`, `/credits-terms`, `/security`, `/privacy/extension` — keep consistent with the paywall change.
- New `/data-deletion` page that a Meta reviewer can follow: exactly what to click, what is removed, and the callback endpoint.
- New `/subprocessors` list with purpose and region.
- A short `/dpa` note stating the controller/processor split and pointing to a signable DPA on request.
- Cross-link them all in the footer and from Settings.

Accuracy over polish: **never claim a certification we do not have** (no "SOC 2", no "GDPR certified"). Say what is true — encryption at rest on the volume, encrypted tokens, EU hosting, deletion on request.

---

## What is NOT in this round

Do not attempt Meta business verification, Meta App Review submission, Chrome Web Store submission, Paddle live keys, or topping up OpenAI. The orchestrator handles those in the founder's own accounts, by hand.
