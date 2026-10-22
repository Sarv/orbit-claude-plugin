import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTokenStore } from '../src/tokenStore.js';
import { htmlToText, truncate, day, list } from '../src/format.js';
import { testConfig } from './helpers.js';

test('file store: owner-only file, survives a new instance, clear removes it', async () => {
  const config = testConfig({ tokenStore: 'file' });
  const store = createTokenStore(config);
  assert.equal(await store.read(), null);
  await store.write('orb_rt_A.one');
  await store.write('orb_rt_A.two');
  const file = path.join(config.dataDir, 'connection-orbit.test.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(await createTokenStore(config).read(), 'orb_rt_A.two');
  assert.deepEqual(fs.readdirSync(config.dataDir).filter((f) => f.endsWith('.tmp')), []);
  await store.clear();
  assert.equal(await store.read(), null);
});

test('file store keeps dev and prod connections apart', async () => {
  const dataDir = testConfig().dataDir;
  const dev = createTokenStore({ apiHost: 'dev-api.orbit.test', dataDir, tokenStore: 'file' });
  const prod = createTokenStore({ apiHost: 'api.orbitorg.com', dataDir, tokenStore: 'file' });
  await dev.write('orb_rt_D.x');
  assert.equal(await prod.read(), null);
});

test('htmlToText turns Orbit HTML into readable plain text', () => {
  const html = '<h2>Plan</h2><p>Add <strong>CSV</strong> export &amp; tests.</p><ul><li>Button</li><li>Endpoint</li></ul><p>Line<br>break &#39;q&#39; &#x2713;</p><script>x()</script>';
  assert.equal(htmlToText(html), 'Plan\nAdd CSV export & tests.\n\n- Button\n- Endpoint\n\nLine\nbreak \'q\' ✓');
  assert.equal(htmlToText(null), '');
});

test('small helpers', () => {
  assert.equal(truncate('abcdef', 4), 'abc…');
  assert.equal(truncate('abc', 4), 'abc');
  assert.equal(day(Date.UTC(2026, 9, 20, 15)), '2026-10-20');
  assert.equal(day(null), '');
  assert.equal(list(['a', 'b', 'c']), 'a, b and c');
  assert.equal(list(['a']), 'a');
});

test('config: a .mcp.json placeholder Claude Code left unexpanded counts as unset', async () => {
  const { loadConfig } = await import('../src/config.js');
  const config = loadConfig({
    ORBIT_API_URL: '${ORBIT_API_URL:-https://api.orbitorg.com/v2}', ORBIT_APP_URL: 'https://dev-app.orbit.test/',
    CLAUDE_PLUGIN_DATA: '${CLAUDE_PLUGIN_DATA}',
  });
  assert.equal(config.apiUrl, 'https://api.orbitorg.com/v2');
  assert.equal(config.appUrl, 'https://dev-app.orbit.test');
  assert.ok(!config.dataDir.includes('${'));
  assert.equal(loadConfig({ CLAUDE_PLUGIN_DATA: '/data/orbit' }).dataDir, '/data/orbit');
});
