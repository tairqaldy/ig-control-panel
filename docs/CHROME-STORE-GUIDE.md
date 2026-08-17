# Publishing Resurfly Companion on the Chrome Web Store

Written for the person who owns the Google account, start to finish. Follow it top to bottom once; after that only
[Shipping an update](#9-shipping-an-update) matters.

Everything policy-related below was checked against Google's own documentation in August 2026 — the sources are
listed in [Sources](#sources) and cited inline as `[1]`, `[2]`, … Where a rule changed recently (the
August 1, 2026 policy update) it is called out.

Copy to paste into every field lives in [`extension/STORE-LISTING.md`](../extension/STORE-LISTING.md). Keep both files
open while you work.

---

## 0. Before you start

| Thing | Where |
| --- | --- |
| The zip you upload | `extension/dist/resurfly-companion-<version>-store.zip` |
| How to build it | `node extension/build-zip.mjs --store` (run from the repo root) |
| Listing copy | `extension/STORE-LISTING.md` |
| Screenshots | `extension/store/store-1…4-*.png` (1280×800) |
| Store icon | `extension/store/icon-1024.png` |
| Privacy policy the listing points at | https://resurfly.com/privacy/extension |

Two builds exist and only one of them may be uploaded:

- **`resurfly-companion-<version>-store.zip`** — the Web Store build. No `optional_host_permissions`; the App-URL
  field in Options is hidden because the package can only ever reach resurfly.com.
- **`resurfly-companion-<version>.zip`** — the self-hoster / load-unpacked build. Keeps `optional_host_permissions`
  (`https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`) so someone running their own Resurfly can point the
  extension at it. **Never upload this one.** A wildcard host pattern is exactly what pushes an extension into
  extended manual review [2], and a reviewer sees "read your data on all sites" where we mean "one self-hosted
  origin the user typed in".

Both builds are produced from the same `extension/manifest.json`; the store build is that manifest minus one key.
`build-zip.mjs --store` asserts the difference so the wrong file cannot be produced by accident.

---

## 1. The developer account ($5, once)

1. Sign in to the Google account that should own the listing. Use one you will still control in three years — the
   e-mail on a developer account **cannot be changed after the account is created**, and a deleted account's e-mail
   can never be reused [3]. A dedicated address (for example `store@resurfly.com` as a Google account) is safer than
   a personal Gmail.
2. Open the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole).
3. Accept the developer agreement and program policies, then pay the **one-time US$5 registration fee** [3], [7].
   It is charged once per account, not per extension and not per year.
4. Fill in the publisher details: a contact e-mail (Google verifies it) and, on the listing, a support e-mail —
   use `hello@resurfly.com` for support so a reviewer question does not sit in a personal inbox.

An account can have up to 20 published extensions [4]; we need one.

---

## 2. Build and upload the package

```bash
# from the repo root
node extension/validate.mjs          # manifest, files, node --check, core.js in sync
node extension/build-zip.mjs --store # → extension/dist/resurfly-companion-<version>-store.zip
```

`validate.mjs` fails the build if a permission appears that has no justification written in `STORE-LISTING.md`, if the
wildcard host sneaks into `host_permissions`, or if `extension/lib/core.js` has drifted from `harvester/core.js`.

In the dashboard: **Items → Add new item → upload the zip** (limit is 2 GB; ours is ~34 KB) [4]. The dashboard then
shows four tabs: **Store listing**, **Privacy practices**, **Distribution**, and a **Payments** tab we do not use.

---

## 3. Store listing tab — every field

Paste from `extension/STORE-LISTING.md`; the shape of each field:

| Field | What goes in |
| --- | --- |
| **Item name** | `Resurfly Companion` |
| **Summary** | 132 characters max — the one-liner from the listing file. Do not keyword-stuff; irrelevant or repetitive metadata is its own rejection category (Yellow Zinc, "insufficient metadata") [1]. |
| **Description** | The long copy from the listing file. It must describe what the extension does and nothing it does not do. |
| **Category** | Productivity |
| **Language** | English |
| **Store icon** | `extension/store/icon-1024.png` (128×128 is taken from the package itself) |
| **Screenshots** | 1280×800, at least one, up to five: `store-1-popup-paired.png`, `store-2-popup-unpaired.png`, `store-3-popup-login-needed.png`, `store-4-options.png`. They must show the actual extension UI — mock-ups or marketing collages get flagged. |
| **Small promo tile / marquee** | Optional. Skip; they only matter for featuring. |
| **Homepage URL** | `https://resurfly.com` |
| **Support URL** | `https://resurfly.com/support` (or the same homepage — it must resolve) |
| **Mature content** | No |

