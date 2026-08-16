# harvester/

| File | What it is |
| --- | --- |
| `core.js` | **Source of truth.** Pure ESM module (no imports, no DOM, no Node APIs): Instagram endpoint paths (`SAVED_FEED_PATH`, `savedFeedUrl`, `collectionsListUrl`, …), request headers (`buildHeaders`), page helpers (`pageItems`, `pageCursor`, `parseFeedPage`, `parseCollectionsPage`), the raw-media → `HarvestItem` normalizer (`normalizeItem`) and the logged-out heuristics (`looksLikeLoginPage`, `looksLikeLoggedOut`). Used by the server's background harvester (`server/src/services/companion.ts`), the browser extension (`extension/lib/core.js`) and the console script. |
| `core.d.ts` | Hand-written types for `core.js` (keep in sync). |
| `harvester.js` | The self-contained console/bookmarklet script served at `/harvester.js`. The block between `/* @core-begin */` and `/* @core-end */` is **generated** from `core.js` (with the `export` keywords stripped). |
| `build.mjs` | `node harvester/build.mjs` regenerates that block and copies `core.js` to `extension/lib/core.js`; `node harvester/build.mjs --check` exits 1 when either copy is stale (run it in CI). |
| `package.json` | Only marks the folder as `"type": "module"` so Node loads `core.js` as ESM. Not an npm workspace. |

Workflow: edit `core.js` → `node harvester/build.mjs` → `node --check harvester/harvester.js`.
