import { z } from 'zod';
import { groupName } from '../resolvers.js';
import { markdownToHtml } from '../markdown.js';
import { resolveTargetState, isGuarded, completionCheck, handoff } from '../policy.js';
import { isUnknown, postComment } from '../writes.js';
import { log } from '../log.js';
import { projectField } from './shared.js';

const MAX_ITEMS = 25;

/**
 * Fresh reads and one decision per item: { ref, it, line } (nothing to send), or { ref, it, move }
 * (a state to move to), plus `handoff` when the completion policy refused the move asked for.
 */
async function decide({ resolvers }, p, me, refs, args) {
  const reads = await Promise.all(refs.map((ref) => resolvers.item(p, ref).then((it) => ({ ref, it }), (err) => {
    if (err.kind !== 'not_found') throw err;
    return { ref, kind: 'failed', line: `${ref} ✗ ${err.message}` };
  })));
  const types = [...new Set(reads.filter((r) => r.it).map((r) => r.it.item_type))];
  const statesByType = new Map(await Promise.all(types.map(async (t) => [t, (await resolvers.states(p, t))?.states || []])));
  const used = new Map(); // item type → the state `status` meant for it

  const decisions = reads.map((r) => {
    if (!r.it) return r;
    const { it } = r;
    const states = statesByType.get(it.item_type);
    const target = resolveTargetState(states, args.status, args.review_state);
    if (target.error) return { ...r, kind: 'failed', line: `${it.item_key} ✗ not moved: for a ${it.item_type}, ${target.error}` };
    used.set(it.item_type, target.state.name);
    if (it.state_id === target.state.id) return { ...r, kind: 'already', line: `${it.item_key} already in "${target.state.name}"` };
    const current = states.find((s) => s.id === it.state_id);
    const from = current?.group || groupName(it.state_group);
    const to = target.state.group;
    if (!isGuarded(from, to)) return { ...r, move: target.state };
    const check = completionCheck(it, me, { from, to });
    if (check.ok) return { ...r, move: target.state };
    const plan = handoff({ from, to, current, reason: check.reason, states, reviewState: args.review_state });
    return { ...r, move: plan.moveTo, handoff: { ...plan, reason: check.reason } };
  });
  return { decisions, used };
}

/** One /work-items/bulk-update per target state (states are per item type). Item id → 'ok' | 'unknown' | error text. */
async function sendMoves({ client, resolvers }, p, decisions) {
  const groups = new Map();
  for (const d of decisions) {
    if (d.move) groups.set(d.move.id, [...(groups.get(d.move.id) || []), d.it.id]);
  }
  const outcome = new Map();
  await Promise.all([...groups].map(async ([stateId, ids]) => {
    try {
      const data = await client.call('/work-items/bulk-update', { ...resolvers.context(p), item_ids: ids, updates: { state_id: stateId } });
      const byId = new Map((data?.results || []).map((r) => [r.itemId, r]));
      for (const id of ids) {
        const r = byId.get(id);
        outcome.set(id, !r ? 'unknown' : r.success ? 'ok' : (r.error || 'Orbit refused the change'));
      }
    } catch (err) {
      if (err.kind === 'not_connected') throw err;
      for (const id of ids) outcome.set(id, isUnknown(err) ? 'unknown' : err.message);
    }
  }));
  return outcome;
}

/** The result line for a decision whose move (if any) has a known outcome. */
function settle(d, result) {
  const key = d.it.item_key;
  if (d.handoff) {
    const handed = `${key} — handed to a person: ${d.handoff.reason}`;
    if (d.move && result !== 'ok') return { kind: 'failed', line: `${handed}. Moving it to "${d.move.name}" failed: ${result}` };
    return { kind: 'handoff', line: `${handed}; ${d.handoff.summary}`, comment: d.handoff.comment };
  }
  if (result === 'ok') return { kind: 'moved', line: `${key} → "${d.move.name}"` };
  return { kind: 'failed', line: `${key} ✗ not moved: ${result}` };
}

const COMMENT_NOTE = { posted: 'comment added', found: 'comment added', not_confirmed: "the comment isn't confirmed (not resent)" };

