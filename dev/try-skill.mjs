// Runs a real Claude Code session with this plugin loaded (`claude -p --plugin-dir`) in a
// throwaway git repo linked to a FAKE Orbit (plugins/orbit/server/test/fakeOrbitServer.js), then
// prints what Claude did in Orbit. It checks the skill without a deployed backend: does Claude
// track a multi-step job by itself, and leave Orbit alone for a quick question?
//
//   node dev/try-skill.mjs "<prompt>"          e.g. "Add a slugify helper to src/strings.js, with tests"
//
//   --required-field       the project's tasks need "Client" (Acme or Globex), with no default
//   --saved-value <label>  .orbit.json saves that value for it (defaults.task.fields.Client)
//   --branch <name>        the throwaway repo is on this branch (e.g. web-5-exports: the fake's WEB-5)
//   --unfinished-job       Orbit also holds a clear, paused Claude job: WEB-20 "Add CSV export" with
//                          WEB-21 (toCsv, done) and WEB-22 (README, to do); src/export.js has toCsv
//   --confirm-plan         .orbit.json asks for a plan preview ("confirm_plan": true)
//   --saved-label <name>   .orbit.json saves a task label (defaults.task.labels; the fake has
//                          backend and frontend). Repeat it for more
//   --saved-priority <name> .orbit.json saves a task priority (defaults.task.priority: High or None)
//   --then <reply>         after the first turn, answer in the same conversation (claude -p --continue),
//                          e.g. --then "OK" after a plan preview or /orbit:undo. Repeat it for more turns
//
// The fake starts with an unfinished Claude job: WEB-2 "Add CSV export" (in progress) under the
// story WEB-1, so a request for that work should continue it rather than start a new parent.
//
// No browser sign-in: the connection is pre-stored in the token store for the fake's own address
// (the macOS Keychain, service orbit-claude-code, account 127.0.0.1:<port>) and removed at the end.
// The session runs with permission prompts off, inside the throwaway repo.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startFakeOrbit } from '../plugins/orbit/server/test/fakeOrbitServer.js';
import { createTokenStore } from '../plugins/orbit/server/src/tokenStore.js';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'orbit');
const APP_URL = 'https://app.acme.test';
const { values: opt, positionals } = parseArgs({
  options: {
    'required-field': { type: 'boolean', default: false }, 'saved-value': { type: 'string' }, branch: { type: 'string' },
    'unfinished-job': { type: 'boolean', default: false }, 'confirm-plan': { type: 'boolean', default: false },
    'saved-label': { type: 'string', multiple: true, default: [] }, 'saved-priority': { type: 'string' },
    then: { type: 'string', multiple: true, default: [] },
  },
  allowPositionals: true,
});
const prompt = positionals.join(' ').trim();
if (!prompt) {
  console.error('usage: node dev/try-skill.mjs [--required-field] [--saved-value <label>] [--saved-label <name>] '
    + '[--saved-priority <name>] [--confirm-plan] [--branch <name>] [--unfinished-job] [--then <reply>] "<prompt>"');
  process.exit(2);
}

