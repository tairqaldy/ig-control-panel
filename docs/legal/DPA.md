# Data processing — controller, processor, and how to get a DPA

*Last updated: 17 August 2026. A short, honest note about roles under the GDPR and equivalent laws, and how to get a signed data processing agreement. It is not a claim of certification: we hold none, and we do not pretend to.*

## Who is controller and who is processor

Resurfly plays two different roles depending on whose personal data is involved.

**We are the controller** for the data about *you*, our customer: your e-mail address, your password hash, your plan and billing status, your usage counters, and the operational logs needed to run the service. We decide why and how that data is processed, and [Privacy](/privacy) is the notice for it.

**We are the processor** for the personal data *you* bring into the service or generate through it:

- the posts you saved on Instagram, including the creator names and captions in them;
- the people who message, comment on or reply to the Instagram account you connect — their Instagram-scoped id, username, message text and the replies your rules send;
- the profile and insights data we read from your connected Instagram account.

For that data you are the controller: you decide what to import, which rules run and what they say. We process it on your instructions, to give you the service and nothing else, and we do not use it for our own purposes, sell it, share it with advertisers or data brokers, or train models on it.

## What that means in practice

- **Instructions.** We process the data you bring in only to run the features you use. Any other processing would need your instruction.
- **Subprocessors.** Four, each named with its purpose and region on [Subprocessors](/subprocessors). We update that page before a change takes effect.
- **Confidentiality.** The service is operated by one person. Access to the production database is limited to that person and used for support and incident work, not for browsing customer libraries.
- **Security.** The concrete measures — password hashing, AES-256-GCM encryption of Instagram tokens and sessions, hashed device tokens, per-account isolation, signature-verified webhooks, nightly backups to a private bucket — are listed on [Security](/security). We have no SOC 2 report, no ISO 27001 certificate and no external audit. Anyone telling you otherwise is wrong.
- **Assistance.** If someone whose data you process asks you for access or deletion, we will help you answer within the legal deadline. The deletion mechanics are on [Data deletion](/data-deletion).
- **Breach notification.** If we become aware of a personal data breach affecting your data we will tell you without undue delay, with what we know and what we are doing.
- **Deletion and return.** You can export everything at any time (JSON, CSV, Markdown, Obsidian) and delete everything from Billing → Delete account. On termination we delete the data as described in [Privacy](/privacy).
- **International transfers.** Hosting is in the **EU** (Railway EU West). The nightly backup goes to Cloudflare R2, whose bucket location Cloudflare assigns automatically — see [Subprocessors](/subprocessors). **OpenAI** and **Paddle** process data outside the EEA, including in the United States; where EEA or UK law applies we rely on those providers' standard contractual clauses. Regions per subprocessor are listed in [Subprocessors](/subprocessors).

## Getting a signed DPA

Write to **hello@resurfly.com** with "DPA" in the subject and the legal name of the entity signing. We will send a data processing agreement — including the standard contractual clauses where they are needed — for signature, normally within a few working days. There is no charge and it is not limited to a particular plan.

If your organisation has its own DPA template, send it; we will review it and either sign it or come back with the specific clauses we cannot honestly meet, rather than signing something we cannot keep.
