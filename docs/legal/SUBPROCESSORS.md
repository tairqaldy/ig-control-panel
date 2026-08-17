# Subprocessors — resurfly.com

*Last updated: 17 August 2026. This page lists every company that can touch your data when you use the hosted service at resurfly.com, what they do with it, and where they are. If you run your own copy of the open-source code, only OpenAI applies — and only if you configure a key.*

We keep this list short on purpose. There are four, and each one is here because the product cannot work without it.

## 1. OpenAI — machine analysis

- **What it does for us:** transcribes reels, reads captions, transcripts and extracted video frames to produce the summary/tags/key points on each save, creates the embeddings used for meaning-based search, answers questions on the Ask page, and generates the Profile score report.
- **What it receives:** captions, machine transcripts, up to a few still frames per video, your notes, your questions, and excerpts of your own library sent as context. When an Instagram account is connected, a question about your own performance also sends that account's public profile fields (handle, name, follower / following / post counts) and the insight figures the answer is drawn from — daily reach and views, your recent posts' captions with their reach, likes, comments and saves, and hashtag performance. On the Profile score page it additionally receives the bio, the link, the account category and the questionnaire answers you give us. It does **not** receive your e-mail address, your password, your payment details, your Instagram token, or anything from anyone else's account.
- **Region:** United States.
- **Terms:** the OpenAI API terms. API data is **not used to train** OpenAI's models. OpenAI may retain API inputs and outputs for **up to 30 days** for abuse monitoring, then deletes them.
- **If it is unavailable:** analysis and Ask pause and the app says so. Nothing else stops working.

## 2. Railway — hosting

- **What it does for us:** runs the application server and holds the persistent disk that stores the SQLite database and the media we cache (thumbnails and video frames).
- **What it receives:** everything the service stores, because the service runs on it.
- **Region: EU West.** The resurfly.com service and its persistent disk run in Railway's **EU West** region, verified against the running service on 17 August 2026. If we ever move the service to another region we will say so here before the move, and e-mail anyone who has signed a DPA with us. Write to hello@resurfly.com if you need this confirmed in writing.
- **At rest:** Railway states that its volumes are encrypted at rest — that control is theirs, not ours. Ours: Instagram tokens and any stored Instagram session are encrypted by us (AES-256-GCM) before they are written, and passwords and device tokens are stored as hashes rather than values — see [Security](/security).

## 3. Cloudflare — DNS and backup storage

- **What it does for us:** DNS for resurfly.com, and R2 object storage for the nightly database backup.
- **What it receives:** DNS queries for the domain, and one gzipped snapshot of the database per night. Media files are not backed up.
- **Region:** the R2 bucket is created with Cloudflare's automatic location hint; Cloudflare places it.
- **Retention:** 14 nightly snapshots are kept, older ones are deleted automatically.

## 4. Paddle — payments

- **What it does for us:** Paddle.com Market Ltd is the **merchant of record**. It runs the checkout, stores your card, calculates and remits VAT/sales tax, issues the invoice, and manages the subscription and the customer portal.
- **What it receives:** your e-mail address, the name and billing address you type into the checkout, your card details, and the purchase itself. Your card details never reach us.
- **Region:** United Kingdom, with processing in the EU and the US.
- **What we keep from it:** your plan and billing status, Paddle's customer, subscription and transaction ids, and the credit ledger. Not the card.

## Not on this list

- **Meta / Instagram** is not our subprocessor. It is the *source* of the data you bring in and the *destination* of the automated replies you configure. What we read and send is described in [Privacy](/privacy).
- **Analytics and advertising:** none. There is no third-party analytics script, no ad pixel, no session recorder and no tag manager anywhere on resurfly.com — not in the app and not on the marketing pages.
- **E-mail:** we do not use a bulk mail provider. Support runs from a normal mailbox at hello@resurfly.com.
- **Error tracking:** none. Errors are printed to the server log and read by the operator.

## Changes to this list

If we add a subprocessor we update this page before the change takes effect, and we say so in the product. If you have a data processing agreement with us, the notice period in that agreement applies — see [DPA](/dpa).

Questions: hello@resurfly.com
