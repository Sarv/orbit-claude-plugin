import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { stepsUnder } from '../policy.js';
import { newRequestId, isUnknown, resolveAssignees, findCreated } from '../writes.js';
import { list, truncate } from '../format.js';
import { projectField, itemField, titleField, markdownField, assigneesField } from './shared.js';

// Orbit takes 100 per call; a lower cap keeps a runaway plan from flooding a project.
const MAX_STEPS = 25;

export default {
  name: 'orbit_create_work_items',
  title: 'Create the steps of a job',
  description: 'Create the steps of a job under one named item, in a single call: one item per plan step '
    + `(at most ${MAX_STEPS}; aim for 15 or fewer and merge small steps). How they attach depends on the named item: `
    + 'tasks under a story, feature or epic; subtasks under a task that isn\'t itself a subtask (it may sit under a '
    + 'story, feature or epic). A subtask can\'t hold steps: then nothing is created, and you track the job on that '
    + 'subtask with comments. If the parent already has children (orbit_get_work_item lists them), create only the '
    + 'steps that are missing. Each step gets its own result line. Never create steps marked "not confirmed" again.',
  inputSchema: z.object({
    project: projectField,
    parent: itemField.describe('The item the job belongs to, as a key like "SBX-142": the parent task you created, '
      + 'or the item the user named.'),
    steps: z.array(z.object({
      title: titleField,
      description: markdownField.optional().describe('Markdown, optional: a line or two about the step.'),
    })).min(1).max(MAX_STEPS),
    assignees: assigneesField.default(['me']),
  }),
  readOnly: false,
  async handler(args, orbit) {
    const { client, resolvers, config } = orbit;
    const p = await resolvers.project(args.project);
    const parent = await resolvers.item(p, args.parent);
    const attach = stepsUnder(parent);
    if (!attach) {
      return `${parent.item_key} "${truncate(parent.title, 100)}" is a subtask, and Orbit allows only one level of `
        + `subtasks, so no steps were created. Track this job on ${parent.item_key} itself: comment as you finish `
        + 'each step (orbit_add_comment) and move it with orbit_set_status.';
    }
    const people = await resolveAssignees(p, args.assignees, resolvers);
    const requestId = newRequestId();
    const items = args.steps.map((step, i) => ({
      item_type: attach.itemType,
      title: step.title,
      ...(step.description && { description: markdownToHtml(step.description) }),
      assignees_arr: people.map((m) => m.empId),
      [attach.field]: parent.id,
      metadata: { mcp_request_id: requestId, mcp_index: i },
    }));

    const what = (n) => `${n} of ${items.length} steps as ${attach.kind} of ${parent.item_key} "${truncate(parent.title, 100)}"`
      + `, ${people.length ? `assigned to ${list(people.map((m) => m.name))}` : 'unassigned'}`;
    const ok = (i, key) => `#${i + 1} ✓ ${key} ${truncate(args.steps[i].title, 100)}`;
    const unconfirmed = (i) => `#${i + 1} ? not confirmed: ${truncate(args.steps[i].title, 100)}`;
    const parentLink = resolvers.itemUrl(p, parent);

    const startedAt = Date.now();
    let data;
    try {
      data = await client.call('/work-items/bulk-create', { ...resolvers.context(p), items }, { timeoutMs: config.bulkRequestTimeoutMs });
    } catch (err) {
      if (!isUnknown(err)) throw err;
      const found = await findCreated(orbit, p, {
        requestId, count: items.length, startedAt, itemType: attach.itemType, parentField: attach.field, parentId: parent.id,
      });
      const lines = items.map((_, i) => (found?.has(i) ? ok(i, found.get(i).item_key) : unconfirmed(i)));
      const confirmed = found?.size ?? 0;
      return {
        isError: confirmed === 0,
        text: [
          `${err.message} Nothing was sent again. Checked Orbit and found ${what(confirmed)}:`,
          ...lines,
          ...(confirmed < items.length
            ? [`The unconfirmed steps may still appear. Don't create them again: tell the user and let them check ${parentLink}, `
              + `or look later with orbit_search_work_items (parent ${parent.item_key}).`]
            : []),
        ].join('\n'),
      };
    }

    // HTTP 201 even when some items fail: trust only each item's own `success`.
    const results = new Map((data?.results || []).map((r) => [r.index, r]));
    const failed = [];
    let created = 0;
    const lines = items.map((_, i) => {
      const r = results.get(i);
      if (!r) return unconfirmed(i); // Orbit didn't report on it: not a definite failure
      if (r.success === true && r.item_key) {
        created += 1;
        return ok(i, r.item_key);
      }
      failed.push(`#${i + 1}`);
      return `#${i + 1} ✗ ${truncate(args.steps[i].title, 60)}: ${r.error || 'Orbit refused it'}`;
    });
    return {
      isError: created === 0,
      text: [
        `Created ${what(created)}:`,
        ...lines,
        ...(failed.length ? [`${failed.join(', ')} failed; the others exist. Retry only those, in a new call, and only if the `
          + 'error is about something you sent (a title, a name) and you fixed it. Otherwise tell the user.'] : []),
        ...(created + failed.length < items.length ? ["Don't create the unconfirmed steps again."] : []),
        `Parent: ${parentLink}`,
      ].join('\n'),
    };
  },
};
