# Resurfly Companion (Chrome extension)

The Companion keeps your Resurfly library in step with the posts you save on Instagram — no console script, no copy-pasting. Every 6 hours (and whenever you press **Sync now**) it reads your saved posts through your own logged-in browser and sends the new ones to Resurfly. Optionally, it can hand Resurfly your Instagram session so saves keep syncing while your browser is closed.

This is the recommended import path on resurfly.com and for self-hosters alike. The one-time console script ([HARVESTER.md](HARVESTER.md)) reads the same feed with the same code and stays the fallback if you would rather not install an extension.

Source: [`extension/`](../extension) — Manifest V3, plain JavaScript, no bundler, no analytics.

## Install

**Chrome Web Store** — listing pending review. Until then, download the latest zip from the [Releases page](https://github.com/tairqaldy/resurfly/releases/latest) and load it unpacked (below) — the Import page in Resurfly links there.

**Load unpacked** (open source / development):

1. Clone the repo (or download the `extension/` folder).
2. Open `chrome://extensions`, switch on **Developer mode** (top right).
3. **Load unpacked** → pick the `extension/` folder.
4. Pin “Resurfly Companion” from the puzzle-piece menu so the icon stays visible.

Works in Chrome, Edge, Brave, Vivaldi and other Chromium browsers (Chrome 116+).

## Pairing

1. In Resurfly open **Import → Companion → Get pairing code** (the Welcome flow shows the same button). You get a code like `RSF-7K2Q-9M4D`, valid for 5 minutes, single use.
2. Click the extension icon, paste the code, **Connect**. The extension receives a device token (`cmp_…`); Resurfly stores only its hash.
3. The first sync starts right away. It walks your whole saved feed once (about 1 request per 1–2 s, ~20 saves per request; 4,000 saves take roughly 5–6 minutes) and continues on its own if Chrome puts the extension to sleep in between — the position is saved after every 100 items. Later syncs only look at the top of the feed and stop after 3 pages of already-known saves.

Analysis starts as soon as items land (newest first, within your plan's allowance); the Import page and the sidebar show progress.

You can also right-click any page on instagram.com and pick **Sync my saves to Resurfly** — the same sync as the popup button, without opening the popup. If the browser is not paired yet, the item opens the Options page instead.

The popup shows the last sync time, how many new saves the last run found, a line with how many saves arrived **since yesterday** (everything the last 24 hours of syncs picked up) and the size of your library. The icon shows a jade badge with the number of new saves for 24 hours after a sync that found something; an amber `!` means Instagram signed you out and a sync is waiting for you to log in again.

You can pair several browsers; each is a separate device in **Settings → Companion** (or **Import → Companion**) with its last sync time, where you can also revoke it. Every run is recorded server-side (`harvest_runs`: source companion / server / script / zip / urls, items imported, new items; `GET /api/companion/runs`). Removing the pairing from the extension's Options page deletes the token locally and stops syncing.

## What is sent, and where

The published policy for this extension is at <https://resurfly.com/privacy/extension> — it covers the same ground as this section plus retention, deletion and contact, and it is the URL listed in the Chrome Web Store listing.

To **your Resurfly** (`https://resurfly.com` or your own URL), authenticated with the device token from pairing:

- `GET /api/companion/state` — asks which saves Resurfly already has (the newest 500 Instagram ids), your total and today's harvest allowance.
- `POST /api/companion/harvest` — the new saves, at most 100 per request, in the same shape the console harvester produces (`harvester/core.js` → `normalizeItem`): link, shortcode, caption, creator (username, name, avatar URL), like/comment/play counts, thumbnail and video URLs, carousel children, music/original audio, location name, usertags, coauthors, paid-partnership flag, taken-at time. No cookies, no tokens, nothing about your Instagram account except what is visible on those posts.

To **Instagram**: `GET https://www.instagram.com/api/v1/feed/saved/posts/?max_id=…` — the same request the instagram.com web app makes when you open your Saved tab, sent from the extension with your browser's own cookies. Headers: `x-ig-app-id`, `x-requested-with: XMLHttpRequest`, and `x-csrftoken` only if you have granted the optional cookies permission (see below). Nothing is written to Instagram — no likes, follows, comments, or messages.

Locally (chrome.storage.local): the app URL, the device token, sync bookkeeping (last sync time/result, resumable cursor, and a 7-day list of `{ when, how many }` for the "since yesterday" line). Nothing else.

## Opt-in: “Also harvest when my browser is closed”

Off by default. When you switch it on:

1. Chrome asks you to grant the extension the **cookies** permission (it is declared as optional and only requested at this moment).
2. The extension reads three cookies for `instagram.com` — `sessionid`, `csrftoken`, `ds_user_id` — and sends them once to `POST /api/companion/session` on your Resurfly, together with your browser's user-agent string.
3. Resurfly stores them encrypted (AES-256-GCM, key derived from the server secret) and uses them every 12 hours to fetch your saved feed server-side with the same request as above. Nothing else is done with the session.
4. If Instagram invalidates the session (HTTP 401/403/429 or a login page), Resurfly marks it invalid, stops, and both the app (a notice on Import/Settings) and the popup tell you to reconnect (switch off and on again while logged in).

Switching it off calls `DELETE /api/companion/session`, which wipes the stored session immediately, and the extension gives the cookies permission back. Revoking the device in Resurfly, or "turn off" next to the device in Settings → Companion, has the same effect. Self-hosters can disable server-side harvesting entirely with `SERVER_HARVEST_ENABLED=false` (the default when not hosted; the popup then shows the switch disabled). Server-side runs count against the same daily harvest allowance as browser syncs.

Why this is opt-in and separate: a session cookie is the equivalent of being logged in as you. The browser-side sync never needs it to leave your machine; only the “while my browser is closed” convenience does.

## Two builds

Same source, one difference in the manifest:

| | `resurfly-companion-<v>.zip` (dev / self-hoster) | `resurfly-companion-<v>-store.zip` (Chrome Web Store) |
| --- | --- | --- |
| Built with | `node extension/build-zip.mjs` | `node extension/build-zip.mjs --store` |
| `optional_host_permissions` | `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | removed |
| App-URL field in Options | shown | hidden |
| Talks to | any origin you grant | resurfly.com only |

The store build drops the wildcard because a reviewer reads `https://*/*` as "this extension wants every site", which is the single fastest way to earn a long manual review. `popup.js` and `options.js` decide at runtime by reading `chrome.runtime.getManifest().optional_host_permissions`, so the store build never shows a control it cannot honour. Publishing walkthrough: [CHROME-STORE-GUIDE.md](CHROME-STORE-GUIDE.md); field-by-field copy: [`extension/STORE-LISTING.md`](../extension/STORE-LISTING.md).

## Self-hosting

The extension ships with permission for `https://www.instagram.com/*` and `https://resurfly.com/*` only — no `<all_urls>`. Pointing it somewhere else needs the dev build (load unpacked, or the plain zip from Releases) — the Web Store version connects to resurfly.com only. Then:

1. Right-click the extension icon → **Options** (or click **change** in the popup).
2. Enter your app origin, e.g. `https://saves.example.com` (or `http://localhost:8080` for development) and press **Save**. Chrome shows a permission prompt for that origin (`optional_host_permissions` in the manifest cover `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`).
3. Pair as usual. The pairing response also carries the server's `appUrl` (`PUBLIC_URL`), which the extension adopts.

The URL cannot be changed while paired — remove the pairing first.

## Building

There is no bundler. Three scripts, all plain Node (run from the repo root):

- `node extension/build-icons.mjs` — renders `web/public/favicon.svg` to `extension/icons/icon{16,32,48,128}.png` with `sharp` (already a server dependency). The PNGs are committed; rerun only when the favicon changes.
- `node extension/validate.mjs` — parses the manifest, checks required keys and referenced files, checks that no permission appears without a justification in `STORE-LISTING.md` and that no wildcard host crept in, runs `node --check` on every JS file, verifies relative imports resolve and that `extension/lib/core.js` is byte-identical to `harvester/core.js`.
- `node extension/build-zip.mjs [--store]` — validates, then writes `extension/dist/resurfly-companion-<version>[-store].zip` with the runtime files only.

`extension/lib/core.js` is a copy of `harvester/core.js` (the shared normalization used by the server, the console script and the extension). Refresh it with `node harvester/build.mjs` (which copies it) or simply `cp harvester/core.js extension/lib/core.js`.

To publish: bump `version` in `manifest.json`, run `node extension/build-zip.mjs --store`, upload the `-store` zip. The full walkthrough — developer account, listing fields, Privacy-practices answers, rejection codes — is in [CHROME-STORE-GUIDE.md](CHROME-STORE-GUIDE.md).

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest: `alarms`, `contextMenus`, `storage`; optional `cookies`; hosts instagram.com + resurfly.com; optional hosts for self-hosters (stripped by `--store`) |
| `background.js` | Service worker: 6-hour alarm → sync, resumable first run, badge, instagram.com context menu, 24-hour new-saves tally, message hub for popup/options |
| `popup.html/.css/.js` | Pair, status (last sync, new, since yesterday, library size), Sync now, the server-side opt-in switch |
| `options.html/.js` | App URL (dev build only, with origin permission prompt), pairing/unpair, what-it-does text; opened once after install |
| `lib/core.js` | Copy of `harvester/core.js`: endpoint paths, headers, `normalizeItem` |
| `lib/api.js` | Device-token client for `/api/companion/*` with retries |
| `lib/sync.js` | The sync algorithm (pagination, stop rules, chunked upload, login detection) |
| `lib/store.js` | `chrome.storage.local` keys |
| `build-icons.mjs`, `validate.mjs`, `build-zip.mjs` | Build helpers |
| `STORE-LISTING.md` | Every Chrome Web Store field, ready to paste |

## Troubleshooting

- **“Instagram login needed”** — open instagram.com, log in, then Sync now. The extension uses your browser session; if you are logged out there, it cannot read anything.
- **“Daily sync limit reached”** — your plan's harvest allowance for today is used up (each sync run that sends something counts once). It continues tomorrow, or upgrade in Resurfly → Billing.
- **“This device was removed in Resurfly”** — the token was revoked from Settings → Companion. Pair again.
- **Pairing fails immediately for a self-hosted URL** — the origin permission was not granted; open Options and press Save on the App URL to trigger the prompt.
