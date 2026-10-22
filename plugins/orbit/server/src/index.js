// Entry point. Checks the Node.js version BEFORE loading anything else, so an old Node gets a
// clear message instead of a syntax error from a dependency (plan 2.7: Node 22+).
const MIN_NODE_MAJOR = 22;
const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE_MAJOR) {
  process.stderr.write(`[orbit-mcp] error: Orbit for Claude Code needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${process.versions.node}. Install a current Node.js LTS and restart Claude Code.\n`);
  process.exit(1);
}
await import('./server.js');
