// Where Orbit is, and where this server keeps its one secret. Everything comes from the
// environment the plugin's .mcp.json passes in; the defaults point at production.
//
//   ORBIT_API_URL      API base, e.g. https://<dev API host>/v2 for dev
//   ORBIT_APP_URL      web app, e.g. https://<dev app host> (consent page + deep links)
//   ORBIT_TOKEN_STORE  auto (default) | keychain | secret-tool | file
//   ORBIT_OPEN_BROWSER 0 to never open a browser (the sign-in link is still in the tool result)
//   CLAUDE_PLUGIN_DATA the plugin's data folder (set by Claude Code); else ~/.orbit-claude

import os from 'node:os';
import path from 'node:path';

// At most this many steps from Claude under one parent, so a job stays readable on the board.
// The steps tool quotes it; skills/orbit-tracking/SKILL.md says the number too, so change both.
export const MAX_STEPS_PER_JOB = 5;

const trimSlash = (url) => String(url).replace(/\/+$/, '');
// A Claude Code version that doesn't know a .mcp.json placeholder passes it through as literal
// text (e.g. "${CLAUDE_PLUGIN_DATA}"); treat that as unset rather than as a URL or a folder name.
const setting = (value) => (value && !value.includes('${') ? value : undefined);

export function loadConfig(env = process.env) {
  const apiUrl = trimSlash(setting(env.ORBIT_API_URL) || 'https://api.orbitorg.com/v2');
  return {
    apiUrl,
    appUrl: trimSlash(setting(env.ORBIT_APP_URL) || 'https://app.orbitorg.com'),
    // One stored connection per Orbit API, so dev and prod never overwrite each other.
    apiHost: new URL(apiUrl).host,
    clientId: 'claude-code',
    tokenStore: setting(env.ORBIT_TOKEN_STORE) || 'auto',
    openBrowser: env.ORBIT_OPEN_BROWSER !== '0',
    dataDir: setting(env.CLAUDE_PLUGIN_DATA) || path.join(os.homedir(), '.orbit-claude'),
    deviceName: os.hostname(),
    requestTimeoutMs: 20_000,
    // Generous for bulk create, so an unknown outcome (never resent) stays rare (plan 2.5).
    bulkRequestTimeoutMs: 60_000,
    // After an unknown create or comment: give Orbit's search index time before looking.
    confirmDelayMs: 2_000,
    // How long a browser sign-in waits for the user to click Allow.
    signInTimeoutMs: 10 * 60_000,
  };
}