const orbit = await startFakeOrbit();
if (opt['required-field']) {
  orbit.state.customFields.task = [{
    id: 'CF_CLIENT', name: 'Client', field_type: 'single_select', is_required: true,
    options: [{ id: 'OPT_ACME', label: 'Acme' }, { id: 'OPT_GLOBEX', label: 'Globex' }],
  }];
}
if (opt['unfinished-job']) {
  const mine = { created_by: { user_id: 'U_ME', emp_id: 7 }, created_via: 'claude', assignees_arr: [7], assignees_user_arr: ['U_ME'] };
  const yesterday = Date.now() - 24 * 3600 * 1000;
  orbit.state.items.push(
    { id: 'I_JOB', item_key: 'WEB-20', item_type: 'task', title: 'Add CSV export', state_id: 'S_PROG', state_group: 3, created_at: yesterday, ...mine },
    { id: 'I_JOB1', item_key: 'WEB-21', item_type: 'task', title: 'Add toCsv helper with tests', state_id: 'S_DONE', state_group: 4, parent_id: 'I_JOB', created_at: yesterday, ...mine },
    { id: 'I_JOB2', item_key: 'WEB-22', item_type: 'task', title: 'Document CSV export in the README', state_id: 'S_TODO', state_group: 2, parent_id: 'I_JOB', created_at: yesterday, ...mine },
  );
  orbit.state.seq = 22;
  orbit.state.comments.push({ id: 'C_PAUSE', item_id: 'I_JOB', author: { user_id: 'U_ME' }, created_at: yesterday,
    content: '<p>Paused after 1 of 2 steps: toCsv is in src/export.js with tests (WEB-21). Next: the README section (WEB-22).</p>' });
}
const apiHost = new URL(orbit.apiUrl).host;
const store = createTokenStore({ apiHost, tokenStore: 'auto', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-try-data-')) });
orbit.state.refresh = `orb_rt_C1.${crypto.randomBytes(16).toString('base64url')}`;
await store.write(orbit.state.refresh);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-try-repo-'));
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'try-repo', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
fs.writeFileSync(path.join(repo, 'src', 'strings.js'), 'export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);\n');
if (opt['unfinished-job']) {
  fs.writeFileSync(path.join(repo, 'src', 'export.js'), "const cell = (v) => (/[\",\\n]/.test(String(v)) ? `\"${String(v).replace(/\"/g, '\"\"')}\"` : String(v));\n"
    + "export const toCsv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\\n');\n");
}
const taskDefaults = {
  ...(opt['saved-value'] && { fields: { Client: opt['saved-value'] } }),
  ...(opt['saved-label'].length && { labels: opt['saved-label'] }),
  ...(opt['saved-priority'] && { priority: opt['saved-priority'] }),
};
const linkFile = path.join(repo, '.orbit.json');
fs.writeFileSync(linkFile, `${JSON.stringify({
  project: `${APP_URL}/u/0/org/acme/ws/eng/prj/web`, org_id: 'O1', workspace_id: 'W1', project_id: 'P1', review_state: 'In Review',
  ...(opt['confirm-plan'] && { confirm_plan: true }),
  ...(Object.keys(taskDefaults).length && { defaults: { task: taskDefaults } }),
}, null, 2)}\n`);
const linkBefore = fs.readFileSync(linkFile, 'utf8');
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=try', '-c', 'user.email=try@example.test', 'commit', '-qm', 'init'], { cwd: repo });
if (opt.branch) execFileSync('git', ['checkout', '-qb', opt.branch], { cwd: repo });

const env = { ...process.env, ORBIT_API_URL: orbit.apiUrl, ORBIT_APP_URL: APP_URL, ORBIT_OPEN_BROWSER: '0' };
delete env.CLAUDECODE; // allow a nested session when this runs from inside Claude Code
console.error(`repo: ${repo}\nfake Orbit: ${orbit.apiUrl}\nprompt: ${prompt}\n`);

// One turn: the prompt, then each --then reply in the same conversation. Prints what that turn did.
for (const [turn, text] of [prompt, ...opt.then].entries()) {
  const before = new Set(orbit.state.items.map((i) => i.item_key));
  const statesBefore = new Map(orbit.state.items.map((i) => [i.item_key, i.state_id]));
  const commentsBefore = new Set(orbit.state.comments.map((c) => c.id));
  const callsBefore = orbit.state.calls.length;
  if (turn) console.error(`\nreply: ${text}\n`);
  const started = Date.now();
  const code = await new Promise((resolve) => {
    const child = spawn('claude', ['-p', text, ...(turn ? ['--continue'] : []), '--plugin-dir', PLUGIN_DIR,
      '--permission-mode', 'bypassPermissions', '--output-format', 'text'], { cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('close', resolve);
  });

  const byId = new Map(orbit.state.items.map((i) => [i.id, i]));
  const created = orbit.state.items.filter((i) => !before.has(i.item_key));
  const writes = orbit.state.calls.slice(callsBefore).filter((c) => /create|update|comments\/add/.test(c.path));
  console.log(`\n── Orbit after turn ${turn + 1} (exit ${code}, ${Math.round((Date.now() - started) / 1000)} s) ──`);
  if (code !== 0) console.log('claude failed. If it said "Not logged in", run `claude` in a terminal, /login, then try again.');
  console.log(`${created.length} items created, ${writes.length} write calls: ${writes.map((c) => c.path.replace('/v2/work-items/', '')).join(', ') || 'none'}`);
  for (const it of created) {
    const parent = byId.get(it.parent_id || it.story_id || it.feature_id || it.epic_id);
    const comments = orbit.state.comments.filter((c) => c.item_id === it.id);
    const extras = [
      (it.custom_fields || []).map((f) => `${f.field_id}=${f.value}`).join(', '),
      it.label_ids?.length && `labels ${it.label_ids.join(', ')}`,
      it.priority_id !== undefined && `priority ${it.priority_id}`,
    ].filter(Boolean);
    console.log(`- ${it.item_key} [${it.item_type}] ${it.state_id} "${it.title}"${parent ? ` under ${parent.item_key}` : ''} · ${comments.length} comment(s)${extras.map((e) => ` · ${e}`).join('')}`);
    for (const c of comments) console.log(`    › ${c.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  }
  for (const it of orbit.state.items.filter((i) => before.has(i.item_key))) {
    const comments = orbit.state.comments.filter((c) => c.item_id === it.id && !commentsBefore.has(c.id));
    const moved = statesBefore.get(it.item_key) !== it.state_id ? ` ${statesBefore.get(it.item_key)} → ${it.state_id}` : '';
    if (comments.length || moved) console.log(`- ${it.item_key} (existing)${moved}${comments.length ? `, ${comments.length} new comment(s)` : ''}`);
    for (const c of comments) console.log(`    › ${c.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  }
}

const commits = execFileSync('git', ['log', '--format=%s', '-6'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
console.log(`Commits: ${commits.map((s) => `"${s}"`).join(', ')}`);
const linkAfter = fs.existsSync(linkFile) ? fs.readFileSync(linkFile, 'utf8') : '(deleted)';
if (linkAfter !== linkBefore) console.log(`.orbit.json changed:\n${linkAfter.trim()}`);

await store.clear();
await orbit.close();
console.log(`\nThe repo is left at ${repo}`);
