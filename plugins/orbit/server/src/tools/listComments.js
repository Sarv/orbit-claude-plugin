import { z } from 'zod';
import { htmlToText, truncate } from '../format.js';
import { projectField, itemField } from './shared.js';

const MAX_COMMENT = 800;
// All comment text together. 50 long comments would be ~40k characters, over Claude Code's tool-
// output warning (10k tokens), and more for non-Latin text; the newest that fit are kept.
const TEXT_BUDGET = 12_000;
const when = (ms) => (Number(ms) ? `${new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');

export default {
  name: 'orbit_list_comments',
  title: 'Read comments',
  description: 'Read the discussion on a work item: the latest comments, oldest first, with author and time. '
    + 'Read it before working on an item the user names, to pick up decisions made there.',
  inputSchema: z.object({
    project: projectField,
    item: itemField,
    limit: z.number().int().min(1).max(50).default(20).describe('How many of the latest comments (default 20, max 50).'),
  }),
  readOnly: true,
  async handler({ project, item, limit }, { client, resolvers }) {
    const p = await resolvers.project(project);
    const it = await resolvers.item(p, item);
    const [data, names] = await Promise.all([
      client.call('/work-items/comments/list', { ...resolvers.context(p), item_id: it.id, from: 0, size: limit, sort_order: 'desc' }),
      resolvers.memberNames(p),
    ]);
    const newestFirst = data?.comments || [];
    if (!newestFirst.length) return `No comments on ${it.item_key} "${truncate(it.title, 100)}".`;
    const kept = [];
    let used = 0;
    for (const c of newestFirst) {
      const text = c.is_deleted ? '[deleted]' : truncate(htmlToText(c.content), MAX_COMMENT);
      if (kept.length && used + text.length > TEXT_BUDGET) break;
      kept.push({ c, text });
      used += text.length;
    }
    kept.reverse();
    const total = data.total ?? newestFirst.length;
    const lines = [`${kept.length} of ${total} comments on ${it.item_key} "${truncate(it.title, 100)}"${total > kept.length ? ' (the latest)' : ''}:`];
    for (const { c, text } of kept) {
      const author = names.get(c.author?.user_id) || 'a former member';
      lines.push(`— ${author}, ${when(c.created_at)}${c.direct_parent ? ' (reply)' : ''}:\n${text}`);
    }
    if (kept.length < newestFirst.length) lines.push(`Older comments didn't fit; read them in Orbit: ${resolvers.itemUrl(p, it)}`);
    return lines.join('\n');
  },
};
