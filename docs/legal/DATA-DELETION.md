# Delete your data — resurfly.com

*Last updated: 17 August 2026. This page is the deletion instruction sheet for resurfly.com. It is written so that anyone — a user, a Meta reviewer, a Chrome Web Store reviewer — can follow it and check the result. What each control removes is listed exactly.*

There are four ways to remove data, from smallest to largest. All of them are immediate; none of them require e-mailing us, though we will do it for you if you ask.

## 1. Delete one saved post

**Library → open the post → Delete.**

Removes that post's row, its caption and metadata, its machine transcript, its analysis and tags, its embedding, its entry in the search index, and the thumbnail and video frames we cached on disk. It does not touch the post on Instagram.

## 2. Disconnect Instagram

**Settings → Instagram → Disconnect.** (API: `DELETE /api/instagram/account`.)

Removes the encrypted Instagram access token and the connected-account record (Instagram user id, username, name, profile picture URL, account type, follower/following/media counts, granted permissions), and unsubscribes our webhook at Meta so no further messages or comments reach us.

Your saved-posts library is not affected — it does not come from the Instagram connection.

## 3. Unpair the Companion extension

**Settings → Companion → Revoke** on the device.

Removes that device's stored token hash and, if you had switched on "Also harvest when my browser is closed", the encrypted Instagram session cookies stored with it. The extension in your browser stops being able to send anything. Uninstalling the extension additionally clears what it kept in `chrome.storage.local` on your machine.

## 4. Delete the whole account

**Billing → Delete account → type DELETE → Delete everything.** The same control is in **Settings → Data**. (API: `DELETE /api/account`.)

This is the complete erasure. In one step it:

- disconnects Instagram as in step 2 (token deleted, webhook unsubscribed) and additionally deletes the cached Instagram analytics — your own posts, their captions and insights, the daily metric rows and the follower snapshots;
- deletes every automation rule, every automation event (including the sender ids, usernames and message text of people who wrote to you) and every automation contact;
- deletes every saved post with its captions, transcripts, analyses, tags, embeddings, search-index entries and the cached thumbnails and video frames on disk;
- deletes your Ask conversations and their messages;
- deletes your import history and harvest history;
- deletes every paired Companion device, its token hash and any stored Instagram session;
- deletes your Profile score questionnaire answers and every report it produced, and any "tell me when Instagram connections open" entry with the e-mail address on it;
- deletes your settings, your onboarding state and your usage counters;
- deletes your user record — e-mail address and password hash — which frees the address for a future signup.

**What is left afterwards, and why.** A numbered account row marked deleted, holding the plan status, Paddle's customer/subscription/transaction ids and the credit ledger (numbers and reasons, no content). That is the invoice trail: Paddle is the merchant of record and tax law requires the purchase history to be reconcilable. It contains nothing you wrote and nothing from Instagram.

**Your subscription.** Deleting the account cancels a live subscription at Paddle first, so nothing further is charged — there would be no account left to cancel from afterwards. If that call to Paddle fails, the screen tells you so and gives you the address to write to; it never reports a cancellation that did not happen. You can also cancel on your own beforehand in **Billing → Cancel subscription**, which opens Paddle's cancel screen for your subscription directly, or through the link in any Paddle invoice e-mail. Export your library first if you want to keep it — Library → Export (JSON, CSV, Markdown, Obsidian) works on every plan.

## 5. Removing Resurfly from Instagram

You can also start the deletion from Instagram's side: **Instagram app → Settings → Website permissions → Apps and websites → Resurfly → Remove.**

Meta then calls our two callbacks with a signed request, and we verify the signature with our app secret before acting:

- `POST https://resurfly.com/api/instagram/deauthorize` — the callback Meta fires when you remove the app. We delete the access token and the connected-account record for that Instagram user, and, because removal is a removal, the same data as the deletion callback below: the automation contacts and events, and the cached Instagram media, insights and follower snapshots.
- `POST https://resurfly.com/api/instagram/delete` — the data-deletion callback. We delete everything we obtained through Meta for that Instagram user: the access token and account record, the automation contacts and events (sender ids, usernames, message and comment text), and the cached Instagram media, insights and follower snapshots. As Meta requires, the response is a JSON body with a `confirmation_code` (a UUID) and a `url` — `https://resurfly.com/data-deletion`, this page. The code is stored against the account the request touched and written to our server log, so quoting it to **hello@resurfly.com** is enough for us to find the request and tell you what was removed and when.

Because the token is deleted, nothing further can reach us for that account even before Meta stops delivering events.

These callbacks are configured in our Meta app as the Deauthorize callback URL and the Data deletion request URL. They touch only the data that came from Instagram; the saved posts you imported with the Companion or an Instagram export are separate and are removed by step 1 or step 4.

## 6. By e-mail

Write to **hello@resurfly.com** from the address on the account, saying what you want removed. We do it and confirm, normally within a few days and always within 30 days. If you are not sure which of the steps above applies, this is the safe option.

If you contacted a Resurfly customer's Instagram account and want the record of that conversation removed, e-mail us with the Instagram username you wrote from and the account you wrote to; we will delete the stored events and contact row for you. We can do this without the account owner's involvement.

## What about backups?

The database is backed up nightly to private object storage and 14 snapshots are kept. A deletion is applied to the live database immediately; the older snapshots still contain the data until they age out of that 14-day window and are pruned automatically. Backups are only ever used to restore the service after a failure.

## Related pages

[Privacy](/privacy) · [Security](/security) · [Subprocessors](/subprocessors) · [Extension privacy](/privacy/extension) · [Terms](/terms)
