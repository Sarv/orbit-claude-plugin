// The plugin's QA checklist (the plan's Appendix C, parts 2–3), run against a real Orbit as far as a
// script can drive it, with PASS / FAIL / SKIP per checklist line.
// It runs the plugin's own tools in-process (the code the plugin ships), so it can also lose
// answers on purpose: a "drop" sends the real request, waits for Orbit's real answer, then tells the
// tool the request timed out.
//
//   ORBIT_API_URL=https://<dev API host>/v2 ORBIT_APP_URL=https://<dev app host> \
//     node dev/qa-dev.mjs --project <org>/<workspace>/<project> [options]
//   node dev/qa-dev.mjs --fake       the same run against the local fake Orbit (checks this script)
//
//   --review "In Review"   the project's review state for tasks (default In Review)
//   --human-task KEY       a task made in the web app (not by Claude), not done. It gets moved to review.
//   --human-done KEY       a done task made in the web app. It stays done; two comments are added.
//
// Uses this computer's Orbit connection for that API; if there is none, the browser opens once.
// Everything it creates is titled "[QA <time>] …" and left in place. One case closes a task that
// carries 2 points, as a person would, which awards those points. It refuses to run on production.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../plugins/orbit/server/src/config.js';
import { createTokenStore } from '../plugins/orbit/server/src/tokenStore.js';
import { createAuth } from '../plugins/orbit/server/src/auth.js';
import { createOrbitClient } from '../plugins/orbit/server/src/orbitClient.js';
import { createResolvers } from '../plugins/orbit/server/src/resolvers.js';
import { TOOLS, runTool } from '../plugins/orbit/server/src/tools/index.js';

const { values: opt } = parseArgs({
  options: {
    project: { type: 'string' },
    review: { type: 'string', default: 'In Review' },
    'human-task': { type: 'string' },
    'human-done': { type: 'string' },
    fake: { type: 'boolean', default: false },
  },
});

let fake = null;
let env = process.env;
if (opt.fake) {
  const { startFakeOrbit } = await import('../plugins/orbit/server/test/fakeOrbitServer.js');
  fake = await startFakeOrbit();
  fake.state.refresh = `orb_rt_C1.${crypto.randomBytes(16).toString('base64url')}`;
  env = {
    ORBIT_API_URL: fake.apiUrl, ORBIT_APP_URL: 'https://app.acme.test', ORBIT_TOKEN_STORE: 'file', ORBIT_OPEN_BROWSER: '0',
    CLAUDE_PLUGIN_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-qa-')),
  };
  // A task made in the web app (no created_via); WEB-7 is a done one.
  fake.state.items.push({ id: 'I_HUMAN', item_key: 'WEB-90', item_type: 'task', title: 'Made in the web app', state_id: 'S_PROG', state_group: 3, assignees_arr: [7], assignees_user_arr: ['U_ME'], created_by: { user_id: 'U_ME' } });
  Object.assign(opt, { project: 'acme/eng/web', 'human-task': 'WEB-90', 'human-done': 'WEB-7' });
}
if (!opt.project) {
  console.error('usage: node dev/qa-dev.mjs --project <org/workspace/project or URL> [--review NAME] [--human-task KEY] [--human-done KEY]\n       node dev/qa-dev.mjs --fake');
  process.exit(2);
}

const config = loadConfig(env);
if (config.apiHost === 'api.orbitorg.com') {
  console.error('This creates test items, so it refuses production. Set ORBIT_API_URL / ORBIT_APP_URL to dev.');
  process.exit(2);
}
const store = createTokenStore(config);
if (fake) await store.write(fake.state.refresh);

// Every request the tools send, and a one-shot "lose the next answer to <path>".
const sent = [];
let drop = null;
async function fetchImpl(url, init) {
  const apiPath = String(url).slice(config.apiUrl.length);
  sent.push(apiPath);
  const res = await fetch(url, init);
  if (drop === apiPath) {
    drop = null;
    await res.arrayBuffer();
    throw Object.assign(new Error('answer dropped by the QA run'), { name: 'TimeoutError' });
  }
  return res;
}
const auth = createAuth({ config, store });
const client = createOrbitClient({ config, auth, fetchImpl });
const resolvers = createResolvers({ config, client });
auth.onConnected(() => resolvers.clearCache());
const orbit = { config, store, auth, client, resolvers };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, fake ? 0 : ms));
const count = (apiPath) => sent.filter((x) => x === apiPath).length;
async function run(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  const res = await runTool(tool, tool.inputSchema.parse(args), orbit);
  return { isError: Boolean(res.isError), text: res.content[0].text };
}

