import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrbitClient } from '../src/orbitClient.js';
import { OrbitError } from '../src/errors.js';
import { testConfig, json } from './helpers.js';

function fakeAuth() {
  let n = 0;
  return {
    refreshes: 0,
    async getAccessToken() { return `orb_at_${n}`; },
    async refreshNow() { this.refreshes += 1; n += 1; return `orb_at_${n}`; },
    forgetAccessToken() {},
    async startSignIn() { return new OrbitError('not_connected', "Orbit isn't connected any more."); },
  };
}

function client(responses) {
  const calls = [];
  const auth = fakeAuth();
  const waits = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { calls, auth, waits, c: createOrbitClient({ config: testConfig(), auth, fetchImpl, wait: async (ms) => { waits.push(ms); } }) };
}

test('POSTs JSON with the API-client headers and returns data', async () => {
  const { c, calls } = client([json(200, { success: true, data: { items: [1] } })]);
  assert.deepEqual(await c.call('/work-items/list', { size: 1 }), { items: [1] });
  assert.equal(calls[0].url, 'https://orbit.test/v2/work-items/list');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-http-client'], 'API');
  assert.equal(calls[0].init.headers.authorization, 'Bearer orb_at_0');
  assert.deepEqual(JSON.parse(calls[0].init.body), { size: 1 });
});

test('a 401 refreshes once and retries', async () => {
  const { c, calls, auth } = client([json(401, { success: false }), json(200, { success: true, data: 'ok' })]);
  assert.equal(await c.call('/x'), 'ok');
  assert.equal(auth.refreshes, 1);
  assert.equal(calls[1].init.headers.authorization, 'Bearer orb_at_1');
});

test('a 401 after refreshing means the connection ended → not_connected', async () => {
  const { c } = client([json(401, {}), json(401, {})]);
  await assert.rejects(c.call('/x'), { kind: 'not_connected' });
});

test('a 429 waits for Retry-After (capped) and retries once', async () => {
  const { c, waits } = client([json(429, { message: 'slow down' }, { 'retry-after': '7' }), json(200, { success: true, data: 1 })]);
  assert.equal(await c.call('/x'), 1);
  assert.deepEqual(waits, [7000]);
});

test("Orbit's hourly cap on new items is never retried: waiting seconds won't help", async () => {
  const quota = json(429, { message: 'Claude has created a lot of items', details: { error_code: 'CONNECTION_CREATE_QUOTA' } }, { 'retry-after': '3600' });
  const { c, waits, calls } = client([quota]);
  await assert.rejects(c.call('/work-items/create'), {
    kind: 'rate_limited', code: 'CONNECTION_CREATE_QUOTA',
    message: /hourly limit on new items from Claude is reached, so nothing was created\. Don't create more Orbit items for now/,
  });
  assert.deepEqual(waits, []);
  assert.equal(calls.length, 1);
});

test('a route Orbit keeps from Claude connections reads as such, not as a permissions problem', async () => {
  const { c } = client([json(403, { message: "Claude Code can't do this in Orbit.", details: { error_code: 'CONNECTION_FORBIDDEN' } })]);
  await assert.rejects(c.call('/work-items/delete'), { kind: 'forbidden', message: /^Orbit doesn't let Claude Code do this, so nothing was changed/ });
});

test('errors are classified: definite failures carry Orbit\'s message; no answer is "unknown"', async () => {
  const cases = [
    [json(403, { message: 'nope', details: { error_code: 'NOT_PROJECT_MEMBER' } }), 'forbidden', /don't have permission/],
    [json(404, { message: 'Work item not found' }), 'not_found', /Work item not found/],
    [json(400, { message: 'Title is too short', details: { error_code: 'VALIDATION_ERROR' } }), 'failed', /Title is too short/],
    [json(500, { message: 'Something went wrong. Please try again later' }), 'failed', /Something went wrong/],
    [new Response('bad gateway', { status: 502 }), 'unknown', /HTTP 502/],
    [new Response('', { status: 500 }), 'unknown', /HTTP 500/],
    [Object.assign(new Error('socket hang up'), { name: 'TypeError' }), 'unknown', /network error/],
    [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'unknown', /timed out/],
  ];
  for (const [response, kind, message] of cases) {
    const { c } = client([response]);
    await assert.rejects(c.call('/x'), (err) => err.kind === kind && message.test(err.message));
  }
});
