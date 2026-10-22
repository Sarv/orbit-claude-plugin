// The real server binary over stdio (as Claude Code runs it) against a fake Orbit API: the MCP
// handshake, the browser sign-in round trip, every read tool, a tracked job through the write
// tools, a restart that reuses the stored connection, an expired access token, and nothing but
// JSON-RPC on stdout.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeOrbit } from './fakeOrbitServer.js';

// `npm run test:dist` runs this file against the committed bundle instead of the source.
const ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', process.env.ORBIT_MCP_ENTRY || 'src/index.js');
const APP_URL = 'https://app.acme.test';

function startServer(apiUrl, dataDir) {
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, ORBIT_API_URL: apiUrl, ORBIT_APP_URL: APP_URL, ORBIT_TOKEN_STORE: 'file', ORBIT_OPEN_BROWSER: '0', CLAUDE_PLUGIN_DATA: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const stdoutLines = [];
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      stdoutLines.push(line);
      const msg = JSON.parse(line); // throws (fails the test) on anything that isn't JSON-RPC
      pending.get(msg.id)?.(msg);
    }
  });
  child.stderr.on('data', () => {});
  const request = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  return {
    stdoutLines,
    async initialize() {
      const res = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      notify('notifications/initialized');
      return res;
    },
    listTools: () => request('tools/list', {}),
    async callTool(name, args = {}) {
      const res = await request('tools/call', { name, arguments: args });
      return { isError: Boolean(res.result?.isError), text: res.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(res.error) };
    },
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); }),
  };
}

let orbit;
let dataDir;
let server;

before(async () => {
  orbit = await startFakeOrbit();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mcp-e2e-'));
  server = startServer(orbit.apiUrl, dataDir);
});
after(async () => {
  await server?.stop();
  await orbit.close();
});

const READ_TOOLS = ['orbit_get_project_config', 'orbit_get_work_item', 'orbit_list_comments', 'orbit_list_projects',
  'orbit_resolve_url', 'orbit_search_work_items', 'orbit_whoami'];
const WRITE_TOOLS = ['orbit_add_comment', 'orbit_create_work_item', 'orbit_create_work_items', 'orbit_logout',
  'orbit_set_status', 'orbit_update_work_item'];

