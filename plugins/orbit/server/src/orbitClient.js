// Every Orbit API call: POST, JSON, `x-http-client: API` + the connection's bearer token. Returns
// the response's `data`; anything else becomes an OrbitError whose `kind` says whether the
// request definitely failed or might have happened anyway (plan 2.5).

import { OrbitError } from './errors.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_RETRY_AFTER_S = 30;

export function createOrbitClient({ config, auth, fetchImpl = fetch, wait = sleep }) {
  async function send(path, body, token, timeoutMs) {
    try {
      return await fetchImpl(`${config.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-http-client': 'API', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new OrbitError('unknown', `No answer from Orbit (${err.name === 'TimeoutError' ? 'timed out' : 'network error'}).`);
    }
  }

  async function toResult(res) {
    const json = await res.json().catch(() => null);
    if (res.ok && json && json.success !== false) return json.data;
    const message = json && typeof json.message === 'string' ? json.message : null;
    const extra = { status: res.status, code: json?.details?.error_code };
    if ([502, 503, 504].includes(res.status) || (res.status >= 500 && !message)) {
      throw new OrbitError('unknown', `Orbit didn't answer properly (HTTP ${res.status}).`, extra);
    }
    if (res.status === 403) {
      throw new OrbitError('forbidden', "Orbit refused: you don't have permission to do that in this project, so nothing "
        + "was changed. Don't retry; tell the user.", extra);
    }
    if (res.status === 404) throw new OrbitError('not_found', message || 'Not found in Orbit.', extra);
    if (res.status === 429) {
      throw new OrbitError('rate_limited', 'Orbit is busy (too many requests), so nothing was saved. Carry on, and retry '
        + 'this call once at your next step.', extra);
    }
    throw new OrbitError('failed', message || `Orbit refused the request (HTTP ${res.status}).`, extra);
  }

  async function call(path, body = {}, { timeoutMs = config.requestTimeoutMs } = {}) {
    let res = await send(path, body, await auth.getAccessToken(), timeoutMs);
    if (res.status === 401) {
      // Expired or revoked: refresh once (which starts a sign-in if the connection has ended).
      auth.forgetAccessToken();
      res = await send(path, body, await auth.refreshNow(), timeoutMs);
      if (res.status === 401) throw await auth.startSignIn('ended');
    }
    if (res.status === 429) {
      // A 429 means Orbit did nothing, so one retry is safe for any request.
      const seconds = Math.min(Number(res.headers.get('retry-after')) || 5, MAX_RETRY_AFTER_S);
      await wait(seconds * 1000);
      res = await send(path, body, await auth.getAccessToken(), timeoutMs);
    }
    return toResult(res);
  }

  return { call };
}