async function connect() {
  try {
    return await resolvers.me();
  } catch (err) {
    if (err.kind !== 'not_connected') throw err;
    console.log(`Orbit isn't connected for ${config.apiHost}. Open this link and click Allow:\n${err.signInUrl}\n`);
  }
  // The plugin's sign-in listener doesn't hold the process open (unref'd; in Claude Code, stdin
  // does), so this timer does, until the sign-in completes.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No sign-in within 10 minutes')), 10 * 60_000);
    auth.onConnected(() => { clearTimeout(timer); resolve(); });
  });
  return resolvers.me();
}

// ─── checks ────────────────────────────────────────────────────────────────────────────────────
const results = [];
class Skip extends Error {}
const skip = (why) => { throw new Skip(why); };
const expect = (ok, what, detail) => { if (!ok) throw new Error(detail ? `${what}: ${detail}` : what); };
const brief = (text) => text.split('\n').slice(0, 3).join(' / ').slice(0, 240);
async function check(label, fn) {
  try {
    results.push(['PASS', label, (await fn()) || '']);
  } catch (err) {
    results.push([err instanceof Skip ? 'SKIP' : 'FAIL', label, err.message]);
  }
}

const me = await connect();
const p = await resolvers.project(opt.project);
const project = opt.project;
console.log(`QA as ${me.displayName || me.email} on ${p.projectName} (${config.apiUrl})\n`);

const tag = `[QA ${new Date().toISOString().slice(5, 16).replace('T', ' ')}]`;
const KEY = '[A-Z][A-Z0-9]*-\\d+';
const createdKey = (text) => text.match(new RegExp(`^Created (${KEY})`, 'm'))?.[1];
const okKeys = (text) => [...text.matchAll(new RegExp(`✓ (${KEY})`, 'g'))].map((m) => m[1]);
const read = (key) => resolvers.item(p, key);
const rest = (apiPath, body) => client.call(apiPath, { ...resolvers.context(p), ...body });
const taskStates = (await resolvers.states(p, 'task'))?.states || [];
const byGroup = (group) => taskStates.filter((s) => s.group === group).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
const groupOf = (it) => taskStates.find((s) => s.id === it.state_id)?.group;
const doneState = byGroup('completed')[0];
const reviewState = taskStates.find((s) => s.name.toLowerCase() === opt.review.toLowerCase());
const setStatus = (items, status, review = opt.review) => run('orbit_set_status', { project, items, status, ...(review && { review_state: review }) });
const hasComment = async (it, text) => ((await rest('/work-items/comments/list', { item_id: it.id, size: 20 }))?.comments || [])
  .filter((c) => c.content?.includes(text)).length;

async function newTask(title, extra = {}) {
  const res = await run('orbit_create_work_item', { project, title: `${tag} ${title}`, ...extra });
  const key = createdKey(res.text);
  expect(key, `couldn't create "${title}"`, res.text);
  return key;
}
// A person adds task points (the connection acts as the user, who needs edit:point_allocations).
async function givePoints(key, points = 2) {
  const it = await read(key);
  try {
    await rest('/work-items/update', { item_id: it.id, task_points: points });
  } catch (err) {
    skip(`couldn't set task points (${err.message}); needs edit:point_allocations`);
  }
  const after = await read(key);
  if (!(Number(after.task_points) > 0)) skip("task points are off in this project's scrum settings, so they weren't saved");
  return after;
}

expect(doneState, 'the task type has no completed state');
if (!reviewState || reviewState.group !== 'started') console.log(`Note: "${opt.review}" isn't a started task state here, so the review cases will fail.\n`);

const MARKDOWN = '## Why\nExport reports.\n\n- a button\n- a builder\n\n```js\nconst ok = 1 < 2;\n```\n\nSee [the docs](https://example.com/docs).';
let parentKey;
let stepKeys = [];
let firstStarted = '';
let storyKey;

