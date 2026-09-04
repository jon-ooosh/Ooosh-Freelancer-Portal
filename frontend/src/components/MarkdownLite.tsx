import React from 'react';

/**
 * Minimal, safe markdown renderer for staff-document bodies.
 *
 * Supports: # / ## / ### headings, **bold**, numbered + bullet lists,
 * [text](url) + bare URLs, blank-line paragraphs. Renders React nodes (never
 * dangerouslySetInnerHTML), so document text can't inject markup. Anything
 * richer than this should be authored elsewhere and uploaded as a PDF.
 */

const URL_RE = /(https?:\/\/[^\s)]+)/g;

// Inline: links + bare URLs within a plain-text run.
function inlineLinks(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // [label](url) first
  const mdLink = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = mdLink.exec(text)) !== null) {
    if (m.index > last) nodes.push(...bareUrls(text.slice(last, m.index), `${keyBase}-t${i}`));
    nodes.push(
      <a key={`${keyBase}-l${i}`} href={m[2]} target="_blank" rel="noopener noreferrer"
         className="text-purple-700 underline break-words">{m[1]}</a>
    );
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) nodes.push(...bareUrls(text.slice(last), `${keyBase}-t${i}`));
  return nodes;
}

function bareUrls(text: string, keyBase: string): React.ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((p, idx) =>
    URL_RE.test(p)
      ? <a key={`${keyBase}-u${idx}`} href={p} target="_blank" rel="noopener noreferrer"
           className="text-purple-700 underline break-words">{p}</a>
      : <React.Fragment key={`${keyBase}-s${idx}`}>{p}</React.Fragment>
  );
}

// Inline with **bold** on top of links.
function inline(text: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((part, idx) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      nodes.push(<strong key={`${keyBase}-b${idx}`} className="font-semibold text-gray-900">{inlineLinks(part.slice(2, -2), `${keyBase}-b${idx}`)}</strong>);
    } else if (part) {
      nodes.push(...inlineLinks(part, `${keyBase}-p${idx}`));
    }
  });
  return nodes;
}

export function MarkdownLite({ text, className = '' }: { text: string; className?: string }) {
  const lines = (text || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let ol: string[] = [];
  let ul: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (!para.length) return;
    blocks.push(<p key={`p${key++}`} className="text-gray-700 leading-relaxed mb-3">{inline(para.join(' '), `p${key}`)}</p>);
    para = [];
  };
  const flushOl = () => {
    if (!ol.length) return;
    blocks.push(
      <ol key={`ol${key++}`} className="list-decimal ml-6 mb-3 space-y-1 text-gray-700 leading-relaxed">
        {ol.map((it, i) => <li key={i}>{inline(it, `ol${key}-${i}`)}</li>)}
      </ol>
    );
    ol = [];
  };
  const flushUl = () => {
    if (!ul.length) return;
    blocks.push(
      <ul key={`ul${key++}`} className="list-disc ml-6 mb-3 space-y-1 text-gray-700 leading-relaxed">
        {ul.map((it, i) => <li key={i}>{inline(it, `ul${key}-${i}`)}</li>)}
      </ul>
    );
    ul = [];
  };
  const flushAll = () => { flushPara(); flushOl(); flushUl(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushAll(); continue; }

    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushAll();
      const level = h[1].length;
      const cls = level === 1 ? 'text-lg font-bold text-gray-900 mb-2'
        : level === 2 ? 'text-base font-semibold text-gray-900 mb-2'
        : 'text-sm font-semibold text-gray-900 mb-1';
      blocks.push(<div key={`h${key++}`} className={cls}>{inline(h[2], `h${key}`)}</div>);
      continue;
    }
    const olm = /^(\d+)\.\s+(.*)$/.exec(line);
    if (olm) { flushPara(); flushUl(); ol.push(olm[2]); continue; }
    const ulm = /^[-*]\s+(.*)$/.exec(line);
    if (ulm) { flushPara(); flushOl(); ul.push(ulm[1]); continue; }

    flushOl(); flushUl();
    para.push(line.trim());
  }
  flushAll();

  return <div className={className}>{blocks}</div>;
}

export default MarkdownLite;
