import { z } from 'zod';
import { truncate, day } from '../format.js';
import { groupName } from '../resolvers.js';
import { projectField } from './shared.js';

// The item a work item sits directly under; parent_id first, so a subtask points at its task.
const PARENT_FIELDS = ['parent_id', 'story_id', 'feature_id', 'epic_id'];
const directParent = (it) => PARENT_FIELDS.map((f) => it[f]).find(Boolean) || null;
// The user's latest items created through Claude that are scanned for jobs.
const SCANNED = 100;
const MAX_STEPS_SHOWN = 8;
const finished = (it) => ['completed', 'cancelled'].includes(groupName(it.state_group));

/**
 * Jobs from the user's items created through Claude: a job is the item its steps sit under (a parent
 * Claude made, or an item the user named) with the Claude items under it. A Claude item with no
 * parent and no steps is a job on its own (tracked on the item itself).
 */
function groupJobs(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const hasSteps = new Set(items.map(directParent).filter((id) => id && byId.has(id)));
  const jobs = new Map(); // anchor id → { anchor?, steps[] }
  const job = (id) => jobs.get(id) || jobs.set(id, { anchor: byId.get(id) || null, steps: [] }).get(id);
  for (const it of items) {
    const parentId = directParent(it);
    if (hasSteps.has(it.id) || !parentId) job(it.id); // a parent of its own steps, or a job on its own
    else job(parentId).steps.push(it);
  }
  return [...jobs.entries()].map(([id, j]) => ({ id, ...j }));
}

export default {
  name: 'orbit_list_jobs',
  title: "List Claude's jobs",
  description: 'List the jobs Claude is tracking for the user in a project, newest first: each parent item with its '
    + 'steps and progress ("1 of 3 steps done"). Call it before creating a parent for new work: if an open job is '
    + 'clearly the same work (e.g. after a session restart), continue it instead of creating a duplicate; if unsure, '
    + 'ask the user in one line. /orbit:status uses it too.',
  inputSchema: z.object({
    project: projectField,
    state: z.enum(['open', 'all']).default('open').describe('"open" (default): jobs with anything not done yet; "all" also finished ones.'),
    limit: z.number().int().min(1).max(20).default(10).describe('How many jobs (default 10).'),
  }),
  readOnly: true,
  async handler({ project, state, limit }, { client, resolvers }) {
    const p = await resolvers.project(project);
    const me = await resolvers.me();
    const data = await client.call('/work-items/list', {
      ...resolvers.context(p), created_via: 'claude', author_ids: [me.userId],
      item_types: ['epic', 'feature', 'story', 'task'], from: 0, size: SCANNED, sort_by: 'created_at', sort_order: 'desc',
    });
    let jobs = groupJobs(data?.items || []);

    // Items the user named as a job's parent weren't made by Claude: read them in one call.
    const missing = jobs.filter((j) => !j.anchor).map((j) => j.id);
    if (missing.length) {
      const anchors = await client.call('/work-items/list', {
        ...resolvers.context(p), item_ids: missing, item_types: ['epic', 'feature', 'story', 'task'], from: 0, size: missing.length,
      });
      const byId = new Map((anchors?.items || []).map((a) => [a.id, a]));
      jobs = jobs.map((j) => (j.anchor ? j : { ...j, anchor: byId.get(j.id) || null })).filter((j) => j.anchor);
    }

    const newest = (j) => Math.max(...[j.anchor, ...j.steps].map((i) => Number(i.created_at) || 0));
    const open = jobs.filter((j) => !finished(j.anchor) || j.steps.some((s) => !finished(s)));
    const shown = (state === 'open' ? open : jobs).sort((a, b) => newest(b) - newest(a));
    const what = state === 'open' ? 'open Claude jobs' : 'Claude jobs';
    if (!shown.length) return `No ${what} in ${p.projectName}.`;

    const states = await resolvers.stateIndex(p, shown.flatMap((j) => [j.anchor, ...j.steps]).map((i) => i.item_type));
    const stateOf = (it) => states.get(it.state_id)?.name || groupName(it.state_group) || '?';
    const lines = [`${Math.min(shown.length, limit)} of ${shown.length} ${what} in ${p.projectName}, newest first:`];
    for (const j of shown.slice(0, limit)) {
      const done = j.steps.filter(finished).length;
      const progress = j.steps.length ? `${done} of ${j.steps.length} steps done` : 'no steps (tracked on the item itself)';
      lines.push(`- ${j.anchor.item_key} "${truncate(j.anchor.title, 100)}" [${j.anchor.item_type}, ${stateOf(j.anchor)}] — ${progress}`
        + `${j.anchor.created_via === 'claude' ? '' : ' (an item the user named)'} · ${day(newest(j))}`);
      for (const s of j.steps.slice(0, MAX_STEPS_SHOWN)) lines.push(`    ${s.item_key} ${stateOf(s)} — ${truncate(s.title, 80)}`);
      if (j.steps.length > MAX_STEPS_SHOWN) lines.push(`    …and ${j.steps.length - MAX_STEPS_SHOWN} more`);
    }
    lines.push(`Open one at ${resolvers.projectUrl(p)}/work-items/<KEY>`);
    return lines.join('\n');
  },
};
