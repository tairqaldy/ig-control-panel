# FAQ

### Self-host or resurfly.com — which one?

Same code. **Self-host** if you want to own the box and the bill: fork, Railway (~$5/mo), your OpenAI key (~$7.5 per 1,000 saves once), done in ~10 minutes. **[resurfly.com](https://resurfly.com)** if you want the result today: sign up, run the harvester, we run the servers and pay OpenAI — 3-day trial (newest 100 saves analyzed), then Pro $12/mo or Studio $34/mo. Exports work everywhere, so you can move between the two whenever you like. Details and margins: [BUSINESS.md](BUSINESS.md).

### What does it cost?

Resurfly itself is free (MIT). Running it:

- **Hosting**: Railway Hobby (~$5/mo incl. usage credit) or any Docker host. RAM use is ~200–400 MB. Storage: ~30 KB per thumbnail + ~4 frames × ~40 KB per reel ≈ 200 KB/save → 1 GB per ~5,000 saves.
- **OpenAI** (measured on a real 3,900-save library, Standard plan = `gpt-5.4-mini` + 4 low-detail frames + `gpt-4o-mini-transcribe`):
  - **≈ $0.0077 per reel** (analysis $0.0057 + transcription of a 40 s reel $0.002), ≈ $0.005 per image/carousel → **~$7.5 per 1,000 saves**
  - **Economy** plan (`gpt-5.4-nano`, 2 frames, transcripts for short reels): **≈ $0.0034 per reel** → ~$3 per 1,000; skip transcription → ~$1.3 per 1,000
  - the Import page shows *Spent so far* (from real token counts) and *To finish current scope*; you can cap spend, limit to the last N years, drop old/irrelevant saves with **Exclude**, and switch tiers at any time
- Ask: one small call per question (~$0.005). Full table and the hosted-version math: [BUSINESS.md](BUSINESS.md).

### How long does the analysis take?

~6–12 s per save with concurrency 3 → 4,500 saves ≈ 3–4 hours in the background. Raise `ANALYSIS_CONCURRENCY` (up to 8) if your OpenAI tier allows; the worker backs off automatically on 429s.

### Is this against Instagram's rules?

You are exporting your own data from your own logged-in browser at a human pace, read-only. That's how every "export my saves" tool works. Instagram's terms discourage automation in general; use it on your own account, don't hammer it, and don't share your session. The server side never logs into Instagram at all.

### The media says "expired"

The CDN links inside the harvest file are signed and short-lived (images ~4 days, videos ~1–2 days). Upload right after harvesting. To fix expired ones later, re-run the harvester and upload again — links get refreshed and only the media stage re-runs; notes, favorites and analyses stay.

### Some saves are "skipped"

Skipped = there was nothing to analyze (no caption, no transcript, no fetchable media — usually a deleted post, a private post from a friend, or expired links). Retry from Import → *Retry failed* after re-harvesting.

### Where's my data?

`$DATA_DIR` (Railway volume at `/data`): `resurface.db` (SQLite; everything structured) and `media/` (thumbnails/frames). Back that folder up and you've backed up everything. Export JSON/CSV/Obsidian anytime from the Library.

### Multiple Instagram accounts?

Run one Resurfly instance per account (the self-hosted build is single-user by design; on resurfly.com, one account = one library). Or import both harvests into one library — saves simply merge (creators/tags mix fine); the dashboard shows the username from the most recent harvest.

### Can I use another LLM?

`OPENAI_BASE_URL` points the SDK at any OpenAI-compatible gateway. The analysis needs vision + strict JSON schema support; transcription needs an `/audio/transcriptions` endpoint.

### Does the DM automation need App Review?

No — for your own account Standard Access is enough (you're the app admin + Instagram tester). You *do* have to switch the app to **Live** so real users' comments/DMs are delivered. See [AUTOMATIONS.md](AUTOMATIONS.md).

### I lost my passcode

Change `APP_PASSCODE` in the environment and redeploy. Sessions are signed with `SESSION_SECRET`; rotate it to log out everyone.

### The knowledge graph is empty / sparse

It's built from analyzed saves only, and tags need ≥ *Min tag uses* (default 3) to appear as nodes. Lower the slider, or wait for more analyses. Similarity links use embeddings with cosine ≥ 0.62.
