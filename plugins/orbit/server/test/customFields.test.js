// Custom fields: shown in the project setup, given by name on create, and checked before anything
// is sent — above all a required field with neither a value nor a default, which Orbit refuses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolHarness } from './helpers.js';

const TASK_FIELDS = [
  { id: 'CF_CLIENT', name: 'Client', field_type: 'single_select', is_required: true, options: [{ id: 'OPT_ACME', label: 'Acme' }, { id: 'OPT_GLOBEX', label: 'Globex' }] },
  { id: 'CF_TEAM', name: 'Team', field_type: 'text', is_required: true, default_value: 'Backend' },
  { id: 'CF_AREAS', name: 'Areas', field_type: 'multi_select', is_required: false, options: [{ id: 'OPT_API', label: 'API' }, { id: 'OPT_UI', label: 'UI' }] },
  { id: 'CF_RELEASE', name: 'Release', field_type: 'date', is_required: false },
  { id: 'CF_URGENT', name: 'Urgent', field_type: 'boolean', is_required: false, default_value: false },
  { id: 'CF_HOURS', name: 'Hours', field_type: 'number', is_required: false },
  { id: 'CF_REVIEWER', name: 'Reviewer', field_type: 'user', is_required: false },
  { id: 'CF_SPEC', name: 'Spec', field_type: 'attachment', is_required: false },
];

async function harness() {
  const h = await toolHarness();
  h.fake.state.customFields.task = TASK_FIELDS;
  return h;
}

test('project setup lists the custom fields: what each takes, which are required, the defaults', async () => {
  const h = await harness();
  const res = await h.run('orbit_get_project_config', { project: h.project });
  assert.match(res.text, /\nCustom fields:\n- Client: one of: Acme, Globex \(required\)\n- Team: text \(required, default "Backend"\)\n- Areas: any of: API, UI\n- Release: a date \(YYYY-MM-DD\)\n- Urgent: yes or no \(default no\)\n/);
  h.fake.state.canViewCustomFields = false;
  h.orbit.resolvers.clearCache();
  assert.match((await h.run('orbit_get_project_config', { project: h.project })).text, /\nCustom fields: none you can see\n/);
});

test('create: values by name become what Orbit stores — option ids, epoch dates, booleans, numbers, members', async () => {
  const h = await harness();
  const res = await h.run('orbit_create_work_item', {
    project: h.project, title: 'Add CSV export',
    fields: { client: 'globex', Areas: ['API', 'ui'], Release: '2026-11-01', Urgent: 'yes', Hours: '2.5', Reviewer: 'ana@acme.test' },
  });
  assert.equal(res.isError, false, res.text);
  const [{ body }] = h.calls('/work-items/create');
  assert.deepEqual(body.custom_fields, [
    { field_id: 'CF_CLIENT', value: 'OPT_GLOBEX' },
    { field_id: 'CF_AREAS', value: ['OPT_API', 'OPT_UI'] },
    { field_id: 'CF_RELEASE', value: new Date(2026, 10, 1).getTime() },
    { field_id: 'CF_URGENT', value: true },
    { field_id: 'CF_HOURS', value: 2.5 },
    { field_id: 'CF_REVIEWER', value: 8 },
  ]);
});

test('create: a required field with no default and no value → nothing sent; the choices are shown and Claude is told not to guess', async () => {
  const h = await harness();
  const res = await h.run('orbit_create_work_item', { project: h.project, title: 'Add CSV export' });
  assert.equal(res.isError, true);
  assert.equal(res.text, 'Nothing was sent: Web App needs these task fields, which have no default: Client (one of: Acme, Globex). '
    + 'Ask the user for the values (never guess), then pass them in "fields".');
  assert.equal(h.calls('/work-items/create').length, 0);
  // Team is required too, but its default fills it: only Client is needed.
  const ok = await h.run('orbit_create_work_item', { project: h.project, title: 'Add CSV export', fields: { Client: 'Acme' } });
  assert.equal(ok.isError, false, ok.text);
  assert.deepEqual(h.calls('/work-items/create')[0].body.custom_fields, [{ field_id: 'CF_CLIENT', value: 'OPT_ACME' }]);
});

test('create: unknown fields and options, wrong types and file fields are refused before sending, all in one message', async () => {
  const h = await harness();
  const res = await h.run('orbit_create_work_item', {
    project: h.project, title: 'Thing',
    fields: { Client: 'Initech', Clinet: 'Acme', Release: 'next week', Hours: 'a few', Urgent: 'maybe', Spec: 'spec.pdf' },
  });
  assert.equal(res.isError, true);
  for (const part of [
    '"Initech" isn\'t an option of Client (one of: Acme, Globex)',
    '"Clinet" isn\'t a task field in Web App (fields: Client, Team, Areas, Release, Urgent, Hours, Reviewer and Spec)',
    'Release takes a date (YYYY-MM-DD), not "next week"',
    'Hours takes a number, not "a few"',
    'Urgent takes yes or no, not "maybe"',
    "Spec is a file field, which Claude can't set",
  ]) assert.ok(res.text.includes(part), `missing: ${part}\n${res.text}`);
  assert.doesNotMatch(res.text, /needs these task fields/, 'Client was given (wrongly), so it isn\'t also reported as missing');
  assert.equal(h.calls('/work-items/create').length, 0);
});

test('steps: the same values on every step; a missing required field stops the whole call before sending', async () => {
  const h = await harness();
  const steps = [{ title: 'Add the button' }, { title: 'Build the CSV' }];
  const refused = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^Nothing was sent: Web App needs these task fields, which have no default: Client/);
  assert.equal(h.calls('/work-items/bulk-create').length, 0);

  const res = await h.run('orbit_create_work_items', { project: h.project, parent: 'WEB-2', steps, fields: { Client: 'Acme' } });
  assert.equal(res.isError, false, res.text);
  const [{ body }] = h.calls('/work-items/bulk-create');
  for (const item of body.items) assert.deepEqual(item.custom_fields, [{ field_id: 'CF_CLIENT', value: 'OPT_ACME' }]);
});

test("someone who can't see the fields: nothing is checked or sent, the result says so, and Orbit's own refusal comes through", async () => {
  const h = await harness();
  h.fake.state.canViewCustomFields = false;
  const res = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', fields: { Client: 'Acme' } });
  assert.equal(res.isError, true);
  assert.equal(res.text, "This project has required fields you don't have access to. Ask a project admin to give them a default value.");
  assert.equal(h.calls('/work-items/create')[0].body.custom_fields, undefined);

  h.fake.state.customFields.task = TASK_FIELDS.filter((f) => f.id !== 'CF_CLIENT'); // every required field has a default
  const created = await h.run('orbit_create_work_item', { project: h.project, title: 'Thing', fields: { Client: 'Acme' } });
  assert.equal(created.isError, false, created.text);
  assert.match(created.text, /\nNot set: Client\. Orbit doesn't show you this project's custom fields; they got the project's defaults, if any\.$/);
});

test('a project without custom fields: creates exactly as before', async () => {
  const h = await toolHarness();
  const res = await h.run('orbit_create_work_item', { project: h.project, title: 'Add CSV export' });
  assert.equal(res.isError, false);
  assert.equal(h.calls('/work-items/create')[0].body.custom_fields, undefined);
  assert.equal(h.calls('/custom-fields/list').length, 1);
});