A feature described in the listing has to work in the shipped package. A listing that promises something the code
does not do is "non-functional feature" (Yellow Magnesium) [1] — this is the reason the store build hides the
App-URL field instead of leaving a control that cannot reach anything.

---

## 4. Privacy practices tab — the exact answers

This tab is where extensions that read a logged-in site pass or fail. All copy is in `STORE-LISTING.md`; here is what
each question is really asking.

### Single purpose

> Sync the user's own Instagram saved posts into their Resurfly library.

One sentence, one purpose. Since **August 1, 2026** the Limited Use policy says user data collection must be
"strictly necessary to the extension's disclosed single purpose" [5], [6] — so this sentence is also the yardstick
every permission below is measured against. Anything you cannot tie back to it, delete from the manifest.

### Permission justifications

There is one box per permission. Keep each answer concrete: what it does, when it runs, why the extension cannot work
without it. Ours (full text in `STORE-LISTING.md`):

- `alarms` — the 6-hour sync timer, the 1-minute continuation of a long first sync, the badge expiry.
- `contextMenus` — one item, "Sync my saves to Resurfly", on instagram.com only.
- `storage` — device token, app URL, resumable feed cursor, last-sync counters. Local only.
- `https://www.instagram.com/*` — read the user's own saved feed; Instagram has no API for saved posts.
- `https://resurfly.com/*` — send those posts to the user's own account.
- `cookies` (optional) — requested only when the user turns on "Also harvest when my browser is closed".

Unused or oversized permissions are their own violation code — **Purple Potassium**, "excessive permissions requested
or unused permissions included in manifest" [1]. Before every submission, check that the manifest and the
justification list match item for item.

### Remote code

Answer **No**. Everything ships in the package: no CDN scripts, no `eval`, no remotely hosted modules, no bundler
pulling anything at runtime. Getting this wrong is **Blue Argon**, the Manifest V3 remote-code violation [1].

### Data collection

Tick exactly two categories:

- **Website content** — the saved posts themselves.
- **Authentication information** — the three instagram.com cookies, and only when the user switches on the optional
  toggle. Google's definition of authentication information explicitly includes authentication cookies [8], so this
  must be ticked even though the cookies go to the user's own account and nowhere else.

Leave the other seven unticked (personally identifiable information, health, financial and payment, personal
communications, location, web history, user activity).

### The three certifications

All three are true for us and all three must be ticked:

1. Not sold or transferred to third parties outside the approved use cases — the only recipient is the user's own
   Resurfly account.
2. Not used or transferred for purposes unrelated to the single purpose.
3. Not used or transferred to determine creditworthiness or for lending purposes.

These mirror the Limited Use requirements [5]: use data only for the single purpose; transfer only when necessary to
that purpose, to comply with law, to fight abuse, or in a merger/acquisition; do not let humans read user data; and
state your compliance publicly on a site belonging to the extension. That public statement is
`https://resurfly.com/privacy/extension`.

### Privacy policy URL

`https://resurfly.com/privacy/extension` — a Companion-specific page. Google requires a privacy policy whenever an
extension handles user data, even data that never leaves the device, and it must say what is collected, how it is
used, and when it is shared [8]. A missing or unreachable policy is **Purple Lithium** [1]. Check the URL loads in a
private window before you submit; a 404 or a login wall fails the same check.

Two more things the page must carry, because the August 2026 update tightened both [5], [6]:

- a **prominent disclosure** of what is collected, shown in the product's own UI and not only in the store listing —
  the Companion's Options page and the opt-in switch text carry it;
- a promise to tell users **before** data handling changes, not after.

### Test instructions

Give the reviewer a working account. An extension that shows an empty state until you sign in somewhere is routinely
rejected as non-functional simply because the reviewer never got past the first screen. Create a Resurfly account for
review, put its credentials in the test-credentials field (never in the public description), and write the two
sentences from `STORE-LISTING.md` explaining that Instagram must be signed in in the same browser.

