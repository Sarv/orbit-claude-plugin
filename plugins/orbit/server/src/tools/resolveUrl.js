import { z } from 'zod';
import { parseProjectRef } from '../resolvers.js';

export default {
  name: 'orbit_resolve_url',
  title: 'Resolve an Orbit URL',
  description: 'Turn a pasted Orbit URL into ids: organisation, workspace and project (and the work item, '
    + 'if the URL points at one). Use it when the user pastes an Orbit link, and in /orbit:link to fill .orbit.json.',
  inputSchema: z.object({
    url: z.string().min(1).describe('An Orbit URL, e.g. https://app.orbitorg.com/u/0/org/acme/ws/eng/prj/web, or "org/workspace/project".'),
  }),
  readOnly: true,
  async handler({ url }, { config, resolvers }) {
    const p = await resolvers.project(url);
    const lines = [
      `Organisation: ${p.orgName} (${p.orgSlug}) — org_id ${p.orgId}`,
      `Workspace: ${p.workspaceSlug} — workspace_id ${p.workspaceId}`,
      `Project: ${p.projectName} (${p.projectSlug}) — project_id ${p.projectId}; its item keys look like ${p.keyPrefix}-123`,
      `Project URL: ${resolvers.projectUrl(p)}`,
    ];
    const { itemKey } = parseProjectRef(url, config.appUrl);
    if (itemKey) {
      const it = await resolvers.item(p, itemKey);
      lines.push(`Work item: ${it.item_key} (${it.item_type}) "${it.title}" — item_id ${it.id}`);
    }
    return lines.join('\n');
  },
};
