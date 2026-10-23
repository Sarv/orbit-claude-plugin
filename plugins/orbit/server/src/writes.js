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

// ─── Custom fields ─────────────────────────────────────────────────────────────────────────────

const FIELD_KINDS = {
  text: 'text', number: 'a number', date: 'a date (YYYY-MM-DD)', boolean: 'yes or no',
  single_select: 'one of', multi_select: 'any of', user: 'a project member', attachment: 'a file',
};
const MAX_OPTIONS_SHOWN = 15;
const optionLabels = (def) => (def.options || []).map((o) => o.label);

/** What a field takes, for messages: "one of: Acme, Globex" or "a date (YYYY-MM-DD)". */
export function fieldHint(def) {
  if (def.field_type !== 'single_select' && def.field_type !== 'multi_select') return FIELD_KINDS[def.field_type] || def.field_type;
  const labels = optionLabels(def);
  return `${FIELD_KINDS[def.field_type]}: ${labels.slice(0, MAX_OPTIONS_SHOWN).join(', ')}${labels.length > MAX_OPTIONS_SHOWN ? ', …' : ''}`;
}

// Orbit fills any default that isn't null/undefined, and a filled default satisfies "required".
export const hasDefault = (def) => def.default_value !== null && def.default_value !== undefined;

const option = (def, label) => (def.options || []).find((o) => o.label.toLowerCase() === String(label).trim().toLowerCase()
  || o.id === String(label).trim());

/** One value Claude gave → what Orbit stores for that field type: { value } or { problem }. */
async function fieldValue(def, raw, p, resolvers) {
  const bad = (what) => ({ problem: `${def.name} takes ${what}, not ${JSON.stringify(raw)}` });
  switch (def.field_type) {
    case 'text': return typeof raw === 'string' ? { value: raw.trim() } : bad('text');
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      return String(raw).trim() !== '' && Number.isFinite(n) ? { value: n } : bad('a number');
    }
    case 'boolean': {
      const yes = ['true', 'yes'], no = ['false', 'no'];
      const s = String(raw).trim().toLowerCase();
      return yes.includes(s) ? { value: true } : no.includes(s) ? { value: false } : bad('yes or no');
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return bad('a date (YYYY-MM-DD)');
      try { return { value: dayToEpoch(String(raw)) }; } catch (err) { return { problem: `${def.name}: ${err.message}` }; }
    }
    case 'single_select': {
      const o = typeof raw === 'string' ? option(def, raw) : null;
      return o ? { value: o.id } : { problem: `${JSON.stringify(raw)} isn't an option of ${def.name} (${fieldHint(def)})` };
    }
    case 'multi_select': {
      const labels = Array.isArray(raw) ? raw : [raw];
      const found = labels.map((l) => option(def, l));
      const unknown = labels.filter((_, i) => !found[i]);
      return unknown.length
        ? { problem: `${unknown.map((l) => JSON.stringify(l)).join(', ')} isn't an option of ${def.name} (${fieldHint(def)})` }
        : { value: [...new Set(found.map((o) => o.id))] };
    }
    case 'user': {
      if (typeof raw !== 'string') return bad('a project member');
      const [person] = await resolveAssignees(p, [raw], resolvers); // refuses a non-member, as for assignees
      return { value: person.empId };
    }
    default: return { problem: `${def.name} is a ${def.field_type === 'attachment' ? 'file' : def.field_type} field, which Claude can't set` };
  }
}

/**
 * Custom field values by name ({ "Client": "Acme" }) → Orbit's [{ field_id, value }] for one item
 * type, checked BEFORE anything is sent: unknown names and options, wrong types, and any required
 * field that has neither a value here nor a default (Orbit fills defaults itself, and refuses a
 * required field left empty). Returns { values, unseen }: when Orbit lists no fields to this user
 * (a CONTRIBUTOR can't see them), nothing is checked or sent and `unseen` names what was given;
 * Orbit then applies the defaults and refuses anything still missing.
 */
export async function resolveCustomFields(p, itemType, fields, resolvers) {
  const defs = await resolvers.customFields(p, itemType);
  const given = Object.entries(fields || {});
  if (!defs.length) return { values: [], unseen: given.map(([name]) => name) };

  const byName = new Map(defs.map((d) => [d.name.trim().toLowerCase(), d]));
  const values = [];
  const problems = [];
  for (const [name, raw] of given) {
    const def = byName.get(name.trim().toLowerCase());
    if (!def) {
      problems.push(`"${name}" isn't a ${itemType} field in ${p.projectName} (fields: ${list(defs.map((d) => d.name))})`);
      continue;
    }
    const out = await fieldValue(def, raw, p, resolvers);
    if (out.problem) problems.push(out.problem);
    else values.push({ field_id: def.id, value: out.value });
  }
  const sent = new Set(values.map((v) => v.field_id));
  const missing = defs.filter((d) => d.is_required && !hasDefault(d) && !sent.has(d.id) && !given.some(([n]) => byName.get(n.trim().toLowerCase()) === d));
  if (missing.length) {
    problems.push(`${p.projectName} needs these ${itemType} fields, which have no default: `
      + `${missing.map((d) => `${d.name} (${fieldHint(d)})`).join('; ')}. Ask the user for the values (never guess), then pass them in "fields"`);
  }
  if (problems.length) throw new OrbitError('invalid', `Nothing was sent: ${problems.join('; ')}.`);
  return { values, unseen: [] };
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