// ── Part 2 ──
await check('2 · multi-step: a parent + subtasks, assigned to me, "via Claude"', async () => {
  parentKey = await newTask('Parent job', { description: MARKDOWN });
  const steps = ['Add the button', 'Build the CSV', 'Wire the endpoint', 'Write tests', 'Update docs'].map((t) => ({ title: `${tag} ${t}` }));
  const res = await run('orbit_create_work_items', { project, parent: parentKey, steps });
  stepKeys = okKeys(res.text);
  expect(stepKeys.length === 5, 'not all 5 steps were created', brief(res.text));
  const parent = await read(parentKey);
  for (const key of [parentKey, ...stepKeys]) {
    const it = await read(key);
    expect(it.created_via === 'claude', `${key}: created_via is ${it.created_via}`);
    expect((it.assignees_user_arr || []).includes(me.userId), `${key} isn't assigned to me`);
    if (key !== parentKey) expect(it.parent_id === parent.id, `${key} isn't a subtask of ${parentKey}`);
  }
  return `${parentKey} + ${stepKeys.join(', ')}`;
});

await check('2 · each subtask → In progress, then Done, with a comment', async () => {
  expect(stepKeys.length, 'no steps (see the first check)');
  for (const key of stepKeys) {
    const started = await setStatus([key], 'started');
    firstStarted ||= started.text;
    expect(new RegExp(`${key} → "`).test(started.text), `${key} wasn't started`, brief(started.text));
    const comment = await run('orbit_add_comment', { project, item: key, text: `Done: ${key}.\nFiles: \`src/export.js\`` });
    expect(!comment.isError, `the comment on ${key} failed`, comment.text);
    const done = await setStatus([key], 'completed');
    expect(done.text.includes(`${key} → "${doneState.name}"`), `${key} wasn't closed`, brief(done.text));
  }
});

await check("2 · activity: me as the actor, \"via Claude\"; Markdown survives Orbit's sanitizer", async () => {
  expect(stepKeys.length, 'no steps (see the first check)');
  await sleep(2000);
  const step = await read(stepKeys[0]);
  const activities = (await rest('/work-items/activities/list', { item_id: step.id, size: 50 }))?.activities || [];
  expect(activities.length, `no activity on ${stepKeys[0]}`);
  expect(activities.every((a) => a.actor?.user_id === me.userId), 'an activity has another actor');
  expect(activities.every((a) => a.via === 'claude'), 'an activity has no via "claude"', activities.map((a) => `${a.action}:${a.via}`).join(', '));
  const parent = await read(parentKey);
  for (const html of ['<h2>', '<li>', '<pre>', '<a href=']) expect(parent.description?.includes(html), `the description lost ${html}`, parent.description?.slice(0, 200));
  expect(await hasComment(step, '<code>'), 'the comment lost its <code>');
  return `look at it: ${resolvers.itemUrl(p, parent)}`;
});

// ── Part 3: completion policy ──
await check('3 · a Claude-created parent with no points closes', async () => {
  const res = await setStatus([parentKey], 'completed');
  expect(res.text.includes(`${parentKey} → "`), "it wasn't closed", brief(res.text));
});

await check('3 · points added during work → refused; moved to the review state with a comment', async () => {
  const key = await newTask('Points added during work');
  await setStatus([key], 'started');
  await givePoints(key);
  const res = await setStatus([key], 'completed');
  expect(/handed to a person: it carries points/.test(res.text), "it wasn't handed to a person", brief(res.text));
  const it = await read(key);
  expect(reviewState && it.state_id === reviewState.id, `it isn't in "${opt.review}"`);
  expect(await hasComment(it, 'Ready for review — not closed by Claude'), 'no handoff comment');
});

await check('3 · only assignee points set → refused', async () => skip('not reachable through the API: allocating points needs task points first (unit-tested)'));

