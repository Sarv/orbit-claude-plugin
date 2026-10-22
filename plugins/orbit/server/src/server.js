// The Orbit MCP server: one shared Orbit connection (auth + client + caches) for the process,
// served over stdio. serveStdio takes a factory and pins one McpServer per connection; the
// tools on every instance share the same `orbit` below.

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { createTokenStore } from './tokenStore.js';
import { createAuth } from './auth.js';
import { createOrbitClient } from './orbitClient.js';
import { createResolvers } from './resolvers.js';
import { registerTools } from './tools/index.js';
import { log } from './log.js';

export function createOrbit(config, overrides = {}) {
  const store = overrides.store || createTokenStore(config);
  const auth = createAuth({ config, store, ...overrides.auth });
  const client = createOrbitClient({ config, auth, ...overrides.client });
  const resolvers = createResolvers({ config, client });
  auth.onConnected(() => resolvers.clearCache());
  return { config, store, auth, client, resolvers };
}

export function createServer(orbit) {
  const server = new McpServer({ name: 'orbit', version: pkg.version }, { capabilities: { tools: {} } });
  registerTools(server, orbit);
  return server;
}

const orbit = createOrbit(loadConfig());
serveStdio(() => createServer(orbit), { onerror: (err) => log('error', 'MCP transport error', { error: err.message }) });
log('info', `ready (Orbit API ${orbit.config.apiUrl}, token store: ${orbit.store.name})`);
