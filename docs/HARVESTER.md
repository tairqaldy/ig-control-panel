# The harvester — exporting your Instagram saves

The harvester is a small self-contained JavaScript file ([`harvester/harvester.js`](../harvester/harvester.js)) that runs **inside your own browser on instagram.com** and downloads all your saved posts as one JSON file. It's the richest import path: captions, creators, like/play counts, durations, audio titles, collections, and the media URLs Resurface uses to fetch thumbnails, extract video frames and transcribe reels.

## Why a browser script?

Instagram has no official API for reading your own saved posts. The web app you already use calls an internal endpoint (`/api/v1/feed/saved/posts/`) with your session; the harvester calls exactly the same endpoint, from the same page, with the same cookies — the way a browser extension would. Nothing is sent anywhere except instagram.com; the result is written to a file on your machine that *you* upload.

Rate limits are respected (~1 request/second with jitter, exponential back-off on `429`). 5,000 saves ≈ 240 requests ≈ 5 minutes.

## Step by step

1. Open **https://www.instagram.com/** on a desktop browser and make sure you're logged in to the account whose saves you want.
2. Run the script. Two options:
   - **Bookmarklet**: on the Resurface *Import* page drag the **"Harvest saves (bookmarklet)"** button to your bookmarks bar. Click it while on instagram.com.
   - **Console**: on the Import page click **"Copy console script"**, then on instagram.com press `F12` → *Console* → paste → `Enter`. Chrome may ask you to type `allow pasting` once first (it's a safety feature; the script is fully readable at `/harvester.js`).
3. A dark panel appears bottom-right. Optional: uncheck *"Also map my collections"* to save requests, or set a *Max saves* to test with a small batch.
4. Click **Start**. Watch the counter. You can **Stop & download** any time to keep what's been collected so far.
5. When it finishes it downloads `resurface-harvest-YYYYMMDD.json` automatically (or click *Download JSON*).
6. Go to Resurface → **Import** → drop the file. Import is instant; analysis then runs in the background (sidebar shows progress).

> **Upload soon after harvesting.** The media URLs inside the file are signed CDN links: images last ~4 days, videos ~1–2 days. Resurface downloads what it needs right after import. If links have expired you'll see `media: expired` on those saves — just re-run the harvester and upload again; existing saves get their links refreshed (analyses, notes and favorites are kept).

## What's in the JSON

```jsonc
{
  "format": "resurface-harvest", "version": 1, "exported_at": 1786876000,
  "account": { "ds_user_id": "…", "username": "you" },
  "collections": [ { "id": "1784…", "name": "Recipes", "count": 42 } ],
  "items": [
    {
      "pk": "3941…", "code": "Da0p7NNxifz", "url": "https://www.instagram.com/reel/Da0p7NNxifz/",
      "taken_at": 1784138627, "media_type": 2, "product_type": "clips",
      "caption": "…", "alt_text": "…",
      "user": { "pk": "…", "username": "angus.sewell", "full_name": "…", "is_verified": false, "profile_pic_url": "…" },
      "like_count": 5807, "comment_count": 44, "play_count": 163593, "video_duration": 58.9,
      "location": null, "music": null, "original_audio": "Original audio",
      "thumb": { "url": "https://…cdninstagram.com/…", "width": 640, "height": 1136 },
      "video": { "url": "https://…", "width": 720, "height": 1280 },
      "carousel": null,                     // or [{ pk, media_type, thumb, video, alt_text }, …]
      "collections": ["Recipes"],           // only if you mapped collections
      "usertags": ["…"], "coauthors": [], "is_paid_partnership": false, "has_audio": true
    }
  ]
}
```

Order matters: items come newest-saved-first; Resurface stores that as `saved_rank` (Instagram doesn't expose the exact save timestamp here — the official data export does, and importing both merges them).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel says *Not authorized (HTTP 401/403)* | You're not logged in, or Instagram is showing a checkpoint. Reload instagram.com, log in, retry. |
| *Rate limited (HTTP 429). Waiting…* | Normal on very large libraries. It waits 20 s, 40 s, 60 s… and continues. Leave the tab open. |
| Stops early with a `5xx` error | Instagram occasionally serves a bad pagination cursor. Click *Stop & download*, upload what you got, then re-run later — new items merge in. |
| Nothing downloads at the end | Some browsers block automatic downloads: click **Download JSON** manually. Or run `copy(JSON.stringify(window.__resurfaceHarvest))` in the console and paste into a file. |
| Bookmarklet does nothing | Some setups block `javascript:` bookmarks on this site — use the console method. |
| Instagram warns *"Stop! This is a browser feature intended for developers…"* | That's a generic warning about pasting unknown code. You can read every line of ours: `/harvester.js`. |

## Privacy & safety

- The script has no dependencies, no analytics, and does not talk to Resurface or any third party.
- It reads only your saved posts (and collection membership if enabled). It never writes to your account.
- Use it on your own account only. Instagram's terms discourage automation; this is a read-only, human-paced export of your own data, but you use it at your own risk.
