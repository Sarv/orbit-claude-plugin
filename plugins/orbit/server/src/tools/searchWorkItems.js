import { z } from 'zod';
import { OrbitError } from '../errors.js';
import { STATE_GROUPS } from '../resolvers.js';
import { itemLine } from '../format.js';
import { projectField, itemTypeField } from './shared.js';

// Which list filter holds "children of X", by X's type. `parent_id` only links task → subtask.
const CHILD_FILTER = { task: 'parent_id', story: 'story_id', feature: 'feature_id', epic: 'epic_id', milestone: 'milestone_id' };
const NAMED_TYPES = ['task', 'story', 'feature', 'epic'];

async function assigneeFilter(assignee, p, resolvers) {
  const who = assignee.trim().toLowerCase();
  if (who === 'anyone') return { ids: null, label: '' };
  if (who === 'me') return { ids: [(await resolvers.me()).userId], label: ' assigned to you' };
  const members = await resolvers.members(p);
  const byEmail = members.filter((m) => m.orgEmail?.toLowerCase() === who);
  const byName = members.filter((m) => `${m.displayName || ''} ${m.fullName || ''}`.toLowerCase().includes(who));
  const found = byEmail.length ? byEmail : byName;
  if (found.length !== 1) {
    const names = found.map((m) => m.displayName || m.fullName).join(', ');
    throw new OrbitError('invalid', found.length
      ? `"${assignee}" matches several members (${names}); use their email.`
      : `No member of ${p.projectName} matches "${assignee}". orbit_get_project_config lists the members.`);
  }
  return { ids: [found[0].userId], label: ` assigned to ${found[0].displayName || found[0].fullName}` };
}

async function stateFilter(state, itemType, p, resolvers) {
  const s = state.trim().toLowerCase();
  if (s === 'open') return { body: { lifecycle: 'open' }, label: 'open' };
  if (s === 'all') return { body: {}, label: '' };
  if (STATE_GROUPS.includes(s)) return { body: { state_groups: [s] }, label: s };
  const types = itemType ? [itemType] : NAMED_TYPES;
  const lists = await Promise.all(types.map((t) => resolvers.states(p, t)));
  const all = lists.flatMap((l) => l?.states || []);
  const ids = all.filter((x) => x.name.toLowerCase() === s).map((x) => x.id);
  if (!ids.length) {
    const names = [...new Set(all.map((x) => x.name))].join(', ');
    throw new OrbitError('invalid', `No state called "${state}". Use open, all, a group (${STATE_GROUPS.join(', ')}) or one of: ${names}.`);
  }
  return { body: { state_ids: ids }, label: `"${state}"` };
}

export default {
  name: 'orbit_search_work_items',
  title: 'Search work items',
  description: 'Find work items in a project — by default the user\'s own open items. Filter by assignee, '
    + 'state, text (matches the key and title), parent (lists an item\'s subtasks or child items) and type. '
    + 'Returns one line per item, most recently updated first. One project per call: when the user asks for "my '
    + 'items" without naming a project, use the linked project and say that\'s what the list covers.',
  inputSchema: z.object({
    project: projectField,
    assignee: z.string().default('me').describe('"me" (default), "anyone", or a project member\'s name or email.'),
    state: z.string().default('open').describe('"open" (default: not completed or cancelled), "all", a state group '
      + '(backlog, unstarted, started, completed, cancelled) or a state name such as "In Review".'),
    text: z.string().optional().describe('Text to match in the item key or title.'),
    parent: z.string().optional().describe('An item key or id: only its subtasks / child items.'),
    item_type: itemTypeField.optional().describe('Only this type. By default every type except milestones.'),
    limit: z.number().int().min(1).max(50).default(20).describe('How many items (default 20, max 50).'),
  }),
  readOnly: true,
  async handler(args, { client, resolvers }) {
    const p = await resolvers.project(args.project);
    const [who, state, parent] = await Promise.all([
      assigneeFilter(args.assignee, p, resolvers),
      stateFilter(args.state, args.item_type, p, resolvers),
      args.parent ? resolvers.item(p, args.parent) : null,
    ]);
    const body = {
      ...resolvers.context(p), ...state.body,
      from: 0, size: args.limit, sort_by: 'updated_at', sort_order: 'desc',
      ...(who.ids && { assignee_ids: who.ids }),
      ...(args.text && { search: args.text }),
      ...(args.item_type && { item_types: [args.item_type] }),
      ...(parent && { [CHILD_FILTER[parent.item_type]]: parent.id }),
    };
    const [data, names] = await Promise.all([client.call('/work-items/list', body), resolvers.memberNames(p)]);
    const items = data?.items || [];
    const describe = `${state.label ? `${state.label} ` : ''}items${who.label}${parent ? ` under ${parent.item_key}` : ''}${args.text ? ` matching "${args.text}"` : ''}`;
    if (!items.length) return `No ${describe} in ${p.projectName}.`;
    const states = await resolvers.stateIndex(p, items.map((it) => it.item_type));
    return [
      `${items.length} of ${data.total ?? items.length} ${describe} in ${p.projectName}, most recently updated first:`,
      ...items.map((it) => itemLine(it, { states, names })),
      `Open one at ${resolvers.projectUrl(p)}/work-items/<KEY>`,
    ].join('\n');
  },
};
