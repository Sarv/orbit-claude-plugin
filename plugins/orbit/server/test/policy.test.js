// The rules in policy.js, row by row (plan 2.1 states, 2.2 hierarchy, 2.3 completion policy).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetState, stepsUnder, parentField, completionCheck, isGuarded, handoff } from '../src/policy.js';

const TASK_STATES = [
  { id: 'TODO', name: 'Todo', group: 'unstarted', sequence: 1 },
  { id: 'REV', name: 'In Review', group: 'started', sequence: 2 },
  { id: 'PROG', name: 'In Progress', group: 'started', sequence: 1 },
  { id: 'DONE', name: 'Done', group: 'completed', sequence: 1 },
];
const name = (r) => r.state?.name ?? r.error;

test('states: a name, a single-state group, a multi-state group (lowest sequence), review', () => {
  assert.equal(name(resolveTargetState(TASK_STATES, 'in review', null)), 'In Review');
  assert.equal(name(resolveTargetState(TASK_STATES, 'completed', null)), 'Done');
  assert.equal(name(resolveTargetState(TASK_STATES, 'started', null)), 'In Progress');
  assert.equal(name(resolveTargetState(TASK_STATES, 'review', 'in review')), 'In Review');
  assert.match(name(resolveTargetState(TASK_STATES, 'Shipped', null)), /no state called "Shipped"; use one of Todo, In Review, In Progress, Done/);
  assert.match(name(resolveTargetState(TASK_STATES, 'cancelled', null)), /no state in the cancelled group/);
});

test('states: review without review_state, a missing one, and one outside started', () => {
  assert.match(resolveTargetState(TASK_STATES, 'review', null).error, /no review state is set/);
  assert.match(resolveTargetState(TASK_STATES, 'review', 'QA').error, /no "QA" state for this item type/);
  assert.match(resolveTargetState(TASK_STATES, 'review', 'Done').error, /"Done" is in the completed group, not started/);
});

test('hierarchy: where the steps of a job attach, every row of the table', () => {
  assert.deepEqual(stepsUnder({ item_type: 'epic' }), { itemType: 'task', field: 'epic_id', kind: 'tasks' });
  assert.deepEqual(stepsUnder({ item_type: 'feature' }), { itemType: 'task', field: 'feature_id', kind: 'tasks' });
  assert.deepEqual(stepsUnder({ item_type: 'story' }), { itemType: 'task', field: 'story_id', kind: 'tasks' });
  assert.deepEqual(stepsUnder({ item_type: 'task' }), { itemType: 'task', field: 'parent_id', kind: 'subtasks' });
  assert.equal(stepsUnder({ item_type: 'task', parent_id: 'X' }), null, 'a subtask gets no new items');
  assert.throws(() => stepsUnder({ item_type: 'milestone', item_key: 'M-1' }), { kind: 'invalid', message: /M-1 is a milestone.*Name a task, story, feature or epic/ });
});

