// A small in-memory fake of Orbit's HTTP API, using the response shapes read from the backend
// source (envelope { success, code, message, data }). `createFakeOrbit()` is the pure fake (unit
// tests call it through a mocked fetch); `startFakeOrbit()` serves it over HTTP, so the real server
// binary can be driven end to end.

import crypto from 'node:crypto';
import http from 'node:http';

const USER = { userId: 'U_ME', email: 'dev@acme.test', fullName: 'Dev One', displayName: 'Dev' };
const ORG = { orgId: 'O1', orgName: 'Acme', orgSlug: 'acme', empId: 7 };
const PROJECT = { id: 'P1', name: 'Web App', slug: 'web', workspace_id: 'W1' };
const GROUP_NUMBER = { backlog: 1, unstarted: 2, started: 3, completed: 4, cancelled: 5 };
const STATES = {
  task: [
    { id: 'S_TODO', name: 'Todo', group: 'unstarted', sequence: 1 },
    { id: 'S_PROG', name: 'In Progress', group: 'started', sequence: 1 },
    { id: 'S_REV', name: 'In Review', group: 'started', sequence: 2 },
    { id: 'S_DONE', name: 'Done', group: 'completed', sequence: 1 },
    { id: 'S_CANC', name: 'Cancelled', group: 'cancelled', sequence: 1 },
  ],
  story: [
    { id: 'S_STORY_READY', name: 'Ready', group: 'unstarted', sequence: 1 },
    { id: 'S_STORY_PROG', name: 'In Progress', group: 'started', sequence: 1 },
    { id: 'S_STORY_DONE', name: 'Done', group: 'completed', sequence: 1 },
  ],
  feature: [{ id: 'S_FEAT_OPEN', name: 'Open', group: 'unstarted', sequence: 1 }],
  epic: [{ id: 'S_EPIC_OPEN', name: 'Open', group: 'unstarted', sequence: 1 }],
};
const DEFAULT_STATE = { task: 'S_TODO', story: 'S_STORY_READY', feature: 'S_FEAT_OPEN', epic: 'S_EPIC_OPEN' };
const MEMBERS = [
  { userId: 'U_ME', empId: 7, displayName: 'Dev', fullName: 'Dev One', orgEmail: 'dev@acme.test' },
  { userId: 'U_ANA', empId: 8, displayName: 'Ana', fullName: 'Ana Silva', orgEmail: 'ana@acme.test' },
];
const LABELS = { task: [{ id: 'L1', name: 'backend' }, { id: 'L2', name: 'frontend' }], story: [{ id: 'L9', name: 'customer' }] };
const ITEMS = [
  { id: 'I_STORY', item_key: 'WEB-1', item_type: 'story', title: 'Reports', state_id: 'S_STORY_READY', state_group: 2, assignees_user_arr: [], created_by: { user_id: 'U_ANA' } },
  { id: 'I_TASK', item_key: 'WEB-2', item_type: 'task', title: 'Add CSV export', state_id: 'S_PROG', state_group: 3, assignees_arr: [7], assignees_user_arr: ['U_ME'], story_id: 'I_STORY', created_by: { user_id: 'U_ME' }, created_via: 'claude', task_points: 3, description: '<p>Export <b>CSV</b></p>', priority_id: 20, created_at: Date.UTC(2026, 9, 20), updated_at: Date.UTC(2026, 9, 21) },
  { id: 'I_SUB', item_key: 'WEB-3', item_type: 'task', title: 'Build CSV', state_id: 'S_TODO', state_group: 2, assignees_arr: [8], assignees_user_arr: ['U_ANA'], parent_id: 'I_TASK', created_by: { user_id: 'U_ME' } },
  { id: 'I_EPIC', item_key: 'WEB-4', item_type: 'epic', title: 'Analytics', state_id: 'S_EPIC_OPEN', state_group: 2, assignees_user_arr: [], created_by: { user_id: 'U_ANA' } },
  { id: 'I_FEAT', item_key: 'WEB-5', item_type: 'feature', title: 'Exports', state_id: 'S_FEAT_OPEN', state_group: 2, assignees_user_arr: [], created_by: { user_id: 'U_ANA' } },
  { id: 'I_MILE', item_key: 'WEB-6', item_type: 'milestone', title: 'Q4 release', state_group: 2, assignees_user_arr: [], created_by: { user_id: 'U_ANA' } },
  { id: 'I_DONE', item_key: 'WEB-7', item_type: 'task', title: 'Old cleanup', state_id: 'S_DONE', state_group: 4, assignees_user_arr: [], created_by: { user_id: 'U_ANA' } },
];
const COMMENTS = [
  { id: 'C1', item_id: 'I_TASK', author: { user_id: 'U_ANA' }, content: '<p>Please add tests</p>', created_at: Date.UTC(2026, 9, 21, 9) },
  { id: 'C2', item_id: 'I_TASK', author: { user_id: 'U_ME' }, content: '<p>Done: <code>exportCsv()</code></p>', created_at: Date.UTC(2026, 9, 21, 9, 30), direct_parent: 'C1' },
];

