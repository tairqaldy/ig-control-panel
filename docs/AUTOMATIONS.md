# Connect Instagram — DM automations and analytics

Resurfly talks to Instagram through Meta's official **Instagram API with Instagram Login** (Graph API v23.0, no Facebook Page required). One connection powers two features:

- **Automations** ("ManyChat-lite") — a small rules engine inside your Resurfly server:
  - **Comment → DM**: someone comments a keyword on your post → they get a private DM (and optionally a public reply).
  - **DM keyword auto-reply**: someone DMs a keyword → auto-reply (with a link).
  - **Story reply responder**: someone replies to your story → auto-reply.
  - Catch-all rules, per-person cooldowns, priorities, `{{username}}` templating, a dry-run tester, an activity log. No third-party bot platform, no extra monthly fee.
- **Analytics** — followers and reach series, profile views, interactions, saves, best hours/days to post, content mix, top posts and hashtags from the Insights API (see [Analytics](#analytics) below).

> Requirements: an Instagram **Professional** account (Business or Creator — switch in Instagram settings, it's free) and, for the self-hosted app, your Resurfly instance reachable over public HTTPS (Railway gives you that).

## Two ways to connect

| | **Hosted (resurfly.com)** or any server with `META_APP_ID` + `META_APP_SECRET` set | **Bring your own Meta app** (self-host, manual token) |
|---|---|---|
| What you do | Automations → **Connect Instagram** → approve on Instagram. | Create a Meta app, generate a token, paste it into Settings → Integrations (~15 min). |
| Token | Long-lived (60 days), stored encrypted (AES-256-GCM), refreshed automatically every 12 h when < 10 days remain. | Long-lived (60 days), stored in your `settings` table (or env). Refresh yourself before it expires (see below). |
| Webhooks | Subscribed for you (`messages, comments, message_reactions, messaging_postbacks, messaging_seen`). | You paste the callback URL + verify token in the Meta dashboard. |
| Starter rules | Three disabled rules are created on first connect (comment keyword → DM the link · first DM → welcome · story reply → thanks). "Add starter rules" on the Automations page does the same later. | Same button. |
| Disconnect | Automations → Disconnect (deletes the token, unsubscribes best-effort). Removing Resurfly under Instagram → *Apps and websites* also disconnects (deauthorize callback). | Clear the fields in Settings. |

Self-hosters get the one-click path too: create the Meta app once (steps 1–3 below), set `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN` and `PUBLIC_URL`, redeploy, then press **Connect Instagram**. The manual token (step 4) is the fallback for when you would rather not run OAuth.

## Meta app setup (both paths for self-hosters; already done for resurfly.com)

Everything below happens at **https://developers.facebook.com/apps**.

### 1. Create the app

1. **Create App** → type **Business**. Name it anything (e.g. `Resurfly`).
2. Use case: **"Manage messaging and content on Instagram"** — this is the *Instagram Login* use case (filter "All" if you don't see it). Do *not* add Marketing API / Facebook Login use cases — they add review requirements you don't need.
3. Dashboard → **Add product → Instagram → Set up**.

### 2. Instagram business login (only for the Connect button)

Left menu → **Instagram → API setup with Instagram business login** → step 3, **Set up Instagram business login** → **Business login settings**:

- **OAuth redirect URIs**: `https://<your-domain>/api/instagram/callback` (exactly what `PUBLIC_URL` resolves to; Resurfly shows it at `GET /api/instagram/status`).
- **Deauthorize callback URL**: `https://<your-domain>/api/instagram/deauthorize`
- **Data deletion request URL**: `https://<your-domain>/api/instagram/delete` (Resurfly answers with `{ url: <your-domain>/privacy, confirmation_code }` and wipes that account's automation contacts/events and analytics cache).
- Scopes requested by Resurfly: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_manage_insights`. Make sure the corresponding permissions are added to the app (Instagram → Permissions, or the use case's *Customize* screen).

On the same page you find the **Instagram App ID** and **Instagram App Secret** — these are `META_APP_ID` and `META_APP_SECRET`. (The *Meta* App Secret under **Settings → Basic** is a different value used to sign webhooks; see step 3.)

**Tester role (do this even for your own account, and for every account that connects while the app is in Development mode):** App Dashboard → **App roles → Roles → Instagram testers → Add** the Instagram username. Then in the **Instagram app**: *Settings and activity → Website permissions / Apps and websites → Tester invites → Accept*.

**Allow message access:** in the Instagram app → *Settings → Messages and story replies → Message controls → Connected tools → **Allow access to messages** = ON*. Without it, sends fail (`error 200 / 2534041`) and message webhooks never arrive.

### 3. Webhooks

In Resurfly → **Automations** the status card shows your **Webhook URL** — `https://<your-domain>/api/webhooks/instagram` — and whether a **verify token** is set.

Pick any string as your verify token (e.g. `resurfly-verify-abc123`) and set it as `META_VERIFY_TOKEN` (env) or in **Settings → Integrations → Bring your own Meta app**. Then in the Meta dashboard, **Instagram → API setup … → Configure webhooks**:

- Callback URL: your webhook URL
- Verify token: the same string
- **Verify and save** — Resurfly answers the handshake (you'll see *"Webhook verified by Meta"* in the Automations activity log).
- Subscribe to fields: **`messages`**, **`comments`** (optionally `messaging_postbacks`, `message_reactions`, `messaging_seen`). With OAuth these are also subscribed per account by Resurfly.

**App secret for signatures:** copy the **Meta App Secret** (Settings → Basic → App Secret → Show) into `META_APP_SECRET` (or the Settings field) so Resurfly verifies `X-Hub-Signature-256` on every webhook. Resurfly fails closed: once an access token is configured, unsigned webhooks are rejected with 401 (and logged) until the secret is set. Without a token *and* without a secret, unsigned events are merely logged (useful for testing the handshake). Hosted accounts connected via OAuth inherit the server's secret automatically.

### 4. Manual token (bring-your-own path only)

Left menu → **Instagram → API setup with Instagram business login** → step 1, **Generate access tokens** → **Add account** → log in with your Instagram professional account → **Generate token**. Copy it — it's a **long-lived token (60 days)**. Turn **on** the webhook toggle on that account row.

Give it to Resurfly either as env vars (Railway → Variables, owner account only) or in **Settings → Integrations → Bring your own Meta app**:

| Key | Value |
|---|---|
| `IG_ACCESS_TOKEN` | the long-lived token |
| `IG_USER_ID` | your numeric professional account id — `GET https://graph.instagram.com/me?fields=user_id,username&access_token=…` → use **`user_id`** (Resurfly's *Test connection* button fills it in) |
| `META_VERIFY_TOKEN` | the string you chose in step 3 |
| `META_APP_SECRET` | Meta App Secret (required as soon as a token is set — see step 3) |
| `GRAPH_API_VERSION` | optional, default `v23.0` |

Click **Test connection** on the Automations page — it calls `/me` and should show your username.

**Tokens expire after 60 days.** Refresh with `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<TOKEN>` (works when the token is > 24 h old) or generate a new one in the dashboard and paste it in Settings. OAuth-connected accounts are refreshed by the server; the account card shows the expiry.

### 5. Development vs Live, and App Review

**This is the one setting that decides whether automations work at all.** Meta's own words, from the [Instagram webhooks reference](https://developers.facebook.com/docs/instagram-platform/webhooks): *apps must be set to Live in the App Dashboard to receive webhook notifications.*

Not "fewer notifications" in Development mode — **none**. A rule can be perfect, the account connected, the webhook subscribed and the signature valid, and still nothing happens, because Instagram never sends the event. There is no error to see, because there is no request. This is why Resurfly's health card raises `Meta app in Live mode` as soon as an account has been connected for five minutes without a single inbound event.

<a id="live-mode"></a>

#### Getting to Live mode

Meta gates the Live switch behind a checklist (App dashboard → **Publish**). In order:

1. **Settings → Basic:** app icon (1024×1024), category, **Privacy Policy URL** `https://<your-domain>/privacy`, **Terms of Service URL** `https://<your-domain>/terms`, **User data deletion** → `https://<your-domain>/api/instagram/delete` (Resurfly implements Meta's signed-request deletion callback).
2. **Business verification** — the slow one. In [Business settings → Business info](https://business.facebook.com/settings/business_info) fill in the **registered legal name, address, phone and website exactly as they appear on your paperwork**, then submit documents Meta can match against a public registry: certificate of incorporation / business registration, a tax document, a bank or utility statement in the business's name. Meta then verifies by phone, e-mail, or a code sent to the address. Days to a few weeks, and it fails on mismatched details more often than on missing ones — a website whose domain doesn't match the business name, or an address written differently than on the certificate.
   **You need a registered entity.** A personal Instagram account and a domain are not enough; if you have no company yet, registering one (sole proprietorship in most countries) is a prerequisite, not a formality.
3. **Publish.** Once verification clears, the Publish button turns on and the app flips to Live. Webhooks start arriving immediately — no redeploy, no reconnect.

#### What App Review does and does not cover

- **Your own account:** Standard Access ("Ready for testing") plus an Instagram tester role is enough. **No App Review needed** — but Live mode is still required, because Live is what turns webhook delivery on.
- **Other people's accounts (hosted):** the four scopes need **Advanced Access** via App Review — a screencast of the Connect flow, the automations page and the analytics page. Until then only accounts with a tester/developer role can connect.
- Not used anywhere: Human-agent tag (7-day window), `pages_*` permissions, Facebook Login.

#### While you wait

Everything except delivery can be built and checked today:

- **Simulate** in the rule builder runs the real matcher against your real rules and shows which rule would answer and why the others wouldn't. No Instagram call.
- **Send to…** performs a genuine DM through the Graph API (it needs a person who messaged you inside the 24-hour window) — that proves the token and permissions independently of webhooks.
- The **health card** tells you which of the seven links in the chain is broken, in plain language.

**Status for resurfly.com (17 Aug 2026):** app `1578560403654755` is in Development mode. The Publish page lists *Business verification: not verified* and the Publish button is disabled. The business portfolio "Resurfly" (`2018572538790775`) exists but has no legal name, address, phone or website on file yet — step 2 above has not been started. Until it is, no DM, comment or story reply will reach the server, for the owner or anyone else.

## Create rules

Automations → **Quick start** shows the three starter rules (edit keywords and reply, toggle Enable, "Send me a test") — or **New rule**:

- Trigger, keywords, match mode (contains / exact / starts with / regex).
- Reply text (supports `{{username}}`), optional link appended, optional public comment reply.
- Cooldown per person (default 24 h) so the same person isn't spammed; priority (lower runs first — first match wins).
- **Test** tab: dry-run any text against your rules — nothing is sent.

Then comment your keyword on one of your own posts from another account (or ask a friend) and watch the **Activity** tab.

Plan limits (hosted): trial 1 rule / 100 sends per month, Pro 10 rules / 5,000 sends, Studio unlimited rules / 25,000 sends. Over the limit the API answers 402 and the UI shows the upgrade prompt.

## Analytics

Once connected, **Analytics** shows the last 7/30/90 days: followers and reach per day, totals (profile views, accounts engaged, interactions, likes, comments, shares, saves, replies, website clicks), best hours and weekdays to post, content mix (reels / carousels / images), engagement rate, top posts by saves and reach, and a hashtag table. Data comes from `GET /{ig-user-id}/insights` (account, `period=day`, both time-series and `metric_type=total_value` calls), `/{ig-user-id}/media` (newest 100) and per-media insights — sequential, at most 120 requests per refresh, refreshed at most every 6 hours per account (the **Refresh** button forces one, at most hourly). Metrics Instagram refuses for a given account are skipped, never fatal. Before you connect, the page shows sample data with a "Connect Instagram" banner.

Ask uses the same 30-day payload for the **Analytics** mode ("what should I post this week?").

## Limits & gotchas (from Meta's docs)

- **24-hour window:** you can DM someone only within 24 h of their last message to you (comments/private replies open that window). Human-agent tag (7 days) needs App Review — not used here.
- **Private replies:** one per comment, within 7 days, only on your own media (comments on ads/other people's posts don't work). Rate: 750/hour.
- Your own outbound messages arrive as webhooks with `is_echo: true` — Resurfly ignores them (no loops). Meta retries deliveries for up to 36 h; Resurfly dedupes on message/comment id.
- Error `10`: outside the 24 h window · `190`: token expired · `368`: temporarily blocked for policy · `613/80002`: rate limit · `508`: link not allowed. They show up in the Activity log.
- Insights: some metrics are unavailable for small or new accounts (Resurfly skips them and shows what it got); `views` is requested for reels/videos only.

## Why not chatmany?

We looked at [ryanlaiyanip-ctrl/chatmany](https://github.com/ryanlaiyanip-ctrl/chatmany) (Aug 2026): a real, MIT-licensed comment→DM funnel on the same official API — but a days-old single-author prototype (5 commits in one afternoon, no releases/issues), **Cloudflare Workers + D1 only** (not portable to a Node/Docker stack), bearer-token single-tenant auth, polling-first, and comment funnels only (no inbound-DM keyword replies). Nice ideas we borrowed: whole-word matching, idempotent sends, echo filtering.

Other options: **OpenReply** (MIT, Next.js + Postgres + Redis, webhooks, follow-gate — the most mature OSS alternative; run it as a sidecar if you outgrow the built-in engine), InstaAuto/insta-p8, ZernFlow (depends on a proprietary API), Typebot (no Instagram channel), Botpress OSS (sunset; IG only in paid cloud), Chatwoot (inbox, no comment→DM), n8n (webhook + HTTP node templates, no first-party IG node).

Verdict: for a solo creator who wants keyword replies + comment→DM inside their own dashboard, a small rules engine on the official API (this) is the least moving parts. If you need visual flows, quick-reply buttons and multi-step conversations, look at OpenReply.
