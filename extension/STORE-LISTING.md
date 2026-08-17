# Chrome Web Store listing — Resurfly Companion

Everything the Web Store developer dashboard asks for, ready to paste. Upload **`extension/dist/resurfly-companion-<version>-store.zip`**, built with `node extension/build-zip.mjs --store`.

> The plain `resurfly-companion-<version>.zip` is the self-hoster / load-unpacked build. It keeps
> `optional_host_permissions` (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) so people running their own
> Resurfly can point the extension at it. Do **not** upload that one: a wildcard host pattern reads to a reviewer as
> "this extension wants every site" and buys a long manual review. The store build drops the key and hides the
> App-URL field in Options, so nothing in the UI promises something the package cannot do.
> Step-by-step publishing walkthrough: [`docs/CHROME-STORE-GUIDE.md`](../docs/CHROME-STORE-GUIDE.md).

## Store listing

**Name:** Resurfly Companion

**Summary (132 chars max):** Keeps your Resurfly library in sync with the posts you save on Instagram. Runs in your own browser, every few hours.

**Description:**

Resurfly turns the posts you save on Instagram into notes you can search: each save gets a transcript, a summary, key points and tags, and you can ask questions across all of them at resurfly.com.

The Companion is the small piece that keeps that library up to date. Instagram has no API for saved posts, so the Companion reads your saved feed from your own logged-in browser tab — the same thing you'd see by opening instagram.com/yourname/saved — and sends the new posts to your Resurfly account.

What it does
• Pairs with your Resurfly account with a one-time code (no Instagram password, no Resurfly password stored in the extension).
• Syncs new saves every 6 hours and whenever you press "Sync now". The first sync walks your whole saved list once; later syncs only look at the top and stop after a few pages of already-known posts.
• Right-click any page on instagram.com and choose "Sync my saves to Resurfly" to run a sync on the spot.
• Shows the last sync time, how many new saves it found and how many arrived since yesterday. A jade badge means new saves; an amber "!" means Instagram signed you out and it's waiting for you to log in again.
• Optional: hand Resurfly your Instagram session (encrypted at rest) so saves keep syncing while your browser is closed. Off by default; one toggle to turn off; the session is deleted immediately.

What it sends
• To Resurfly: the saved posts (link, caption, creator name, counts, thumbnail/video URLs, timestamps) and nothing else. Resurfly stores only a hash of the device token.
• To Instagram: nothing beyond the requests your browser already makes to show you your saved posts.

What it does not do
• No tracking, no analytics, no ads, no third-party scripts.
• It never posts, likes, follows, messages or changes anything on Instagram.
• It does not read your Instagram password.

Resurfly is open source (MIT). If you run your own instance, build the extension from source — the Web Store version connects to resurfly.com only.

**Category:** Productivity
**Language:** English

## Privacy practices tab

**Single purpose (one sentence, paste as is):**

> Sync the user's own Instagram saved posts into their Resurfly library.

**Permission justifications** — one per permission the store build declares:

| Field in the dashboard | Justification to paste |
| --- | --- |
| `alarms` | Schedules the 6-hour background sync, the 1-minute continuation of a long first sync, and the timer that clears the "new saves" badge after 24 hours. Without it the extension can only sync while the popup is open. |
| `contextMenus` | Adds a single item, "Sync my saves to Resurfly", to the right-click menu on instagram.com so the user can sync the page they are already looking at. It appears on no other site and does nothing else. |
| `storage` | Stores the pairing device token, the Resurfly URL, the resumable position in the saved feed, and the last-sync counters locally in the browser. Nothing is stored anywhere else on the device. |
| Host permission `https://www.instagram.com/*` | Reads the signed-in user's own saved-posts feed (`/api/v1/feed/saved/posts/`) with the session already in their browser. This is the extension's single purpose; there is no Instagram API for saved posts. |
| Host permission `https://resurfly.com/*` | Sends those saved posts to the user's own Resurfly account and asks which posts it already has, authenticated with the device token created during pairing. |
| Optional permission `cookies` | Requested only when the user switches on "Also harvest when my browser is closed". Used once, at that moment, to read three instagram.com cookies (`sessionid`, `csrftoken`, `ds_user_id`) that the user chose to hand to their own Resurfly account so syncing continues while the browser is shut. The permission is given back when the switch is turned off. The extension works fully without it. |

**Remote code:** No, the extension does not use remote code. All logic ships inside the package; there are no external scripts, no `eval`, no remotely hosted modules, no bundler.

**Data collected** — tick these two categories and no others:

- **Website content** — the user's own saved Instagram posts (link, caption, creator name, like/comment counts, thumbnail and video URLs, timestamps), sent to the user's own Resurfly account.
- **Authentication information** — only if the user switches on the optional "Also harvest when my browser is closed": three instagram.com cookies, sent once to the user's own Resurfly account, stored encrypted (AES-256-GCM) and deleted when the switch is turned off.

Do not tick: personally identifiable information, health information, financial and payment information, personal communications, location, web history, user activity.

**The three certifications** — all three can be ticked truthfully:

1. Data is not sold or transferred to third parties, outside of the approved use cases. (The only recipient is the user's own Resurfly account.)
2. Data is not used or transferred for purposes unrelated to the item's single purpose.
3. Data is not used or transferred to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://resurfly.com/privacy/extension
**Homepage URL:** https://resurfly.com
**Support URL / e-mail:** hello@resurfly.com

Everything is transmitted over HTTPS and stored encrypted at rest, as the User Data policy requires.

## Distribution

- Visibility: **Public**
- Regions: all
- Pricing: free
- No in-app purchases in the extension itself (Resurfly's own plans are billed on resurfly.com).

## Test instructions for the reviewer (paste into "Instructions" on the Privacy tab)

> The extension needs a Resurfly account to do anything. A reviewer test account is at
> https://resurfly.com — e-mail and passcode are in the "Test credentials" note below. Sign in, open
> Import → Companion → Get pairing code, paste the code into the extension popup, press Connect.
> The extension then reads the signed-in Instagram account's saved posts from instagram.com in the same
> browser and sends them to that Resurfly account. If no Instagram account is signed in, the popup shows
> "Instagram login needed" — that is the expected state and no request is made.

(Create the reviewer account before submitting and put its credentials in the test-credentials field, not in the public listing.)

## Graphic assets

- Icon 128×128: `extension/icons/icon128.png`
- Store icon 1024×1024: `extension/store/icon-1024.png`
- Screenshots 1280×800: `extension/store/store-1-popup-paired.png`, `store-2-popup-unpaired.png`, `store-3-popup-login-needed.png`, `store-4-options.png`
- Raw popup/options captures (720×1200 @2x) live next to them as `popup-*.png` / `options.png`

## Version bumps

1. Edit `version` in `extension/manifest.json`.
2. `node extension/validate.mjs`
3. `node extension/build-zip.mjs --store`
4. Upload `extension/dist/resurfly-companion-<version>-store.zip` in the dashboard, re-check the Privacy tab, submit.

Keep `harvester/core.js` and `extension/lib/core.js` identical (`node harvester/build.mjs`); `validate.mjs` fails otherwise.
