# Privacy notice template — a self-hosted Resurfly instance

*Last updated: 17 August 2026.*

**This is not the privacy policy for resurfly.com** — that one is [`docs/PRIVACY.md`](../PRIVACY.md), published at <https://resurfly.com/privacy>, and it describes a multi-user service.

This file is a template for somebody running their own copy of the open-source code for their own Instagram account. Meta asks for a Privacy Policy URL when you switch your own Meta app to Live; publish this, with the operator name and contact filled in, and point Meta at it. It deliberately says the instance is not offered to other people, which is true of a single-user deployment and false of resurfly.com — which is why it is a separate file. A reviewer skimming the hosted policy for "is this a service other people use?" used to reach this text at the bottom of it and get the wrong answer.

---

**Who operates this app.** A single individual runs this Resurfly instance for their **own** Instagram professional account. It is not offered as a service to other people.

**What data is processed.**
- *Saved posts:* metadata of posts the operator saved on Instagram (captions, creator usernames, public counts, thumbnails, video frames and machine transcripts), stored on the operator's own server for personal knowledge management.
- *Messaging automations (optional):* when someone sends a DM, story reply or comment to the operator's Instagram account, Meta delivers that event to this server via webhook. The server stores the sender's Instagram-scoped ID, username (if provided), the message/comment text and timestamps, and may send an automated reply through Meta's API according to rules the operator configured.

**Why.** To organize the operator's own saved content and to answer incoming messages/comments automatically (e.g., sending a requested link).

**Third parties.** Text and images may be sent to OpenAI's API for transcription, analysis and embeddings, under OpenAI's API data-usage terms. No data is sold or shared with advertisers.

**Retention & deletion.** Data lives in the operator's private database and can be deleted at any time by the operator (per-item delete, or wiping the data directory). Anyone who messaged the account can request deletion of their messages by contacting the account owner on Instagram.

**Data deletion callback.** The operator is the only user of this app. Removing the app under Instagram → Apps and websites triggers `/api/instagram/deauthorize` (token deleted) and `/api/instagram/delete` (automation contacts, events and cached analytics deleted). Anyone who messaged the account: message the account owner on Instagram.

**Contact.** The Instagram account that runs this instance.
