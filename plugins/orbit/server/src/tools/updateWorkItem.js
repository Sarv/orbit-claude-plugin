import { z } from 'zod';
import { OrbitError } from '../errors.js';
import { markdownToHtml } from '../markdown.js';
import { isUnknown, resolveAssignees, resolveLabels, resolvePriority, dayToEpoch, retryOnceIfUnknown } from '../writes.js';
import { list, truncate } from '../format.js';
import { projectField, itemField, titleField, markdownField, dayField } from './shared.js';

const names = z.array(z.string().trim().min(1)).max(20);
const operation = (what) => z.object({
  set: names.optional().describe(`Replace all ${what} with these.`),
  add: names.optional(),
  remove: names.optional(),
});

/** { set?, add?, remove? } of names → the same shape with Orbit ids; undefined when empty. */
async function resolveOperation(op, resolve) {
  const keys = ['set', 'add', 'remove'].filter((k) => op[k]);
  if (!keys.length) return undefined;
  const resolved = await Promise.all(keys.map((k) => resolve(op[k])));
  return Object.fromEntries(keys.map((k, i) => [k, resolved[i]]));
}

export default {
  name: 'orbit_update_work_item',
  title: 'Update a work item',
  description: 'Change a work item\'s title, description (Markdown; replaces the whole description), assignees, '
    + 'labels, priority or dates. It cannot change the status: use orbit_set_status. Assign only people the '
    + 'developer named. To add to a description, read it with orbit_get_work_item first and send the whole new text.',
  inputSchema: z.object({
    project: projectField,
    item: itemField,
    title: titleField.optional(),
    description: markdownField.optional().describe('Markdown. Replaces the whole description.'),
    assignees: operation('assignees').optional().describe('{ add: [...] }, { remove: [...] } or { set: [...] }, '
      + 'with "me", or a project member\'s email (safest) or name as Orbit shows it.'),
    labels: operation('labels').optional().describe('{ add }, { remove } or { set } with label names. Labels differ '
      + 'per item type; orbit_get_project_config lists them.'),
    priority: z.string().trim().min(1).optional().describe('A priority name such as "High".'),
    start_date: dayField.optional().describe('YYYY-MM-DD'),
    due_date: dayField.optional().describe('YYYY-MM-DD'),
  }),
  readOnly: false,
  idempotent: true,
  async handler(args, { client, resolvers }) {
    const p = await resolvers.project(args.project);
    const it = await resolvers.item(p, args.item);
    const [assignees, labels, priorityId] = await Promise.all([
      args.assignees && resolveOperation(args.assignees,
        async (refs) => (await resolveAssignees(p, refs, resolvers)).map((m) => m.empId)),
      args.labels && resolveOperation(args.labels, (labelNames) => resolveLabels(p, it.item_type, labelNames, resolvers)),
      args.priority && resolvePriority(args.priority, resolvers),
    ]);
    const changes = {
      title: args.title,
      description: args.description && markdownToHtml(args.description),
      assignees,
      labels,
      priority_id: priorityId,
      start_date: args.start_date && dayToEpoch(args.start_date),
      due_date: args.due_date && dayToEpoch(args.due_date),
    };
    const fields = Object.keys(changes).filter((k) => changes[k] !== undefined);
    if (!fields.length) {
      throw new OrbitError('invalid', 'Nothing to change: give at least one field. To change the status, use orbit_set_status.');
    }
    const body = { ...resolvers.context(p), item_id: it.id, ...Object.fromEntries(fields.map((k) => [k, changes[k]])) };
    const url = resolvers.itemUrl(p, it);
    try {
      // Every field here is an absolute value or an idempotent add/remove, so one retry is safe.
      await retryOnceIfUnknown(() => client.call('/work-items/update', body));
    } catch (err) {
      if (!isUnknown(err)) throw err;
      throw new OrbitError('unknown', `${err.message} Tried twice, so the change may or may not have been saved. Read `
        + `${it.item_key} with orbit_get_work_item: if the change isn't there, send it once more (safe for updates). ${url}`);
    }
    const label = { priority_id: 'priority', start_date: 'start date', due_date: 'due date' };
    return `Updated ${it.item_key} "${truncate(args.title || it.title, 100)}": ${list(fields.map((k) => label[k] || k))}. ${url}`;
  },
};
