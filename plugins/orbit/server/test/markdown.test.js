import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml } from '../src/markdown.js';

// Orbit's work-item / comment allowlist (RICH_TEXT_EDITOR_V1, common/constants/rich-text-editor-config.js).
const ALLOWED = new Set(['p', 'br', 'h1', 'h2', 'h3', 'blockquote', 'pre', 'code', 'hr', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'colgroup', 'col', 'strong', 'em', 'u', 's', 'a', 'span', 'mark', 'img', 'div']);
const tags = (html) => [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase());

test('headings, lists, code and links come out as Orbit-safe HTML', () => {
  const html = markdownToHtml('## Plan\n\n- Button\n- Endpoint\n\n```js\nconst ok = 1 < 2;\n```\n\nSee [the PR](https://bitbucket.org/x/pr/1).');
  assert.equal(html, '<h2>Plan</h2>\n<ul>\n<li>Button</li>\n<li>Endpoint</li>\n</ul>\n<pre><code class="language-js">const ok = 1 &lt; 2;\n</code></pre>\n'
    + '<p>See <a href="https://bitbucket.org/x/pr/1">the PR</a>.</p>');
});

test('what Orbit would drop or refuse is kept visible instead', () => {
  const html = markdownToHtml('#### Deep\nUpdated the <Header> component ~~twice~~\n\n![screenshot](https://x.test/a.png)\n\n- [x] done\n- [ ] todo\n\n<div>raw</div>');
  assert.match(html, /<h3>Deep<\/h3>/, 'h4 → h3');
  assert.match(html, /the &lt;Header&gt; component <s>twice<\/s>/, 'raw HTML shown as text; ~~ → <s>');
  assert.match(html, /<a href="https:\/\/x\.test\/a\.png">screenshot<\/a>/, 'an image becomes a link');
  assert.match(html, /<li>\[x\] done<\/li>\n<li>\[ \] todo<\/li>/);
  assert.match(html, /<p>&lt;div&gt;raw&lt;\/div&gt;<\/p>/);
  for (const tag of tags(html)) assert.ok(ALLOWED.has(tag), `<${tag}> isn't in Orbit's allowlist`);
});

test('single newlines are line breaks (as in a GitHub comment); empty input is empty', () => {
  assert.equal(markdownToHtml('Changed export.\nFiles: a.js'), '<p>Changed export.<br>Files: a.js</p>');
  assert.equal(markdownToHtml('   '), '');
});
