// Orbit lets a Claude connection call only the routes it lists for the app (pt-s3-node:
// common/constants/app-connection-constants.js, APP_CLIENTS['claude-code'].allowedRoutes, every
// one a POST under /v2). This is a copy of that list. Every endpoint the plugin's code calls must be
// on it, so no tool can ship calling something Orbit refuses. A new endpoint: add it to Orbit's
// list first, then here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORBIT_ALLOWED = [
  '/auth/me', '/auth/organisations', '/resolve/path', '/workspaces/list', '/projects/list',
  '/projects/:id/members/list', '/states/list', '/labels/list', '/priorities/list', '/custom-fields/list',
  '/work-items/get', '/work-items/list', '/work-items/children', '/work-items/comments/list',
  '/work-items/activities/list', '/work-items/create', '/work-items/bulk-create', '/work-items/update',
  '/work-items/bulk-update', '/work-items/comments/add',
];

const here = path.dirname(fileURLToPath(import.meta.url));
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  .filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));

/** Paths passed as a literal to `<call>(…)` in these files; `${…}` becomes ":id". */
function calledPaths(sources, call) {
  const found = new Set();
  for (const file of sources) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(new RegExp(`${call}\\(\\s*([\`'])(/[^\`']+)\\1`, 'g'))) found.add(m[2].replace(/\$\{[^}]+\}/g, ':id'));
  }
  return [...found];
}

test('every Orbit endpoint the plugin calls is on the list Orbit allows Claude connections', () => {
  const called = calledPaths(files(path.join(here, '..', 'src')), 'client\\.call');
  assert.ok(called.length >= 19, `found only ${called.length} endpoints: the scan missed some`);
  const refused = called.filter((p) => !ORBIT_ALLOWED.includes(p));
  assert.deepEqual(refused, [], `Orbit refuses these for Claude connections: ${refused.join(', ')}. Add them to `
    + "APP_CLIENTS['claude-code'].allowedRoutes in pt-s3-node first, then to ORBIT_ALLOWED here.");
});

test('the QA script only calls allowed endpoints too (it runs on a real connection)', () => {
  const qaScript = path.join(here, '..', '..', '..', '..', 'dev', 'qa-dev.mjs');
  const called = calledPaths([qaScript], 'rest');
  assert.ok(called.length > 0);
  assert.deepEqual(called.filter((p) => !ORBIT_ALLOWED.includes(p)), []);
});
