# Instagram DM automations ("ManyChat-lite") — setup guide

Resurface ships a small rules engine on top of Meta's official **Instagram API with Instagram Login**:

- **Comment → DM**: someone comments a keyword on your post → they get a private DM (and optionally a public reply).
- **DM keyword auto-reply**: someone DMs a keyword → auto-reply (with a link).
- **Story reply responder**: someone replies to your story with a keyword → auto-reply.
- Catch-all rules, per-person cooldowns, priorities, `{{username}}` templating, a dry-run tester and an activity log.

It runs inside your Resurface server: no third-party bot platform, no monthly fee, your data stays on your volume.

> Requirements: an Instagram **Professional** account (Business or Creator — switch in Instagram settings, it's free), a Meta developer account, and your Resurface instance reachable over public HTTPS (Railway gives you that).

Time: ~15 minutes. Everything below happens at **https://developers.facebook.com/apps**.

## 1. Create the Meta app

1. **Create App** → type **Business**. Name it anything (e.g. `Resurface DM`).
2. Use case: **"Manage messaging and content on Instagram"** (filter "All" if you don't see it). Do *not* add Marketing API / Facebook Login use cases — they add review requirements you don't need.
3. Dashboard → **Add product → Instagram → Set up**.

## 2. Connect your Instagram account & get a token

Left menu → **Instagram → API setup with Instagram business login**. Three numbered steps on that page:

1. **Generate access tokens** → **Add account** → log in with your Instagram professional account → **Generate token**. Copy it — it's a **long-lived token (60 days)**.
   Turn **on** the webhook toggle on that account row.
2. **Configure webhooks** (see step 3 below).
3. *(Set up Instagram business login — skip; only needed if you build an OAuth flow.)*

Also on that page: your **Instagram App ID / Instagram App Secret**. (The *Meta* App Secret under **Settings → Basic** is a different value — that's the one used to sign webhooks; see below.)

**Tester role (do this even for your own account):** App Dashboard → **App roles → Roles → Instagram testers → Add** your Instagram username. Then in the **Instagram app**: *Settings and activity → Website permissions / Apps and websites → Tester invites → Accept*.

**Allow message access:** in the Instagram app → *Settings → Messages and story replies → Message controls → Connected tools → **Allow access to messages** = ON*. Without it, sends fail (`error 200 / 2534041`) and message webhooks never arrive.

## 3. Point the webhook at Resurface

In Resurface → **Automations** the status card shows your **Webhook URL** — `https://<your-domain>/api/webhooks/instagram` — and whether a **verify token** is set.

Pick any string as your verify token (e.g. `resurface-verify-abc123`) and set it as `META_VERIFY_TOKEN` (env var) or in **Settings → Instagram automations**. Then in the Meta dashboard, **Configure webhooks**:

- Callback URL: your webhook URL
- Verify token: the same string
- **Verify and save** — Resurface answers the handshake (you'll see *"Webhook verified by Meta"* in the Automations activity log).
- Subscribe to fields: **`messages`**, **`comments`** (optionally `messaging_postbacks`, `message_reactions`).

**Required before you paste an access token:** copy the **Meta App Secret** (Settings → Basic → App Secret → Show) into `META_APP_SECRET` so Resurface verifies the `X-Hub-Signature-256` HMAC on every webhook. Resurface fails closed: once an access token is configured, unsigned webhooks are rejected with 401 (and logged) until the secret is set. Without a token *and* without a secret, unsigned events are merely logged (useful for testing the handshake).

## 4. Give Resurface the credentials

Either as environment variables (Railway → Variables) or in **Settings → Instagram automations**:

| Key | Value |
|---|---|
| `IG_ACCESS_TOKEN` | the long-lived token from step 2 |
| `IG_USER_ID` | your numeric professional account id — get it with `GET https://graph.instagram.com/me?fields=user_id,username&access_token=…` → use **`user_id`** (Resurface's *Test connection* button shows it) |
| `META_VERIFY_TOKEN` | the string you chose |
| `META_APP_SECRET` | Meta App Secret (required as soon as a token is set — see step 3) |
| `GRAPH_API_VERSION` | optional, default `v23.0` |

Click **Test connection** on the Automations page — it calls `/me` and should show your username.

## 5. Go Live

Top of the Meta dashboard: switch the app from **Development** to **Live** (it asks for a Privacy Policy URL under Settings → Basic — you can use this repo's [docs/PRIVACY.md](PRIVACY.md), e.g. `https://github.com/<you>/<repo>/blob/main/docs/PRIVACY.md`).

Why: in Development mode Meta only delivers webhooks for accounts that have a role on the app (your testers). Comments and DMs from real people only arrive when the app is **Live**. Standard Access is enough for your own account — **no App Review needed**.

## 6. Create rules

Automations → **New rule** (or the "comment LINK → send link" template):

- Trigger, keywords, match mode (contains / exact / starts with / regex).
- Reply text (supports `{{username}}`), optional link appended, optional public comment reply.
- Cooldown per person (default 24h) so the same person isn't spammed; priority (lower runs first — first match wins).
- **Test** tab: dry-run any text against your rules — nothing is sent.

Then comment your keyword on one of your own posts from another account (or ask a friend) and watch the **Activity** tab.

## Limits & gotchas (from Meta's docs)

- **24-hour window:** you can DM someone only within 24h of their last message to you (comments/private replies open that window). Human-agent tag (7 days) needs App Review — not used here.
- **Private replies:** one per comment, within 7 days, only on your own media (comments on ads/other people's posts don't work). Rate: 750/hour.
- **Tokens expire after 60 days.** Refresh with `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<TOKEN>` (works when the token is >24h old) or generate a new one in the dashboard and paste it in Settings.
- Your own outbound messages arrive as webhooks with `is_echo: true` — Resurface ignores them (no loops). Meta retries deliveries for up to 36h; Resurface dedupes on message/comment id.
- Error `10`: outside the 24h window · `190`: token expired · `368`: temporarily blocked for policy · `613/80002`: rate limit · `508`: link not allowed. They show up in the Activity log.

## Why not chatmany?

We looked at [ryanlaiyanip-ctrl/chatmany](https://github.com/ryanlaiyanip-ctrl/chatmany) (Aug 2026): a real, MIT-licensed comment→DM funnel on the same official API — but a days-old single-author prototype (5 commits in one afternoon, no releases/issues), **Cloudflare Workers + D1 only** (not portable to a Node/Docker stack), bearer-token single-tenant auth, polling-first, and comment funnels only (no inbound-DM keyword replies). Nice ideas we borrowed: whole-word matching, idempotent sends, echo filtering.

Other options: **OpenReply** (MIT, Next.js + Postgres + Redis, webhooks, follow-gate — the most mature OSS alternative; run it as a sidecar if you outgrow the built-in engine), InstaAuto/insta-p8, ZernFlow (depends on a proprietary API), Typebot (no Instagram channel), Botpress OSS (sunset; IG only in paid cloud), Chatwoot (inbox, no comment→DM), n8n (webhook + HTTP node templates, no first-party IG node).

Verdict: for a solo creator who wants keyword replies + comment→DM inside their own dashboard, a small rules engine on the official API (this) is the least moving parts. If you need visual flows, quick-reply buttons and multi-step conversations, look at OpenReply.