const ok = (data, status = 200) => ({ status, body: { success: true, code: status, message: 'ok', data } });
const fail = (status, message, errorCode) => ({ status, body: { success: false, code: status, message, details: { request_id: 'R', error_code: errorCode } } });
const PARENT_FIELDS = ['parent_id', 'story_id', 'feature_id', 'epic_id'];

export function createFakeOrbit() {
  const state = {
    codes: new Map(), refresh: null, access: new Set(), calls: [],
    items: structuredClone(ITEMS), comments: structuredClone(COMMENTS), seq: ITEMS.length,
    activities: [], // state changes only: { item_id, actor, via, to }
  };
  const issue = () => {
    state.refresh = `orb_rt_C1.${crypto.randomBytes(12).toString('base64url')}`;
    const access = `orb_at_${crypto.randomBytes(12).toString('base64url')}`;
    state.access.add(access);
    return { token_type: 'Bearer', access_token: access, expires_in: 3600, refresh_token: state.refresh };
  };
  const item = (id) => state.items.find((i) => i.id === id);
  const stateById = (id) => Object.values(STATES).flat().find((s) => s.id === id);
  const toUserIds = (empIds) => empIds.map((e) => MEMBERS.find((m) => m.empId === Number(e))?.userId);
  // Orbit records a state change only when the state actually changes.
  function moveTo(it, target) {
    if (it.state_id === target.id) return;
    it.state_id = target.id;
    it.state_group = GROUP_NUMBER[target.group];
    state.activities.push({ item_id: it.id, actor: { user_id: USER.userId }, via: 'claude', to: target.id });
  }

  // The fixed backend (plan 2.6): a non-member assignee fails the item.
  function newItem(input) {
    if (!input.title || input.title.length < 3) throw Object.assign(new Error('title is too short'), { status: 400 });
    const userIds = toUserIds(input.assignees_arr || []);
    if (userIds.some((u) => !u)) throw Object.assign(new Error(`Not active members of this project: ${input.assignees_arr.join(', ')}`), { status: 400 });
    if (input.state_id && !STATES[input.item_type]?.some((st) => st.id === input.state_id)) {
      throw Object.assign(new Error(`Invalid state_id for ${input.item_type}`), { status: 400 });
    }
    const stateId = input.state_id || DEFAULT_STATE[input.item_type]; // milestones have no states
    state.seq += 1;
    const it = {
      id: `I_NEW${state.seq}`, item_key: `WEB-${state.seq}`, item_type: input.item_type, title: input.title,
      ...(input.description && { description: input.description }),
      ...(stateId && { state_id: stateId }), state_group: stateId ? GROUP_NUMBER[stateById(stateId).group] : 2,
      assignees_arr: (input.assignees_arr || []).map(Number), assignees_user_arr: userIds,
      ...Object.fromEntries(PARENT_FIELDS.filter((f) => input[f]).map((f) => [f, input[f]])),
      ...(input.priority_id !== undefined && { priority_id: input.priority_id }),
      ...(input.due_date && { due_date: input.due_date }),
      ...(input.metadata && { metadata: input.metadata }),
      created_by: { user_id: USER.userId, emp_id: ORG.empId }, created_via: 'claude', created_at: Date.now(), updated_at: Date.now(),
    };
    state.items.push(it);
    return it;
  }

  function applyOp(current, op) {
    if (op.set) return [...op.set];
    return [...new Set([...current, ...(op.add || [])])].filter((x) => !(op.remove || []).map(String).includes(String(x)));
  }

  function route(path, body, auth) {
    if (path === '/v2/connect/token') {
      if (body.grant_type === 'authorization_code') {
        const grant = state.codes.get(body.code);
        state.codes.delete(body.code);
        const challenge = crypto.createHash('sha256').update(body.code_verifier || '').digest('base64url');
        if (!grant || grant.challenge !== challenge || grant.redirectUri !== body.redirect_uri) return fail(400, 'expired', 'invalid_grant');
        return ok(issue());
      }
      if (body.refresh_token !== state.refresh) return fail(400, 'Your Claude Code connection to Orbit has ended.', 'invalid_grant');
      return ok(issue());
    }
    if (path === '/v2/connect/revoke') {
      // RFC 7009: 200 either way; the connection (and its access tokens) ends only for its own token.
      if (body.token === state.refresh) {
        state.refresh = null;
        state.access.clear();
        state.revoked = true;
      }
      return ok(null);
    }
    if (!state.access.has(String(auth).replace(/^Bearer /, ''))) return fail(401, 'expired', 'CONNECTION_TOKEN_INVALID');
    state.calls.push({ path, body });
    switch (path) {
      case '/v2/auth/me': return ok({ ...USER });
      case '/v2/auth/organisations': return ok({ organisations: [ORG] });
      case '/v2/resolve/path':
        if (body.projectSlug !== 'web') return ok({ org: { orgId: 'O1', name: 'Acme', slug: 'acme' }, workspace: { id: 'W1', slug: 'eng' }, project: null, projectError: 'You do not have access to this project' });
        return ok({ org: { orgId: 'O1', name: 'Acme', slug: 'acme' }, membership: { empId: 7 }, workspace: { id: 'W1', name: 'Engineering', slug: 'eng' }, project: { id: 'P1', name: 'Web App', slug: 'web' } });
      case '/v2/workspaces/list': return ok({ workspaces: [{ id: 'W1', name: 'Engineering', slug: 'eng' }], total: 1 });
      case '/v2/projects/list': return ok({ projects: [PROJECT], total: 1 });
      case '/v2/states/list': return ok({ states: STATES[body.item_type] || [], default_state_ids: { ...DEFAULT_STATE } });
      case '/v2/labels/list': return ok({ labels: LABELS[body.item_type] || [] });
      case '/v2/priorities/list': return ok({ priorities: [{ id: 20, name: 'High' }, { id: 50, name: 'None' }] });
      case '/v2/projects/P1/members/list': return ok({ members: MEMBERS, total: 2, hasMore: false });
      case '/v2/work-items/get': {
        const it = body.item_id ? item(body.item_id) : state.items.find((i) => i.item_key === body.item_key);
        return it ? ok(structuredClone(it)) : fail(404, 'The requested item was not found', 'NOT_FOUND');
      }
      case '/v2/work-items/children': {
        const parent = item(body.item_id);
        const field = parent.item_type === 'task' ? 'parent_id' : `${parent.item_type}_id`;
        return ok({ ...parent, children: state.items.filter((i) => i[field] === parent.id) });
      }
      case '/v2/work-items/list': {
        let items = state.items.filter((i) => (body.item_types || []).includes('milestone') || i.item_type !== 'milestone');
        if (body.item_ids) items = items.filter((i) => body.item_ids.includes(i.id));
        if (body.item_types) items = items.filter((i) => body.item_types.includes(i.item_type));
        if (body.assignee_ids) items = items.filter((i) => i.assignees_user_arr.some((u) => body.assignee_ids.includes(u)));
        if (body.author_ids) items = items.filter((i) => body.author_ids.includes(i.created_by?.user_id));
        if (body.created_at_from) items = items.filter((i) => (i.created_at || 0) >= body.created_at_from);
        if (body.lifecycle === 'open') items = items.filter((i) => i.state_group < 4);
        for (const f of PARENT_FIELDS) if (body[f]) items = items.filter((i) => i[f] === body[f]);
        if (body.sort_by === 'created_at') items = [...items].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        const page = items.slice(0, Number(body.size) || 50).map(({ metadata, description, ...rest }) => rest);
        return ok({ items: page, total: items.length, from: 0, size: body.size, hasMore: items.length > page.length });
      }
      case '/v2/work-items/create':
        try {
          const it = newItem(body);
          return ok({ id: it.id, item_key: it.item_key, item_seq: state.seq, item_type: it.item_type, created_at: it.created_at }, 201);
        } catch (err) {
          return fail(err.status || 500, err.message, 'VALIDATION_ERROR');
        }
      case '/v2/work-items/bulk-create': {
        // Whole-batch shape check first, as the real route does.
        if (body.items.some((i) => !i.title || i.title.length < 3)) return fail(400, 'Please check your input', 'VALIDATION_ERROR');
        const results = body.items.map((input, index) => {
          try {
            // Stand-in for a per-item check (e.g. a state that isn't valid for the type).
            if (input.title.includes('[bad]')) throw new Error('Invalid state_id for task');
            const it = newItem(input);
            return { index, success: true, id: it.id, item_key: it.item_key, title: it.title };
          } catch (err) {
            return { index, success: false, title: input.title, error: err.message };
          }
        });
        const successful = results.filter((r) => r.success).length;
        return ok({ total: results.length, successful, failed: results.length - successful, results }, 201);
      }
      case '/v2/work-items/update': {
        const it = item(body.item_id);
        if (!it) return fail(404, 'Work item not found', 'NOT_FOUND');
        for (const f of ['title', 'description', 'priority_id', 'start_date', 'due_date', 'task_points']) if (body[f] !== undefined) it[f] = body[f];
        if (body.state_id) moveTo(it, stateById(body.state_id));
        if (body.assignees) {
          it.assignees_arr = applyOp(it.assignees_arr || [], body.assignees).map(Number);
          it.assignees_user_arr = toUserIds(it.assignees_arr);
        }
        if (body.labels) it.label_ids = applyOp(it.label_ids || [], body.labels);
        it.updated_at = Date.now();
        return ok({ id: it.id, item_key: it.item_key, updated_at: it.updated_at });
      }
      case '/v2/work-items/bulk-update': {
        const target = stateById(body.updates.state_id);
        const results = body.item_ids.map((itemId) => {
          const it = item(itemId);
          if (!it) return { itemId, success: false, error: 'Work item not found' };
          if (!STATES[it.item_type]?.includes(target)) return { itemId, success: false, error: 'Invalid state for this item type' };
          moveTo(it, target);
          return { itemId, success: true };
        });
        const successful = results.filter((r) => r.success).length;
        return ok({ total: results.length, successful, failed: results.length - successful, results });
      }
      case '/v2/work-items/activities/list': {
        const activities = state.activities.filter((a) => a.item_id === body.item_id);
        return ok({ activities, total: activities.length });
      }
      case '/v2/work-items/comments/add': {
        const comment = { id: `C${state.comments.length + 1}`, item_id: body.item_id, author: { user_id: USER.userId }, content: body.content, created_at: Date.now() };
        state.comments.push(comment);
        return ok({ ...comment }, 201);
      }
      case '/v2/work-items/comments/list': {
        const all = state.comments.filter((c) => c.item_id === body.item_id).sort((a, b) => b.created_at - a.created_at);
        return ok({ comments: all.slice(0, body.size || 20), total: all.length, hasMore: all.length > (body.size || 20) });
      }
      default: return fail(404, `Can't find ${path}`, 'NOT_FOUND');
    }
  }

  return {
    state,
    route,
    // Clicking Allow on the consent page: a one-time code bound to the PKCE challenge.
    allow(consentUrl) {
      const q = new URL(consentUrl).searchParams;
      const code = crypto.randomBytes(16).toString('base64url');
      state.codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
      return `${q.get('redirect_uri')}?${new URLSearchParams({ code, state: q.get('state') })}`;
    },
    expireAccessTokens() { state.access.clear(); },
    find: (key) => state.items.find((i) => i.item_key === key),
  };
}

export async function startFakeOrbit() {
  const fake = createFakeOrbit();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const { status, body } = fake.route(req.url, raw ? JSON.parse(raw) : {}, req.headers.authorization);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...fake, apiUrl: `${base}/v2`, close: () => new Promise((resolve) => server.close(resolve)) };
}
