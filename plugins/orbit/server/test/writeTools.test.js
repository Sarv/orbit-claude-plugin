// Create / update / comment tools against the in-memory fake Orbit (plan 2.2 hierarchy, 2.5 write
// contract, D3 assignees). `timeout` = the request never reached Orbit; `drop` = Orbit did the
// work but the answer was lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHarness } from './helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('create: Markdown → HTML, assigned to me by employee id, stamped with a request id', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_create_work_item', { project: h.project, title: 'Add CSV export', description: '## Why\n- reports' });
  assert.equal(res.isError, false);
  assert.match(res.text, /^Created WEB-8 \[task\] "Add CSV export", assigned to you: https:\/\/app\.orbit\.test\/u\/0\/org\/acme\/ws\/eng\/prj\/web\/work-items\/WEB-8$/);
  const [{ body }] = h.calls('/work-items/create');
  assert.deepEqual(body.assignees_arr, [7]);
  assert.equal(body.description, '<h2>Why</h2>\n<ul>\n<li>reports</li>\n</ul>');
  assert.match(body.metadata.mcp_request_id, UUID);
  assert.equal(body.metadata.mcp_index, 0);
  assert.equal(body.created_via, undefined, 'Orbit sets created_via itself; the server never sends it');
  assert.deepEqual([body.org_id, body.workspace_id, body.project_id], ['O1', 'W1', 'P1']);
});

test('create: a parent, a priority and a due date; someone the developer named', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_create_work_item', {
    project: h.project, title: 'Export button', parent: 'WEB-1', assignees: ['me', 'ana@acme.test'], priority: 'high', due_date: '2026-10-25',
  });
  assert.match(res.text, /under WEB-1, assigned to you and Ana/);
  const [{ body }] = h.calls('/work-items/create');
  assert.equal(body.story_id, 'I_STORY');
  assert.deepEqual(body.assignees_arr, [7, 8]);
  assert.equal(body.priority_id, 20);
  assert.equal(body.due_date, new Date(2026, 9, 25).getTime());
});

