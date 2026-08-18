# Round 7 — findings from the review pass, and what happened to each

*Written by the fix pass. Six reviewers examined the round-7 work against `ROUND7-SPEC.md`; 41 defects were reported, all 41 reproduced in the source, and 38 were fixed in this pass. This file records the three that were not, and the two claims about production that no amount of reading the repository can settle.*

Everything else is in the code, with the reason written next to it. `npm run typecheck`, `npm run build` and `npm test` all pass.

---

## Not fixed in this round

### 1. ~~`SESSION_SECRET` is still allowed to be absent on a hosted boot~~ — CLOSED by the orchestrator, 17 Aug 2026

The fix pass left this open for one reason only: it could not see the production environment, so hard-failing the boot risked taking the live site down. **`SESSION_SECRET` is set on the Railway service** (verified against `railway variables`), so that risk does not exist and the stronger fix shipped: `loadSessionSecret()` now throws in hosted mode instead of generating a key onto the data volume. The error names the file it would have used and tells the operator to copy its contents into the variable, because setting a *different* value signs everybody out and makes stored Instagram tokens undecryptable. Self-hosters are unchanged — with `HOSTED` unset the generated-key fallback still works. Verified all three paths: hosted without the variable refuses to boot, hosted with it boots, `HOSTED` unset generates a 64-char key. `/security` and `.env.example` were updated to describe the new behaviour.

The original finding, kept for the record:

### 1a. `SESSION_SECRET` was allowed to be absent on a hosted boot

**The finding.** `docs/legal/SECURITY.md` said the key that encrypts Instagram tokens "lives only in the deployment environment". `loadSessionSecret()` (`server/src/config.ts`) falls back to generating 48 random bytes and writing them to `<DATA_DIR>/.session-secret` — on Railway, the same volume as `resurfly.db` and the AES-256-GCM ciphertext inside it. Anyone with a copy of the volume, or a snapshot of it, holds both halves.

**What was done.** The claim was corrected rather than the behaviour: `/security` now says the secret is an environment variable on resurfly.com, describes the file fallback as what it is (a convenience for somebody running their own copy with no configuration), and tells self-hosters to set `SESSION_SECRET`. A hosted boot without it prints an error explaining the consequence, and the missing variable is listed in the owner's setup issues on `/api/auth/me`, next to the other things a deploy is missing.

**Why not the stronger fix.** The reviewer's suggestion was to refuse to boot in hosted mode without it. That is right for a service being set up and wrong for one already running: this fix pass cannot see the production environment, and if `SESSION_SECRET` is not set on the live Railway service today, shipping that check takes the site down on the next deploy — and, because the generated secret is *in* the volume, "just set it now" also signs everybody out and makes every stored Instagram token undecryptable. That is a deliberate, scheduled migration, not a side effect of a bug-fix commit.

**To close it:** set `SESSION_SECRET` on the Railway service to the current contents of `/data/.session-secret` (so nothing is invalidated), confirm the setup issue disappears, then change the fallback to a hard failure when `HOSTED` is on.

### 2. `QuickStart` and the `['starter-rules']` query key are dead code

`QuickStart`, `STARTERS`, `bindStarter` and `draftFromStarter` are still exported from `web/src/components/instagram/index.ts` but nothing renders them — the templates gallery replaced them in round 7 — and the `['starter-rules']` invalidations in `Automations.tsx` and `RuleBuilder.tsx` now target a query nobody runs. It is inert: an invalidation of an unused key is a no-op, and the unused export costs a few hundred bytes the bundler already tree-shakes out of the entry chunk.

Not fixed because deleting a round-6 component during a fix pass mixes cleanup into a commit whose job is to be reviewable against a list of defects. It belongs in the next round's opening tidy, together with `POST /api/instagram/starter`, which is the server half of the same retired flow.

### 3. The webhook that belongs to nobody is dropped, not queued

`tenantsForWebhook` now returns an empty list on a hosted deployment when a payload matches no account, and the route acknowledges the event with 200 and stores nothing. That closes the leak — a disconnected customer's DMs used to land in the operator's activity log, with the sender's Instagram id, handle and message text — but it also means those events are simply gone.

