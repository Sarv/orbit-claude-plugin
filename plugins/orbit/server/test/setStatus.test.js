// orbit_set_status against the in-memory fake Orbit: state resolution per type (2.1), the completion
// policy on a fresh read and its fallback table (2.3), and the retry rule for status moves (2.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHarness } from './helpers.js';

const REVIEW = 'In Review';

async function withClaudeTask(title = 'Claude task') {
  const h = await toolHarness();
  await h.run('orbit_create_work_item', { project: h.project, title });
  return { h, key: h.fake.state.items.at(-1).item_key };
}
const status = (h, items, s, extra = {}) => h.run('orbit_set_status', { project: h.project, items, status: s, review_state: REVIEW, ...extra });
const stateOf = (h, key) => h.fake.find(key).state_id;
const commentsOn = (h, key) => h.fake.state.comments.filter((c) => c.item_id === h.fake.find(key).id);

test('started → the lowest-sequence started state, named in the result; completed closes a Claude item with no points', async () => {
  const { h, key } = await withClaudeTask();
  const started = await status(h, [key], 'started');
  assert.equal(started.text, `"started" means "In Progress" for a task.\n${key} → "In Progress"`);
  const done = await status(h, [key], 'completed');
  assert.equal(done.isError, false);
  assert.equal(done.text, `"completed" means "Done" for a task.\n${key} → "Done"`);
  assert.equal(stateOf(h, key), 'S_DONE');
  assert.deepEqual(h.calls('/work-items/bulk-update').map((c) => c.body.updates), [{ state_id: 'S_PROG' }, { state_id: 'S_DONE' }]);
  assert.equal(commentsOn(h, key).length, 0);
});

test('a repeat of the same status sends nothing', async () => {
  const { h, key } = await withClaudeTask();
  await status(h, [key], 'started');
  const again = await status(h, [key], 'In Progress');
  assert.match(again.text, new RegExp(`${key} already in "In Progress"`));
  assert.equal(h.calls('/work-items/bulk-update').length, 1);
});

test('points added during work: the close is refused, the item goes to review with a handoff comment', async () => {
  const { h, key } = await withClaudeTask();
  await status(h, [key], 'started');
  h.fake.find(key).task_points = 2; // a person adds points mid-job
  const res = await status(h, [key], 'completed');
  assert.equal(res.isError, false, 'a handoff is expected, not an error');
  assert.match(res.text, new RegExp(`${key} — handed to a person: it carries points \\(task points 2\\); moved to "In Review"; comment added\\. https://app\\.orbit\\.test/.*/work-items/${key}$`));
  assert.equal(stateOf(h, key), 'S_REV');
  const [comment] = commentsOn(h, key);
  assert.match(comment.content, /^<p>Ready for review — not closed by Claude: it carries points \(task points 2\)\. Moved to &quot;In Review&quot;; a person needs to close it\.<\/p>$/);
});

test('only assignee points set → refused too; already in review → comment only, no move', async () => {
  const { h, key } = await withClaudeTask();
  await status(h, [key], 'review');
  h.fake.find(key).assignee_points = [{ emp_id: 7, points: 1 }];
  const res = await status(h, [key], 'completed');
  assert.match(res.text, /handed to a person: it carries points \(points allocated to assignees\); left in "In Review"; comment added/);
  assert.equal(h.calls('/work-items/bulk-update').length, 1, 'only the first move to review');
});

