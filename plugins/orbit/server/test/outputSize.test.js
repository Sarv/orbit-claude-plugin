// Tool output stays well under Claude Code's limits (a warning above 10k tokens, truncation at
// 25k) on a large project: 600 items with long titles, an item with a 50k description and 600
// subtasks, 80 long comments, 120 members and 150 labels (plan Phase 6, step 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHarness } from './helpers.js';
import { runTool, MAX_OUTPUT_CHARS } from '../src/tools/index.js';

const words = (n) => 'Wörter und दस्तावेज़ '.repeat(Math.ceil(n / 20)).slice(0, n);

async function bigProject() {
  const h = await toolHarness();
  const s = h.fake.state;
  s.items.find((i) => i.item_key === 'WEB-2').description = `<p>${words(50_000)}</p>`;
  for (let i = 0; i < 600; i += 1) {
    s.items.push({ id: `I_BIG${i}`, item_key: `WEB-${100 + i}`, item_type: 'task', title: words(200), state_id: 'S_PROG', state_group: 3,
      assignees_arr: [7], assignees_user_arr: ['U_ME'], parent_id: 'I_TASK', due_date: Date.UTC(2026, 10, 1), created_via: 'claude', created_by: { user_id: 'U_ME' } });
  }
  for (let i = 0; i < 80; i += 1) {
    s.comments.push({ id: `CB${i}`, item_id: 'I_TASK', author: { user_id: 'U_ANA' }, content: `<p>${words(3000)}</p>`, created_at: Date.UTC(2026, 9, 22, 0, i) });
  }
  return h;
}

test('every read tool stays under the output ceiling on a large project', async () => {
  const h = await bigProject();
  const runs = [
    ['orbit_search_work_items', { project: h.project, limit: 50 }],
    ['orbit_search_work_items', { project: h.project, parent: 'WEB-2', assignee: 'anyone', limit: 50 }],
    ['orbit_get_work_item', { project: h.project, item: 'WEB-2' }],
    ['orbit_list_comments', { project: h.project, item: 'WEB-2', limit: 50 }],
  ];
  for (const [name, args] of runs) {
    const res = await h.run(name, args);
    assert.equal(res.isError, false, `${name}: ${res.text.slice(0, 200)}`);
    assert.ok(res.text.length <= 16_000, `${name} returned ${res.text.length} characters`);
  }
});

test('comments: the newest that fit, oldest first, with a pointer to the rest', async () => {
  const h = await bigProject();
  const res = await h.run('orbit_list_comments', { project: h.project, item: 'WEB-2', limit: 50 });
  const shown = Number(res.text.match(/^(\d+) of \d+ comments/)[1]);
  assert.ok(shown >= 10 && shown < 50, `showed ${shown}`);
  assert.match(res.text, /Older comments didn't fit; read them in Orbit: https:\/\/app\.orbit\.test\/.*\/work-items\/WEB-2$/);
  const times = [...res.text.matchAll(/— Ana, (2026-10-22 \d\d:\d\d) UTC/g)].map((m) => m[1]);
  assert.equal(times.length, shown);
  assert.deepEqual(times, [...times].sort(), 'oldest first');
  assert.equal(times.at(-1), '2026-10-22 01:19', 'ends at the newest comment');
});

test('the runner cuts any oversized result at a line, and says so', async () => {
  const huge = { name: 'huge', handler: async () => Array.from({ length: 2000 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n') };
  const { content } = await runTool(huge, {}, {});
  const text = content[0].text;
  assert.ok(text.length <= MAX_OUTPUT_CHARS + 120);
  assert.match(text, /\nline \d+ x+\n…the rest was cut to keep this short\. Narrow the request/);
});
