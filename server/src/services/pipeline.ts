import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db, now, j } from '../db.js';
import type { Analysis, ItemRow, MediaUrls } from '../types.js';
import { ANALYSIS_JSON_SCHEMA, ANALYSIS_SYSTEM_PROMPT, buildAnalysisUserPrompt, CATEGORIES } from '../prompts/analysis.js';
import { download, extractAudio, extractFrames, fileToVisionDataUrl, HttpError, itemDir, mediaAbs, saveThumb, safeName, toVisionDataUrl } from './media.js';
import { embedTexts, embeddingToBuffer, generateStructured, hasOpenAI, models, transcribeFile } from './openai.js';
import { enrichFromEmbed } from './importers.js';
import { indexItem, normalizeTag } from './search.js';
import { updateNeighborsFor, currentEmbeddingTag } from './neighbors.js';

export type Stage = 'media' | 'transcribe' | 'analyze' | 'embed';

export interface ProcessOptions {
  force?: boolean; // re-run analysis even if done
  skipMedia?: boolean;
  mediaOnly?: boolean; // fetch media/transcript now (URLs expire) but do NOT run the paid analysis
  log?: (msg: string) => void;
}

const log = (id: string, msg: string) => console.log(`[pipeline ${id}] ${msg}`);

export function getItem(id: string): ItemRow | undefined {
  return db().prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
}

function setItem(id: string, patch: Record<string, unknown>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db().prepare(`UPDATE items SET ${sets}, updated_at = @__now WHERE id = @__id`).run({ ...patch, __now: now(), __id: id });
}

/** Full processing of one item: media → transcript → analysis → embedding. Idempotent & resumable. */
export async function processItem(id: string, opts: ProcessOptions = {}): Promise<void> {
  let item = getItem(id);
  if (!item) throw new Error(`item ${id} not found`);

  // ---- Stage 1: media (thumb, frames, transcript) ----
  if (!opts.skipMedia && (item.media_status === 'pending' || (opts.force && item.media_status === 'failed'))) {
    try {
      await runMediaStage(item);
    } catch (e: any) {
      log(id, `media stage failed: ${e?.message || e}`);
      setItem(id, { media_status: 'failed', media_error: String(e?.message || e).slice(0, 500) });
    }
    item = getItem(id)!;
  }

  if (opts.mediaOnly) return;

  // ---- Stage 2: analysis ----
  if (item.analysis_status !== 'done' || opts.force) {
    if (!hasOpenAI()) {
      setItem(id, { analysis_status: 'pending', analysis_error: 'OpenAI API key not configured' });
      return;
    }
    setItem(id, { analysis_status: 'running', analysis_error: null });
    try {
      await runAnalysisStage(item);
      item = getItem(id)!;
      // Analysis is the expensive part — never let an embedding hiccup mark it failed (it gets re-embedded on the next pass).
      let embedErr: string | null = null;
      try { await runEmbeddingStage(item); } catch (e: any) { embedErr = `embedding failed (will retry): ${String(e?.message || e).slice(0, 300)}`; log(id, embedErr); }
      setItem(id, { analysis_status: 'done', analysis_error: embedErr, attempts: item.attempts + 1 });
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 800);
      log(id, `analysis failed: ${msg}`);
      setItem(id, { analysis_status: msg.startsWith('SKIP:') ? 'skipped' : 'failed', analysis_error: msg, attempts: item.attempts + 1 });
    }
  } else if (!item.embedding && hasOpenAI()) {
    // Analyzed earlier but the embedding is missing/mismatched → just embed.
    try { await runEmbeddingStage(item); setItem(id, { analysis_error: null }); } catch (e: any) { log(id, `embedding retry failed: ${e?.message || e}`); }
  }
}

