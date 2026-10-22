import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAuth } from '../src/auth.js';
import { withFileLock } from '../src/lock.js';
import { testConfig, memoryStore, fakeOrbitAuth } from './helpers.js';

function setup({ storeToken = null, config = testConfig() } = {}) {
  const orbit = fakeOrbitAuth();
  const store = memoryStore(storeToken);
  const opened = [];
  const auth = createAuth({ config, store, fetchImpl: orbit.fetch, openBrowser: (url) => { opened.push(url); return true; } });
  return { orbit, store, opened, auth, config };
}

test('no connection: the call returns at once with a sign-in link, and opens the browser once', async () => {
  const { auth, opened, config } = setup();
  const err = await auth.getAccessToken().catch((e) => e);
  assert.equal(err.kind, 'not_connected');
  assert.match(err.message, /^Orbit isn't connected yet, so nothing was sent\. Orbit's Allow page is open in the user's browser: ask them to click Allow and tell you\. Carry on with the coding meanwhile, and run this call again once they have\.\n/);
  assert.equal(opened.length, 1);
  const consent = new URL(opened[0]);
  assert.equal(`${consent.origin}${consent.pathname}`, `${config.appUrl}/u/0/connect/claude-code`);
  assert.match(consent.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(consent.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(consent.searchParams.get('device'), 'test-mac');
  assert.ok(err.message.includes(opened[0]));

  const again = await auth.getAccessToken().catch((e) => e);
  assert.equal(again.signInUrl, err.signInUrl);
  assert.equal(opened.length, 1, 'a pending sign-in is reused, not reopened');
});

test('clicking Allow connects: the refresh token is stored, the next call just works', async () => {
  const { auth, opened, orbit, store } = setup();
  await auth.getAccessToken().catch(() => {});
  const res = await fetch(orbit.allow(opened[0]));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Connected to Orbit/);
  assert.equal(store.token, orbit.currentRefresh);
  assert.match(await auth.getAccessToken(), /^orb_at_/);
  assert.equal(orbit.refreshCalls, 0, 'the code exchange already gave us an access token');
});

test('a callback with the wrong state is refused and the sign-in stays open; Cancel ends it', async () => {
  const { auth, opened } = setup();
  await auth.getAccessToken().catch(() => {});
  const redirect = new URL(opened[0]).searchParams.get('redirect_uri');
  assert.equal((await fetch(`${redirect}?code=x&state=forged`)).status, 400);

  const state = new URL(opened[0]).searchParams.get('state');
  const cancelled = await fetch(`${redirect}?error=access_denied&state=${state}`);
  assert.match(await cancelled.text(), /chose not to connect/);
  await auth.getAccessToken().catch(() => {});
  assert.equal(opened.length, 2, 'after Cancel, the next call starts a new sign-in');
});

test('a stored connection refreshes, rotates the stored token, and reuses the access token', async () => {
  const { auth, orbit, store } = setup();
  orbit.issue();
  store.token = orbit.currentRefresh;
  const first = store.token;
  const token = await auth.getAccessToken();
  assert.match(token, /^orb_at_/);
  assert.notEqual(store.token, first, 'the refresh token changes every time');
  assert.equal(await auth.getAccessToken(), token);
  assert.equal(orbit.refreshCalls, 1);
});

test('a refused refresh (disconnected, password changed…) clears the store and starts a new sign-in', async () => {
  const { auth, store, opened } = setup({ storeToken: 'orb_rt_C1.revoked' });
  const err = await auth.getAccessToken().catch((e) => e);
  assert.equal(err.kind, 'not_connected');
  assert.match(err.message, /isn't connected any more/);
  assert.equal(store.token, null);
  assert.equal(opened.length, 1);
});

test('two sessions sharing one connection refresh at once and both keep working (lock + re-read)', async () => {
  const config = testConfig();
  const orbit = fakeOrbitAuth();
  orbit.issue();
  const store = memoryStore(orbit.currentRefresh); // the shared keychain entry
  const make = () => createAuth({ config, store, fetchImpl: orbit.fetch, openBrowser: () => true });
  const [a, b] = [make(), make()];
  const [ta, tb] = await Promise.all([a.getAccessToken(), b.getAccessToken()]);
  assert.match(ta, /^orb_at_/);
  assert.match(tb, /^orb_at_/);
  assert.equal(orbit.refreshCalls, 2, 'one refresh each, one after the other, each with the latest token');
  assert.equal(store.token, orbit.currentRefresh);
});

test('a lock left behind by a dead process is taken over', async () => {
  const dir = testConfig().dataDir;
  const file = path.join(dir, 'x.lock');
  fs.writeFileSync(file, '999999');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(file, old, old);
  assert.equal(await withFileLock(dir, 'x', async () => 'ran'), 'ran');
  assert.equal(fs.existsSync(file), false);
});

test('logout revokes the connection in Orbit, then forgets it; the next call starts a new sign-in', async () => {
  const { auth, orbit, store, opened } = setup();
  const first = orbit.issue();
  await store.write(first.refresh_token);
  await auth.getAccessToken();
  const stored = store.token;

  assert.deepEqual(await auth.logout(), { wasConnected: true, revoked: true });
  assert.deepEqual(orbit.revoked, [stored]);
  assert.equal(store.token, null);
  const err = await auth.getAccessToken().catch((e) => e);
  assert.equal(err.kind, 'not_connected', 'the in-memory access token is gone too');
  assert.equal(opened.length, 1);

  assert.deepEqual(await auth.logout(), { wasConnected: false });
});

test('logout forgets the token even when Orbit can\'t be reached, and says so', async () => {
  const store = memoryStore('orb_rt_C1.stale');
  const auth = createAuth({ config: testConfig(), store, fetchImpl: async () => { throw new TypeError('fetch failed'); }, openBrowser: () => true });
  assert.deepEqual(await auth.logout(), { wasConnected: true, revoked: false });
  assert.equal(store.token, null);
});
