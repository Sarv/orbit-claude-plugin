// A lock file that serialises token refreshes across every Claude Code session on this computer
// (they share one connection, plan 2.8). `wx` creates the file only if it doesn't exist, which
// is atomic on every platform. A lock older than STALE_MS belongs to a process that died.

import fs from 'node:fs/promises';
import path from 'node:path';

const STALE_MS = 30_000;
const WAIT_MS = 20_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withFileLock(dir, name, fn) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.lock`);
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const stat = await fs.stat(file).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_MS) {
        await fs.rm(file, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error('Timed out waiting for another Claude Code session to refresh the Orbit connection');
      await sleep(100 + Math.random() * 150);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(file, { force: true });
  }
}
