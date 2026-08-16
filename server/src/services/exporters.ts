import AdmZip from 'adm-zip';
import { j } from '../db.js';
import type { Analysis, ItemRow } from '../types.js';

export interface ExportItem {
  id: string;
  url: string;
  shortcode: string | null;
  media_type: string;
  product_type: string | null;
  author_username: string | null;
  author_name: string | null;
  caption: string | null;
  transcript: string | null;
  taken_at: string | null;
  saved_at: string | null;
  like_count: number | null;
  play_count: number | null;
  comment_count: number | null;
  duration: number | null;
  music: string | null;
  location: string | null;
  collections: string[];
  favorite: boolean;
  user_notes: string | null;
  user_tags: string[];
  analysis: Analysis | null;
  analysis_status: string;
  thumb_url: string | null;
}

const iso = (t: number | null) => (t ? new Date(t * 1000).toISOString() : null);

export function toExportItem(r: ItemRow, publicBase = ''): ExportItem {
  return {
    id: r.id,
    url: r.url,
    shortcode: r.shortcode,
    media_type: r.media_type,
    product_type: r.product_type,
    author_username: r.author_username,
    author_name: r.author_name,
    caption: r.caption,
    transcript: r.transcript,
    taken_at: iso(r.taken_at),
    saved_at: iso(r.saved_at),
    like_count: r.like_count,
    play_count: r.play_count,
    comment_count: r.comment_count,
    duration: r.duration,
    music: r.music_title ? `${r.music_title}${r.music_artist ? ` — ${r.music_artist}` : ''}` : null,
    location: r.location,
    collections: j<string[]>(r.collections, []),
    favorite: !!r.favorite,
    user_notes: r.user_notes,
    user_tags: j<string[]>(r.user_tags, []),
    analysis: j<Analysis | null>(r.analysis, null),
    analysis_status: r.analysis_status,
    thumb_url: r.thumb_path ? `${publicBase}/media/${r.thumb_path}` : null,
  };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = Array.isArray(v) ? v.join('; ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  // Spreadsheet formula injection guard (OWASP): captions/AI text starting with = + - @ or tab/CR must not be evaluated by Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(items: ExportItem[]): string {
  const cols = [
    'id', 'url', 'title', 'one_liner', 'summary', 'category', 'subcategory', 'tags', 'content_type', 'action_type', 'key_points', 'actionable_takeaways',
    'why_saved_guess', 'usefulness_score', 'is_evergreen', 'vibe', 'language', 'hook_text', 'hook_style', 'format_notes', 'on_screen_text', 'quotes',
    'people', 'brands', 'tools', 'places', 'books_media', 'products', 'resurface_prompt', 'remix_idea', 'confidence',
    'author_username', 'author_name', 'media_type', 'product_type', 'taken_at', 'saved_at', 'like_count', 'play_count', 'comment_count', 'duration',
    'music', 'location', 'collections', 'favorite', 'user_tags', 'user_notes', 'caption', 'transcript', 'analysis_status',
  ];
  const lines = [cols.join(',')];
  for (const it of items) {
    const a = it.analysis;
    const row = [
      it.id, it.url, a?.title, a?.one_liner, a?.summary, a?.category, a?.subcategory, a?.tags, a?.content_type, a?.action_type, a?.key_points, a?.actionable_takeaways,
      a?.why_saved_guess, a?.usefulness_score, a?.is_evergreen, a?.vibe, a?.language, a?.hook?.text, a?.hook?.style, a?.format_notes, a?.on_screen_text, a?.quotes,
      a?.entities?.people, a?.entities?.brands, a?.entities?.tools, a?.entities?.places, a?.entities?.books_media, a?.entities?.products, a?.resurface_prompt, a?.remix_idea, a?.confidence,
      it.author_username, it.author_name, it.media_type, it.product_type, it.taken_at, it.saved_at, it.like_count, it.play_count, it.comment_count, it.duration,
      it.music, it.location, it.collections, it.favorite, it.user_tags, it.user_notes, it.caption, it.transcript, it.analysis_status,
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

const mdEscape = (s: string) => s.replace(/\r/g, '').trim();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'save';

export function itemToMarkdown(it: ExportItem, opts: { frontmatter?: boolean; wikilinks?: boolean } = {}): string {
  const a = it.analysis;
  const title = a?.title || (it.caption ? it.caption.split('\n')[0].slice(0, 70) : `Save ${it.id}`);
  const out: string[] = [];
  if (opts.frontmatter) {
    out.push('---');
    out.push(`title: ${JSON.stringify(title)}`);
    out.push(`source: ${it.url}`);
    if (it.author_username) out.push(`author: "@${it.author_username}"`);
    if (a) {
      out.push(`category: ${JSON.stringify(a.category)}`);
      out.push(`subcategory: ${JSON.stringify(a.subcategory)}`);
      out.push(`tags: [${[...a.tags, ...it.user_tags].map((t) => JSON.stringify(t)).join(', ')}]`);
      out.push(`content_type: ${a.content_type}`);
      out.push(`action: ${a.action_type}`);
      out.push(`usefulness: ${a.usefulness_score}`);
      out.push(`evergreen: ${a.is_evergreen}`);
      out.push(`language: ${a.language}`);
    }
    out.push(`media_type: ${it.media_type}`);
    if (it.saved_at) out.push(`saved_at: ${it.saved_at}`);
    if (it.taken_at) out.push(`posted_at: ${it.taken_at}`);
    if (it.collections.length) out.push(`collections: [${it.collections.map((c) => JSON.stringify(c)).join(', ')}]`);
    out.push(`favorite: ${it.favorite}`);
    out.push('---');
    out.push('');
  }
  out.push(`# ${title}`);
  out.push('');
  if (a?.one_liner) out.push(`> ${a.one_liner}`);
  out.push('');
  const meta: string[] = [];
  if (it.author_username) meta.push(`by [@${it.author_username}](https://www.instagram.com/${it.author_username}/)`);
  meta.push(`[open on Instagram](${it.url})`);
  if (a) meta.push(`${a.category}${a.subcategory ? ` · ${a.subcategory}` : ''}`);
  out.push(meta.join(' · '));
  out.push('');
  if (a) {
    if (a.summary) { out.push('## Summary'); out.push(mdEscape(a.summary)); out.push(''); }
    if (a.key_points.length) { out.push('## Key points'); for (const k of a.key_points) out.push(`- ${mdEscape(k)}`); out.push(''); }
    if (a.actionable_takeaways.length) { out.push('## Do this'); for (const k of a.actionable_takeaways) out.push(`- [ ] ${mdEscape(k)}`); out.push(''); }
    if (a.quotes.length) { out.push('## Quotes'); for (const q of a.quotes) out.push(`> ${mdEscape(q)}`); out.push(''); }
    if (a.hook?.text) { out.push('## Hook'); out.push(`${mdEscape(a.hook.text)} _(${a.hook.style})_`); out.push(''); }
    const ents = Object.entries(a.entities).filter(([, v]) => v.length);
    if (ents.length) { out.push('## Entities'); for (const [k, v] of ents) out.push(`- **${k.replace('_', ' ')}**: ${v.join(', ')}`); out.push(''); }
    if (a.on_screen_text) { out.push('## On-screen text'); out.push(mdEscape(a.on_screen_text)); out.push(''); }
    if (a.remix_idea) { out.push('## Remix idea'); out.push(mdEscape(a.remix_idea)); out.push(''); }
    out.push('## Why saved (guess)'); out.push(mdEscape(a.why_saved_guess)); out.push('');
    out.push(`Tags: ${a.tags.map((t) => (opts.wikilinks ? `[[${t}]]` : `#${t}`)).join(' ')}`);
    out.push('');
  }
  if (it.user_notes) { out.push('## My notes'); out.push(mdEscape(it.user_notes)); out.push(''); }
  if (it.caption) { out.push('## Original caption'); out.push(mdEscape(it.caption)); out.push(''); }
  if (it.transcript) { out.push('## Transcript'); out.push(mdEscape(it.transcript)); out.push(''); }
  return out.join('\n');
}

export function toMarkdownDigest(items: ExportItem[]): string {
  const byCat = new Map<string, ExportItem[]>();
  for (const it of items) {
    const c = it.analysis?.category || 'Unanalyzed';
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c)!.push(it);
  }
  const out: string[] = [`# Resurface export — ${items.length} saves`, '', `Exported ${new Date().toISOString().slice(0, 10)}.`, ''];
  for (const [cat, list] of Array.from(byCat.entries()).sort((a, b) => b[1].length - a[1].length)) {
    out.push(`## ${cat} (${list.length})`, '');
    for (const it of list) {
      const a = it.analysis;
      out.push(`### ${a?.title || it.id}`);
      if (a?.one_liner) out.push(`_${a.one_liner}_`);
      out.push(`${it.author_username ? `@${it.author_username} · ` : ''}[Instagram](${it.url})${a ? ` · ${a.tags.map((t) => `#${t}`).join(' ')}` : ''}`);
      if (a?.key_points.length) { out.push(''); for (const k of a.key_points) out.push(`- ${k}`); }
      out.push('');
    }
  }
  return out.join('\n');
}

/** Obsidian-ready vault zip: one note per save + index note + tag notes. Returns the zip as a Buffer. */
export function toObsidianZip(items: ExportItem[]): Buffer {
  const zip = new AdmZip();
  const archive = { append: (content: string, o: { name: string }) => zip.addFile(o.name, Buffer.from(content, 'utf8')) };
  const usedNames = new Set<string>();
  const index: string[] = ['# Resurface — Instagram Saves', '', `${items.length} saves. Open the graph view to explore tags ↔ saves.`, ''];
  const tagMap = new Map<string, string[]>();
  for (const it of items) {
    const a = it.analysis;
    let base = slug(a?.title || it.id);
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base}-${n++}`;
    usedNames.add(name);
    const md = itemToMarkdown(it, { frontmatter: true, wikilinks: true });
    archive.append(md, { name: `Saves/${name}.md` });
    index.push(`- [[Saves/${name}|${a?.title || it.id}]]${a ? ` — ${a.one_liner}` : ''}`);
    for (const t of a?.tags || []) { if (!tagMap.has(t)) tagMap.set(t, []); tagMap.get(t)!.push(name); }
  }
  for (const [t, names] of tagMap) {
    archive.append([`# ${t}`, '', ...names.map((n) => `- [[Saves/${n}]]`)].join('\n'), { name: `Tags/${t}.md` });
  }
  archive.append(index.join('\n'), { name: 'Resurface Index.md' });
  return zip.toBuffer();
}
