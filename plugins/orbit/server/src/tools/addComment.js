import { z } from 'zod';
import { markdownToHtml } from '../markdown.js';
import { postComment } from '../writes.js';
import { truncate } from '../format.js';
import { projectField, itemField, markdownField } from './shared.js';

export default {
  name: 'orbit_add_comment',
  title: 'Comment on a work item',
  description: 'Post a progress comment on a work item, in Markdown: 2–4 lines on what changed, the key files, and '
    + 'the commit hash or PR link. Use it after finishing each step, and for the summary on the parent when the job is '
    + 'done. If the result says the comment is not confirmed, do not post it again.',
  inputSchema: z.object({
    project: projectField,
    item: itemField,
    text: markdownField.describe('The comment, in Markdown.'),
  }),
  readOnly: false,
  async handler({ project, item, text }, orbit) {
    const { resolvers } = orbit;
    const p = await resolvers.project(project);
    const it = await resolvers.item(p, item);
    const outcome = await postComment(orbit, p, it, markdownToHtml(text));
    const url = resolvers.itemUrl(p, it);
    if (outcome === 'posted') return `Commented on ${it.item_key} "${truncate(it.title, 100)}": ${url}`;
    if (outcome === 'found') return `Orbit didn't answer, but the comment is on ${it.item_key} (checked): ${url}`;
    return {
      isError: true,
      text: `Orbit didn't answer, and the comment isn't showing on ${it.item_key} yet, so it may still appear. `
        + `It was not sent again; don't post it again. Tell the user and let them check ${url}`,
    };
  },
};
