/* Tiny markdown → React renderer for the legal pages (docs/*.md imported with `?raw`).
   Supports exactly what those documents use: # / ## / ### headings, paragraphs, `-` and `1.` lists,
   `---` rules, **bold**, *italic*, `code`, [links](url) and bare https:// URLs. No dependency. */
import { Fragment, type ReactNode } from 'react';

type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'hr' };

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', text: para.join(' ') }); para = []; } };
  const flushList = () => { if (list) { blocks.push({ t: list.kind, items: list.items }); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, text: h[2].trim() }); continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); flushList(); blocks.push({ t: 'hr' }); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    const oli = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (li || oli) {
      flushPara();
      const kind = li ? 'ul' : 'ol';
      if (!list || list.kind !== kind) { flushList(); list = { kind, items: [] }; }
      list.items.push((li ?? oli)![1]);
      continue;
    }
    // continuation of a list item (indented) or a paragraph line
    if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += ' ' + line.trim(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|https?:\/\/[^\s)<>]+[^\s)<>.,;:!?"'])/g;

export function renderInline(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0; let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{renderInline(tok.slice(2, -2))}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (tok.startsWith('*')) out.push(<em key={k++}>{renderInline(tok.slice(1, -1))}</em>);
    else if (tok.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(<a key={k++} href={mm[2]} target={mm[2].startsWith('http') ? '_blank' : undefined} rel="noreferrer">{renderInline(mm[1])}</a>);
    } else out.push(<a key={k++} href={tok} target="_blank" rel="noreferrer">{tok}</a>);
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 ? out[0] : <>{out.map((n, i) => <Fragment key={i}>{n}</Fragment>)}</>;
}

/** First `# heading` of a document (used for <title>), or null. */
export function markdownTitle(src: string): string | null {
  const m = /^#\s+(.+)$/m.exec(src);
  return m ? m[1].replace(/\*\*?|`/g, '').trim() : null;
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': { const Tag = (`h${b.level}`) as 'h1' | 'h2' | 'h3'; return <Tag key={i} id={slug(b.text)}>{renderInline(b.text)}</Tag>; }
          case 'p': return <p key={i}>{renderInline(b.text)}</p>;
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ul>;
          case 'ol': return <ol key={i}>{b.items.map((it, j) => <li key={j}>{renderInline(it)}</li>)}</ol>;
          case 'hr': return <hr key={i} />;
        }
      })}
    </div>
  );
}

function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
