# Architecture

One Docker container. One SQLite file. No queues, no Redis, no Postgres, no serverless functions.

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Docker (node:22-bookworm-slim + ffmpeg)                                    │
│                                                                            │
│  Hono HTTP server (server/src)                                             │
│   ├─ /api/auth        cookie session (HMAC), rate-limited login            │
│   ├─ /api/items       list/filter/search, detail (+related), patch, bulk   │
│   ├─ /api/import      harvester JSON · Instagram export ZIP · URLs         │
│   ├─ /api/jobs        status · pause · resume · queue · clear · concurrency · reindex       │
│   ├─ /api/export      json · csv · md · obsidian(zip)                      │
│   ├─ /api/ask         SSE: sources + streamed answer (RAG)                 │
│   ├─ /api/resurface   daily picks (deterministic per day) + notes          │
│   ├─ /api/graph       nodes/links for the knowledge graph                  │
│   ├─ /api/automations rules · events · contacts · test · send-test         │
│   ├─ /api/webhooks    Meta webhook (GET verify, POST events)  [public]     │
│   ├─ /api/settings    editable settings, tests, storage                    │
│   ├─ /media/*         thumbnails & frames (cookie-protected)               │
│   ├─ /harvester.js    the browser harvester (public)                       │
│   └─ /*               React SPA (web/dist)                                 │
│                                                                            │
│  Worker (in-process): picks items with queue_state='queued'                │
│   media stage → transcribe → analyze (structured output) → embed → neighbors│
│                                                                            │
│  SQLite (better-sqlite3, WAL) at $DATA_DIR/resurface.db                    │
│   items · item_tags · item_neighbors · items_fts (FTS5) · imports          │
│   settings · meta · automation_rules · automation_events · contacts        │
│  Files: $DATA_DIR/media/<id>/thumb.webp, frame_N.jpg, slide_N.webp         │
└────────────────────────────────────────────────────────────────────────────┘
```

## Pipeline per item (`server/src/services/pipeline.ts`)

1. **Media stage** — download the thumbnail (→ WebP 640px via sharp). Video: download → `ffmpeg` extracts 4 frames at 12/38/64/90% (640px JPEG) and a mono 16k mp3 → OpenAI transcription (`gpt-4o-mini-transcribe`) → video deleted (unless `KEEP_VIDEOS=true`). Carousel: up to 6 slides. URL-only items (from the Instagram export / pasted links) get enriched from the public embed page (`/p/<code>/embed/captioned/`, which server-renders for non-browser user agents and often includes a direct `video_url` for reels).
2. **Analysis stage** — one Responses API call with a strict JSON schema (`prompts/analysis.ts`), inputs: metadata + caption + alt text + transcript + images (`detail: low`) + the library's top existing tags ("preferred vocabulary"). Output normalized (tags kebab-cased/singularized, scores clamped), stored as JSON, tags exploded into `item_tags`, FTS row rebuilt.
3. **Embedding stage** — `text-embedding-3-small` (512 dims) over title/summary/key points/tags/entities/caption/transcript excerpt. Stored as a BLOB; an in-memory matrix serves semantic search. Top-8 neighbors per item are maintained incrementally (`item_neighbors`), including reverse edges — no O(N²) rebuild needed (but `POST /api/jobs/reindex` can rebuild everything).

Statuses are persisted per stage (`media_status`, `analysis_status`, `queue_state`) so the pipeline is idempotent and resumable across restarts. Concurrency is a setting (1–8). 429s trigger a short back-off.

## Search

- Keyword: FTS5 (`unicode61`, diacritics removed) with weighted BM25 across title/summary/key points/tags/caption/transcript/author/entities; tokens are prefix-matched.
- Semantic: cosine over the in-memory embedding matrix (fine up to ~20k items).
- Library search combines both (semantic toggle); **Ask** fuses both with reciprocal-rank fusion, sends the top 12 as context, and streams the answer with `[#id]` citations that the UI turns into clickable chips.

## Frontend (`web/`)

React 19 + Vite + Tailwind v4 (design tokens as CSS variables, light/dark), Motion for animations, TanStack Query for data, react-router, cmdk (⌘K palette), sonner (toasts), react-force-graph-2d (canvas graph with custom node painting, thumbnails at zoom ≥1.6, hover-dim, focus mode).

Design: "bone / ink / jade" — warm paper background with a faint grain, Instrument Serif display type, Instrument Sans UI, Geist Mono for metadata, one jade accent used as punctuation.

## Security model

- Single user; credentials from env; session cookie `rs_session` = base64url(payload).HMAC-SHA256(secret); 30 days; `Secure` when behind HTTPS (`x-forwarded-proto`).
- All `/api/*` except `auth`, `webhooks`, `health` require the session. `/media/*` too.
- Webhook POSTs verified with `X-Hub-Signature-256` when `META_APP_SECRET` is set.
- Settings stored in SQLite are plaintext on your private volume (single-tenant); env vars override and are shown as locked in the UI.

## Extending

- New import source → implement a `HarvestItem[]` producer in `services/importers.ts` and call `upsertItems`.
- New analysis field → add it to `ANALYSIS_JSON_SCHEMA` + `Analysis` type; it flows into exports automatically (JSON/MD; add a CSV column in `exporters.ts`).
- Different LLM provider → `services/openai.ts` is the only place that talks to OpenAI (`OPENAI_BASE_URL` works for compatible gateways).
