// Turns what Claude passes (a project URL or org/ws/project, an item key or id, "me") into the
// ids Orbit's API wants, and caches the project's reference data. States and labels are cached
// per (project, item type) — Orbit scopes both to the item type (plan 2.1).

import { OrbitError } from './errors.js';

const TTL_MS = 5 * 60_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ITEM_KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const MAX_MEMBERS = 500;

// Orbit's state groups; on work items `state_group` is the 1-based number.
export const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
export const ITEM_TYPES = ['epic', 'feature', 'story', 'task', 'milestone'];
export const groupName = (n) => STATE_GROUPS[Number(n) - 1] || null;

const PROJECT_HELP = 'Give the project as its Orbit URL (…/org/<org>/ws/<workspace>/prj/<project>) or as org/workspace/project.';

/** A project URL or "org/ws/project" → slugs (+ the item key when the URL points at one). */
export function parseProjectRef(ref, appUrl) {
  const raw = String(ref || '').trim();
  if (/^https?:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw new OrbitError('invalid', `That isn't a valid URL. ${PROJECT_HELP}`); }
    const expected = new URL(appUrl).host;
    if (url.host !== expected) {
      throw new OrbitError('invalid', `That link is for ${url.host}, but this Orbit connection is for ${expected}.`);
    }
    const parts = url.pathname.split('/').filter(Boolean);
    const after = (name) => { const i = parts.indexOf(name); return i >= 0 ? decodeURIComponent(parts[i + 1] || '') : ''; };
    const slugs = { orgSlug: after('org'), workspaceSlug: after('ws'), projectSlug: after('prj') };
    if (![slugs.orgSlug, slugs.workspaceSlug, slugs.projectSlug].every((s) => SLUG.test(s))) {
      throw new OrbitError('invalid', `That link doesn't point at a project. ${PROJECT_HELP}`);
    }
    const itemKey = after('work-items') || after('milestones');
    return ITEM_KEY.test(itemKey) ? { ...slugs, itemKey: itemKey.toUpperCase() } : slugs;
  }
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 3 && parts.every((s) => SLUG.test(s))) {
    return { orgSlug: parts[0], workspaceSlug: parts[1], projectSlug: parts[2] };
  }
  throw new OrbitError('invalid', `"${raw}" isn't a project. ${PROJECT_HELP}`);
}

export function createResolvers({ config, client }) {
  const cache = new Map();
  // Caches the promise, so concurrent callers share one request; a failure isn't cached.
  async function cached(key, fetch, ttl = TTL_MS) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = fetch();
    cache.set(key, { value, at: Date.now() });
    try {
      return await value;
    } catch (err) {
      cache.delete(key);
      throw err;
    }
  }

  const me = () => cached('me', () => client.call('/auth/me', {}));
  const orgs = () => cached('orgs', async () => (await client.call('/auth/organisations', {}))?.organisations || []);

  async function project(ref) {
    const { orgSlug, workspaceSlug, projectSlug } = parseProjectRef(ref, config.appUrl);
    return cached(`project:${orgSlug}/${workspaceSlug}/${projectSlug}`, async () => {
      const data = await client.call('/resolve/path', { orgSlug, workspaceSlug, projectSlug });
      if (!data?.project || !data?.workspace) {
        throw new OrbitError('not_found', data?.projectError || data?.workspaceError
          || `There is no project ${orgSlug}/${workspaceSlug}/${projectSlug} that you can open.`);
      }
      return {
        orgId: data.org.orgId, orgSlug: data.org.slug, orgName: data.org.name,
        workspaceId: data.workspace.id, workspaceSlug: data.workspace.slug,
        projectId: data.project.id, projectSlug: data.project.slug, projectName: data.project.name,
        keyPrefix: String(data.project.slug).toUpperCase(),
      };
    }, Infinity);
  }

  const context = (p) => ({ org_id: p.orgId, workspace_id: p.workspaceId, project_id: p.projectId });

  const states = (p, itemType) => cached(`states:${p.projectId}:${itemType}`,
    () => client.call('/states/list', { ...context(p), item_type: itemType }));
  const labels = (p, itemType) => cached(`labels:${p.projectId}:${itemType}`,
    async () => (await client.call('/labels/list', { ...context(p), item_type: itemType }))?.labels || []);
  const priorities = () => cached('priorities',
    async () => (await client.call('/priorities/list', {}))?.priorities || [], Infinity);
  // The project's custom fields for one item type. [] when it has none, and also when the user
  // may not see them: Orbit lists none to a CONTRIBUTOR.
  const customFields = (p, itemType) => cached(`fields:${p.projectId}:${itemType}`,
    async () => (await client.call('/custom-fields/list', { ...context(p), item_type: itemType }))?.fields || []);

  const members = (p) => cached(`members:${p.projectId}`, async () => {
    const all = [];
    for (let from = 0; from < MAX_MEMBERS; from += 100) {
      const data = await client.call(`/projects/${encodeURIComponent(p.projectId)}/members/list`, { org_id: p.orgId, from, size: 100 });
      all.push(...(data?.members || []));
      if (!data?.hasMore) break;
    }
    return all;
  });

  /** A work item by key ("SBX-142") or id, read fresh. */
  async function item(p, ref) {
    const value = String(ref || '').trim();
    const body = ITEM_KEY.test(value) ? { item_key: value.toUpperCase() } : { item_id: value };
    try {
      return await client.call('/work-items/get', { ...context(p), ...body });
    } catch (err) {
      if (err.kind === 'not_found') throw new OrbitError('not_found', `There is no work item ${value} in ${p.projectName} that you can see.`);
      throw err;
    }
  }

  // id → { name, group } for every state of the given item types.
  async function stateIndex(p, itemTypes) {
    const lists = await Promise.all([...new Set(itemTypes)].map((t) => states(p, t)));
    return new Map(lists.flatMap((l) => l?.states || []).map((s) => [s.id, s]));
  }

  // user id → display name, for the project's members.
  async function memberNames(p) {
    return new Map((await members(p)).map((m) => [m.userId, m.displayName || m.fullName || m.orgEmail || 'a member']));
  }

  const projectUrl = (p) => `${config.appUrl}/u/0/org/${p.orgSlug}/ws/${p.workspaceSlug}/prj/${p.projectSlug}`;
  const itemUrl = (p, it) => `${projectUrl(p)}/${it.item_type === 'milestone' ? 'milestones' : 'work-items'}/${it.item_key}`;

  // A new sign-in may be a different user (the consent page lets them switch accounts).
  const clearCache = () => cache.clear();

  return {
    clearCache, me, orgs, project, context, states, labels, priorities, customFields, members, item, stateIndex, memberNames, projectUrl, itemUrl,
  };
}
