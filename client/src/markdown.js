// Minimal, XSS-safe Markdown renderer for MessHall post bodies.
//
// Security model: raw HTML is escaped FIRST, so injected tags can never
// execute. Only the syntax below is then converted to elements.
//
// Supports: fenced code blocks, `inline code`, **bold**, *italic*,
// ~strikethrough~, [text](https://url), bare https:// URLs, #/##/###
// headings, > blockquotes, - unordered lists, 1. ordered lists.

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(src, stash) {
  let s = src;

  // Inline code spans -> placeholders (protect contents from other transforms).
  s = s.replace(/`([^`\n]+)`/g, (_, code) => {
    const i = stash.push(`<code>${code}</code>`) - 1;
    return `\u0000${i}\u0000`;
  });

  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~([^~\n]+)~/g, '<del>$1</del>');

  // [text](https://url) — http(s) only, no javascript: URLs.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Bare URLs (not already inside an href="...").
  s = s.replace(
    /(?<!["'=])(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // Restore inline code placeholders.
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  return s;
}

export function renderMarkdown(src) {
  if (!src) return '';

  // Fenced code blocks -> placeholders (protect contents from everything).
  const stash = [];
  let text = esc(src).replace(/```[\w-]*\n([\s\S]*?)(?:```|$)/g, (_, code) => {
    // Strip one trailing newline so the block doesn't end with a blank line.
    const clean = code.replace(/\n$/, '');
    const i = stash.push(`<pre><code>${clean}</code></pre>`) - 1;
    return `\u0001${i}\u0001`;
  });

  const lines = text.split('\n');
  const out = [];
  let list = null; // { tag: 'ul'|'ol', items: [] }
  let quote = [];

  const flushList = () => {
    if (list) {
      out.push(
        `<${list.tag}>${list.items.map((it) => `<li>${inline(it, stash)}</li>`).join('')}</${list.tag}>`
      );
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.map((q) => inline(q, stash)).join('<br>')}</blockquote>`);
      quote = [];
    }
  };
  const flushPara = (para) => {
    if (para.length) out.push(`<p>${para.map((l) => inline(l, stash)).join('<br>')}</p>`);
  };

  let para = [];
  for (const line of lines) {
    const t = line.trim();

    // Fenced-block placeholder on its own line -> restore as a block.
    const blockPh = /^\u0001(\d+)\u0001$/.exec(t);
    if (blockPh) {
      flushPara(para); para = [];
      flushList(); flushQuote();
      out.push(stash[Number(blockPh[1])]);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(t);
    if (heading) {
      flushPara(para); para = [];
      flushList(); flushQuote();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2], stash)}</h${level}>`);
      continue;
    }

    const qm = /^&gt;\s?(.*)$/.exec(t);
    if (qm) {
      flushPara(para); para = [];
      flushList();
      quote.push(qm[1]);
      continue;
    }

    const ulm = /^[-*]\s+(.*)$/.exec(t);
    const olm = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ulm || olm) {
      flushPara(para); para = [];
      flushQuote();
      const tag = ulm ? 'ul' : 'ol';
      const item = (ulm || olm)[1];
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(item);
      continue;
    }

    if (t === '') {
      flushPara(para); para = [];
      flushList(); flushQuote();
      continue;
    }

    flushList(); flushQuote();
    para.push(line);
  }
  flushPara(para);
  flushList();
  flushQuote();

  return out.join('\n').replace(/\u0001(\d+)\u0001/g, (_, i) => stash[Number(i)]);
}