test('create: refused before anything is sent — a non-member, an ambiguous name, a subtask or milestone parent, a bad title', async () => {
  const h = await toolHarness();
  const nonMember = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', assignees: ['bob@acme.test'] });
  assert.equal(nonMember.isError, true);
  assert.match(nonMember.text, /^Nothing was sent: "bob@acme\.test" isn't a member of Web App/);
  const partial = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', assignees: ['an'] });
  assert.match(partial.text, /"an" isn't a member of Web App \(did you mean Ana <ana@acme\.test>\?\)/);
  const subtask = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', parent: 'WEB-3' });
  assert.match(subtask.text, /WEB-3 is a subtask, and Orbit allows only one level/);
  const milestone = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', parent: 'WEB-6' });
  assert.match(milestone.text, /can go under an epic, a feature, a story or a top-level task, not under WEB-6 \(a milestone\)/);
  const badDate = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', due_date: '2026-02-31' });
  assert.match(badDate.text, /"2026-02-31" isn't a real date/);
  await assert.rejects(h.run('orbit_create_work_item', { project: h.project, title: 'ab' }), /expected string to have >=3 characters/);
  assert.equal(h.calls('/work-items/create').length, 0);
});

test('create: a definite failure is reported with Orbit\'s message and not retried', async () => {
  const h = await toolHarness();
  h.faults.push({ path: '/work-items/create', mode: 'respond', status: 400, body: { success: false, message: 'Please check work item details', details: { error_code: 'VALIDATION_ERROR' } } });
  const res = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing' });
  assert.equal(res.isError, true);
  assert.equal(res.text, 'Please check work item details');
  h.faults.push({ path: '/work-items/create', mode: 'respond', status: 403, body: { success: false, message: 'Forbidden' } });
  assert.match((await h.run('orbit_create_work_item', { project: h.project, title: 'Thing' })).text, /don't have permission/);
  assert.equal(h.fake.state.items.length, 7, 'nothing was created');
});

test('create: a lost answer is never resent; the read-only check finds the item by request id', async () => {
  const h = await toolHarness();
  h.faults.push({ path: '/work-items/create', mode: 'drop' });
  const landed = await h.run('orbit_create_work_item', { project: h.project, title: 'Lost answer', parent: 'WEB-2' });
  assert.equal(landed.isError, false);
  assert.match(landed.text, /^No answer from Orbit \(timed out\)\. Checked: it was created\. Created WEB-8 \[task\] "Lost answer" under WEB-2/);
  const [list] = h.calls('/work-items/list');
  assert.deepEqual(list.body.author_ids, ['U_ME']);
  assert.equal(list.body.parent_id, 'I_TASK');

  h.faults.push({ path: '/work-items/create', mode: 'timeout' });
  const lost = await h.run('orbit_create_work_item', { project: h.project, title: 'Never arrived' });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /not sent again, and it isn't showing in Orbit yet.*Don't create it again/);
  assert.equal(h.sent('/work-items/create'), 2, 'one request per call: nothing resent');
  assert.equal(h.fake.state.items.filter((i) => i.title === 'Lost answer').length, 1);
});

test('bulk: steps under a top-level task become subtasks, one line per step', async () => {
  const h = await toolHarness();
  const steps = ['Add export button', 'Build CSV', 'Wire endpoint', 'Write tests', 'Update docs'].map((title) => ({ title }));
  const res = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps });
  assert.equal(res.isError, false);
  assert.match(res.text, /^Created 5 of 5 steps as subtasks of WEB-2 "Add CSV export", assigned to you:\n#1 ✓ WEB-8 Add export button\n/);
  assert.match(res.text, /#5 ✓ WEB-12 Update docs\nParent: https:\/\/app\.orbit\.test\/.*\/work-items\/WEB-2$/);
  const [{ body }] = h.calls('/work-items/bulk-create');
  assert.ok(body.items.every((it, i) => it.parent_id === 'I_TASK' && it.item_type === 'task' && it.metadata.mcp_index === i));
  assert.equal(new Set(body.items.map((it) => it.metadata.mcp_request_id)).size, 1);
});

test('bulk: a named story, feature or epic gets tasks; a subtask gets nothing; a milestone is refused', async () => {
  const h = await toolHarness();
  for (const [key, field] of [['WEB-1', 'story_id'], ['WEB-5', 'feature_id'], ['WEB-4', 'epic_id']]) {
    const res = await h.run('orbit_create_work_items', { project: h.project, parent: key, steps: [{ title: `Step under ${key}` }] });
    assert.match(res.text, new RegExp(`Created 1 of 1 steps as tasks of ${key}`));
    assert.ok(h.calls('/work-items/bulk-create').at(-1).body.items[0][field]);
  }
  const subtask = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-3', steps: [{ title: 'Nope' }] });
  assert.equal(subtask.isError, false);
  assert.match(subtask.text, /WEB-3 "Build CSV" is a subtask.*no steps were created\. Track this job on WEB-3 itself/);
  const milestone = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-6', steps: [{ title: 'Nope' }] });
  assert.equal(milestone.isError, true);
  assert.match(milestone.text, /WEB-6 is a milestone/);
  assert.equal(h.calls('/work-items/bulk-create').length, 3);
});

test('bulk: partial success reports each index; failed ones are never called created', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: [{ title: 'Good one' }, { title: 'Broken [bad]' }, { title: 'Good two' }] });
  assert.equal(res.isError, false);
  assert.match(res.text, /^Created 2 of 3 steps/);
  assert.match(res.text, /#1 ✓ WEB-8 Good one\n#2 ✗ Broken \[bad\]: Invalid state_id for task\n#3 ✓ WEB-9 Good two/);
  assert.match(res.text, /#2 failed; the others exist\. Retry only those, in a new call, and only if the error is about something you sent/);
});

test('bulk: a whole-batch refusal and the 25-step cap send nothing', async () => {
  const h = await toolHarness();
  h.faults.push({ path: '/work-items/bulk-create', mode: 'respond', status: 400, body: { success: false, message: 'Please check your input' } });
  const res = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: [{ title: 'One' }] });
  assert.equal(res.isError, true);
  assert.equal(res.text, 'Please check your input');
  const tooMany = Array.from({ length: 26 }, (_, i) => ({ title: `Step ${i}` }));
  await assert.rejects(h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: tooMany }), /expected array to have <=25 items/);
  assert.equal(h.fake.state.items.length, 7);
});

test('bulk: a lost answer reports landed steps by request id and the rest as not confirmed — never resent', async () => {
  const h = await toolHarness();
  // Orbit created all 3, but only the first 2 are visible to the check (e.g. not indexed yet).
  h.faults.push({ path: '/work-items/bulk-create', mode: 'drop', after: (fake) => { fake.state.items.pop(); } });
  const res = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }] });
  assert.equal(res.isError, false);
  assert.match(res.text, /^No answer from Orbit \(timed out\)\. Nothing was sent again\. Checked Orbit and found 2 of 3 steps/);
  assert.match(res.text, /#1 ✓ WEB-8 One\n#2 ✓ WEB-9 Two\n#3 \? not confirmed: Three\nThe unconfirmed steps may still appear\. Don't create them again/);
  assert.equal(h.sent('/work-items/bulk-create'), 1);

  // Someone else's matching titles never count: only metadata.mcp_request_id does.
  const other = await toolHarness();
  other.fake.state.items.push({ ...other.fake.find('WEB-3'), id: 'I_X', item_key: 'WEB-99', title: 'One', created_via: 'claude', created_at: Date.now(), metadata: { mcp_request_id: 'someone-else', mcp_index: 0 } });
  other.faults.push({ path: '/work-items/bulk-create', mode: 'timeout' });
  const none = await other.run('orbit_create_work_items', { project: other.project, parent: 'WEB-2', steps: [{ title: 'One' }] });
  assert.equal(none.isError, true);
  assert.match(none.text, /found 0 of 1 steps.*\n#1 \? not confirmed: One/);
  assert.equal(other.sent('/work-items/bulk-create'), 1);
});

