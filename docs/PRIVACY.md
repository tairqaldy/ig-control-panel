# Privacy policy — resurfly.com

*Last updated: 17 August 2026. This is the privacy policy for the hosted service at resurfly.com, operated by Resurfly (contact: hello@resurfly.com). If you run your own copy of the open-source code, the operator notice at the bottom of this page applies instead.*

This page says what we store, why, who else can see it, where it lives, how long we keep it and how to delete it. Three companion pages go into more detail: [Subprocessors](/subprocessors) names every company involved, [Data deletion](/data-deletion) is the step-by-step erasure sheet, and [Security](/security) covers encryption, hashing and backups. The [Companion extension privacy policy](/privacy/extension) covers the Chrome extension specifically.

## The short version

- We store the posts you saved on Instagram, what our analysis derives from them, and — only if you connect an Instagram professional account — that account's profile, your own posts and their insights, and the messages and comments your automations answer.
- The only company we send your content to is **OpenAI**, for transcription, analysis, embeddings and answers. It is not used to train models.
- We do not sell your data, do not share it with advertisers or data brokers, and run **no third-party analytics and no ad pixels** anywhere on the site.
- You can export everything on any plan and delete everything yourself in one step.
- We never see your Instagram password, and we never see your card.

## 1. Account and billing

- **E-mail address** and a **scrypt hash** of your password (the password itself is never stored). Used to sign you in and to write to you about your account.
- **Plan, billing status, trial and renewal dates, and Paddle's customer / subscription / transaction ids.** Used to give you the plan you paid for and to reconcile invoices.
- **Usage counters** — how many saves were analyzed, questions asked, replies sent, harvests run this period — and the **credit ledger** (every purchase and every debit, with its reason). Used to apply plan allowances and to let you audit your own balance.
- **Your IP address, for rate limiting only.** Signups are counted per IP for a minute at a time; failed logins and Companion pairing attempts for ten minutes at a time. The counters live in the server's memory and are never written to the database. We run no request log in production, so your IP is not recorded there either; our host and Cloudflare necessarily see it in order to deliver the request.
- **A waiting-list row, only if you ask for one.** While Meta is still reviewing our app you can press "tell me when this is ready" instead of a Connect button that would fail. That stores one row: an e-mail address (the one on your account unless you type another), which screen you asked from, and the date. Taking yourself off the list again on that same screen deletes the row, and so does deleting your account.
- **A record of each paired Companion device**, if you use the extension: the name you give it, the browser's user-agent string, a SHA-256 hash of its device token (never the token), when it was last seen and when it last sent saves, and how many. Used to show you your own devices and to let you revoke one. Revoking the device or deleting the account removes the row.
- **A session cookie** named `rs_session`: `HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS, valid for 30 days. It is what keeps you signed in. There are no advertising or tracking cookies. Your dark/light preference is kept in your browser's local storage and never sent to us.

Paddle is our **merchant of record**: it runs the checkout, stores the card, calculates tax and issues the invoice. Card details never reach our servers. Paddle's own script is loaded from Paddle only at the moment you open a checkout.

## 2. Your saved posts

The Companion extension and the harvester script run **in your browser with your own Instagram session** — we never ask for or receive your Instagram password. What reaches us is the harvest JSON:

- the post link, shortcode, caption and alt text; the creator's username, display name and avatar URL; like/comment/play counts; duration; music or original-audio credit; location name; user tags, co-authors and the paid-partnership flag; when the post was taken and, when Instagram tells us, when you saved it and to which collection.

You can also upload an official Instagram data export (`saved_posts.json`) or paste post URLs, which produces the same kind of record.

**What we derive from it.** We download the thumbnail and, for reels, a few still frames and the audio, so we can transcribe and analyze them. From that we store a machine transcript, a structured analysis (summary, key points, tags, entities, category), an embedding vector for meaning-based search, and the cached thumbnail and frames.

The **video file and the audio track are deleted the moment processing finishes** — on resurfly.com we keep only the thumbnail, the still frames and the transcript. (Keeping reels on disk is a `KEEP_VIDEOS` switch for people running their own copy; it is off here.)

All of it is scoped to your account and is never shown to another account.

## 3. Instagram connection (optional)

Nothing in this section happens unless you press **Connect Instagram** and grant the permissions Instagram shows you. We ask for four, and each one is used for exactly one part of the product:

- `instagram_business_basic` — your profile and your own recent posts. Used by the Analytics and Profile score pages.
- `instagram_business_manage_messages` — receive the DMs and story replies people send you, and send the replies your own rules define. Used by automations.
- `instagram_business_manage_comments` — receive comments on your posts and reply to them. Used by automations.
- `instagram_business_manage_insights` — the metrics Instagram reports for your account and for individual posts. Used by the Analytics page.

We ask for nothing else, and we do not use these permissions for anything beyond the pages named above.

We receive an access token for your Instagram professional account through Meta's Instagram Login. It is **encrypted with AES-256-GCM before it is written to the database**, refreshed automatically before it expires, and never written to logs. With it we store and process:

- **Profile.** Your Instagram user id and app-scoped id, username, display name, profile picture URL, account type, and follower / following / media counts. Refreshed periodically, with a dated snapshot kept so the Analytics page can show change over time.
- **Your own media.** For your recent posts: the media id, caption, media type and product type, media and thumbnail URLs, permalink, timestamp, like and comment counts, and the insights Instagram returns for that post. This is what the Analytics and Profile score pages read.
- **Account insights.** Daily metric values (reach, views, profile activity and similar) as Instagram reports them, stored per day and metric.
- **Messages, comments and story replies — only for the automations you build.** When someone sends a DM, comments on a post or replies to a story, Meta delivers a webhook to us. We verify Meta's `x-hub-signature-256` before processing it, then store: the sender's Instagram-scoped id, their username when Instagram provides it, the text of the message or comment, the timestamp, which rule matched (or why none did), what we sent back, any error, and the first 8,000 characters of the raw event as Meta delivered it, for troubleshooting. We also keep a small contact row per sender — id, username, first and last seen, message count, which rules already fired for them — so a rule can honour "only once per person" and a cooldown.

We do not read your inbox history, your feed, your followers list, or anything about accounts other than yours. We never post, like, follow or comment on your behalf beyond the replies your own rules send.

**Disconnecting** in Settings → Instagram deletes the token and the account record and unsubscribes the webhook. Removing Resurfly under Instagram → Apps and websites does the same through Meta's signed-request callbacks and additionally deletes the automation contacts and events and the cached media, insights and snapshots. See [Data deletion](/data-deletion).

## 4. Background sync (opt-in, off by default)

Only if you switch on **"Also harvest when my browser is closed"** in the Companion does it send us three `instagram.com` cookies — `sessionid`, `csrftoken`, `ds_user_id` — and your browser's user-agent string, once. We store them encrypted (AES-256-GCM), never log them, and use them for exactly one thing: fetching your saved-posts feed about every 12 hours. If Instagram invalidates the session we stop and ask you to reconnect. Turning the switch off, revoking the device or deleting the account removes them immediately. Details in the [Companion extension privacy policy](/privacy/extension).

## 5. Profile score

If you use the Profile score page we store the answers to its short questionnaire (what the account is for, your niche, who should follow you, what you want people to do, your tone) and the reports it generates. If your Instagram account is not connected you can type the profile fields in by hand instead; we store what you type. The questionnaire answers and the profile fields are sent to OpenAI to produce the report.

## 6. Who else processes it

Four companies, each with a job the product cannot do without. The full list with purpose and region is on [Subprocessors](/subprocessors):

- **OpenAI** — transcription, analysis, embeddings, Ask answers, Profile score. Receives captions, transcripts, video frames, your notes and questions, and library excerpts as context. When you connect an Instagram account and ask a question about your own performance, it also receives that account's public profile fields (handle, name, follower / following / post counts) and the insight figures behind the answer — daily reach and views, your recent posts' captions with their reach, likes, comments and saves, and hashtag performance. On the Profile score page it additionally receives the bio, the link and the account category. Nothing from anyone else's account is ever sent. Under the OpenAI API terms your data is **not used to train** OpenAI's models; OpenAI may retain API inputs and outputs for up to 30 days for abuse monitoring.
- **Railway** — hosting: the application server and the disk holding the database and cached media.
- **Cloudflare** — DNS for the domain, and R2 object storage for the nightly database backup.
- **Paddle** — payments, as merchant of record.

That is the whole list. No analytics vendor, no error-tracking vendor, no mailing platform, no advertising network.

## 7. Where it lives

The database and the cached media sit on one persistent disk attached to our Railway service; the disks are encrypted at rest by the infrastructure provider, and we encrypt tokens and sessions ourselves on top of that. A gzipped snapshot of the database is written nightly to a private Cloudflare R2 bucket that is not publicly readable.

The service itself is hosted in the **EU (Railway, EU West)**, so your library and your account live in the EU. Two subprocessors do process data outside the EEA, including in the United States: **OpenAI** (the text we send for analysis and answers) and **Paddle** (payment and billing data). Where EEA or UK law applies, those transfers rely on the providers' standard contractual clauses. See [Subprocessors](/subprocessors) for the full list and each one's region.

## 8. How long we keep it

- **While your account is active:** everything above is kept, so the product works.
- **After a subscription is cancelled or a trial ends:** your library stays readable and exportable, and **we do not delete it automatically** — come back in two months and it is still there. It goes when you delete the account or ask us to. There is no dormant-account clean-up job today; if we ever add one we will say so in the product and by e-mail **at least 30 days before** it runs. You never have to wait for us: Billing → Delete account erases everything immediately.
- **Instagram token:** until you disconnect, remove the app on Instagram's side, or delete the account.
- **Stored Instagram session (opt-in only):** until you switch the option off, revoke the device, or delete the account. Also dropped when Instagram invalidates it.
- **Automation events and contacts:** while the account is active. They are deleted when you delete the account, when you disconnect through Meta's deletion callback, or on request.
- **Backups:** 14 nightly snapshots, pruned automatically. A deletion applies to the live database at once and ages out of the backups within that window.
- **Session cookie:** 30 days.
- **Invoices:** kept by Paddle for as long as tax law requires. We keep the ids needed to reconcile them.

## 9. How to delete it

Every route — one post, the Instagram connection, a paired device, the whole account, and Meta's own signed-request callbacks — is written out step by step on **[Data deletion](/data-deletion)**, including exactly what each one removes. The short version: **Billing → Delete account** erases everything we hold about you and your library; **hello@resurfly.com** does it for you if you would rather ask.

## 10. What survives account deletion

A numbered account row marked deleted, with the plan status, Paddle's customer/subscription/transaction ids and the credit ledger — numbers and reasons, no content, no e-mail address (the user record with your e-mail and password hash is deleted, which frees the address for a future signup). This is the minimum needed to reconcile invoices and satisfy tax law.

## 11. Your rights

You can ask us to give you a copy of your data, correct it, delete it, restrict or object to processing, or hand it to another service. Export is built in and works on every plan (JSON, CSV, Markdown, Obsidian); the rest you can do yourself in the app or by writing to hello@resurfly.com. We answer within 30 days and usually the same week. We do not charge for this and we do not require a particular form of words.

Where the GDPR applies, our legal bases are: **performance of the contract** for running the account and the service you paid for; **legitimate interests** for keeping the service secure, preventing abuse and reconciling payments; **consent** for the optional background-sync session hand-off, which you can withdraw with one switch; and **legal obligation** for invoice records. For the personal data of people who message the Instagram account you connect, **you** are the controller and we are your processor — see [DPA](/dpa). If you are in the EEA or the UK you can complain to your data protection authority; we would rather you told us first.

## 12. Children

Resurfly is not for children. You must be at least 16 to have an account.

## 13. Changes to this policy

The date at the top changes whenever this page does. If we change **what we collect or who we send it to**, we will say so in the product before the change takes effect — not afterwards — and update [Subprocessors](/subprocessors) at the same time.

## 14. Contact

**hello@resurfly.com** for any privacy, access or deletion request, and for a signed data processing agreement.

---

*The template a self-hoster publishes as their own privacy notice has moved to [`docs/legal/SELF-HOSTED-PRIVACY.md`](https://github.com/tairqaldy/resurfly/blob/main/docs/legal/SELF-HOSTED-PRIVACY.md) in the repository. It described a single-user instance "not offered as a service to other people", which is the opposite of what this page and our Meta app-review submission say, and it used to sit at the bottom of this one.*
