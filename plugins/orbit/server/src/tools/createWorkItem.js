import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { parentField } from '../policy.js';
import { newRequestId, isUnknown, resolveAssignees, resolvePriority, dayToEpoch, findCreated } from '../writes.js';
import { list, truncate } from '../format.js';
import { projectField, titleField, markdownField, assigneesField, dayField } from './shared.js';

export default {
  name: 'orbit_create_work_item',
  title: 'Create a work item',
  description: 'Create one Orbit work item, normally the parent task of a multi-step job. For the job\'s steps, '
    + 'create the parent with this tool, then all the steps in ONE orbit_create_work_items call. It is assigned to '
    + 'the developer unless they named someone else. If the outcome is reported as unknown, don\'t create it again: '
    + 'orbit_search_work_items with its title shows later whether it appeared.',
  inputSchema: z.object({
    project: projectField,
    title: titleField,
    description: markdownField.optional().describe('Markdown: a short description of the request.'),
    item_type: z.enum(['task', 'story', 'feature', 'epic']).default('task').describe('Default task, which is right '
      + 'for a job\'s parent. Use story, feature or epic only when the user asks for that type by name.'),
    parent: z.string().trim().min(1).optional().describe('An item key to put the new item under: a story, feature '
      + 'or epic, or a task that isn\'t itself a subtask (which makes the new task its subtask). Omit for a '
      + 'top-level item.'),
    assignees: assigneesField.default(['me']),
    priority: z.string().trim().min(1).optional().describe('A priority name such as "High".'),
    start_date: dayField.optional().describe('YYYY-MM-DD'),
    due_date: dayField.optional().describe('YYYY-MM-DD'),
  }),
  readOnly: false,
  async handler(args, orbit) {
    const { client, resolvers } = orbit;
    const p = await resolvers.project(args.project);
    const parent = args.parent ? await resolvers.item(p, args.parent) : null;
    const field = parent ? parentField(args.item_type, parent) : null;
    const [people, priorityId] = await Promise.all([
      resolveAssignees(p, args.assignees, resolvers),
      args.priority ? resolvePriority(args.priority, resolvers) : undefined,
    ]);
    const requestId = newRequestId();
    const body = {
      ...resolvers.context(p),
      item_type: args.item_type,
      title: args.title,
      ...(args.description && { description: markdownToHtml(args.description) }),
      assignees_arr: people.map((m) => m.empId),
      ...(field && { [field]: parent.id }),
      ...(priorityId !== undefined && { priority_id: priorityId }),
      ...(args.start_date && { start_date: dayToEpoch(args.start_date) }),
      ...(args.due_date && { due_date: dayToEpoch(args.due_date) }),
      metadata: { mcp_request_id: requestId, mcp_index: 0 },
    };

    const summary = (key) => `${key} [${args.item_type}] "${truncate(args.title, 120)}"${parent ? ` under ${parent.item_key}` : ''}, `
      + `${people.length ? `assigned to ${list(people.map((m) => m.name))}` : 'unassigned'}: ${resolvers.itemUrl(p, { item_type: args.item_type, item_key: key })}`;

    const startedAt = Date.now();
    try {
      const created = await client.call('/work-items/create', body);
      return `Created ${summary(created.item_key)}`;
    } catch (err) {
      if (!isUnknown(err)) throw err;
      const found = (await findCreated(orbit, p, {
        requestId, count: 1, startedAt, itemType: args.item_type, parentField: field, parentId: parent?.id,
      }))?.get(0);
      if (found) return `${err.message} Checked: it was created. Created ${summary(found.item_key)}`;
      const where = parent ? resolvers.itemUrl(p, parent) : resolvers.projectUrl(p);
      return {
        isError: true,
        text: `${err.message} The item was not sent again, and it isn't showing in Orbit yet, so it may still appear. `
          + `Don't create it again: tell the user and let them check ${where}, or look later with `
          + 'orbit_search_work_items (text: its title).',
      };
    }
  },
};
