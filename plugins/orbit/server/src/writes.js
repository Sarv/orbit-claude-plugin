// The write contract (plan 2.5). Every write gets a request id, and creates stamp it into the
// item's `metadata` with the item's position. Results are reported per item, never "created"
// unless Orbit said so for that item.
//
// After an UNKNOWN outcome (timeout, network error, 502/503/504) a create or comment is NEVER
// resent: Orbit has no idempotency keys, and a request whose answer was lost may still be running.
// A read-only check reports what landed instead. Status and field updates set absolute values and
// insert nothing, so those are retried once.

import crypto from 'node:crypto';
import { OrbitError } from './errors.js';
import { htmlToText, list } from './format.js';
import { log } from './log.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Candidates may have been created slightly before our clock says the request started.
const CLOCK_SLACK_MS = 60_000;

export const newRequestId = () => crypto.randomUUID();
export const isUnknown = (err) => err instanceof OrbitError && err.kind === 'unknown';
export const memberName = (m) => m.displayName || m.fullName || m.orgEmail || 'a member';

/**
 * People Claude names ("me", a member's email, or their exact name) → project members, checked
 * BEFORE anything is sent (D3): Orbit stores an unchecked assignee today (plan 2.6), so anyone who
 * isn't an active member of the project stops the whole write. Returns [{ empId, userId, name }].
 */
export async function resolveAssignees(p, refs, resolvers) {
  if (!refs.length) return [];
  const [members, me] = await Promise.all([resolvers.members(p), resolvers.me()]);
  const found = new Map();
  const problems = [];
  for (const ref of refs) {
    const who = String(ref).trim().toLowerCase();
    let matches;
    if (who === 'me') {
      matches = members.filter((m) => m.userId === me.userId);
      if (!matches.length) problems.push(`you aren't a member of ${p.projectName}`);
    } else {
      const byEmail = members.filter((m) => m.orgEmail?.toLowerCase() === who);
      matches = byEmail.length ? byEmail
        : members.filter((m) => [m.displayName, m.fullName].some((n) => n?.trim().toLowerCase() === who));
      if (matches.length > 1) {
        problems.push(`"${ref}" matches several members (${list(matches.map(memberName))}); use their email`);
      } else if (!matches.length) {
        const close = members.filter((m) => `${m.displayName || ''} ${m.fullName || ''}`.toLowerCase().includes(who));
        const suggest = close.slice(0, 5).map((m) => (m.orgEmail ? `${memberName(m)} <${m.orgEmail}>` : memberName(m)));
        problems.push(`"${ref}" isn't a member of ${p.projectName}${suggest.length ? ` (did you mean ${list(suggest)}?)` : ''}`);
      }
    }
    if (matches.length === 1) {
      const m = matches[0];
      found.set(m.userId, { empId: m.empId, userId: m.userId, name: m.userId === me.userId ? 'you' : memberName(m) });
    }
  }
  if (problems.length) {
    throw new OrbitError('invalid', `Nothing was sent: ${problems.join('; ')}. orbit_get_project_config lists the members.`);
  }
  return [...found.values()];
}

/** A priority name ("High") → its id. */
export async function resolvePriority(name, resolvers) {
  const priorities = await resolvers.priorities();
  const match = priorities.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!match) throw new OrbitError('invalid', `There is no priority called "${name}"; use one of ${priorities.map((x) => x.name).join(', ')}.`);
  return match.id;
}

/** Label names → ids, among the labels of this item type (labels are per type, plan 2.1). */
export async function resolveLabels(p, itemType, names, resolvers) {
  const labels = await resolvers.labels(p, itemType);
  const missing = [];
  const ids = names.map((name) => {
    const match = labels.find((l) => l.name.toLowerCase() === name.trim().toLowerCase());
    if (!match) missing.push(`"${name}"`);
    return match?.id;
  });
  if (missing.length) {
    throw new OrbitError('invalid', `Nothing was sent: ${p.projectName} has no ${itemType} label ${missing.join(', ')}. ${itemType} labels: ${labels.map((l) => l.name).join(', ') || 'none'}.`);
  }
  return [...new Set(ids)];
}

/** "2026-10-25" → epoch millis at local midnight, as Orbit's web app sends a picked date. */
export function dayToEpoch(day) {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    throw new OrbitError('invalid', `"${day}" isn't a real date (use YYYY-MM-DD).`);
  }
  return date.getTime();
}

/**
 * After an unknown create: which of this request's items exist? Read-only — for reporting, never
 * for resending. Lists the user's items created since the request started (under the same parent),
 * reads up to twice the batch size of them, and matches `metadata.mcp_request_id` + `mcp_index`,
 * never titles. Returns Map(index → item), or null when the check itself couldn't run.
 */
export async function findCreated({ config, client, resolvers }, p, { requestId, count, startedAt, itemType, parentField, parentId }) {
  try {
    await sleep(config.confirmDelayMs);
    const me = await resolvers.me();
    const listed = await client.call('/work-items/list', {
      ...resolvers.context(p),
      author_ids: [me.userId],
      created_at_from: startedAt - CLOCK_SLACK_MS,
      item_types: [itemType],
      ...(parentField && { [parentField]: parentId }),
      from: 0, size: count * 2, sort_by: 'created_at', sort_order: 'desc',
    });
    const candidates = await Promise.all((listed?.items || []).map((c) =>
      client.call('/work-items/get', { ...resolvers.context(p), item_id: c.id }).catch(() => null)));
    const found = new Map();
    for (const it of candidates) {
      const m = it?.metadata;
      if (m?.mcp_request_id === requestId && Number.isInteger(m.mcp_index)) found.set(m.mcp_index, it);
    }
    return found;
  } catch (err) {
    log('warn', 'could not check what an unknown create left behind', { error: err.message });
    return null;
  }
}

/**
 * Post a comment (HTML). Returns 'posted', or after an unknown outcome 'found' (a comment by this
 * user, since the request started, with the same text is there) or 'not_confirmed'. Never resent.
 * A definite failure throws.
 */
export async function postComment({ config, client, resolvers }, p, item, html) {
  const startedAt = Date.now();
  try {
    await client.call('/work-items/comments/add', { ...resolvers.context(p), item_id: item.id, content: html });
    return 'posted';
  } catch (err) {
    if (!isUnknown(err)) throw err;
  }
  try {
    await sleep(config.confirmDelayMs);
    const [me, data] = await Promise.all([
      resolvers.me(),
      client.call('/work-items/comments/list', { ...resolvers.context(p), item_id: item.id, from: 0, size: 20, sort_order: 'desc' }),
    ]);
    // Orbit's sanitizer may rewrite the HTML, so compare the text.
    const text = htmlToText(html);
    const landed = (data?.comments || []).some((c) => c.author?.user_id === me.userId
      && Number(c.created_at) >= startedAt - CLOCK_SLACK_MS && htmlToText(c.content) === text);
    return landed ? 'found' : 'not_confirmed';
  } catch (err) {
    log('warn', 'could not check whether an unknown comment landed', { error: err.message });
    return 'not_confirmed';
  }
}

/** For writes that set absolute values (field updates): an unknown outcome is retried once. */
export async function retryOnceIfUnknown(fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isUnknown(err)) throw err;
    log('info', 'unknown outcome on an update; retrying once', { error: err.message });
    return fn();
  }
}