await check('3 · an item not created by Claude (one the user named) → handed to a person, never closed', async () => {
  if (!opt['human-task']) skip('pass --human-task KEY');
  const res = await setStatus([opt['human-task']], 'completed');
  expect(/handed to a person: it wasn't created through Claude/.test(res.text), "it wasn't handed to a person", brief(res.text));
  expect(groupOf(await read(opt['human-task'])) !== 'completed', 'it was closed');
});

await check('3 · a Claude item with points, moved out of completed → stays completed, allocations untouched, comment only', async () => {
  const key = await newTask('Reopen with points');
  await givePoints(key);
  await rest('/work-items/update', { item_id: (await read(key)).id, state_id: doneState.id }); // a person closes it
  const closed = await read(key);
  expect(closed.state_id === doneState.id, "the person's close didn't land");
  const moves = count('/work-items/bulk-update');
  const res = await setStatus([key], 'started');
  expect(/handed to a person: it carries points.*left in "/.test(res.text), "it wasn't refused", brief(res.text));
  const after = await read(key);
  expect(after.state_id === doneState.id, 'it left completed');
  const allocations = (it) => JSON.stringify(it.assignee_points ?? it.my_assignee_points ?? null);
  expect(allocations(after) === allocations(closed), 'the allocations changed');
  expect(count('/work-items/bulk-update') === moves, 'a state change was sent');
});

await check("3 · a done item not created by Claude, asked to reopen or cancel → stays done, comment only", async () => {
  if (!opt['human-done']) skip('pass --human-done KEY');
  const moves = count('/work-items/bulk-update');
  for (const status of ['started', 'cancelled']) {
    const res = await setStatus([opt['human-done']], status);
    expect(/handed to a person/.test(res.text), `${status}: not handed to a person`, brief(res.text));
  }
  expect(groupOf(await read(opt['human-done'])) === 'completed', 'it left completed');
  expect(count('/work-items/bulk-update') === moves, 'a state change was sent');
});

await check('3 · no review_state → state unchanged, comment added, the user told', async () => {
  const key = await newTask('No review state');
  await givePoints(key);
  const before = (await read(key)).state_id;
  const res = await setStatus([key], 'completed', null);
  expect(/no review state is set/.test(res.text), 'the result says nothing', brief(res.text));
  expect((await read(key)).state_id === before, 'the state changed');
});

await check('3 · a review_state outside started → treated as none', async () => {
  const key = await newTask('Review state outside started');
  await givePoints(key);
  const before = (await read(key)).state_id;
  const res = await setStatus([key], 'completed', doneState.name);
  expect(/is in the completed group, not started/.test(res.text), 'not treated as none', brief(res.text));
  expect((await read(key)).state_id === before, 'the state changed');
});

// ── Part 3: hierarchy ──
await check('3 · named story → steps created as tasks with story_id', async () => {
  storyKey = createdKey((await run('orbit_create_work_item', { project, title: `${tag} Story`, item_type: 'story' })).text);
  expect(storyKey, "the story wasn't created");
  const res = await run('orbit_create_work_items', { project, parent: storyKey, steps: [{ title: `${tag} Story step` }] });
  const [key] = okKeys(res.text);
  expect(key, 'no step', brief(res.text));
  const it = await read(key);
  expect(it.item_type === 'task' && it.story_id === (await read(storyKey)).id, 'not a task with story_id');
});

await check('3 · named feature / epic → tasks with feature_id / epic_id', async () => {
  for (const type of ['feature', 'epic']) {
    const parent = createdKey((await run('orbit_create_work_item', { project, title: `${tag} ${type}`, item_type: type })).text);
    expect(parent, `the ${type} wasn't created`);
    const res = await run('orbit_create_work_items', { project, parent, steps: [{ title: `${tag} ${type} step` }] });
    const [key] = okKeys(res.text);
    expect(key, `no step under the ${type}`, brief(res.text));
    expect((await read(key))[`${type}_id`] === (await read(parent)).id, `the step has no ${type}_id`);
  }
});

await check('3 · named top-level task → subtasks with parent_id', async () => {
  if (stepKeys.length < 5) skip('needs the steps from the first check, which failed');
  return 'checked in the first check';
});

await check('3 · named subtask → no new items; tracked by comments', async () => {
  if (stepKeys.length < 3) skip('needs the steps from the first check, which failed');
  const creates = count('/work-items/bulk-create');
  const res = await run('orbit_create_work_items', { project, parent: stepKeys[0], steps: [{ title: `${tag} Nope` }] });
  expect(!res.isError && /is a subtask/.test(res.text), 'not refused gently', brief(res.text));
  expect(count('/work-items/bulk-create') === creates, 'something was sent');
});

await check('3 · named milestone → refused with a clear message', async () => {
  let milestone;
  try {
    milestone = (await rest('/work-items/create', { item_type: 'milestone', title: `${tag} Milestone` })).item_key;
  } catch (err) {
    skip(`couldn't create a milestone to test with (${err.message})`);
  }
  const res = await run('orbit_create_work_items', { project, parent: milestone, steps: [{ title: `${tag} Nope` }] });
  expect(res.isError && /is a milestone/.test(res.text), 'not refused', brief(res.text));
});

// ── Part 3: write contract ──
const contractParent = await newTask('Write contract');
await check('3 · partial bulk success: an invalid state_id fails alone, reported by index', async () => {
  const parentId = (await read(contractParent)).id;
  const items = [1, 2, 3].map((i) => ({ item_type: 'task', title: `${tag} Partial ${i}`, parent_id: parentId, ...(i === 2 && { state_id: 'QA_NOT_A_STATE' }) }));
  const data = await rest('/work-items/bulk-create', { items });
  const byIndex = new Map((data?.results || []).map((r) => [r.index, r]));
  expect(byIndex.get(1)?.success === false, "the bad item didn't fail", JSON.stringify(byIndex.get(1)));
  expect(byIndex.get(0)?.success && byIndex.get(2)?.success, 'a good item failed', JSON.stringify(data?.results));
  return `Orbit's error for #2: ${byIndex.get(1).error}`;
});

await check('3 · a shape error (2-character title) → whole call refused, nothing created', async () => {
  const schema = TOOLS.find((t) => t.name === 'orbit_create_work_items').inputSchema;
  expect(!schema.safeParse({ project, parent: contractParent, steps: [{ title: 'ab' }] }).success, 'the tool accepted a 2-character title');
  const marker = `${tag} Shape ok`;
  let refused = null;
  try {
    await rest('/work-items/bulk-create', { items: [{ item_type: 'task', title: marker }, { item_type: 'task', title: 'ab' }] });
  } catch (err) {
    refused = err.kind;
  }
  expect(refused === 'failed', "Orbit didn't refuse the whole batch");
  await sleep(2000);
  const found = (await rest('/work-items/list', { search: marker, size: 5 }))?.items || [];
  expect(!found.some((i) => i.title === marker), 'part of the batch was created');
});

await check("3 · an assignee who isn't a project member → refused before sending; nothing created", async () => {
  const creates = count('/work-items/create');
  const res = await run('orbit_create_work_item', { project, title: `${tag} Bad assignee`, assignees: ['nobody@qa.invalid'] });
  expect(res.isError && /^Nothing was sent/.test(res.text), 'not refused', brief(res.text));
  expect(count('/work-items/create') === creates, 'it was sent');
});

await check('3 · lost answer on a bulk create → nothing resent; found by request id; each step exists once', async () => {
  const parent = await newTask('Lost answer');
  const titles = [1, 2, 3].map((i) => `${tag} Lost ${i}`);
  const creates = count('/work-items/bulk-create');
  drop = '/work-items/bulk-create';
  const res = await run('orbit_create_work_items', { project, parent, steps: titles.map((title) => ({ title })) });
  expect(count('/work-items/bulk-create') === creates + 1, 'the create was sent again');
  expect(/Nothing was sent again/.test(res.text), 'not reported as unknown', brief(res.text));
  await sleep(10_000);
  const children = (await rest('/work-items/list', { parent_id: (await read(parent)).id, size: 20 }))?.items || [];
  for (const title of titles) {
    const n = children.filter((c) => c.title === title).length;
    expect(n === 1, `"${title}" exists ${n} times`);
  }
  return `the check found ${okKeys(res.text).length} of 3 right away`;
});

await check('3 · lost answer on a comment → not resent; reported; exists once', async () => {
  if (stepKeys.length < 3) skip('needs the steps from the first check, which failed');
  const step = await read(stepKeys[1]);
  const text = `${tag} lost-answer comment`;
  const posts = count('/work-items/comments/add');
  drop = '/work-items/comments/add';
  const res = await run('orbit_add_comment', { project, item: stepKeys[1], text });
  expect(count('/work-items/comments/add') === posts + 1, 'the comment was sent again');
  expect(/didn't answer/.test(res.text), 'not reported', brief(res.text));
  await sleep(2000);
  expect((await hasComment(step, text)) === 1, "the comment doesn't exist exactly once");
  return res.isError ? 'reported as not confirmed' : 'found by the check';
});

await check('3 · an identical status update repeated → no duplicate activity', async () => {
  if (stepKeys.length < 3) skip('needs the steps from the first check, which failed');
  const step = await read(stepKeys[2]);
  const total = async () => (await rest('/work-items/activities/list', { item_id: step.id, size: 1 }))?.total;
  await sleep(2000);
  const before = await total();
  for (let i = 0; i < 2; i += 1) await rest('/work-items/bulk-update', { item_ids: [step.id], updates: { state_id: step.state_id } });
  await sleep(2000);
  const after = await total();
  expect(after === before, `activities went from ${before} to ${after}`);
  expect(/already in/.test((await setStatus([stepKeys[2]], 'completed')).text), 'the tool sent a move to the same state');
});

// ── Backend fix 2.6 ──
await check('2.6 · single create with a non-member assignee → 400', async () => {
  let created;
  try {
    created = await rest('/work-items/create', { item_type: 'task', title: `${tag} Non-member (should fail)`, assignees_arr: [987654321] });
  } catch (err) {
    expect(err.kind === 'failed' && err.status === 400, `expected a 400, got ${err.kind} ${err.status}`);
    return err.message;
  }
  throw new Error(`created ${created.item_key}: the assignee fix isn't on this server`);
});

await check('2.6 · bulk create with one non-member → only that item fails', async () => {
  const data = await rest('/work-items/bulk-create', { items: [
    { item_type: 'task', title: `${tag} Member ok` },
    { item_type: 'task', title: `${tag} Non-member (should fail)`, assignees_arr: [987654321] },
  ] });
  const byIndex = new Map((data?.results || []).map((r) => [r.index, r]));
  expect(byIndex.get(0)?.success === true && byIndex.get(1)?.success === false, 'not a per-item failure', JSON.stringify(data?.results));
});

// ── States (2.1) ──
await check('2.1 · "started" with two started states → the lower-sequence one, named in the result', async () => {
  const started = byGroup('started');
  if (started.length < 2) skip(`tasks have ${started.length} started state(s) here`);
  if (!firstStarted) skip('needs the steps from the first check, which failed');
  expect(firstStarted.includes(`"started" means "${started[0].name}" for a task`), 'wrong state, or not named', brief(firstStarted));
});

await check('2.1 · one call moving a story and a task → split per type, both moved', async () => {
  expect(storyKey, 'no story (see the named-story check)');
  const key = await newTask('Mixed types');
  const res = await setStatus([storyKey, key], 'started');
  expect(/for a story/.test(res.text) && /for a task/.test(res.text), 'not resolved per type', brief(res.text));
  const storyStates = (await resolvers.states(p, 'story'))?.states || [];
  const story = await read(storyKey);
  expect(storyStates.find((s) => s.id === story.state_id)?.group === 'started', "the story didn't move");
  expect(groupOf(await read(key)) === 'started', "the task didn't move");
});

// ─── report ────────────────────────────────────────────────────────────────────────────────────
const width = Math.max(...results.map((r) => r[1].length));
for (const [status, label, note] of results) console.log(`${status.padEnd(4)}  ${label.padEnd(width)}  ${note}`);
const tally = (s) => results.filter((r) => r[0] === s).length;
console.log(`\n${tally('PASS')} passed, ${tally('FAIL')} failed, ${tally('SKIP')} skipped. Items are titled "${tag} …"${parentKey ? `; the main job: ${resolvers.itemUrl(p, { item_type: 'task', item_key: parentKey })}` : ''}`);
console.log('Not covered here (manual): Part 1 (curl), the Claude Code session itself (Part 2: link, sign-in, unprompted tracking, Disconnect), and the rendering in the web app.');
await fake?.close();
process.exit(tally('FAIL') ? 1 : 0);
