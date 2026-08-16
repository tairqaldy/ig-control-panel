# Privacy policy (for a self-hosted Resurfly instance)

*Use this page as the "Privacy Policy URL" when you switch your Meta app to Live. Adjust the operator name/contact if you publish it elsewhere.*

**Who operates this app.** A single individual runs this Resurfly instance for their **own** Instagram professional account. It is not offered as a service to other people.

**What data is processed.**
- *Saved posts:* metadata of posts the operator saved on Instagram (captions, creator usernames, public counts, thumbnails, video frames and machine transcripts), stored on the operator's own server for personal knowledge management.
- *Messaging automations (optional):* when someone sends a DM, story reply or comment to the operator's Instagram account, Meta delivers that event to this server via webhook. The server stores the sender's Instagram-scoped ID, username (if provided), the message/comment text and timestamps, and may send an automated reply through Meta's API according to rules the operator configured.

**Why.** To organize the operator's own saved content and to answer incoming messages/comments automatically (e.g., sending a requested link).

**Third parties.** Text and images may be sent to OpenAI's API for transcription, analysis and embeddings, under OpenAI's API data-usage terms. No data is sold or shared with advertisers.

**Retention & deletion.** Data lives in the operator's private database and can be deleted at any time by the operator (per-item delete, or wiping the data directory). Anyone who messaged the account can request deletion of their messages by contacting the account owner on Instagram.

**Data deletion callback.** This app does not use Facebook Login for other users; the operator is the only user. Deletion requests: message the account owner on Instagram.

**Contact.** The Instagram account that runs this instance.

---

# Privacy notes for the hosted service (resurfly.com)

The hosted version runs the same open-source code, operated by Resurfly (contact: the e-mail on the pricing page). What is different when you use resurfly.com instead of your own server:

**Account.** We store your e-mail address, a salted password hash, your plan and billing status, and usage counters (how many saves were analyzed, questions asked, messages sent) so the plan limits can be enforced.

**Your saved posts.** The harvester runs in *your* browser with *your* Instagram session; we never see or store your Instagram password or session cookies. What reaches us is the harvest JSON (post metadata, captions, creator usernames, thumbnail/video URLs). We download thumbnails/frames and, for reels, the audio, so we can transcribe and analyze them. Analyses, transcripts, embeddings and thumbnails are stored per account and are never shown to other accounts.

**Processors.** OpenAI (analysis, transcription, embeddings — under OpenAI's API terms, no training on your data), Railway (hosting, EU/US regions), Cloudflare (DNS, and R2 object storage when enabled), Paddle (payments — Paddle is the merchant of record and stores card details; we never see them).

**Retention.** Everything is kept while your account is active. When a subscription ends (or the trial ends and you don't upgrade) your data stays readable and exportable for **30 days**, then analyses, media, transcripts and vectors are deleted; the account row keeps only your e-mail and invoice history. You can delete everything immediately from Billing → Delete account, or by e-mailing us.

**Export.** JSON, CSV, Markdown and Obsidian exports work on every plan, including after the trial ends.

**Automations.** If you connect your own Meta app, incoming DMs/comments/story replies are processed exactly as described above for a self-hosted instance, scoped to your account.

**No tracking.** No third-party analytics or ad pixels on the app; the marketing page may use privacy-preserving, cookie-less analytics.