test('an item not created through Claude (e.g. one the user named) is handed to a person, never closed', async () => {
  const h = await toolHarness();
  const res = await status(h, ['WEB-3'], 'completed');
  assert.match(res.text, /WEB-3 — handed to a person: it wasn't created through Claude; moved to "In Review"; comment added/);
  assert.equal(stateOf(h, 'WEB-3'), 'S_REV');
});

test('out of completed: refused → the state stays completed, no state change is sent, comment only', async () => {
  const h = await toolHarness();
  for (const s of ['started', 'cancelled']) {
    const res = await status(h, ['WEB-7'], s);
    assert.match(res.text, /WEB-7 — handed to a person: it wasn't created through Claude; left in "Done"; comment added/);
  }
  assert.equal(stateOf(h, 'WEB-7'), 'S_DONE');
  assert.equal(h.calls('/work-items/bulk-update').length, 0);
  assert.match(commentsOn(h, 'WEB-7')[0].content, /^<p>Not reopened by Claude/);
  assert.match(commentsOn(h, 'WEB-7')[1].content, /^<p>Not cancelled by Claude/);

  // A Claude item that picked up points after it was closed can't be reopened either.
  const { h: h2, key } = await withClaudeTask();
  await status(h2, [key], 'completed');
  h2.fake.find(key).task_points = 3;
  const reopen = await status(h2, [key], 'started');
  assert.match(reopen.text, /handed to a person: it carries points \(task points 3\); left in "Done"/);
  assert.equal(stateOf(h2, key), 'S_DONE');
  assert.equal(h2.calls('/work-items/bulk-update').length, 1);
});

test('no review state, or one outside started → state unchanged, comment says why', async () => {
  for (const reviewState of [undefined, 'Done']) {
    const { h, key } = await withClaudeTask();
    h.fake.find(key).task_points = 1;
    const res = await status(h, [key], 'completed', { review_state: reviewState });
    assert.match(res.text, /left in "Todo" \((no review state is set in \.orbit\.json|"Done" is in the completed group, not started)\); comment added/);
    assert.equal(stateOf(h, key), 'S_TODO');
    assert.equal(h.calls('/work-items/bulk-update').length, 0);
  }
});

test('cancel: allowed for a Claude item even with points; refused for anyone else\'s', async () => {
  const { h, key } = await withClaudeTask();
  h.fake.find(key).task_points = 2;
  assert.match((await status(h, [key], 'cancelled')).text, new RegExp(`${key} → "Cancelled"`));
  const other = await status(h, ['WEB-3'], 'cancelled');
  assert.match(other.text, /WEB-3 — handed to a person: it wasn't created through Claude; left in "Todo"/);
  assert.match(commentsOn(h, 'WEB-3')[0].content, /^<p>Not cancelled by Claude/);
});

test('mixed item types: the state is resolved per type, one bulk update per type', async () => {
  const h = await toolHarness();
  await h.run('orbit_create_work_item', { project: h.project, title: 'Claude story', item_type: 'story' });
  await h.run('orbit_create_work_item', { project: h.project, title: 'Claude task' });
  const [story, task] = h.fake.state.items.slice(-2).map((i) => i.item_key);
  const res = await status(h, [story, task], 'completed');
  assert.equal(res.text, `"completed" means "Done" for a story, "Done" for a task.\n${story} → "Done"\n${task} → "Done"`);
  assert.deepEqual(h.calls('/work-items/bulk-update').map((c) => c.body.updates.state_id).sort(), ['S_DONE', 'S_STORY_DONE']);

  // A type without the named state fails just that item.
  const review = await status(h, ['WEB-1', 'WEB-3'], 'review');
  assert.match(review.text, /WEB-1 ✗ not moved: for a story, there is no "In Review" state for this item type\nWEB-3 → "In Review"/);
});

test('unknown names, missing items and a move Orbit refuses are reported per item', async () => {
  const h = await toolHarness();
  const res = await status(h, ['WEB-3', 'WEB-404'], 'Shipped');
  assert.equal(res.isError, true);
  assert.match(res.text, /^Nothing could be moved to "Shipped"\.\nWEB-3 ✗ not moved: for a task, there is no state called "Shipped"; use one of Todo, In Progress, In Review, Done, Cancelled/);
  assert.match(res.text, /WEB-404 ✗ There is no work item WEB-404 in Web App/);

  h.faults.push({ path: '/work-items/bulk-update', mode: 'respond', status: 200, body: { success: true, data: { results: [{ itemId: 'I_SUB', success: false, error: 'Blocked by WEB-9' }] } } });
  assert.match((await status(h, ['WEB-3'], 'started')).text, /WEB-3 ✗ not moved: Blocked by WEB-9/);
});

test('an unknown outcome is retried once from a fresh read; twice unknown is reported', async () => {
  const { h, key } = await withClaudeTask();
  // The move landed but the answer was lost: the fresh read shows it done, so nothing is resent.
  h.faults.push({ path: '/work-items/bulk-update', mode: 'drop' });
  assert.match((await status(h, [key], 'completed')).text, new RegExp(`${key} → "Done"`));
  assert.equal(h.sent('/work-items/bulk-update'), 1);

  // The move never reached Orbit: the retry sends it.
  h.faults.push({ path: '/work-items/bulk-update', mode: 'timeout' });
  assert.match((await status(h, [key], 'cancelled')).text, new RegExp(`${key} → "Cancelled"`));
  assert.equal(h.sent('/work-items/bulk-update'), 3);

  h.faults.push({ path: '/work-items/bulk-update', mode: 'timeout' }, { path: '/work-items/bulk-update', mode: 'timeout' });
  const twice = await status(h, [key], 'started');
  assert.equal(twice.isError, true);
  assert.match(twice.text, new RegExp(`${key} \\? Orbit didn't answer twice, so it may or may not be in "In Progress" now`));
  assert.equal(h.sent('/work-items/bulk-update'), 5);
});

test('the retry re-runs the completion policy on the item as it is now', async () => {
  const { h, key } = await withClaudeTask();
  // The first try never arrives; meanwhile a person adds points.
  h.faults.push({ path: '/work-items/bulk-update', mode: 'timeout' });
  const original = h.orbit.client.call;
  h.orbit.client.call = async (path, body, opts) => {
    if (path === '/work-items/bulk-update' && !h.fake.find(key).task_points) h.fake.find(key).task_points = 5;
    return original(path, body, opts);
  };
  const res = await status(h, [key], 'completed');
  assert.match(res.text, /handed to a person: it carries points \(task points 5\); moved to "In Review"/);
  assert.equal(stateOf(h, key), 'S_REV');
});
