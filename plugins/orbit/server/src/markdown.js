// Claude writes Markdown; Orbit stores HTML. Orbit's own sanitizer stays the authority — this only
// keeps the output inside what that sanitizer allows (RICH_TEXT_EDITOR_V1), so nothing silently
// disappears or gets the whole request refused:
//   - raw HTML is shown as text: otherwise "the <Header> component" loses "<Header>";
//   - h4–h6 become h3 (Orbit allows h1–h3), and ~~x~~ becomes <s> (Orbit drops <del>);
//   - images become links: Orbit refuses any <img> that isn't one of its own uploads (400);
//   - task-list boxes become "[ ]" / "[x]" text (Orbit drops <input>).

import { Marked } from 'marked';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

const marked = new Marked({
  gfm: true,
  breaks: true, // a single newline is a line break, as in a GitHub comment
  renderer: {
    html({ text, block }) {
      const shown = escapeHtml(block ? text.trim() : text);
      return block ? `<p>${shown.replace(/\n/g, '<br>')}</p>\n` : shown;
    },
    heading({ tokens, depth }) {
      const level = Math.min(depth, 3);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    del({ tokens }) {
      return `<s>${this.parser.parseInline(tokens)}</s>`;
    },
    image({ href, text }) {
      return `<a href="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
    },
    checkbox({ checked }) {
      return checked ? '[x] ' : '[ ] ';
    },
  },
});

/** Markdown → HTML for a description or comment; '' for empty input. */
export function markdownToHtml(markdown) {
  const text = String(markdown ?? '').trim();
  return text ? marked.parse(text).trim() : '';
}
