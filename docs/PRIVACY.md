# Privacy policy — resurfly.com

*Last updated: 17 August 2026. This is the privacy policy for the hosted service at resurfly.com. If you run your own copy of the open-source code, the operator notice at the bottom of this page applies instead.*

The hosted version runs the same open-source code, operated by Resurfly (contact: hello@resurfly.com). Here is what we store, why, who else sees it, and how long we keep it.

Two companion pages go into more detail: the [Companion extension privacy policy](/privacy/extension) covers exactly what the Chrome extension reads and sends, and [Security](/security) covers encryption, password hashing, backups and how to delete everything.

**Account.** We store your e-mail address, a salted password hash, your plan and billing status, and usage counters (how many saves were analyzed, questions asked, messages sent) so the plan limits can be enforced.

**Your saved posts.** The Companion extension and the harvester script run in *your* browser with *your* Instagram session; we never see your Instagram password. What reaches us is the harvest JSON (post metadata, captions, creator usernames, thumbnail/video URLs). We download thumbnails/frames and, for reels, the audio, so we can transcribe and analyze them. Analyses, transcripts, embeddings and thumbnails are stored per account and are never shown to other accounts.

**Background sync (opt-in).** Only if you switch on "Also harvest when my browser is closed" in the Companion, it sends us your Instagram session cookies (`sessionid`, `csrftoken`, `ds_user_id`) and browser user-agent once. We store them encrypted (AES-256-GCM), use them solely to read your saved-posts feed about every 12 hours, never log them, and delete them the moment you switch the option off, revoke the device, or delete your account. If Instagram invalidates the session we stop and ask you to reconnect.

**Instagram connection.** When you press "Connect Instagram" we receive an access token for your professional account through Meta's Instagram Login, stored encrypted and refreshed automatically. We use it to receive DM/comment/story-reply webhooks for your automations, to send the replies you configured, and to read your account and post insights for the Analytics page. Disconnecting in Resurfly, or removing Resurfly under Instagram → Apps and websites, deletes the token; a data-deletion request from Instagram additionally deletes stored automation contacts, events and cached analytics.

**Processors.** OpenAI (analysis, transcription, embeddings — under OpenAI's API terms, no training on your data), Railway (hosting, EU/US regions), Cloudflare (DNS, and R2 object storage when enabled), Paddle (payments — Paddle is the merchant of record and stores card details; we never see them).

**Retention.** Everything is kept while your account is active. When a subscription ends (or the trial ends and you don't upgrade) your data stays readable and exportable for **30 days**, then analyses, media, transcripts and vectors are deleted; the account row keeps only your e-mail and invoice history. You can delete everything immediately from Billing → Delete account, or by e-mailing us.

**Export.** JSON, CSV, Markdown and Obsidian exports work on every plan, including after the trial ends.

**Automations.** Once your Instagram account is connected, incoming DMs/comments/story replies are processed exactly as described in the self-hosted notice below, scoped to your account: we store the sender's Instagram-scoped id, their username if Instagram provides it, the message or comment text and timestamps, and the reply we sent.

**Payments and credits.** Paddle handles checkout and stores the card; we never see it. We keep your plan, billing status, Paddle's subscription and transaction ids, and the credit ledger (each purchase and each debit, with the reason) so the balance can be audited and invoices reconciled.

**No tracking.** No third-party analytics or ad pixels on the app; the marketing page may use privacy-preserving, cookie-less analytics.

**Contact.** hello@resurfly.com for any privacy, access or deletion request. We answer within 30 days.

---

# Privacy notice for a self-hosted Resurfly instance

*This second notice does not apply to resurfly.com. It is the template a self-hoster uses as their own "Privacy Policy URL" when switching their Meta app to Live; adjust the operator name and contact before publishing it.*

**Who operates this app.** A single individual runs this Resurfly instance for their **own** Instagram professional account. It is not offered as a service to other people.

**What data is processed.**
- *Saved posts:* metadata of posts the operator saved on Instagram (captions, creator usernames, public counts, thumbnails, video frames and machine transcripts), stored on the operator's own server for personal knowledge management.
- *Messaging automations (optional):* when someone sends a DM, story reply or comment to the operator's Instagram account, Meta delivers that event to this server via webhook. The server stores the sender's Instagram-scoped ID, username (if provided), the message/comment text and timestamps, and may send an automated reply through Meta's API according to rules the operator configured.

**Why.** To organize the operator's own saved content and to answer incoming messages/comments automatically (e.g., sending a requested link).

**Third parties.** Text and images may be sent to OpenAI's API for transcription, analysis and embeddings, under OpenAI's API data-usage terms. No data is sold or shared with advertisers.

**Retention & deletion.** Data lives in the operator's private database and can be deleted at any time by the operator (per-item delete, or wiping the data directory). Anyone who messaged the account can request deletion of their messages by contacting the account owner on Instagram.

**Data deletion callback.** The operator is the only user of this app. Removing the app under Instagram → Apps and websites triggers `/api/instagram/deauthorize` (token deleted) and `/api/instagram/delete` (automation contacts, events and cached analytics deleted). Anyone who messaged the account: message the account owner on Instagram.

**Contact.** The Instagram account that runs this instance.