test('comment: Markdown in; a lost answer is checked, never resent', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_add_comment', { project: h.project, item: 'WEB-2', text: 'Built `exportCsv()`.\nCommit: abc123' });
  assert.match(res.text, /^Commented on WEB-2 "Add CSV export": https:/);
  assert.equal(h.calls('/work-items/comments/add')[0].body.content, '<p>Built <code>exportCsv()</code>.<br>Commit: abc123</p>');

  h.faults.push({ path: '/work-items/comments/add', mode: 'drop' });
  const found = await h.run('orbit_add_comment', { project: h.project, item: 'WEB-2', text: 'Second <note>' });
  assert.equal(found.isError, false);
  assert.match(found.text, /didn't answer, but the comment is on WEB-2 \(checked\)/);

  h.faults.push({ path: '/work-items/comments/add', mode: 'timeout' });
  const lost = await h.run('orbit_add_comment', { project: h.project, item: 'WEB-2', text: 'Third' });
  assert.equal(lost.isError, true);
  assert.match(lost.text, /isn't showing on WEB-2 yet.*not sent again; don't post it again/);
  assert.equal(h.sent('/work-items/comments/add'), 3, 'one request per call: nothing resent');
  assert.equal(h.fake.state.comments.filter((c) => c.content.includes('Second')).length, 1);
});

test('update: fields, assignee and label operations by name; no status field', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_update_work_item', {
    project: h.project, item: 'WEB-2', title: 'Add CSV and XLSX export', assignees: { add: ['Ana Silva'] },
    labels: { add: ['Backend'] }, priority: 'None', start_date: '2026-10-21',
  });
  assert.match(res.text, /^Updated WEB-2 "Add CSV and XLSX export": title, assignees, labels, priority and start date\./);
  const [{ body }] = h.calls('/work-items/update');
  assert.deepEqual(body.assignees, { add: [8] });
  assert.deepEqual(body.labels, { add: ['L1'] });
  assert.equal(body.priority_id, 50);
  assert.deepEqual(h.fake.find('WEB-2').assignees_user_arr, ['U_ME', 'U_ANA']);

  const status = await h.run('orbit_update_work_item', { project: h.project, item: 'WEB-2', state: 'Done' });
  assert.equal(status.isError, true);
  assert.match(status.text, /Nothing to change.*use orbit_set_status/);
  const wrongType = await h.run('orbit_update_work_item', { project: h.project, item: 'WEB-1', labels: { add: ['backend'] } });
  assert.match(wrongType.text, /has no story label "backend"\. story labels: customer/);
  assert.equal(h.calls('/work-items/update').length, 1);
});

test('update: an unknown outcome is retried once; twice unknown is reported, not guessed', async () => {
  const h = await toolHarness();
  h.faults.push({ path: '/work-items/update', mode: 'timeout' });
  const res = await h.run('orbit_update_work_item', { project: h.project, item: 'WEB-2', title: 'Retried title' });
  assert.equal(res.isError, false);
  assert.equal(h.sent('/work-items/update'), 2, 'the first try never reached Orbit; the retry did');
  assert.equal(h.fake.find('WEB-2').title, 'Retried title');

  h.faults.push({ path: '/work-items/update', mode: 'drop' }, { path: '/work-items/update', mode: 'drop' });
  const twice = await h.run('orbit_update_work_item', { project: h.project, item: 'WEB-2', title: 'Twice' });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /Tried twice, so the change may or may not have been saved\. Read WEB-2 with orbit_get_work_item: if the change isn't there, send it once more/);
  assert.equal(h.sent('/work-items/update'), 4, 'exactly one retry');
});

test('an unexpected error on a write tool says the write may have landed; on a read tool it doesn\'t', async () => {
  const { runTool } = await import('../src/tools/index.js');
  const boom = async () => { throw new TypeError('x is undefined'); };
  const write = await runTool({ name: 'w', readOnly: false, handler: boom }, {}, {});
  assert.equal(write.isError, true);
  assert.equal(write.content[0].text, 'Orbit tool error: x is undefined. It may or may not have been saved: check with a read before trying again. Carry on with the coding.');
  const read = await runTool({ name: 'r', readOnly: true, handler: boom }, {}, {});
  assert.equal(read.content[0].text, 'Orbit tool error: x is undefined. Carry on with the coding.');
});
