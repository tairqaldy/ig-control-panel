import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { config } from '../config.js';

const execFileP = promisify(execFile);
const require = createRequire(import.meta.url);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let _ffmpeg: string | null | undefined;
export function ffmpegPath(): string | null {
  if (_ffmpeg !== undefined) return _ffmpeg;
  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) return (_ffmpeg = config.ffmpegPath);
  // system ffmpeg (Docker image installs it via apt)
  for (const cand of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(cand)) return (_ffmpeg = cand);
  }
  try {
    const p = (require('ffmpeg-static') as string | null) || null;
    if (p && fs.existsSync(p)) return (_ffmpeg = p);
  } catch {}
  // last resort: hope it's on PATH
  _ffmpeg = 'ffmpeg';
  return _ffmpeg;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Only fetch public http(s) hosts — never loopback/private/link-local (SSRF guard for URLs coming from import files). */
export function isSafeUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return false;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

export async function download(url: string, opts: { maxBytes?: number; timeoutMs?: number; retries?: number } = {}): Promise<{ buf: Buffer; contentType: string }> {
  if (!isSafeUrl(url)) throw new HttpError(400, `Refusing to fetch non-public URL: ${url.slice(0, 60)}`);
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: '*/*' }, signal: ctrl.signal, redirect: 'follow' });
      if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} for ${url.slice(0, 80)}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (opts.maxBytes && len && len > opts.maxBytes) throw new HttpError(413, `File too large (${Math.round(len / 1e6)}MB)`);
      const ab = await res.arrayBuffer();
      if (opts.maxBytes && ab.byteLength > opts.maxBytes) throw new HttpError(413, `File too large (${Math.round(ab.byteLength / 1e6)}MB)`);
      return { buf: Buffer.from(ab), contentType: res.headers.get('content-type') || '' };
    } catch (e: any) {
      lastErr = e;
      // Don't retry definitive HTTP errors (expired/forbidden/not found/too large)
      if (e instanceof HttpError && (e.status === 403 || e.status === 404 || e.status === 410 || e.status === 413)) throw e;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function itemDir(itemId: string): string {
  const name = safeName(itemId);
  if (!name) throw new Error('invalid item id');
  const d = path.join(config.mediaDir, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
export function safeName(s: string): string {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+$/, '');
}

/** Save a thumbnail (webp, max 640px wide) and return relative media path. */
export async function saveThumb(itemId: string, buf: Buffer, name = 'thumb'): Promise<{ rel: string; width: number; height: number }> {
  const dir = itemDir(itemId);
  const out = path.join(dir, `${name}.webp`);
  const img = sharp(buf, { failOn: 'none' }).rotate().resize({ width: 640, withoutEnlargement: true }).webp({ quality: 78 });
  const info = await img.toFile(out);
  return { rel: `${safeName(itemId)}/${name}.webp`, width: info.width, height: info.height };
}

/** Prepare an image for the vision model: JPEG, max 768px. Returns data URL. */
export async function toVisionDataUrl(buf: Buffer): Promise<string> {
  const jpg = await sharp(buf, { failOn: 'none' }).rotate().resize({ width: 768, height: 768, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString('base64')}`;
}

export async function fileToVisionDataUrl(absPath: string): Promise<string> {
  return toVisionDataUrl(await fsp.readFile(absPath));
}

/** Probe duration (seconds) using ffmpeg stderr parse (no ffprobe dependency). */
export async function probeDuration(file: string): Promise<number | null> {
  try {
    await execFileP(ffmpegPath()!, ['-hide_banner', '-i', file], { windowsHide: true, maxBuffer: 4e6 });
  } catch (e: any) {
    const m = String(e?.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  return null;
}

/** Extract N frames evenly spread (skipping the very start/end) as JPEG files. */
export async function extractFrames(videoFile: string, itemId: string, n: number, durationHint?: number | null): Promise<string[]> {
  const ff = ffmpegPath();
  if (!ff) return [];
  const dur = durationHint || (await probeDuration(videoFile)) || 10;
  const dir = itemDir(itemId);
  const rels: string[] = [];
  const count = Math.max(1, Math.min(8, n));
  for (let i = 0; i < count; i++) {
    const frac = count === 1 ? 0.35 : 0.12 + (0.78 * i) / (count - 1);
    const ts = Math.max(0, Math.min(dur - 0.2, dur * frac));
    const out = path.join(dir, `frame_${i + 1}.jpg`);
    try {
      await execFileP(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', ts.toFixed(2), '-i', videoFile, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out], { windowsHide: true, timeout: 60_000 });
      if (fs.existsSync(out) && fs.statSync(out).size > 0) rels.push(`${safeName(itemId)}/frame_${i + 1}.jpg`);
    } catch {
      /* skip frame */
    }
  }
  return rels;
}

/** Extract mono 16k mp3 audio for cheap/fast transcription. Returns null if no audio stream. */
export async function extractAudio(videoFile: string, outFile: string): Promise<boolean> {
  const ff = ffmpegPath();
  if (!ff) return false;
  try {
    await execFileP(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoFile, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '40k', outFile], { windowsHide: true, timeout: 180_000 });
    return fs.existsSync(outFile) && fs.statSync(outFile).size > 1000;
  } catch {
    return false;
  }
}

export function mediaAbs(rel: string): string {
  return path.join(config.mediaDir, rel);
}

export async function removeItemMedia(itemId: string) {
  const name = safeName(itemId);
  if (!name) return; // never resolve to the media root itself
  const target = path.resolve(config.mediaDir, name);
  if (!target.startsWith(path.resolve(config.mediaDir) + path.sep)) return;
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {}
}
