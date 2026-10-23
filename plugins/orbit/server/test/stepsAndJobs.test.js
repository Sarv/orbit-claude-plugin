// A job has at most 5 steps from Claude under its parent (people's own items don't count), and
// orbit_list_jobs shows Claude's jobs with their progress, so an unfinished one is continued rather
// than duplicated. The fake's WEB-1 is a story a person made, holding WEB-2: a task Claude made
// for the user that is still in progress.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHarness } from './helpers.js';

const steps = (n, prefix = 'Step') => Array.from({ length: n }, (_, i) => ({ title: `${prefix} ${i + 1}` }));

test('steps: 5 fit; a 6th is refused before anything is sent, with what to do instead', async () => {
  const h = await toolHarness();
  const ok = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: steps(5) });
  assert.equal(ok.isError, false, ok.text);

  const h2 = await toolHarness();
  const six = await h2.run('orbit_create_work_items', { project: h2.project, parent: 'WEB-2', steps: steps(6) });
  assert.equal(six.isError, true);
  assert.equal(six.text, 'Nothing was sent: a job has at most 5 steps from Claude, and WEB-2 has none yet, so 5 more fit. '
    + "Merge these 6 into 5 or fewer, with the details in each step's description.");
  assert.equal(h2.calls('/work-items/bulk-create').length, 0);
});

test('steps: the ones Claude already made under the parent count; calling again cannot get past 5', async () => {
  const h = await toolHarness();
  await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: steps(3) });
  const more = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: steps(3, 'More') });
  assert.match(more.text, /^Nothing was sent: a job has at most 5 steps from Claude, and WEB-2 already has 3, so 2 more fit\. Merge these 3 into 2 or fewer/);
  await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: steps(2, 'Last') });
  const full = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: steps(1, 'Extra') });
  assert.match(full.text, /already has 5, so no more fit\. Fold the extra work into the existing steps/);
  assert.equal(h.calls('/work-items/bulk-create').length, 2);
});

test("steps: people's own items under the parent don't count", async () => {
  const h = await toolHarness();
  // WEB-1, a story a person made, already holds 12 tasks from the team.
  for (let i = 0; i < 12; i += 1) {
    h.fake.state.items.push({ id: `I_TEAM${i}`, item_key: `WEB-${100 + i}`, item_type: 'task', title: `Team task ${i}`, state_id: 'S_TODO', state_group: 2, story_id: 'I_STORY', assignees_user_arr: [], created_by: { user_id: 'U_ANA' } });
  }
  const res = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-1', steps: steps(4) });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /^Created 4 of 4 steps as tasks of WEB-1/);
});

test('jobs: a new parent and its steps form one job, with progress that follows the statuses', async () => {
  const h = await toolHarness();
  await h.run('orbit_create_work_item', { project: h.project, title: 'Add CSV export' }); // WEB-8
  await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-8', steps: steps(2) }); // WEB-9, WEB-10
  let res = await h.run('orbit_list_jobs', { project: h.project });
  assert.match(res.text, /^2 of 2 open Claude jobs in Web App, newest first:\n- WEB-8 "Add CSV export" \[task, Todo\] — 0 of 2 steps done · \d{4}-\d{2}-\d{2}\n {4}WEB-9 Todo — Step 1\n {4}WEB-10 Todo — Step 2\n/);
  // The older job: WEB-2 (Claude's, in progress) under WEB-1, a story the user named.
  assert.match(res.text, /\n- WEB-1 "Reports" \[story, Ready\] — 0 of 1 steps done \(an item the user named\) · [^\n]*\n {4}WEB-2 In Progress — Add CSV export\n/);

  await h.run('orbit_set_status', { project: h.project, items: ['WEB-9'], status: 'completed' });
  res = await h.run('orbit_list_jobs', { project: h.project });
  assert.match(res.text, /WEB-8 "Add CSV export" \[task, Todo\] — 1 of 2 steps done/);

  await h.run('orbit_set_status', { project: h.project, items: ['WEB-10', 'WEB-8'], status: 'completed' });
  res = await h.run('orbit_list_jobs', { project: h.project });
  assert.doesNotMatch(res.text, /WEB-8/, 'a finished job is no longer open');
  assert.match((await h.run('orbit_list_jobs', { project: h.project, state: 'all' })).text, /WEB-8 "Add CSV export" \[task, Done\] — 2 of 2 steps done/);
});

test('jobs: a Claude item with no parent and no steps is a job on its own; only my Claude items are read', async () => {
  const h = await toolHarness();
  await h.run('orbit_create_work_item', { project: h.project, title: 'Fix the login redirect' });
  const res = await h.run('orbit_list_jobs', { project: h.project });
  assert.match(res.text, /- WEB-8 "Fix the login redirect" \[task, Todo\] — no steps \(tracked on the item itself\)/);
  const [list] = h.calls('/work-items/list');
  assert.equal(list.body.created_via, 'claude');
  assert.deepEqual(list.body.author_ids, ['U_ME']);
  assert.equal(list.body.sort_by, 'created_at');
});

test('jobs: none open says so', async () => {
  const h = await toolHarness();
  h.fake.state.items = h.fake.state.items.filter((i) => i.created_via !== 'claude');
  assert.equal((await h.run('orbit_list_jobs', { project: h.project })).text, 'No open Claude jobs in Web App.');
});

test('search: created_by_claude asks Orbit for items created via Claude only', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_search_work_items', { project: h.project, created_by_claude: true });
  assert.equal(h.calls('/work-items/list')[0].body.created_via, 'claude');
  assert.match(res.text, /open items created via Claude assigned to you in Web App/);
  assert.match(res.text, /WEB-2 \[task\]/);
});
