import { z } from 'zod';
import { truncate } from '../format.js';

const MAX_LINES = 60;

export default {
  name: 'orbit_list_projects',
  title: 'List Orbit projects',
  description: 'List the Orbit projects the user can open, as org/workspace/project slugs with their URL. '
    + 'Use it to find a project by name, e.g. to link a repo or when the user names a project.',
  inputSchema: z.object({
    query: z.string().optional().describe('Only projects whose name or slug contains this text.'),
    org: z.string().optional().describe('Only this organisation (its slug).'),
  }),
  readOnly: true,
  async handler({ query, org }, { client, resolvers }) {
    const orgs = (await resolvers.orgs()).filter((o) => !org || o.orgSlug === org);
    if (!orgs.length) return org ? `You aren't in an organisation with the slug "${org}".` : 'You aren\'t in any Orbit organisation.';
    const needle = query?.toLowerCase();
    const perOrg = await Promise.all(orgs.map(async (o) => {
      const base = { org_id: o.orgId, size: 100, status: 'active' };
      const [ws, prj] = await Promise.all([
        client.call('/workspaces/list', { ...base, reqFields: ['name', 'slug'] }),
        client.call('/projects/list', { ...base, reqFields: ['name', 'slug', 'workspace_id'] }),
      ]);
      const wsSlug = new Map((ws?.workspaces || []).map((w) => [w.id, w.slug]));
      return (prj?.projects || [])
        .filter((p) => !needle || `${p.name} ${p.slug}`.toLowerCase().includes(needle))
        .map((p) => ({ o, p, ws: wsSlug.get(p.workspace_id) }))
        .filter((r) => r.ws);
    }));
    const rows = perOrg.flat();
    if (!rows.length) return query ? `No project matches "${query}".` : 'No projects found.';
    const lines = rows.slice(0, MAX_LINES).map(({ o, p, ws }) => {
      const ref = `${o.orgSlug}/${ws}/${p.slug}`;
      return `${ref} — ${truncate(p.name, 80)} — ${resolvers.projectUrl({ orgSlug: o.orgSlug, workspaceSlug: ws, projectSlug: p.slug })}`;
    });
    if (rows.length > MAX_LINES) lines.push(`…and ${rows.length - MAX_LINES} more. Narrow it with "query".`);
    return lines.join('\n');
  },
};
