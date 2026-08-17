# Security at Resurfly

*Last updated: 17 August 2026. Plain language, no diagrams. If something here matters to your decision and is not clear enough, write to hello@resurfly.com and we will explain it properly.*

Resurfly holds two things worth protecting: your library of saved posts, and the credentials that reach your Instagram account. This page says what we do about both.

What we do **not** have: a SOC 2 report, an ISO 27001 certificate, a penetration test or an external audit. We are not going to imply otherwise. Everything below is a control you can check for yourself in the open-source code.

## Passwords

Your password is never stored. We keep a **scrypt** hash of it with a random per-account salt (N = 16384, 64-byte output). Verification is a constant-time comparison. If our database were copied, the hashes would still have to be attacked one account at a time, and scrypt makes that slow and memory-expensive on purpose.

We never e-mail you your password, and support cannot read it.

## Tokens and sessions, encrypted at rest

Anything that would let someone act as you is encrypted before it is written to the database, with **AES-256-GCM** and a key derived from the server secret, which is never in the code or the repository. On resurfly.com that secret is a deployment environment variable, so it is not stored beside the data it protects — and the server **refuses to start** in hosted mode without it, so this cannot silently degrade. (Running your own copy with no configuration at all still works: a secret is generated once and written to the data directory, which is convenient but puts the key on the same disk as the data it protects. If you self-host anything you care about, set `SESSION_SECRET` in your environment.) What is encrypted:

- The Instagram access token from "Connect Instagram".
- The Instagram session cookies, if you turned on the optional "Also harvest when my browser is closed" hand-off in the Companion.

None of these are ever written to logs or error reports. Deleting the connection, turning the setting off, revoking the device, or deleting the account removes them straight away.

## Device tokens are stored hashed

When you pair the Companion extension, the browser receives a device token. We store only its **SHA-256 hash**. The database therefore never holds a value that could be replayed against your library. The same is true of the short pairing codes, which are hashed and expire quickly.

Every device is listed in Settings → Companion with its last sync, and you can revoke any of them in one click.

## Isolation between accounts

Every row of your data carries your tenant id, and every query is scoped to the account making the request. Saves, analyses, transcripts, embeddings, thumbnails and automation logs are readable only by the account they belong to. Search results, recommendations and Ask answers never reach across accounts.

## Transport and webhooks

The site and the API are served over HTTPS. The app's session cookie is `HttpOnly`, `SameSite=Lax` and `Secure` on HTTPS. Incoming webhooks are verified before they are processed: Instagram events against Meta's `x-hub-signature-256`, Paddle events against Paddle's signature header. An unsigned or mismatched request is rejected.

## Payments

We never see your card. Paddle is the merchant of record and handles the checkout, card storage and tax. Resurfly stores your plan, billing status, and Paddle's transaction and subscription ids so invoices and credit purchases can be reconciled. Paddle webhooks are signature-verified.

## Logs

There is no request log in production: we do not record a line per page view, and no table holds an IP address. IP addresses are counted in memory to rate-limit signups (a one-minute window), failed logins and Companion pairing attempts (ten-minute windows), and are then gone. Our host and Cloudflare see IP addresses because they have to route the request to us.

Errors are printed to the server log and read by the operator; Instagram tokens, stored sessions and password hashes are never written to them. We use no third-party error-tracking or analytics service, so nothing about your use of the app is sent anywhere to be measured.

## Backups

The database is backed up **nightly**, compressed, and written to private object storage (Cloudflare R2) that is not publicly readable. Backups are kept on a rolling window (14 days by default) and older ones are pruned automatically. Media files are re-fetchable from source, so they are not part of the nightly archive.

Backups exist to recover from our mistakes, not to keep your data after you leave: once a deletion has run, the deleted data ages out of the backup window and is gone.

## Third parties we send data to

- **OpenAI** — captions, transcripts, frames and text for analysis, transcription and embeddings, under OpenAI's API terms. No training on your data.
- **Railway** — hosting: the application server and the volume holding the database and the cached thumbnails and frames.
- **Cloudflare** — DNS for the domain, and R2 object storage for the nightly database backup. Media is not stored there.
- **Paddle** — payments, as merchant of record.

That is the complete list, with purposes and regions on [Subprocessors](/subprocessors). We do not sell your data, do not share it with data brokers or advertisers, do not train models on it, and run no third-party analytics, error tracking or ad pixels anywhere on resurfly.com.

## Deleting everything

- **One item:** open it in the Library and delete it.
- **The Instagram connection:** Settings → Instagram → Disconnect. That deletes the stored token; removing Resurfly under Instagram → Apps and websites does the same and additionally clears automation contacts, events and cached analytics.
- **The Companion:** Settings → Companion → revoke the device, which invalidates the token hash and wipes any stored session.
- **The whole account:** Billing → Delete account. In one step this disconnects Instagram, then removes your saves, analyses, transcripts, embeddings, media, Ask conversations, automation rules/events/contacts, paired devices, Profile score answers and reports, settings, usage counters and your user record. What remains is the invoice trail Paddle and tax law require us to keep: a numbered account row and the credit ledger, with no content and no e-mail address.
- **By e-mail:** hello@resurfly.com. We will do it and confirm, normally within a few days and always within 30.

Every route, and exactly what each one removes, is written out on [Data deletion](/data-deletion). Export first if you want to keep anything: JSON, CSV, Markdown and Obsidian exports work on every plan, including after a trial ends.

## Reporting a problem

If you find a vulnerability, e-mail hello@resurfly.com with enough detail to reproduce it. We will confirm receipt within 72 hours, keep you updated, and credit you when the fix ships if you would like that. Please do not run automated scans against production or access data belonging to other accounts while testing.

Resurfly is a small operation, not a company with a security team on rotation. We have said exactly what is in place above so you can judge it for yourself.
