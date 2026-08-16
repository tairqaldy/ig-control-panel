# Chrome Web Store listing — Resurfly Companion

Everything the Web Store developer dashboard asks for, ready to paste. Upload `extension/dist/resurfly-companion-<version>.zip` (build with `node extension/build-zip.mjs`).

## Store listing

**Name:** Resurfly Companion
**Summary (132 chars max):** Keeps your Resurfly library in sync with the posts you save on Instagram. Runs in your own browser, every few hours.

**Description:**

Resurfly turns the posts you save on Instagram into notes you can search: each save gets a transcript, a summary, key points and tags, and you can ask questions across all of them at resurfly.com.

The Companion is the small piece that keeps that library up to date. Instagram has no API for saved posts, so the Companion reads your saved feed from your own logged-in browser tab — the same thing you'd see by opening instagram.com/yourname/saved — and sends the new posts to your Resurfly account.

What it does
• Pairs with your Resurfly account with a one-time code (no Instagram password, no Resurfly password stored in the extension).
• Syncs new saves every 6 hours and whenever you press "Sync now". The first sync walks your whole saved list once; later syncs only look at the top and stop after a few pages of already-known posts.
• Shows the last sync time and how many new saves it found. A jade badge means new saves; an amber "!" means Instagram signed you out and it's waiting for you to log in again.
• Optional: hand Resurfly your Instagram session (encrypted at rest) so saves keep syncing while your browser is closed. Off by default; one toggle to turn off; the session is deleted immediately.

What it sends
• To Resurfly: the saved posts (link, caption, creator name, counts, thumbnail/video URLs, timestamps) and nothing else. Resurfly stores only a hash of the device token.
• To Instagram: nothing beyond the requests your browser already makes to show you your saved posts.

What it does not do
• No tracking, no analytics, no ads, no third-party scripts.
• It never posts, likes, follows, messages or changes anything on Instagram.
• It does not read your Instagram password.

Works with the hosted service at resurfly.com and with self-hosted Resurfly (open source, MIT) — set your own app URL in Options.

**Category:** Productivity
**Language:** English

## Permission justifications (Privacy practices tab)

- **alarms** — schedule the 6-hour sync and the retry/continue timers.
- **storage** — keep the pairing (device token), app URL, sync cursor and last-sync stats locally.
- **Host permission https://www.instagram.com/*** — read the user's own saved-posts feed (`/api/v1/feed/saved/posts/`) with the user's existing session; this is the extension's single purpose.
- **Host permission https://resurfly.com/*** — send the saved posts to the user's Resurfly account and read which posts it already has.
- **Optional host permissions (https://*/*, http://localhost/*)** — only requested when a self-hosted user enters their own Resurfly URL in Options; never requested otherwise.
- **Optional permission cookies** — only requested if the user turns on "Also harvest when my browser is closed"; used once to read the Instagram session cookies (sessionid, csrftoken, ds_user_id) that the user chose to hand to Resurfly. Removed when the toggle is turned off.
- **Remote code:** none. All code ships in the package.

**Single purpose:** Sync the user's own Instagram saved posts to their Resurfly library.

**Data usage disclosure:** The extension transmits *website content* (the user's saved Instagram posts) and, only with the optional toggle, *authentication information* (Instagram session cookies) to the user's Resurfly account. Data is not sold, not used for advertising, not used for creditworthiness or lending, and only used for the extension's single purpose.

**Privacy policy URL:** https://resurfly.com/privacy
**Homepage URL:** https://resurfly.com
**Support URL / e-mail:** hello@resurfly.com

## Graphic assets

- Icon 128×128: `extension/icons/icon128.png`
- Screenshots 1280×800 (at least one, up to five): generate with `node scripts/capture.mjs cards …` style captures or take them from a paired Companion popup on a light background — ready in `extension/store/` (popup-unpaired, popup-paired, popup-login-needed, options; 720×1200 @2x popup captures — the Web Store wants 1280×800 or 640×400, so place them on a paper background with the tool of your choice or use them as-is for the small tile).
- App icon 1024×1024 (also usable for Meta): `extension/store/icon-1024.png`.

## Publishing steps (once, by the account owner)

1. https://chrome.google.com/webstore/devconsole → pay the one-time $5 developer registration (needs the Google account of the person who will own the listing).
2. New item → upload the zip → fill Store listing / Privacy practices from this file → Distribution: Public.
3. Submit for review. First review usually takes 1–3 days; the optional `cookies` permission and the broad optional host permission may trigger a manual look — the justifications above are what they read.
4. When approved, put the listing URL into Railway as `VITE_COMPANION_URL` (web build-time env) or update `COMPANION_INSTALL_URL` in `web/src/components/import/useCompanion.ts`, and in `docs/COMPANION.md`.

## Version bumps

Edit `extension/manifest.json` version, run `node extension/validate.mjs && node extension/build-zip.mjs`, upload the new zip. Keep `harvester/core.js` and `extension/lib/core.js` in sync with `node harvester/build.mjs`.
