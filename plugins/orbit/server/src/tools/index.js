// Registers every tool. Each tool module exports { name, title, description, inputSchema,
// readOnly, idempotent?, handler(args, orbit) → text | { text, isError } }. Errors become a short
// text result with isError, so Claude sees Orbit's own message (or the sign-in link) instead of
// a protocol error.

import { OrbitError } from '../errors.js';
import { log } from '../log.js';
import whoami from './whoami.js';
import listProjects from './listProjects.js';
import resolveUrl from './resolveUrl.js';
import getProjectConfig from './getProjectConfig.js';
import searchWorkItems from './searchWorkItems.js';
import getWorkItem from './getWorkItem.js';
import listComments from './listComments.js';
import createWorkItem from './createWorkItem.js';
import createWorkItems from './createWorkItems.js';
import updateWorkItem from './updateWorkItem.js';
import setStatus from './setStatus.js';
import addComment from './addComment.js';
import logout from './logout.js';

export const TOOLS = [
  whoami, listProjects, resolveUrl, getProjectConfig, searchWorkItems, getWorkItem, listComments,
  createWorkItem, createWorkItems, updateWorkItem, setStatus, addComment,
  logout, // only for /orbit:logout
];

// Claude Code warns above 10k tokens of tool output and truncates at 25k. Each tool keeps its own
// output short; this is the backstop, cut at a line so no line is half-shown.
export const MAX_OUTPUT_CHARS = 20_000;

function capped(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const cut = text.lastIndexOf('\n', MAX_OUTPUT_CHARS);
  return `${text.slice(0, cut > 0 ? cut : MAX_OUTPUT_CHARS)}\n…the rest was cut to keep this short. Narrow the request (a filter, fewer items).`;
}

export async function runTool(tool, args, orbit) {
  try {
    const out = await tool.handler(args, orbit);
    const { text, isError } = typeof out === 'string' ? { text: out } : out;
    return { ...(isError && { isError: true }), content: [{ type: 'text', text: capped(text) }] };
  } catch (err) {
    if (!(err instanceof OrbitError)) log('error', `${tool.name} failed`, { error: err.stack || err.message });
    const text = err instanceof OrbitError ? err.message
      : `Orbit tool error: ${err.message}.${tool.readOnly ? '' : ' It may or may not have been saved: check with a read before trying again.'}`
        + ' Carry on with the coding.';
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

export function registerTools(server, orbit) {
  for (const tool of TOOLS) {
    server.registerTool(tool.name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      // No tool deletes anything (v1 has no delete tool).
      annotations: tool.readOnly
        ? { readOnlyHint: true, openWorldHint: true }
        : { readOnlyHint: false, destructiveHint: false, idempotentHint: Boolean(tool.idempotent), openWorldHint: true },
    }, (args) => runTool(tool, args, orbit));
  }
}