The alternative would be a quarantine table so an accidental disconnect could be replayed after reconnecting. Not built: it would be a new table holding third-party message content for tenants who by definition are not our customers at that moment, which is a worse privacy position than dropping the event, and Meta stops delivering once the subscription lapses anyway. The console line names the case if it ever turns out to be common.

---

## Two claims the repository cannot verify — both now checked against production (orchestrator, 17 Aug 2026)

**Nightly backups: TRUE, evidence attached.** All four `R2_*` variables are set on the Railway service and `BACKUP_KEEP` is unset (so the default 14 applies). `GET /api/admin/backup` on production answers `configured: true`, `keep: 14`, `hourUtc: 3`, `lastError: null`, and its newest scheduled snapshot is `backups/resurface-20260817-0302.db.gz`, 20,499,624 bytes, taken at 03:02 UTC that morning, with earlier snapshots also present in the bucket. The sentence stays on all three pages.

**Hosting region: EU West, so the disclaimer was replaced with the fact.** `railway status` reports `region: EU West` for the `resurface` service and its volume. `SUBPROCESSORS.md` now states EU West with the verification date instead of "assume the United States"; `PRIVACY.md` and `DPA.md` now say hosting is in the EU and name OpenAI and Paddle as the two subprocessors that do process outside the EEA. The R2 backup bucket is deliberately **not** claimed as EU — it was created with Cloudflare's automatic location hint, so its placement is Cloudflare's and both pages say so.

The original notes, kept for the record:

### Nightly backups