async function runMediaStage(itemIn: ItemRow) {
  let item = itemIn;
  const id = item.id;
  let urls = j<MediaUrls | null>(item.media_urls, null);
  const patch: Record<string, unknown> = {};

  // URL-only item (from IG export or manual URL) or expired URLs: best-effort enrichment via the public embed page.
  const urlsMissing = !urls || (!urls.thumb && !urls.video && !urls.carousel?.length);
  const urlsStale = !!item.media_urls_fetched_at && now() - item.media_urls_fetched_at > 3.5 * 86400 && !item.thumb_path;
  if ((urlsMissing || urlsStale) && item.shortcode) {
    const info = await enrichFromEmbed(item.shortcode);
    if (info) {
      if (info.caption && !item.caption) patch.caption = info.caption;
      if (info.username && !item.author_username) patch.author_username = info.username;
      if (info.taken_at && !item.taken_at) patch.taken_at = info.taken_at;
      if (typeof info.like_count === 'number' && item.like_count == null) patch.like_count = info.like_count;
      if (info.product_type && !item.product_type) patch.product_type = info.product_type;
      if (info.thumb || info.video_url) {
        urls = { thumb: info.thumb || urls?.thumb || null, video: info.video_url || null };
        patch.media_urls = JSON.stringify(urls);
        patch.media_urls_fetched_at = now();
      }
      if ((info.video || info.video_url) && item.media_type !== 'carousel') patch.media_type = 'video';
      else if (info.thumb && item.media_type === 'unknown') patch.media_type = 'image';
      if (patch.media_type) item = { ...item, media_type: patch.media_type as any };
    }
    if (Object.keys(patch).length) setItem(id, patch);
  }
  if (!urls || (!urls.thumb && !urls.video && !urls.carousel?.length)) {
    setItem(id, { media_status: 'skipped', media_error: 'No media URLs available (login-walled or expired). Analysis will use caption only.' });
    return;
  }

  const ageDays = item.media_urls_fetched_at ? (now() - item.media_urls_fetched_at) / 86400 : 99;
  const frames: string[] = [];
  let thumbRel: string | null = item.thumb_path;
  let firstError: string | null = null;

  // Thumbnail
  if (urls.thumb && !thumbRel) {
    try {
      const { buf } = await download(urls.thumb, { maxBytes: 15e6, timeoutMs: 45_000 });
      thumbRel = (await saveThumb(id, buf)).rel;
    } catch (e: any) {
      firstError = `thumb: ${e?.message || e}`;
      log(id, firstError);
    }
  }

  // Carousel slides → frames for vision (up to 6), each also stored as webp
  if (item.media_type === 'carousel' && urls.carousel?.length) {
    const slides = urls.carousel.slice(0, 6);
    for (let i = 0; i < slides.length; i++) {
      const s = slides[i];
      if (!s.thumb) continue;
      try {
        const { buf } = await download(s.thumb, { maxBytes: 15e6, timeoutMs: 45_000 });
        const rel = (await saveThumb(id, buf, `slide_${i + 1}`)).rel;
        frames.push(rel);
        if (!thumbRel) thumbRel = rel;
      } catch (e: any) {
        if (!firstError) firstError = `slide ${i + 1}: ${e?.message || e}`;
      }
    }
  }

  // Video → audio transcript + frames
  let transcript: string | null = item.transcript;
  let transcriptLang: string | null = item.transcript_lang;
  let videoPathRel: string | null = item.video_path;
  const videoUrl = urls.video || urls.carousel?.find((c) => c.video)?.video || null;
  if (videoUrl && item.media_type !== 'image' && !transcript) {
    const dir = itemDir(id);
    const tmpVideo = path.join(config.tmpDir, `${safeName(id)}.mp4`);
    try {
      const { buf } = await download(videoUrl, { maxBytes: config.maxVideoMb * 1e6, timeoutMs: 120_000 });
      await fsp.writeFile(tmpVideo, buf);
      // frames
      const fr = await extractFrames(tmpVideo, id, config.visionFrames, item.duration);
      frames.push(...fr);
      if (!thumbRel && fr.length) {
        // use the first frame as thumbnail if we don't have one
        const fbuf = await fsp.readFile(mediaAbs(fr[0]));
        thumbRel = (await saveThumb(id, fbuf)).rel;
      }
      // transcript
      if (hasOpenAI() && (item.duration || 0) <= config.transcribeMaxSeconds) {
        const audioFile = path.join(config.tmpDir, `${safeName(id)}.mp3`);
        let audioBuf: Buffer | null = null;
        let audioName = 'audio.mp3';
        if (await extractAudio(tmpVideo, audioFile)) {
          audioBuf = await fsp.readFile(audioFile);
        } else if (buf.byteLength <= 24.5e6) {
          audioBuf = buf; audioName = 'video.mp4';
        }
        if (audioBuf) {
          try {
            const captionHint = (item.caption || '').slice(0, 200);
            const tr = await transcribeFile(audioBuf, audioName, { prompt: captionHint ? `Instagram reel. Caption: ${captionHint}` : undefined });
            transcript = tr.text || '';
            transcriptLang = tr.language || null;
            if (transcript.length < 3) transcript = '';
          } catch (e: any) {
            log(id, `transcription failed: ${e?.message || e}`);
            if (!firstError) firstError = `transcribe: ${e?.message || e}`;
          }
        }
        await fsp.rm(audioFile, { force: true }).catch(() => {});
      }
      if (config.keepVideos) {
        const dest = path.join(dir, 'video.mp4');
        await fsp.copyFile(tmpVideo, dest);
        videoPathRel = `${safeName(id)}/video.mp4`;
      }
    } catch (e: any) {
      const msg = e instanceof HttpError && (e.status === 403 || e.status === 410 || e.status === 404) ? `video URL expired/unavailable (HTTP ${e.status})` : `video: ${e?.message || e}`;
      if (!firstError) firstError = msg;
      log(id, msg);
    } finally {
      await fsp.rm(tmpVideo, { force: true }).catch(() => {});
    }
  }

  const gotSomething = !!thumbRel || frames.length > 0 || !!transcript;
  const expired = !gotSomething && ageDays > 1 && !!firstError && /HTTP 40[34]|HTTP 410|expired/.test(firstError);
  setItem(id, {
    thumb_path: thumbRel,
    frames: frames.length ? JSON.stringify(frames) : item.frames,
    video_path: videoPathRel,
    transcript: transcript ?? null,
    transcript_lang: transcriptLang,
    media_status: gotSomething ? (firstError ? 'partial' : 'done') : expired ? 'expired' : 'failed',
    media_error: firstError,
  });
}

