#!/usr/bin/env node
/**
 * Build the landing "product tour" video from a manifest of clips using ffmpeg-static.
 *
 *   node scripts/make-tour.mjs <manifest.json> <outBase>
 *
 * manifest.json: { "width": 1280, "height": 800, "fps": 30, "clips": [
 *   { "type": "image", "src": "shots/library.jpg", "duration": 4, "zoom": "in" | "out" | "pan-right" | "none" },
 *   { "type": "video", "src": "clips/ask.mp4", "duration": 8 },            // trimmed to duration (or full if shorter)
 *   { "type": "gif",   "src": "clips/graph.gif", "duration": 4 }
 * ], "xfade": 0.5 }
 *
 * Output: <outBase>.mp4 (h264, yuv420p, faststart) and <outBase>.webm (vp9), plus <outBase>-poster.jpg from the 2nd clip.
 * Every clip is normalized to WxH (cover-crop), fps, and silent; then chained with xfade transitions.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ffmpeg = require('ffmpeg-static');
const [manifestPath, outBase] = process.argv.slice(2);
if (!manifestPath || !outBase) { console.error('usage: node scripts/make-tour.mjs <manifest.json> <outBase>'); process.exit(1); }
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const W = m.width || 1280, H = m.height || 800, FPS = m.fps || 30, XF = m.xfade ?? 0.5;
const base = path.dirname(path.resolve(manifestPath));
const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'tour-'));
const run = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

const norm = [];
m.clips.forEach((c, i) => {
  const src = path.resolve(base, c.src);
  const out = path.join(tmp, `clip${String(i).padStart(2, '0')}.mp4`);
  const d = Number(c.duration || 4);
  const frames = Math.round(d * FPS);
  if (c.type === 'image') {
    // Ken Burns: scale up 1.6x for headroom, then zoompan.
    const zoom = c.zoom || 'in';
    let zp;
    if (zoom === 'in') zp = `zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    else if (zoom === 'out') zp = `zoompan=z='if(eq(on,1),1.12,max(zoom-0.0009,1.0))':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    else if (zoom === 'pan-right') zp = `zoompan=z='1.08':x='min(x+1.2,iw-iw/zoom)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    else zp = `zoompan=z='1.0':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    run(['-loop', '1', '-i', src, '-vf', `scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},${zp},format=yuv420p`, '-t', String(d), '-r', String(FPS), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out]);
  } else {
    // video/gif: cover-crop to WxH, fps, trim
    run(['-i', src, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p`, '-t', String(d), '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', out]);
  }
  norm.push({ file: out, d });
});

// Chain with xfade
if (norm.length === 1) {
  fs.copyFileSync(norm[0].file, `${outBase}.mp4`);
} else {
  const inputs = norm.flatMap((n) => ['-i', n.file]);
  let filter = '';
  let last = '[0:v]';
  let offset = 0;
  for (let i = 1; i < norm.length; i++) {
    offset += norm[i - 1].d - XF;
    const outLabel = i === norm.length - 1 ? '[v]' : `[x${i}]`;
    filter += `${last}[${i}:v]xfade=transition=fade:duration=${XF}:offset=${offset.toFixed(3)}${outLabel};`;
    last = outLabel;
  }
  filter = filter.replace(/;$/, '');
  run([...inputs, '-filter_complex', filter, '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', `${outBase}.mp4`]);
}
// webm (vp9) — smaller, for browsers that prefer it
run(['-i', `${outBase}.mp4`, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1', '-an', `${outBase}.webm`]);
// poster from ~1s in
run(['-ss', '1', '-i', `${outBase}.mp4`, '-frames:v', '1', '-q:v', '3', `${outBase}-poster.jpg`]);
const size = (f) => (fs.statSync(f).size / 1024 / 1024).toFixed(2) + ' MB';
console.log(`done: ${outBase}.mp4 (${size(`${outBase}.mp4`)}), ${outBase}.webm (${size(`${outBase}.webm`)}), poster`);
