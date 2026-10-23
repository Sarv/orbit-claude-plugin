import { z } from 'zod';
import { STATE_GROUPS } from '../resolvers.js';
import { fieldHint, hasDefault } from '../writes.js';
import { day } from '../format.js';
import { projectField, itemTypeField } from './shared.js';

const MAX_MEMBERS_SHOWN = 50;

/** A field's default as a person would read it: an option's label, a day, yes/no, a member's name. */
function defaultText(f, members) {
  const v = f.default_value;
  const label = (id) => f.options?.find((o) => o.id === id)?.label || id;
  if (f.field_type === 'single_select') return label(v);
  if (f.field_type === 'multi_select') return (Array.isArray(v) ? v : [v]).map(label).join(', ');
  if (f.field_type === 'date') return day(v);
  if (f.field_type === 'boolean') return v ? 'yes' : 'no';
  if (f.field_type === 'user') {
    const m = members.find((x) => String(x.empId) === String(v));
    return m ? m.displayName || m.fullName : 'a member';
  }
  return `"${v}"`;
}

export default {
  name: 'orbit_get_project_config',
  title: 'Get project setup',
  description: 'Get a project\'s setup for one work-item type: its states (each with its group: backlog, '
    + 'unstarted, started, completed or cancelled), labels, custom fields (which are required, their defaults and '
    + 'choices), priorities and members. Call it when you need exact names: a label, a custom field, a priority, a state '
    + 'you haven\'t seen, or a person you can\'t name exactly. Not needed for started / completed / cancelled / review, '
    + 'which orbit_set_status resolves itself. States, labels and custom fields differ per item type; priorities and '
    + 'members don\'t.',
  inputSchema: z.object({
    project: projectField,
    item_type: itemTypeField.default('task').describe('Which item type\'s states and labels (default task).'),
  }),
  readOnly: true,
  async handler({ project, item_type: itemType }, { resolvers }) {
    const p = await resolvers.project(project);
    const [stateData, labels, customFields, priorities, members, me] = await Promise.all([
      resolvers.states(p, itemType), resolvers.labels(p, itemType), resolvers.customFields(p, itemType),
      resolvers.priorities(), resolvers.members(p), resolvers.me(),
    ]);
    const defaultState = stateData?.default_state_ids?.[itemType];
    const states = [...(stateData?.states || [])].sort((a, b) =>
      (STATE_GROUPS.indexOf(a.group) - STATE_GROUPS.indexOf(b.group)) || ((a.sequence ?? 0) - (b.sequence ?? 0)));
    const lines = [`${p.projectName} (${p.orgSlug}/${p.workspaceSlug}/${p.projectSlug}) — ${itemType} settings`];
    lines.push(`States: ${states.map((s) => `${s.name} (${s.group}${s.id === defaultState ? ', default' : ''})`).join(' · ') || 'none'}`);
    lines.push(`Labels: ${labels.map((l) => l.name).join(', ') || 'none'}`);
    // Orbit lists no custom fields to someone who may not see them, so "none" can't be stronger.
    lines.push(customFields.length ? 'Custom fields:' : 'Custom fields: none you can see');
    for (const f of customFields) {
      const notes = [f.is_required && 'required', hasDefault(f) && `default ${defaultText(f, members)}`].filter(Boolean);
      lines.push(`- ${f.name}: ${fieldHint(f)}${notes.length ? ` (${notes.join(', ')})` : ''}`);
    }
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
