// Where the refresh token lives between sessions (plan 2.8). It is the only secret this server
// keeps on disk; access tokens stay in memory. In order of preference:
//   macOS  → the login Keychain, through the built-in `security` tool
//   Linux  → the desktop keyring, through `secret-tool` (libsecret), when it works
//   else   → a file only this user can read, in the plugin's data folder
// No native modules, so the server still bundles to one file. The secret always reaches a child
// process on stdin, never in its arguments (which `ps` would show).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { log } from './log.js';

const SERVICE = 'orbit-claude-code';

function run(cmd, args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ code: -1, stdout: '' })); // e.g. the tool isn't installed
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(input ?? '');
  });
}

function keychainStore(account) {
  return {
    name: 'keychain',
    async read() {
      const { code, stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      return code === 0 && stdout.trim() ? stdout.trim() : null;
    },
    async write(token) {
      // `security -i` reads its command from stdin. Tokens are base64url + '.', so no quoting issues.
      await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -w ${token}\n`);
      if ((await this.read()) !== token) throw new Error('Keychain write failed');
    },
    async clear() {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    },
  };
}

function secretToolStore(account) {
  const attrs = ['service', SERVICE, 'account', account];
  return {
    name: 'secret-tool',
    async read() {
      const { code, stdout } = await run('secret-tool', ['lookup', ...attrs]);
      return code === 0 && stdout.trim() ? stdout.trim() : null;
    },
    async write(token) {
      const { code } = await run('secret-tool', ['store', '--label=Orbit (Claude Code)', ...attrs], token);
      if (code !== 0 || (await this.read()) !== token) throw new Error('secret-tool write failed');
    },
    async clear() {
      await run('secret-tool', ['clear', ...attrs]);
    },
  };
}

function fileStore(dataDir, account) {
  const file = path.join(dataDir, `connection-${account.replace(/[^A-Za-z0-9.-]/g, '_')}.json`);
  return {
    name: 'file',
    async read() {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8')).refresh_token || null;
      } catch {
        return null;
      }
    },
    async write(token) {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ refresh_token: token }), { mode: 0o600 });
      await fs.rename(tmp, file); // atomic: a concurrent reader sees the old token or the new one
    },
    async clear() {
      await fs.rm(file, { force: true });
    },
  };
}

// A preferred store that falls back to the file when it can't write (e.g. no keyring daemon).
// Reads check the file too: an earlier session may have fallen back to it.
function withFileFallback(primary, file) {
  return {
    name: primary.name,
    async read() { return (await primary.read()) ?? (await file.read()); },
    async write(token) {
      try {
        await primary.write(token);
        await file.clear();
      } catch (err) {
        log('warn', `${primary.name} unavailable, storing the Orbit connection in a private file instead`, { error: err.message });
        await file.write(token);
      }
    },
    async clear() { await Promise.all([primary.clear(), file.clear()]); },
  };
}

export function createTokenStore(config) {
  const account = config.apiHost;
  const file = fileStore(config.dataDir, account);
  const mode = config.tokenStore;
  if (mode === 'file') return file;
  if (mode === 'keychain' || (mode === 'auto' && process.platform === 'darwin')) {
    return withFileFallback(keychainStore(account), file);
  }
  if (mode === 'secret-tool' || (mode === 'auto' && process.platform === 'linux')) {
    return withFileFallback(secretToolStore(account), file);
  }
  return file;
}