---

## 5. Distribution tab

- **Visibility: Public.** Unlisted also works for a soft launch — the extension is installable by link and does not
  appear in search — and can be switched to public later without a new review.
- **Regions:** all.
- **Deferred publishing:** if you leave "publish automatically after approval" unchecked, the approved item waits for
  you to press publish. You then have **30 days** to do it, after which the submission reverts to draft and needs
  another review [4]. If you have no reason to time the launch, let it publish automatically.

---

## 6. What review actually looks at, and why we pass

Extensions that read a logged-in website are the sharpest case in the store. These are the recurring rejection
reasons and our answer to each.

| Rejection reason | Why it is raised | Our answer |
| --- | --- | --- |
| **Broad host permissions** — `<all_urls>`, `*://*/*` | Sends the item straight into extended manual review [2] and reads as "wants every site" | The store build declares two hosts: `www.instagram.com` and `resurfly.com`. No wildcard anywhere; `validate.mjs` fails the build if one appears. |
| **Excessive / unused permissions** (Purple Potassium [1]) | A permission in the manifest that no code path uses | Four permissions, each used by named code: `alarms` (background.js timers), `storage` (lib/store.js), `contextMenus` (one instagram.com item), `cookies` optional and requested at the moment the user flips the switch. |
| **Sensitive execution permissions** — `cookies`, `tabs`, `downloads` | Reviewers verify these are genuinely necessary [2] | `cookies` is declared **optional**, never requested at install, requested only inside the user gesture that enables background harvesting, and handed back with `chrome.permissions.remove` when the switch is turned off. The extension is fully functional without it. |
| **Single purpose / multiple unrelated functions** (Red family [1]) | Two products in one package | One purpose: move the user's saved posts into their own library. No ads, no search modification, no unrelated features. The context-menu item and the popup both do the same one thing. |
| **Reading a logged-in site looks like scraping** | Extension reads another service's authenticated content | It reads only the signed-in user's *own* saved feed, using the session already in their browser, making the same request instagram.com makes for them. It never touches other users' data, never writes to Instagram, and the data goes to that same user's own account — not to us as a dataset. Say this in the justification, not just in the description. |
| **Handling session cookies** | The scariest thing a reviewer can see | Off by default, opt-in, three named cookies, one recipient (the user's own Resurfly), encrypted at rest, deleted the moment the switch is turned off. Disclosed both in the popup text and in the privacy policy. |
| **Missing / unreachable privacy policy** (Purple Lithium [1]) | No policy, or one behind a login | Public page at `https://resurfly.com/privacy/extension`, no auth, Companion-specific. |
| **Undisclosed data collection** (Purple Nickel [1]) | The disclosure is not shown before collection | The Options page opens on install and states what is read; the optional switch spells out the cookies before Chrome's own permission prompt appears. |
| **Insecure transmission** (Purple Copper [1]) | Any plain HTTP | All traffic is HTTPS. The store build cannot even be pointed at an `http://localhost` origin — that pattern only exists in the self-hoster build. |
| **Remote code** (Blue Argon [1]) | External scripts, `eval`, remote modules | None. Plain ES modules in the package; no bundler; `validate.mjs` runs `node --check` over every file so nothing is minified or obfuscated. Obfuscated code is disallowed outright [2]. |
| **Non-functional feature** (Yellow Magnesium [1]) | Something described does not work | The reviewer gets a working test account; the App-URL field, which the store build cannot honour, is hidden rather than shipped dead. |

---

## 7. Review timeline

Most items finish review **within a few days**, but it can take **up to a few weeks**; if nothing has moved after
**three weeks**, contact developer support [2]. Google noted a surge in submissions in 2026, so plan for the slow end
rather than the fast one. Being a new developer, requesting sensitive permissions, or making large code changes all
push a submission toward manual review [2] — the first submission of a new account with a `cookies` permission hits
two of those three, so expect days, not hours.

While a submission is pending, the currently published version of the listing stays exactly as it is and users are
not notified of anything [2].

---

## 8. If it is rejected

1. **Read the e-mail for the violation code.** It is two words, a colour and an element — `Purple Potassium`,
   `Blue Argon` [1]. That code, not the prose, tells you which policy was hit; look it up in the troubleshooting
   table [1].
2. **Fix the cause, not the wording**, if the code points at the package (permissions, remote code, host patterns).
   Bump the version, rebuild with `--store`, upload, resubmit.
3. **Appeal when the code points at something you believe is already correct.** Use the **Appeal** button on the item
   detail page in the dashboard; responses usually come within about three days [1], [2]. Appeals are also the right
   channel for "please tell me which permission you mean".
4. **Write the appeal like the justification, only shorter.** One paragraph: what the extension does, which single
   user's data it touches, where that data goes, and why the flagged permission is unavoidable. For us the load-bearing
   sentence is: *Instagram exposes no API for saved posts, so the only way to read the user's own saved list is the
   same authenticated request their browser already makes, run in their own browser, with the result sent only to
   their own account.*
5. **Do not resubmit unchanged** hoping for a different reviewer. Repeated non-compliant submissions put the developer
   account itself at risk.

Keep a note of each rejection code and the fix in this file, so the second submission does not relearn the first.

---

## 9. Shipping an update

```bash
# 1. bump the version
#    extension/manifest.json → "version": "0.2.1"
# 2. validate
node extension/validate.mjs
# 3. build the store zip
node extension/build-zip.mjs --store
# 4. upload extension/dist/resurfly-companion-0.2.1-store.zip in the dashboard → Package → Upload new package
# 5. re-check the Privacy practices tab (see below), then Submit for review
```

Rules of thumb:

- The version must be strictly higher than the published one; dotted integers only (`validate.mjs` enforces the shape).
- **Any new permission re-opens the privacy review.** Add the justification to `STORE-LISTING.md` and to the dashboard
  in the same change, or the update is rejected for an unjustified permission.
- If what the extension collects changes, update `https://resurfly.com/privacy/extension` **and** tell existing users
  in the product — since August 2026 a change in data handling must be disclosed proactively, not silently [5], [6].
- Updates by an established developer with no new permissions are usually the fastest reviews; a permission change is
  a fresh manual look.
- After approval, Chrome rolls the update out to installed users automatically within a few hours.

When the listing goes live, put its URL into `COMPANION_INSTALL_URL` in `web/src/components/import/useCompanion.ts`
(or the `VITE_COMPANION_URL` build env on Railway) and into `docs/COMPANION.md`, so the Import page links to the store
instead of the Releases page.

---

## Sources

Checked August 2026.

1. [Troubleshooting Chrome Web Store violations](https://developer.chrome.com/docs/webstore/troubleshooting) — violation codes (Purple Potassium, Purple Lithium/Nickel/Copper/Magnesium, Blue Argon, Red family, Yellow Magnesium/Zinc) and the appeal button.
2. [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process) — timelines, what slows review (broad host permissions, `cookies`/`tabs`/`downloads`, obfuscated code), rejection e-mails, appeals within about three days.
3. [Register your developer account](https://developer.chrome.com/docs/webstore/register) — one-time registration fee, the developer e-mail cannot be changed and cannot be reused.
4. [Publish your extension](https://developer.chrome.com/docs/webstore/publish) — upload, tabs, distribution, deferred publishing and the 30-day window, 20-item limit, 2 GB package limit.
5. [Limited Use policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use) — the four requirements and the prohibited uses (personalized ads, data brokers, creditworthiness).
6. [Chrome Web Store policy updates 2026](https://developer.chrome.com/blog/cws-policy-updates-2026) — effective August 1, 2026: data strictly necessary to the single purpose, prominent disclosure of all collection, proactive notice when practices change.
7. [Chrome Web Store developer registration fee 2026](https://www.extensionradar.com/blog/chrome-web-store-developer-fee-2026) — the fee amount, US$5, one-time, no renewal.
8. [Updated Privacy Policy & Secure Handling Requirements](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) — what counts as personal or sensitive data (authentication cookies, website content), privacy-policy contents, prominent disclosure and consent, HTTPS in transit and encryption at rest.
9. [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) — the structure of the Privacy practices tab: single purpose, per-permission justification, remote code, data categories, certifications, policy URL.
