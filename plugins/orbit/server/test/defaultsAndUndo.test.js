// Per-repo labels and priority (.orbit.json defaults.<item type>.labels / .priority) reach Orbit by
// name on both create tools, checked per item type before anything is sent; and /orbit:undo's tool
// path: the newest job is picked, finished or not, and cancelling it follows the completion rules.
// The fake's task labels are backend and frontend; its only story label is customer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHarness } from './helpers.js';

test('labels and priority: names resolve per item type, on a single create and on every step', async () => {
  const h = await toolHarness();
  const task = await h.run('orbit_create_work_item', { project: h.project, title: 'Add CSV export', labels: ['Backend'], priority: 'High' });
  assert.match(task.text, /^Created WEB-8 \[task\] "Add CSV export", assigned to you, labels Backend, priority High: https:/);
  const [{ body }] = h.calls('/work-items/create');
  assert.deepEqual(body.label_ids, ['L1']);
  assert.equal(body.priority_id, 20);

  await h.run('orbit_create_work_item', { project: h.project, title: 'Exports for customers', item_type: 'story', labels: ['customer'] });
  assert.deepEqual(h.calls('/work-items/create')[1].body.label_ids, ['L9']);

  const steps = await h.run('orbit_create_work_items', {
    project: h.project, parent: 'WEB-8', steps: [{ title: 'Build CSV' }, { title: 'Wire endpoint' }], labels: ['backend', 'frontend'], priority: 'high',
  });
  assert.match(steps.text, /^Created 2 of 2 steps as subtasks of WEB-8 "Add CSV export", assigned to you, labels backend, frontend, priority high:\n/);
  const [bulk] = h.calls('/work-items/bulk-create');
  assert.ok(bulk.body.items.every((it) => it.label_ids.join() === 'L1,L2' && it.priority_id === 20));
  assert.deepEqual(h.fake.find('WEB-10').label_ids, ['L1', 'L2']);
});

test('labels and priority: an unknown label, one of another item type, or an unknown priority sends nothing', async () => {
  const h = await toolHarness();
  const otherType = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', labels: ['customer'] });
  assert.equal(otherType.isError, true);
  assert.equal(otherType.text, 'Nothing was sent: Web App has no task label "customer". task labels: backend, frontend.');
  const unknown = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: [{ title: 'Step' }], labels: ['backend', 'nope'] });
  assert.match(unknown.text, /^Nothing was sent: Web App has no task label "nope"\./);
  const priority = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: [{ title: 'Step' }], priority: 'Urgent' });
  assert.equal(priority.text, 'There is no priority called "Urgent"; use one of High, None.');
  assert.equal(h.calls('/work-items/create').length + h.calls('/work-items/bulk-create').length, 0);
});

test('undo: the newest job is picked even when finished; cancelling it moves only what the rules allow', async () => {
  const h = await toolHarness();
  await h.run('orbit_create_work_item', { project: h.project, title: 'Add XLSX export' }); // WEB-8
  await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-8', steps: [{ title: 'Build XLSX' }, { title: 'Wire it' }] });
  await h.run('orbit_set_status', { project: h.project, items: ['WEB-9', 'WEB-10', 'WEB-8'], status: 'completed' });
  h.fake.find('WEB-10').task_points = 2; // points given after it was closed

  const newest = await h.run('orbit_list_jobs', { project: h.project, state: 'all', limit: 1 });
  assert.match(newest.text, /^1 of 2 Claude jobs in Web App, newest first:\n- WEB-8 "Add XLSX export" \[task, Done\] — 2 of 2 steps done/);

  const res = await h.run('orbit_set_status', { project: h.project, items: ['WEB-9', 'WEB-10', 'WEB-8'], status: 'cancelled', review_state: 'In Review' });
  assert.match(res.text, /^"cancelled" means "Cancelled" for a task\.\nWEB-9 → "Cancelled"\nWEB-10 — handed to a person: it carries points \(task points 2\); left in "Done"; comment added\. https:.*\nWEB-8 → "Cancelled"$/);
  assert.equal(h.fake.find('WEB-10').state_id, 'S_DONE');
});
