// Test doubles: a fake Orbit sign-in server (just /connect/token, with strict refresh rotation),
// an in-memory token store, and config pointing at a throwaway data folder.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function testConfig(overrides = {}) {
  return {
    apiUrl: 'https://orbit.test/v2',
    appUrl: 'https://app.orbit.test',
    apiHost: 'orbit.test',
    clientId: 'claude-code',
    tokenStore: 'file',
    openBrowser: true,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-mcp-test-')),
    deviceName: 'test-mac',
    requestTimeoutMs: 2000,
    bulkRequestTimeoutMs: 2000,
    confirmDelayMs: 0,
    signInTimeoutMs: 5000,
    ...overrides,
  };
}

export function memoryStore(token = null) {
  return {
    name: 'memory',
    token,
    async read() { return this.token; },
    async write(t) { this.token = t; },
    async clear() { this.token = null; },
  };
}

export const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

// Orbit's token endpoint, minus the grace window: only the CURRENT refresh token works, so a
// test that lets two sessions refresh with the same token at once would fail loudly.
export function fakeOrbitAuth() {
  const orbit = {
    codes: new Map(), // code → { challenge, redirectUri }
    currentRefresh: null,
    refreshCalls: 0,
    revoked: [],
    issue() {
      orbit.currentRefresh = `orb_rt_C1.${crypto.randomBytes(8).toString('hex')}`;
      return { token_type: 'Bearer', access_token: `orb_at_${crypto.randomBytes(8).toString('hex')}`, expires_in: 3600, refresh_token: orbit.currentRefresh };
    },
    // What clicking Allow on the consent page does: a code bound to its PKCE challenge.
    allow(consentUrl) {
      const q = new URL(consentUrl).searchParams;
      const code = crypto.randomBytes(16).toString('base64url');
      orbit.codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
      return `${q.get('redirect_uri')}?${new URLSearchParams({ code, state: q.get('state') })}`;
    },
    async fetch(url, init) {
      const body = JSON.parse(init.body);
      if (String(url).endsWith('/connect/revoke')) {
        // RFC 7009: 200 whether or not the token was valid.
        orbit.revoked.push(body.token);
        if (body.token === orbit.currentRefresh) orbit.currentRefresh = null;
        return json(200, { success: true, data: null });
      }
      if (!String(url).endsWith('/connect/token')) throw new Error(`unexpected fetch ${url}`);
      const bad = () => json(400, { success: false, message: 'Your Claude Code connection to Orbit has ended.', details: { error_code: 'invalid_grant' } });
      if (body.grant_type === 'authorization_code') {
        const grant = orbit.codes.get(body.code);
        orbit.codes.delete(body.code);
        const challenge = crypto.createHash('sha256').update(body.code_verifier || '').digest('base64url');
        if (!grant || grant.redirectUri !== body.redirect_uri || grant.challenge !== challenge) return bad();
        return json(200, { success: true, data: orbit.issue() });
      }
      orbit.refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 20)); // long enough for a race to show
      if (!orbit.currentRefresh || body.refresh_token !== orbit.currentRefresh) return bad();
      return json(200, { success: true, data: orbit.issue() });
    },
  };
  return orbit;
}

// ─── Tool harness: the in-memory fake Orbit behind a mocked fetch ──────────────────────────────

const timeoutError = () => Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

/**
 * Real client + resolvers + tools against createFakeOrbit(). Push to `faults` to break the next
 * call to a path: { path, mode: 'timeout' } never reaches Orbit; { path, mode: 'drop', after? }
 * reaches Orbit (which does the work) but the answer is lost; { path, mode: 'respond', status, body }.
 * `calls(path)` = requests Orbit received; `sent(path)` = requests the server tried to send.
 */
export async function toolHarness() {
  const { createFakeOrbit } = await import('./fakeOrbitServer.js');
  const { createOrbitClient } = await import('../src/orbitClient.js');
  const { createResolvers } = await import('../src/resolvers.js');
  const { OrbitError } = await import('../src/errors.js');
  const { TOOLS, runTool } = await import('../src/tools/index.js');

  const fake = createFakeOrbit();
  const token = 'orb_at_test';
  fake.state.access.add(token);
  const config = testConfig();
  const faults = [];
  const attempts = []; // every request the server tried to send, whether or not it reached Orbit
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    attempts.push(path);
    const i = faults.findIndex((f) => `/v2${f.path}` === path);
    const fault = i >= 0 ? faults.splice(i, 1)[0] : null;
    if (fault?.mode === 'timeout') throw timeoutError();
    if (fault?.mode === 'respond') return json(fault.status, fault.body);
    const { status, body } = fake.route(path, JSON.parse(init.body), init.headers.authorization);
    if (fault?.mode === 'drop') {
      fault.after?.(fake);
      throw timeoutError();
    }
    return json(status, body);
  };
  const auth = {
    async getAccessToken() { return token; },
    async refreshNow() { return token; },
    forgetAccessToken() {},
    async startSignIn() { return new OrbitError('not_connected', "Orbit isn't connected."); },
  };
  const client = createOrbitClient({ config, auth, fetchImpl, wait: async () => {} });
  const orbit = { config, client, resolvers: createResolvers({ config, client }) };
  const calls = (path) => fake.state.calls.filter((c) => c.path === `/v2${path}`);
  const sent = (path) => attempts.filter((p) => p === `/v2${path}`).length;
  // Like the MCP SDK: validate + apply defaults with the tool's schema, then run it.
  async function run(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    const res = await runTool(tool, tool.inputSchema.parse(args), orbit);
    return { isError: Boolean(res.isError), text: res.content.map((c) => c.text).join('\n') };
  }
  return { fake, faults, calls, sent, run, orbit, project: 'acme/eng/web' };
}