`docs/legal/SECURITY.md`, `docs/PRIVACY.md` and `docs/legal/DATA-DELETION.md` all state that the database is backed up nightly with 14 snapshots kept. `services/backup.ts` only does that when **all four** of `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are set; otherwise it logs "not configured … nightly DB backups disabled" and does nothing. **Confirm those four are set on the production service, and that `BACKUP_KEEP` is unset or `14`.** If they are not, the sentence has to come off three pages before app review.

### Hosting region

The spec asked `/privacy` to name "Railway (EU-West)". The pages deliberately say the opposite and safer thing — `SUBPROCESSORS.md` says to assume the United States, `PRIVACY.md` says outside the EEA — because nothing in the repository pins a region and `railway.json` does not carry one. That is the honest wording, and it is a conscious deviation from the spec sentence. **It must match what Railway actually reports before the DPA goes to anyone**, and if the service really does run in EU-West, saying so is a better answer for European customers than the disclaimer that is there now.

---

## Where the fixed defects live

For anyone tracing a change back to the report that caused it, the fixes cluster in nine places:

| Area | Files |
| --- | --- |
| Paywall promises (`no card`, one-click cancel, unresolvable webhooks, grandfathering) | `services/paywall.ts`, `services/paddle.ts`, `services/plans.ts`, `routes/billing.ts`, `lib/plans.ts`, `pages/{Landing,Signup,Login,Billing,Paywall}.tsx`, `components/{Pricing,marketing,UpgradeModal}.tsx` |
| Onboarding wizard (the loop, the OAuth exit, per-account browser state, the phone) | `components/onboarding/**`, `lib/store.tsx`, `lib/utils.ts`, `components/instagram/useIgAccount.ts` |
| Never recommend the impossible | `services/ig-availability.ts`, `routes/{instagram,onboarding}.ts`, `components/instagram/{ConnectCard,HealthCard}.tsx`, `pages/{Analytics,Automations}.tsx` |
| Profile score (concurrency, the missing bio, the unbounded call, the empty answer) | `services/profile-score.ts`, `routes/profile-score.ts`, `components/profile/ManualProfile.tsx`, `pages/ProfileScore.tsx`, `lib/types-profile.ts` |
| Automations list and picker | `components/instagram/{RuleList,PostPicker,HealthCard}.tsx`, `pages/Automations.tsx` |
| Tenant isolation on incoming webhooks | `services/automations.ts`, `routes/automations.ts` |
| Deletion actually deleting | `routes/{instagram,billing}.ts`, `services/media.ts`, `services/media-sweep.ts` |
| Policy pages matching the code | `docs/PRIVACY.md`, `docs/legal/**`, `docs/BUSINESS.md`, `.env.example` |
| Tests for all of the above | `services/{paywall,ig-availability,profile-score,onboarding-wizard,automations,deletion}.test.ts` |

A verification pass over this list afterwards reproduced every fix in the source and found the tree green, but five of
the server-side fixes had no test standing behind them: the OAuth `next` round trip, the deauthorize wipe, the stored
data-deletion confirmation code, the Paddle cancel on account deletion, and the orphaned-media sweep. They are now
covered by `server/src/services/deletion.test.ts` (45 checks, registered in `npm test`). Each assertion was confirmed
to fail against the pre-fix behaviour rather than passing vacuously — the sweep's "an empty live set removes nothing"
guard especially, since without it a database that is not open yet reads as an empty library and every tenant's cached
media on the volume would be deleted.


---

## Orchestrator ruling: the paywall "bypass" on the pre-guard routes

The integrator flagged that `paywallGuard` is mounted from `mountPublicExtras`, so routes registered earlier in `app.ts` — `POST /api/import/harvest-form` and the Companion's bearer-token device endpoints — never reach it, and asked for a conscious decision.

**Ruling: leave it. It is not reachable.** Both paths require a credential that can only be obtained from behind the wall. The Companion's device token comes from `POST /api/companion/pair-code`, which is a session route inside the guard, and the harvest-form token is minted by a session route too. A locked tenant is locked from the moment it is created — `requires_payment = 1` is written during signup itself — so it never has a window in which to mint either credential. And a tenant that already holds a device token is by definition one that was never locked (grandfathered) or has already paid.

What would make this a real hole is a future change that locks an *existing* tenant — for example re-locking on a failed renewal. If that is ever added, these two routes must be moved behind the guard in the same commit. `server/src/services/paywall.test.ts` enumerates `app.routes` against an explicit allowlist, so a new pre-guard route will fail the suite rather than slip through, but a change in *when* a tenant becomes locked would not be caught by it.

---

## OPEN defect, found in post-deploy verification: the wizard never shows the pairing code

**Impact.** A new person who picks "Install the Companion" on screen 1 of `/welcome` never gets a code to paste. The button sits on "Creating…". This is the primary path of the first onboarding screen — the exact flow round 7 exists to make finishable. **Workaround: `/import` works**, so anyone stuck can be sent there.

**What is established, each verified against production rather than reasoned about:**

- The server is fine. `POST /api/companion/pair-code` as a fresh trial account returns `200 {"code":"RSF-ABHY-QDYK","expiresAt":<ms>,"ttlSeconds":300}` immediately, by curl and in the browser (the network tab shows the 200).
- `/import` renders the same `PairingCode` component and **works** for the same fresh trial account: still "Creating…" at 1.2 s, code on screen by 5.2 s. It also works for the owner — the `import-pairing` flow step has passed in every run.
- The wizard does **not**: polled every 500 ms for 20 s after the click, no `RSF-` ever appears, no `<code>` element is in the DOM, no Copy button, and `RSF-` is absent from `innerHTML` as well as `innerText`. So the code branch never mounts.
- It is not the expiry bug fixed in 51ee756: `expired` is now correctly false throughout, and no countdown renders either.
- No console errors, no page errors, no failed requests.

**What that leaves.** `pair.data` is never populated in the wizard's instance while the request plainly succeeded — so either that instance is unmounted before the mutation settles (a remount would reset it to idle, which matches "no code, no expiry, no countdown") or the settled state lands on an instance that is no longer the one rendering. `StepBringSaves` polls (`useJobs`, `useCompanionDevices`, `total`, `advancing`) so it re-renders continuously, and `PairingCode` sits inside an `<ol>` inside `WizardShell`; the list keys are stable (`key={t}`), so the remount, if that is what it is, comes from higher up.

**How to finish it.** Run the wizard locally against a fresh tenant with React DevTools' "highlight updates" on, or drop a `useEffect(() => console.log('PairingCode mount'), [])` into the component — one reload of `/welcome` will say immediately whether it is mounting repeatedly. If it is, hoist the mutation state above the polling boundary (lift `usePairCode` into `StepBringSaves` and pass `code`/`onMint` down, or memoise the subtree) rather than trying to make the child survive.

**Do not** fix this by auto-minting on mount. That was the round-6 behaviour and it was removed for a good reason: the code lives five minutes and this step sits behind "download the zip, unzip it, switch on Developer mode", so the code was routinely dead before it was pasted.