export default {
  name: 'orbit_set_status',
  title: 'Change status',
  description: 'Move one or more work items to a status. Use "started" before you begin a step and "completed" '
    + 'after it is done (and for the parent when the whole job is done). Orbit only lets Claude close, reopen or '
    + 'cancel items Claude created that carry no points; anything else is handed to a person with a comment. '
    + '"Handed to a person" is expected, not an error: tell the user in one line which items wait for them and why, '
    + 'and never try to get around it with another status or a repeat. To reopen an item, use "unstarted" unless '
    + 'the user names a state. The result names the state used per item type.',
  inputSchema: z.object({
    project: projectField,
    items: z.array(z.string().trim().min(1)).min(1).max(MAX_ITEMS).describe('Item keys like "SBX-142" (or ids).'),
    status: z.string().trim().min(1).describe('A state group (backlog, unstarted, started, completed, cancelled; a '
      + 'group with several states uses its first), "review", or a state name such as "In Review".'),
    review_state: z.string().trim().min(1).optional().describe('The review_state from .orbit.json: pass it whenever '
      + 'it is set. It is what "review" means, and where an item goes when Claude may not close it (a refused reopen '
      + 'or cancel leaves the item where it is).'),
  }),
  readOnly: false,
  idempotent: true,
  async handler(args, orbit) {
    const { resolvers } = orbit;
    const p = await resolvers.project(args.project);
    const me = await resolvers.me();
    // Keys and ULID ids are upper-case, so "web-2" and "WEB-2" are one item.
    const refs = [...new Set(args.items.map((ref) => ref.toUpperCase()))];
    const settled = new Map(); // ref → { kind, line, comment?, it? }
    const used = new Map();

    // Status moves set an absolute value, so an unknown outcome is retried once — from a fresh
    // read, so the completion policy runs again on the item as it is now.
    let pending = refs;
    for (let attempt = 1; attempt <= 2 && pending.length; attempt += 1) {
      const round = await decide(orbit, p, me, pending, args);
      round.used.forEach((name, type) => used.set(type, name));
      const sent = await sendMoves(orbit, p, round.decisions);
      const unknown = [];
      for (const d of round.decisions) {
        if (!d.move) {
          // On the retry, "already there" most likely means the unanswered first attempt landed.
          const landed = attempt === 2 && d.kind === 'already';
          settled.set(d.ref, d.handoff ? { ...settle(d, 'ok'), it: d.it }
            : landed ? { kind: 'moved', line: d.line.replace(' already in ', ' → ') } : d);
          continue;
        }
        const result = sent.get(d.it.id);
        if (result === 'unknown') {
          unknown.push(d.ref);
          settled.set(d.ref, { kind: 'unknown', line: `${d.it.item_key} ? Orbit didn't answer twice, so it may or may not be in "${d.move.name}" now. Check it: ${resolvers.itemUrl(p, d.it)}` });
        } else {
          settled.set(d.ref, { ...settle(d, result), it: d.it });
        }
      }
      if (unknown.length && attempt === 1) log('info', 'status move had an unknown outcome; retrying once', { items: unknown.length });
      pending = unknown;
    }

    // Handoff comments go out once the moves are settled, so they describe what really happened.
    const notes = new Map(await Promise.all([...settled].filter(([, s]) => s.comment).map(async ([ref, s]) => {
      try {
        return [ref, COMMENT_NOTE[await postComment(orbit, p, s.it, markdownToHtml(s.comment))]];
      } catch (err) {
        if (err.kind === 'not_connected') throw err;
        return [ref, `the comment failed: ${err.message}`];
      }
    })));

    const results = refs.map((ref) => settled.get(ref));
    // A handoff needs a person, so its line carries the item's link.
    const lines = refs.map((ref, i) => {
      const r = results[i];
      const line = notes.has(ref) ? `${r.line}; ${notes.get(ref)}` : r.line;
      return r.kind === 'handoff' ? `${line}. ${resolvers.itemUrl(p, r.it)}` : line;
    });
    const header = used.size
      ? `"${args.status}" means ${[...used].map(([type, name]) => `"${name}" for a ${type}`).join(', ')}.`
      : `Nothing could be moved to "${args.status}".`;
    return {
      isError: results.every((r) => r.kind === 'failed' || r.kind === 'unknown'),
      text: [header, ...lines].join('\n'),
    };
  },
};
