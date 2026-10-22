// Runs a real Claude Code session with this plugin loaded (`claude -p --plugin-dir`) in a
// throwaway git repo linked to a FAKE Orbit (plugins/orbit/server/test/fakeOrbitServer.js), then
// prints what Claude did in Orbit. It checks the skill without a deployed backend: does Claude
// track a multi-step job by itself, and leave Orbit alone for a quick question?
//
//   node dev/try-skill.mjs "<prompt>"          e.g. "Add a slugify helper to src/strings.js, with tests"
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
import { startFakeOrbit } from '../plugins/orbit/server/test/fakeOrbitServer.js';
import { createTokenStore } from '../plugins/orbit/server/src/tokenStore.js';

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'orbit');
const APP_URL = 'https://app.acme.test';
const prompt = process.argv.slice(2).join(' ').trim();
if (!prompt) {
  console.error('usage: node dev/try-skill.mjs "<prompt>"');
  process.exit(2);
}

const orbit = await startFakeOrbit();
const apiHost = new URL(orbit.apiUrl).host;
const store = createTokenStore({ apiHost, tokenStore: 'auto', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-try-data-')) });
orbit.state.refresh = `orb_rt_C1.${crypto.randomBytes(16).toString('base64url')}`;
await store.write(orbit.state.refresh);

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-try-repo-'));
fs.mkdirSync(path.join(repo, 'src'));
fs.writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ name: 'try-repo', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
fs.writeFileSync(path.join(repo, 'src', 'strings.js'), 'export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);\n');
fs.writeFileSync(path.join(repo, '.orbit.json'), `${JSON.stringify({
  project: `${APP_URL}/u/0/org/acme/ws/eng/prj/web`, org_id: 'O1', workspace_id: 'W1', project_id: 'P1', review_state: 'In Review',
}, null, 2)}\n`);
execFileSync('git', ['init', '-q'], { cwd: repo });
execFileSync('git', ['add', '.'], { cwd: repo });
execFileSync('git', ['-c', 'user.name=try', '-c', 'user.email=try@example.test', 'commit', '-qm', 'init'], { cwd: repo });

const before = new Set(orbit.state.items.map((i) => i.item_key));
const commentsBefore = new Set(orbit.state.comments.map((c) => c.id));
const env = { ...process.env, ORBIT_API_URL: orbit.apiUrl, ORBIT_APP_URL: APP_URL, ORBIT_OPEN_BROWSER: '0' };
delete env.CLAUDECODE; // allow a nested session when this runs from inside Claude Code
console.error(`repo: ${repo}\nfake Orbit: ${orbit.apiUrl}\nprompt: ${prompt}\n`);
const started = Date.now();
const code = await new Promise((resolve) => {
  const child = spawn('claude', ['-p', prompt, '--plugin-dir', PLUGIN_DIR, '--permission-mode', 'bypassPermissions', '--output-format', 'text'], {
    cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('close', resolve);
});


const byId = new Map(orbit.state.items.map((i) => [i.id, i]));
const created = orbit.state.items.filter((i) => !before.has(i.item_key));
const writes = orbit.state.calls.filter((c) => /create|update|comments\/add/.test(c.path));
console.log(`\n── Orbit after the session (exit ${code}, ${Math.round((Date.now() - started) / 1000)} s) ──`);
if (code !== 0) console.log('claude failed. If it said "Not logged in", run `claude` in a terminal, /login, then try again.');
console.log(`${created.length} items created, ${writes.length} write calls: ${writes.map((c) => c.path.replace('/v2/work-items/', '')).join(', ') || 'none'}`);
for (const it of created) {
  const parent = byId.get(it.parent_id || it.story_id || it.feature_id || it.epic_id);
  const comments = orbit.state.comments.filter((c) => c.item_id === it.id);
  console.log(`- ${it.item_key} [${it.item_type}] ${it.state_id} "${it.title}"${parent ? ` under ${parent.item_key}` : ''} · ${comments.length} comment(s)`);
  for (const c of comments) console.log(`    › ${c.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)}`);
}
for (const it of orbit.state.items.filter((i) => before.has(i.item_key))) {
  const comments = orbit.state.comments.filter((c) => c.item_id === it.id && !commentsBefore.has(c.id));
  if (comments.length) console.log(`- ${it.item_key} (existing) got ${comments.length} comment(s)`);
}

await store.clear();
await orbit.close();
console.log(`\nThe repo is left at ${repo}`);
