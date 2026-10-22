import { z } from 'zod';
import { STATE_GROUPS } from '../resolvers.js';
import { projectField, itemTypeField } from './shared.js';

const MAX_MEMBERS_SHOWN = 50;

export default {
  name: 'orbit_get_project_config',
  title: 'Get project setup',
  description: 'Get a project\'s setup for one work-item type: its states (each with its group: backlog, '
    + 'unstarted, started, completed or cancelled), labels, priorities and members. Call it when you need exact '
    + 'names: a label, a priority, a state you haven\'t seen, or a person you can\'t name exactly. Not needed for '
    + 'started / completed / cancelled / review, which orbit_set_status resolves itself. States and labels differ '
    + 'per item type; priorities and members don\'t.',
  inputSchema: z.object({
    project: projectField,
    item_type: itemTypeField.default('task').describe('Which item type\'s states and labels (default task).'),
  }),
  readOnly: true,
  async handler({ project, item_type: itemType }, { resolvers }) {
    const p = await resolvers.project(project);
    const [stateData, labels, priorities, members, me] = await Promise.all([
      resolvers.states(p, itemType), resolvers.labels(p, itemType), resolvers.priorities(), resolvers.members(p), resolvers.me(),
    ]);
    const defaultState = stateData?.default_state_ids?.[itemType];
    const states = [...(stateData?.states || [])].sort((a, b) =>
      (STATE_GROUPS.indexOf(a.group) - STATE_GROUPS.indexOf(b.group)) || ((a.sequence ?? 0) - (b.sequence ?? 0)));
    const lines = [`${p.projectName} (${p.orgSlug}/${p.workspaceSlug}/${p.projectSlug}) — ${itemType} settings`];
    lines.push(`States: ${states.map((s) => `${s.name} (${s.group}${s.id === defaultState ? ', default' : ''})`).join(' · ') || 'none'}`);
    lines.push(`Labels: ${labels.map((l) => l.name).join(', ') || 'none'}`);
    lines.push(`Priorities: ${priorities.map((x) => x.name).join(', ')}`);
    lines.push(`Members (${members.length}):`);
    for (const m of members.slice(0, MAX_MEMBERS_SHOWN)) {
      const you = m.userId === me.userId ? ' (you)' : '';
      lines.push(`- ${m.displayName || m.fullName || 'Unnamed'}${m.orgEmail ? ` <${m.orgEmail}>` : ''}${you}`);
    }
    if (members.length > MAX_MEMBERS_SHOWN) lines.push(`…and ${members.length - MAX_MEMBERS_SHOWN} more.`);
    return lines.join('\n');
  },
};