test('handshake and the 13 tools: 7 read, 5 write + logout, none destructive', async () => {
  const init = await server.initialize();
  assert.equal(init.result.serverInfo.name, 'orbit');
  const { result } = await server.listTools();
  assert.deepEqual(result.tools.map((t) => t.name).sort(), [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.ok(result.tools.every((t) => t.description.length > 40));
  for (const t of result.tools) {
    const write = WRITE_TOOLS.includes(t.name);
    assert.equal(t.annotations.readOnlyHint, !write, t.name);
    if (write) assert.equal(t.annotations.destructiveHint, false, t.name);
  }
  const search = result.tools.find((t) => t.name === 'orbit_search_work_items');
  assert.deepEqual(search.inputSchema.required, ['project']);
  const status = result.tools.find((t) => t.name === 'orbit_set_status');
  assert.deepEqual(status.inputSchema.required.sort(), ['items', 'project', 'status']);
  const update = result.tools.find((t) => t.name === 'orbit_update_work_item');
  assert.equal(update.inputSchema.properties.state, undefined, 'status only changes through orbit_set_status');
});

test('first call: not connected → sign-in link; after Allow the same call works', async () => {
  const first = await server.callTool('orbit_whoami');
  assert.equal(first.isError, true);
  assert.match(first.text, /isn't connected yet, so nothing was sent\. Ask the user to open this link, click Allow and tell you\. Carry on with the coding meanwhile/);
  const consentUrl = first.text.split('\n').pop();
  assert.ok(consentUrl.startsWith(`${APP_URL}/u/0/connect/claude-code?`));

  const page = await fetch(orbit.allow(consentUrl), { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), `${APP_URL}/u/0/connected-apps`);

  const second = await server.callTool('orbit_whoami');
  assert.equal(second.isError, false);
  assert.match(second.text, /Connected to Orbit as Dev <dev@acme\.test>/);
  assert.match(second.text, /Acme \(acme\) — employee id 7/);
});

test('read tools return compact, resolved text', async () => {
  const projects = await server.callTool('orbit_list_projects');
  assert.equal(projects.text, `acme/eng/web — Web App — ${APP_URL}/u/0/org/acme/ws/eng/prj/web`);

  const resolved = await server.callTool('orbit_resolve_url', { url: `${APP_URL}/u/0/org/acme/ws/eng/prj/web/work-items/web-2` });
  assert.match(resolved.text, /project_id P1; its item keys look like WEB-123/);
  assert.match(resolved.text, /Work item: WEB-2 \(task\) "Add CSV export" — item_id I_TASK/);

  const config = await server.callTool('orbit_get_project_config', { project: 'acme/eng/web' });
  assert.match(config.text, /States: Todo \(unstarted, default\) · In Progress \(started\) · In Review \(started\) · Done \(completed\)/);
  assert.match(config.text, /- Dev <dev@acme\.test> \(you\)/);

  const mine = await server.callTool('orbit_search_work_items', { project: 'acme/eng/web' });
  assert.match(mine.text, /^1 of 1 open items assigned to you in Web App/);
  assert.match(mine.text, /WEB-2 \[task\] In Progress — Add CSV export · Dev · via Claude/);

  const subtasks = await server.callTool('orbit_search_work_items', { project: 'acme/eng/web', parent: 'WEB-2', assignee: 'anyone' });
  assert.match(subtasks.text, /WEB-3 \[task\] Todo — Build CSV · Ana/);

  const item = await server.callTool('orbit_get_work_item', { project: 'acme/eng/web', item: 'WEB-2' });
  assert.match(item.text, /^WEB-2 · Add CSV export\nType: task · State: In Progress \(started\) · Priority: High/);
  assert.match(item.text, /Created by Dev on 2026-10-20 via Claude/);
  assert.match(item.text, /Points: task 3/);
  assert.match(item.text, /Story: WEB-1 Reports/);
  assert.match(item.text, /Link: https:\/\/app\.acme\.test\/u\/0\/org\/acme\/ws\/eng\/prj\/web\/work-items\/WEB-2/);
  assert.match(item.text, /Description:\nExport CSV/);
  assert.match(item.text, /Subtasks \(1\):\n- WEB-3/);

  const comments = await server.callTool('orbit_list_comments', { project: 'acme/eng/web', item: 'WEB-2' });
  assert.match(comments.text, /— Ana, 2026-10-21 09:00 UTC:\nPlease add tests\n— Dev, 2026-10-21 09:30 UTC \(reply\):\nDone: exportCsv\(\)/);
});

test('clear errors: unknown key, a project you are not in, a link from another Orbit, bad input', async () => {
  const missing = await server.callTool('orbit_get_work_item', { project: 'acme/eng/web', item: 'WEB-999' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /no work item WEB-999 in Web App/);

  const other = await server.callTool('orbit_search_work_items', { project: 'acme/eng/secret' });
  assert.equal(other.text, 'You do not have access to this project');

  const wrongHost = await server.callTool('orbit_resolve_url', { url: 'https://app.orbitorg.com/u/0/org/acme/ws/eng/prj/web' });
  assert.match(wrongHost.text, /That link is for app\.orbitorg\.com, but this Orbit connection is for app\.acme\.test/);

  const badState = await server.callTool('orbit_search_work_items', { project: 'acme/eng/web', state: 'Shipped', item_type: 'task' });
  assert.match(badState.text, /No state called "Shipped".*Todo, In Progress, In Review, Done/);
});

test('a tracked job: parent, steps, statuses, comments — all via Claude, as me', async () => {
  const project = 'acme/eng/web';
  const parent = await server.callTool('orbit_create_work_item', { project, title: 'Add XLSX export', description: 'Export the report as **XLSX**.' });
  assert.equal(parent.isError, false, parent.text);
  const parentKey = parent.text.match(/^Created (WEB-\d+)/)[1];

  const steps = await server.callTool('orbit_create_work_items', { project, parent: parentKey, steps: [{ title: 'Add XLSX writer' }, { title: 'Wire the button' }] });
  assert.match(steps.text, new RegExp(`^Created 2 of 2 steps as subtasks of ${parentKey}`));
  const stepKeys = [...steps.text.matchAll(/✓ (WEB-\d+)/g)].map((m) => m[1]);
  assert.equal(stepKeys.length, 2);

  for (const key of stepKeys) {
    assert.match((await server.callTool('orbit_set_status', { project, items: [key], status: 'started', review_state: 'In Review' })).text, /→ "In Progress"/);
    assert.match((await server.callTool('orbit_add_comment', { project, item: key, text: `Done: ${key}.\nFiles: \`export.js\`` })).text, /^Commented on/);
  }
  const closed = await server.callTool('orbit_set_status', { project, items: [...stepKeys, parentKey], status: 'completed', review_state: 'In Review' });
  assert.equal(closed.text.split('\n').filter((l) => l.endsWith('→ "Done"')).length, 3, closed.text);

  for (const key of [parentKey, ...stepKeys]) {
    const it = orbit.find(key);
    assert.equal(it.created_via, 'claude');
    assert.equal(it.created_by.user_id, 'U_ME');
    assert.deepEqual(it.assignees_arr, [7]);
    assert.equal(it.state_id, 'S_DONE');
  }
  assert.equal(orbit.find(parentKey).description, '<p>Export the report as <strong>XLSX</strong>.</p>');
  assert.ok(stepKeys.every((k) => orbit.find(k).parent_id === orbit.find(parentKey).id));
});

test('an expired access token is refreshed silently', async () => {
  const before = orbit.state.refresh;
  orbit.expireAccessTokens();
  const res = await server.callTool('orbit_search_work_items', { project: 'acme/eng/web' });
  assert.equal(res.isError, false);
  assert.match(res.text, /WEB-2/);
  assert.notEqual(orbit.state.refresh, before, 'the 401 led to a refresh (rotating the refresh token)');
});

test('a restart reuses the stored connection without a new sign-in', async () => {
  await server.stop();
  server = startServer(orbit.apiUrl, dataDir);
  await server.initialize();
  const res = await server.callTool('orbit_get_work_item', { project: 'acme/eng/web', item: 'WEB-3' });
  assert.equal(res.isError, false);
  assert.match(res.text, /Type: task \(subtask\)/);
});

test('/orbit:logout: revoked in Orbit and forgotten here; the next call starts a new sign-in', async () => {
  const out = await server.callTool('orbit_logout');
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /^Disconnected from Orbit \(127\.0\.0\.1:\d+\)/);
  assert.equal(orbit.state.revoked, true);
  const store = fs.readdirSync(dataDir).filter((f) => f.startsWith('connection-'));
  assert.deepEqual(store, [], 'the stored refresh token is gone');
  const next = await server.callTool('orbit_whoami');
  assert.equal(next.isError, true);
  assert.match(next.text, /isn't connected yet, so nothing was sent\. Ask the user to open this link, click Allow and tell you\. Carry on with the coding meanwhile/);
  assert.match((await server.callTool('orbit_logout')).text, /wasn't connected/);
});

test('stdout carried only JSON-RPC', () => {
  assert.ok(server.stdoutLines.length > 0);
  for (const line of server.stdoutLines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
});