async function runAnalysisStage(item: ItemRow) {
  const id = item.id;
  const frames = j<string[]>(item.frames, []);
  const images: string[] = [];
  const imageFiles = frames.length ? frames : item.thumb_path ? [item.thumb_path] : [];
  for (const rel of imageFiles.slice(0, 8)) {
    try { images.push(await fileToVisionDataUrl(mediaAbs(rel))); } catch {}
  }
  const caption = item.caption || '';
  const transcript = item.transcript || '';
  if (!caption.trim() && !transcript.trim() && images.length === 0) {
    throw new Error('SKIP: no content available (no caption, transcript or images)');
  }
  const postType = item.media_type === 'video' ? (item.product_type === 'clips' ? 'reel' : 'video') : item.media_type === 'carousel' ? 'carousel post' : item.media_type === 'image' ? 'image post' : 'post';
  const imageNote = item.media_type === 'carousel' ? `${images.length} carousel slides` : frames.length ? `${images.length} video frames sampled across the video (in order)` : images.length ? 'cover image' : '';
  const transcriptNote = item.media_type === 'video' ? (item.media_status === 'expired' ? 'video could not be fetched' : 'no speech detected or transcription unavailable') : 'not a video';
  const music = item.music_title ? `${item.music_title}${item.music_artist ? ` — ${item.music_artist}` : ''}` : null;
  const user = buildAnalysisUserPrompt(
    {
      author: item.author_username, authorName: item.author_name, postType, takenAt: item.taken_at, likeCount: item.like_count, playCount: item.play_count,
      commentCount: item.comment_count, duration: item.duration, music, location: item.location, collections: j<string[]>(item.collections, []), url: item.url,
      imageCount: images.length, imageNote,
    },
    caption, item.alt_text || '', transcript, transcriptNote,
  );
  const model = models().analysis;
  const preferred = preferredTags();
  const userWithTags = preferred.length ? `${user}\n\n## Preferred existing tags\nReuse these exact tags when they genuinely fit (add new specific ones as needed): ${preferred.join(', ')}` : user;
  const { data, usage } = await generateStructured<Analysis>({
    model, system: ANALYSIS_SYSTEM_PROMPT, user: userWithTags, images, schemaName: 'save_analysis', schema: ANALYSIS_JSON_SCHEMA as any, maxOutputTokens: 3000, effort: 'low',
  });
  const analysis = normalizeAnalysis(data);
  setItem(id, { analysis: JSON.stringify(analysis), analysis_model: model, analyzed_at: now() });
  // tags
  const d = db();
  const delTags = d.prepare("DELETE FROM item_tags WHERE item_id = ? AND kind = 'ai'");
  const insTag = d.prepare("INSERT OR IGNORE INTO item_tags (item_id, tag, kind) VALUES (?, ?, 'ai')");
  d.transaction(() => { delTags.run(id); for (const t of analysis.tags) insTag.run(id, t); })();
  indexItem(getItem(id)!);
  log(id, `analyzed (${usage.input}+${usage.output} tokens) → ${analysis.category} / ${analysis.title}`);
}