test('hierarchy: which parent a new item may name (Orbit would silently drop the others)', () => {
  assert.equal(parentField('task', { item_type: 'story' }), 'story_id');
  assert.equal(parentField('task', { item_type: 'task' }), 'parent_id');
  assert.equal(parentField('story', { item_type: 'feature' }), 'feature_id');
  assert.equal(parentField('feature', { item_type: 'epic' }), 'epic_id');
  assert.throws(() => parentField('task', { item_type: 'task', parent_id: 'P', item_key: 'S-2' }), /S-2 is a subtask/);
  assert.throws(() => parentField('story', { item_type: 'story', item_key: 'S-1' }), /A story can go under an epic or a feature, not under S-1 \(a story\)/);
  assert.throws(() => parentField('task', { item_type: 'milestone', item_key: 'M-1' }), /an epic, a feature, a story or a top-level task/);
  assert.throws(() => parentField('epic', { item_type: 'epic', item_key: 'E-1' }), /An epic can't go under another item/);
});

const ME = { userId: 'U_ME' };
const mine = (extra = {}) => ({ created_via: 'claude', created_by: { user_id: 'U_ME' }, ...extra });
const closing = { from: 'started', to: 'completed' };

test('completion policy: each condition false in turn', () => {
  assert.deepEqual(completionCheck(mine(), ME, closing), { ok: true });
  assert.deepEqual(completionCheck(mine({ task_points: 0, story_points: 0, assignee_points: [] }), ME, closing), { ok: true });
  assert.match(completionCheck(mine({ created_via: undefined }), ME, closing).reason, /wasn't created through Claude/);
  assert.match(completionCheck(mine({ created_by: { user_id: 'U_ANA' } }), ME, closing).reason, /someone else created it/);
  assert.match(completionCheck(mine({ task_points: 2 }), ME, closing).reason, /carries points \(task points 2\)/);
  assert.match(completionCheck(mine({ story_points: 5 }), ME, closing).reason, /story points 5/);
  assert.match(completionCheck(mine({ assignee_points: [{ emp_id: 7, points: 1 }] }), ME, closing).reason, /points allocated to assignees/);
  // A non-admin viewer sees only their own allocation.
  assert.match(completionCheck(mine({ assignee_points: null, my_assignee_points: { points: 1 } }), ME, closing).reason, /allocated/);
  assert.match(completionCheck(mine({ points_access: { can_view_task_points: false } }), ME, closing).reason, /doesn't show Claude its points/);
});

test('completion policy: reopening needs no points too; a plain cancel needs only conditions 1 and 2', () => {
  assert.equal(completionCheck(mine({ task_points: 2 }), ME, { from: 'completed', to: 'started' }).ok, false);
  assert.equal(completionCheck(mine({ task_points: 2 }), ME, { from: 'started', to: 'cancelled' }).ok, true);
  assert.equal(completionCheck(mine({ task_points: 2 }), ME, { from: 'completed', to: 'cancelled' }).ok, false);
  assert.equal(completionCheck(mine({ created_via: undefined }), ME, { from: 'started', to: 'cancelled' }).ok, false);
  assert.equal(isGuarded('started', 'started'), false);
  assert.equal(isGuarded('unstarted', 'started'), false);
  assert.ok(isGuarded('started', 'completed') && isGuarded('completed', 'started') && isGuarded('started', 'cancelled'));
});

test('fallback: never moves into or out of completed; review only when valid and not already there', () => {
  const done = TASK_STATES[3];
  const prog = TASK_STATES[2];
  const rev = TASK_STATES[1];
  const out = handoff({ from: 'completed', to: 'started', current: done, reason: 'r', states: TASK_STATES, reviewState: 'In Review' });
  assert.equal(out.moveTo, null);
  assert.match(out.comment, /^Not reopened by Claude: r\. It stays in "Done"/);
  assert.equal(handoff({ from: 'completed', to: 'cancelled', current: done, reason: 'r', states: TASK_STATES }).moveTo, null);

  const toReview = handoff({ from: 'started', to: 'completed', current: prog, reason: 'r', states: TASK_STATES, reviewState: 'In Review' });
  assert.equal(toReview.moveTo, rev);
  assert.match(toReview.comment, /^Ready for review — not closed by Claude: r\. Moved to "In Review"/);

  const already = handoff({ from: 'started', to: 'completed', current: rev, reason: 'r', states: TASK_STATES, reviewState: 'In Review' });
  assert.equal(already.moveTo, null);

  const none = handoff({ from: 'started', to: 'completed', current: prog, reason: 'r', states: TASK_STATES, reviewState: null });
  assert.equal(none.moveTo, null);
  assert.match(none.comment, /Left in "In Progress" \(no review state is set in \.orbit\.json\)/);

  const outsideStarted = handoff({ from: 'started', to: 'completed', current: prog, reason: 'r', states: TASK_STATES, reviewState: 'Done' });
  assert.equal(outsideStarted.moveTo, null, 'a review state outside started counts as none');

  const cancel = handoff({ from: 'started', to: 'cancelled', current: prog, reason: 'r', states: TASK_STATES, reviewState: 'In Review' });
  assert.equal(cancel.moveTo, null);
  assert.match(cancel.comment, /^Not cancelled by Claude: r\./);
});
