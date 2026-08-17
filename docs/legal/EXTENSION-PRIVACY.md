# Privacy policy — Resurfly Companion (Chrome extension)

*Last updated: 17 August 2026. This page covers the browser extension only. For the website and the hosted service, see [Privacy](/privacy) and [Security](/security).*

The Companion has one job: copy the posts you saved on Instagram into your own Resurfly library. It runs in your browser, using the Instagram session you are already logged in with. We never ask for and never receive your Instagram password.

## What the extension reads

- **Your saved-posts feed on instagram.com.** The extension calls `https://www.instagram.com/api/v1/feed/saved/posts/` — the same request instagram.com makes when you open your Saved tab — with your browser's own cookies attached by Chrome. It reads nothing else on Instagram: not your inbox, not your feed, not other people's profiles, not pages you browse.
- **Its own settings in `chrome.storage.local`:** the Resurfly URL it is paired with, the device token from pairing, and sync bookkeeping (last sync time, last result, a resumable cursor).

The extension never writes to Instagram. It does not like, follow, comment, message, or post.

## What leaves your browser, and where it goes

Everything below goes to your Resurfly instance (`https://resurfly.com`, or your own server if you self-host) and nowhere else. There are no third-party analytics, no ad pixels, and no other network destinations.

- `GET /api/companion/state` — asks which saves your library already has (the newest 500 Instagram ids) so the extension can skip them, plus your remaining daily harvest allowance.
- `POST /api/companion/harvest` — the new saves, at most 100 per request: link, shortcode, caption, creator username/name/avatar URL, like/comment/play counts, thumbnail and video URLs, carousel children, music or original-audio credit, location name, user tags, co-authors, paid-partnership flag, and the time the post was taken.

That is post metadata that is visible on the posts themselves. No cookies and no Instagram tokens are included in a normal sync, and nothing about your Instagram account beyond what those posts show.

Requests are authenticated with a device token created when you pair the extension. Resurfly stores only a SHA-256 hash of that token, so the stored value cannot be replayed against your account.

## The optional session hand-off

**Off by default.** The setting "Also harvest when my browser is closed" is the only case in which authentication information leaves your browser, and it exists so syncing can continue while Chrome is shut.

When you switch it on:

1. Chrome asks you to grant the extension the `cookies` permission. It is declared as optional and requested only at that moment.
2. The extension reads three `instagram.com` cookies — `sessionid`, `csrftoken`, `ds_user_id` — and sends them once, with your browser's user-agent string, to `POST /api/companion/session` on your Resurfly.
3. Resurfly stores them encrypted (AES-256-GCM, key derived from the server secret), never writes them to logs, and uses them for one purpose: fetching your saved-posts feed about every 12 hours with the same request described above.
4. If Instagram invalidates the session, Resurfly stops using it, marks it invalid, and asks you to reconnect.

Switching the setting off calls `DELETE /api/companion/session`, which deletes the stored session immediately, and the extension hands the `cookies` permission back to Chrome. Revoking the device in Settings → Companion, or deleting your account, has the same effect.

A session cookie is the equivalent of being logged in as you, which is why it is separate, opt-in, and reversible in one click. Browser-side syncing never needs it.

## Permissions, and why each one exists

- `alarms` — schedules the periodic sync while Chrome is open.
- `storage` — keeps the app URL, device token and sync bookkeeping in `chrome.storage.local`.
- `contextMenus` — adds the right-click item "Sync my saves to Resurfly" on instagram.com.
- `cookies` (optional) — requested only when you turn on "Also harvest when my browser is closed", to read the three cookies listed above.
- Host access to `https://www.instagram.com/*` — reads your saved-posts feed.
- Host access to `https://resurfly.com/*` — sends the saves to your library.

The build published to the Chrome Web Store requests no other hosts. The unpacked build for self-hosters can additionally be granted a host you type in yourself, so it can talk to your own server.

## Remote code

None. All the extension's code ships inside the package. It does not download or evaluate scripts at runtime.

## Retention and deletion

- Saves sent to your library stay while your account is active. After a subscription or trial ends, the library remains readable and exportable for 30 days and is then deleted. See [Privacy](/privacy).
- The stored session (if you enabled the hand-off) is deleted the moment you turn the setting off, revoke the device, or delete your account.
- The device token hash is deleted when you revoke the device in Settings → Companion, or when you uninstall and unpair.
- Uninstalling the extension removes everything it kept in `chrome.storage.local`. It does not delete the saves already in your library — do that from the Library page, or delete the whole account from Billing → Delete account.
- You can export your library at any time (JSON, CSV, Markdown, Obsidian) on every plan.

## Selling and sharing

We do not sell your data, do not share it with data brokers or advertisers, and do not use it to train models. The processors behind the hosted service are listed in [Privacy](/privacy).

## Contact

hello@resurfly.com — for privacy questions, data requests, or deletion requests. We answer within 30 days and usually the same week.