/** Top existing tags (cached 5 min) injected into the prompt so the library converges on a shared vocabulary. */
let _prefTags: { at: number; tags: string[] } | null = null;
export function preferredTags(): string[] {
  if (_prefTags && Date.now() - _prefTags.at < 5 * 60_000) return _prefTags.tags;
  const rows = db().prepare("SELECT tag, COUNT(*) AS n FROM item_tags WHERE kind = 'ai' GROUP BY tag HAVING n >= 2 ORDER BY n DESC LIMIT 160").all() as Array<{ tag: string; n: number }>;
  _prefTags = { at: Date.now(), tags: rows.map((r) => r.tag) };
  return _prefTags.tags;
}

export function normalizeAnalysis(a: Analysis): Analysis {
  const clampInt = (v: any, lo: number, hi: number, def: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  const clamp = (v: any, lo: number, hi: number, def: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  const arr = (v: any, max = 12) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()).slice(0, max) : []);
  const tags = Array.from(new Set(arr(a.tags, 14).map(normalizeTag).filter(Boolean))).slice(0, 12);
  return {
    ...a,
    title: (a.title || '').trim().slice(0, 120) || 'Untitled save',
    one_liner: (a.one_liner || '').trim().slice(0, 240),
    summary: (a.summary || '').trim(),
    key_points: arr(a.key_points, 10),
    category: (CATEGORIES as readonly string[]).includes(a.category) ? a.category : 'Other',
    subcategory: (a.subcategory || '').trim().slice(0, 60),
    tags,
    actionable_takeaways: arr(a.actionable_takeaways, 6),
    quotes: arr(a.quotes, 4),
    entities: {
      people: arr(a.entities?.people), brands: arr(a.entities?.brands), tools: arr(a.entities?.tools), places: arr(a.entities?.places),
      books_media: arr(a.entities?.books_media), products: arr(a.entities?.products),
    },
    hook: { text: (a.hook?.text || '').trim().slice(0, 300), style: a.hook?.style || 'none' },
    language: (a.language || 'und').toLowerCase().slice(0, 5),
    usefulness_score: clampInt(a.usefulness_score, 1, 10, 5),
    confidence: clamp(a.confidence, 0, 1, 0.5),
    is_evergreen: !!a.is_evergreen,
  };
}

export function embeddingText(item: ItemRow, a: Analysis | null): string {
  const parts: string[] = [];
  if (a) {
    parts.push(a.title, a.one_liner, a.summary, ...a.key_points, `Category: ${a.category} / ${a.subcategory}`, `Tags: ${a.tags.join(', ')}`);
    const ents = [...a.entities.people, ...a.entities.brands, ...a.entities.tools, ...a.entities.places, ...a.entities.books_media, ...a.entities.products];
    if (ents.length) parts.push(`Entities: ${ents.join(', ')}`);
    if (a.on_screen_text) parts.push(`On screen: ${a.on_screen_text.slice(0, 500)}`);
  }
  if (item.author_username) parts.push(`Author: @${item.author_username}`);
  if (item.caption) parts.push(`Caption: ${item.caption.slice(0, 800)}`);
  if (item.transcript) parts.push(`Transcript: ${item.transcript.slice(0, 1200)}`);
  return parts.filter(Boolean).join('\n').slice(0, 7000);
}

async function runEmbeddingStage(item: ItemRow) {
  const a = j<Analysis | null>(item.analysis, null);
  const text = embeddingText(item, a);
  if (!text.trim()) return;
  const [vec] = await embedTexts([text]);
  setItem(item.id, { embedding: embeddingToBuffer(vec), embedding_model: currentEmbeddingTag() });
  updateNeighborsFor(item.id, vec);
}

/** Remove derived data so an item can be fully re-processed. Returns false if the item is mid-flight (caller should tell the user). */
export function resetItemForReprocess(id: string, opts: { media?: boolean } = {}): boolean {
  const cur = getItem(id);
  if (!cur) return false;
  if (cur.queue_state === 'running') return false;
  const patch: Record<string, unknown> = { analysis_status: 'pending', analysis_error: null };
  if (opts.media) Object.assign(patch, { media_status: 'pending', media_error: null, transcript: null, transcript_lang: null, frames: null, thumb_path: null });
  setItem(id, patch);
  if (opts.media) {
    const name = safeName(id);
    const dir = path.join(config.mediaDir, name);
    if (name && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  return true;
}

export { toVisionDataUrl };
