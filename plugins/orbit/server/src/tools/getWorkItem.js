import { z } from 'zod';
import { groupName } from '../resolvers.js';
import { htmlToText, truncate, day, itemLine } from '../format.js';
import { projectField, itemField } from './shared.js';

const ANCESTORS = [['parent_id', 'Parent'], ['story_id', 'Story'], ['feature_id', 'Feature'], ['epic_id', 'Epic'], ['milestone_id', 'Milestone']];
const MAX_CHILDREN = 30;
const MAX_DESCRIPTION = 3000;

export default {
  name: 'orbit_get_work_item',
  title: 'Read a work item',
  description: 'Read one work item by key (e.g. SBX-142) or id: type, state, priority, assignees, points, '
    + 'parent, description, its subtasks / child items, and a link. Use it before working on an item the '
    + 'user names, and to check an item\'s current state.',
  inputSchema: z.object({ project: projectField, item: itemField }),
  readOnly: true,
  async handler({ project, item }, { client, resolvers }) {
    const p = await resolvers.project(project);
    const it = await resolvers.item(p, item);
    const ancestorIds = ANCESTORS.map(([field]) => it[field]).filter(Boolean);
    const isSubtask = it.item_type === 'task' && Boolean(it.parent_id);

    const [childData, ancestorData, names, priorities, labels] = await Promise.all([
      isSubtask || it.item_type === 'milestone' ? null : client.call('/work-items/children', { ...resolvers.context(p), item_id: it.id }),
      ancestorIds.length
        ? client.call('/work-items/list', { ...resolvers.context(p), item_ids: ancestorIds, item_types: ['epic', 'feature', 'story', 'task', 'milestone'], size: ancestorIds.length })
        : null,
      resolvers.memberNames(p),
      resolvers.priorities(),
      resolvers.labels(p, it.item_type),
    ]);
    const children = childData?.children || [];
    const states = await resolvers.stateIndex(p, [it.item_type, ...children.map((c) => c.item_type)]);
    const ancestors = new Map((ancestorData?.items || []).map((a) => [a.id, a]));

    const state = states.get(it.state_id);
    const assignees = (it.assignees_user_arr || []).map((id) => names.get(id) || 'someone');
    const creator = names.get(it.created_by?.user_id) || 'someone';
    const labelNames = new Map(labels.map((l) => [l.id, l.name]));
    const points = [it.task_points && `task ${it.task_points}`, it.story_points && `story ${it.story_points}`,
      it.assignee_points?.length && `allocated to ${it.assignee_points.length} people`].filter(Boolean);

    const lines = [
      `${it.item_key} · ${it.title}`,
      `Type: ${it.item_type}${isSubtask ? ' (subtask)' : ''} · State: ${state?.name || '?'} (${state?.group || groupName(it.state_group) || '?'}) · Priority: ${priorities.find((x) => x.id === it.priority_id)?.name || 'None'}`,
      `Assignees: ${assignees.join(', ') || 'none'}`,
      `Created by ${creator} on ${day(it.created_at)}${it.created_via === 'claude' ? ' via Claude' : ''} · updated ${day(it.updated_at)}`,
    ];
    if (points.length) lines.push(`Points: ${points.join(', ')}`);
    for (const [field, label] of ANCESTORS) {
      const a = it[field] && ancestors.get(it[field]);
      if (a) lines.push(`${label}: ${a.item_key} ${truncate(a.title, 100)}`);
    }
    if (it.start_date || it.due_date) lines.push(`Dates: ${[it.start_date && `start ${day(it.start_date)}`, it.due_date && `due ${day(it.due_date)}`].filter(Boolean).join(', ')}`);
    if (it.label_ids?.length) lines.push(`Labels: ${it.label_ids.map((id) => labelNames.get(id) || 'unknown').join(', ')}`);
    lines.push(`Link: ${resolvers.itemUrl(p, it)}`);
    const description = htmlToText(it.description);
    lines.push(description ? `Description:\n${truncate(description, MAX_DESCRIPTION)}` : 'No description.');
    if (children.length) {
      lines.push(`${it.item_type === 'task' ? 'Subtasks' : 'Child items'} (${children.length}):`);
      lines.push(...children.slice(0, MAX_CHILDREN).map((c) => `- ${itemLine(c, { states, names })}`));
      if (children.length > MAX_CHILDREN) lines.push(`…and ${children.length - MAX_CHILDREN} more (use orbit_search_work_items with parent).`);
    }
    return lines.join('\n');
  },
};
