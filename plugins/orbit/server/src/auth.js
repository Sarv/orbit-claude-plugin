// Browser sign-in (plan 2.8): OAuth 2.0 authorization code + PKCE with a loopback redirect.
//
// First time: a one-shot listener on http://127.0.0.1:<random port>/callback, the browser opens
// Orbit's consent page, the user clicks Allow, Orbit redirects back here with a one-time code,
// and we trade it (plus the PKCE verifier) for tokens. The tool call that needed Orbit does not
// wait for any of that: it returns at once with "click Allow, then ask me again".
//
// After that: the access token (1 h) lives in memory only; the refresh token lives in the token
// store and is replaced on every refresh. Refreshes are serialised across all sessions on this
// computer with a lock file, re-reading the store after taking it.

import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { OrbitError } from './errors.js';
import { withFileLock } from './lock.js';
import { log } from './log.js';

const EXPIRY_MARGIN_MS = 60_000;

function defaultOpenBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function sendPage(res, status, title, text) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
    + '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5">'
    + `<h1 style="font-size:1.3rem">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body>`);
}

export function createAuth({ config, store, fetchImpl = fetch, openBrowser = defaultOpenBrowser, now = Date.now }) {
  const lockName = `refresh-${config.apiHost.replace(/[^A-Za-z0-9.-]/g, '_')}`;
  let access = null; // { token, expiresAt }
  let refreshing = null; // this process's in-flight refresh, shared by concurrent callers
  let signIn = null; // the pending browser sign-in, if any
  const connectedListeners = []; // run after a browser sign-in connects (possibly a different user)

  async function tokenRequest(body) {
    let res;
    try {
      res = await fetchImpl(`${config.apiUrl}/connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: config.clientId, ...body }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (err) {
      throw new OrbitError('unknown', `Couldn't reach Orbit to sign in (${err.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
    }
    const json = await res.json().catch(() => null);
    if (res.ok && json?.data?.access_token) return json.data;
    const code = json?.details?.error_code;
    throw new OrbitError(code === 'invalid_grant' ? 'invalid_grant' : 'failed',
      json?.message || `Orbit sign-in failed (HTTP ${res.status}).`, { status: res.status, code });
  }

  function accept(data) {
    access = { token: data.access_token, expiresAt: now() + data.expires_in * 1000 };
  }

  async function doRefresh() {
    return withFileLock(config.dataDir, lockName, async () => {
      // Another session may have rotated the token while we waited for the lock.
      const stored = await store.read();
      if (!stored) throw await startSignIn('first');
      let data;
      try {
        data = await tokenRequest({ grant_type: 'refresh_token', refresh_token: stored });
      } catch (err) {
        if (err.kind !== 'invalid_grant') throw err;
        // Disconnected, password changed, unused for 90 days, or a replayed token: start over.
        log('info', 'Orbit connection ended; starting a new sign-in');
        await store.clear();
        access = null;
        throw await startSignIn('ended');
      }
      await store.write(data.refresh_token);
      accept(data);
      return access.token;
    });
  }

  function refreshNow() {
    refreshing ??= doRefresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  async function getAccessToken() {
    if (access && now() < access.expiresAt - EXPIRY_MARGIN_MS) return access.token;
    return refreshNow();
  }

  function forgetAccessToken() {
    access = null;
  }

  async function beginBrowserSignIn() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');

    const server = http.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    server.unref(); // never keeps the process alive once Claude Code closes stdin
    const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
    const url = `${config.appUrl}/u/0/connect/${config.clientId}?${new URLSearchParams({
      redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, device: config.deviceName,
    })}`;

    const pending = { url, opened: false };
    const timer = setTimeout(() => finish(), config.signInTimeoutMs);
    timer.unref();
    function finish() {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (signIn === pending) signIn = null;
    }

    server.on('request', async (req, res) => {
      const query = new URL(req.url, redirectUri);
      if (query.pathname !== '/callback') { res.writeHead(404).end(); return; }
      if (query.searchParams.get('state') !== state) {
        sendPage(res, 400, 'Not connected', 'This sign-in page is out of date. Ask Claude to connect to Orbit again.');
        return;
      }
      if (query.searchParams.get('error')) {
        sendPage(res, 200, 'Not connected', 'You chose not to connect. Claude Code will ask again next time it needs Orbit.');
        finish();
        return;
      }
      try {
        const data = await tokenRequest({
          grant_type: 'authorization_code', code: query.searchParams.get('code') || '', code_verifier: verifier, redirect_uri: redirectUri,
        });
        await withFileLock(config.dataDir, lockName, () => store.write(data.refresh_token));
        accept(data);
        connectedListeners.forEach((fn) => fn());
        log('info', 'Orbit connected');
        sendPage(res, 200, 'Connected to Orbit', 'Claude Code can now use Orbit as you. You can close this tab and go back to Claude Code.');
      } catch (err) {
        log('warn', 'Orbit sign-in failed', { error: err.message });
        sendPage(res, 400, 'Not connected', `${err.message} Ask Claude to connect to Orbit again.`);
      }
      finish();
    });

    pending.opened = config.openBrowser ? openBrowser(url) : false;
    return pending;
  }

  // Starts a browser sign-in (once — a second caller gets the pending one) and returns the
  // error the tool reports back. Never waits for the user.
  async function startSignIn(reason) {
    signIn ??= await beginBrowserSignIn();
    // Claude reads this and relays it, so it says what to tell the user and what to do meanwhile.
    const lead = `${reason === 'ended' ? "Orbit isn't connected any more" : "Orbit isn't connected yet"}, so nothing was sent.`;
    const action = signIn.opened
      ? "Orbit's Allow page is open in the user's browser: ask them to click Allow and tell you."
      : 'Ask the user to open this link, click Allow and tell you.';
    return new OrbitError('not_connected', `${lead} ${action} Carry on with the coding meanwhile, and run this call `
      + `again once they have.\n${signIn.url}`, { signInUrl: signIn.url });
  }

  const onConnected = (fn) => { connectedListeners.push(fn); };

  // /orbit:logout: end this device's connection in Orbit (POST /connect/revoke, which answers 200
  // whether or not the token was still valid — RFC 7009), then forget the stored token. Under the
  // refresh lock, so a session refreshing at the same moment can't write a fresh token back.
  // The token is forgotten even when Orbit can't be reached; `revoked` says whether Orbit heard.
  async function logout() {
    return withFileLock(config.dataDir, lockName, async () => {
      access = null;
      const stored = await store.read();
      if (!stored) return { wasConnected: false };
      let revoked = false;
      try {
        const res = await fetchImpl(`${config.apiUrl}/connect/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client_id: config.clientId, token: stored }),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        });
        revoked = res.ok;
        if (!res.ok) log('warn', 'Orbit refused to revoke the connection', { status: res.status });
      } catch (err) {
        log('warn', "couldn't reach Orbit to revoke the connection", { error: err.message });
      }
      await store.clear();
      return { wasConnected: true, revoked };
    });
  }

  return { getAccessToken, refreshNow, forgetAccessToken, startSignIn, onConnected, logout };
}
