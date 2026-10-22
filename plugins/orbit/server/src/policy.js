// The rules about what Claude may do, enforced here so they don't depend on Claude remembering
// them (plan 2.1–2.3): which state a status means, where new items attach, and which items Claude
// may close, reopen or cancel.

import { OrbitError } from './errors.js';
import { STATE_GROUPS } from './resolvers.js';

// ─── States (2.1) ──────────────────────────────────────────────────────────────────────────────

const bySequence = (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0);

/** The review state named in .orbit.json, for one item type's states: { state } or { error }. */
export function reviewTarget(states, reviewState) {
  if (!reviewState) return { error: 'no review state is set in .orbit.json' };
  const state = states.find((s) => s.name.toLowerCase() === reviewState.trim().toLowerCase());
  if (!state) return { error: `there is no "${reviewState}" state for this item type` };
  // A review state outside `started` would close the item or move it backwards.
  if (state.group !== 'started') return { error: `"${state.name}" is in the ${state.group} group, not started` };
  return { state };
}

/**
 * What `status` means for one item type's states: { state } or { error }. A group or "review"
 * first, then a state name (case-insensitive). A group with several states → the lowest sequence.
 */
export function resolveTargetState(states, status, reviewState) {
  const wanted = status.trim().toLowerCase();
  if (wanted === 'review') return reviewTarget(states, reviewState);
  if (STATE_GROUPS.includes(wanted)) {
    const [state] = states.filter((s) => s.group === wanted).sort(bySequence);
    return state ? { state } : { error: `there is no state in the ${wanted} group for this item type` };
  }
  const state = states.find((s) => s.name.toLowerCase() === wanted);
  if (state) return { state };
  return { error: `there is no state called "${status}"; use one of ${states.map((s) => s.name).join(', ')}, a group (${STATE_GROUPS.join(', ')}) or review` };
}

// ─── Hierarchy (2.2) ───────────────────────────────────────────────────────────────────────────

const isSubtask = (item) => item.item_type === 'task' && Boolean(item.parent_id);

/**
 * What a job's steps become under the named item: { itemType, field, kind }, or null for a
 * subtask (Orbit allows one level of subtasks, so the job is tracked on it with comments).
 */
export function stepsUnder(item) {
  if (['epic', 'feature', 'story'].includes(item.item_type)) return { itemType: 'task', field: `${item.item_type}_id`, kind: 'tasks' };
  if (item.item_type === 'task') return isSubtask(item) ? null : { itemType: 'task', field: 'parent_id', kind: 'subtasks' };
  throw new OrbitError('invalid', `${item.item_key} is a ${item.item_type}, which can't hold the steps of a job. Name a task, story, feature or epic instead.`);
}

// Which items a new item of each type can sit under. Orbit silently DROPS any other parent field,
// which would create the item at the top level, so refuse instead.
const PARENT_TYPES = { task: ['epic', 'feature', 'story', 'task'], story: ['epic', 'feature'], feature: ['epic'], epic: [] };
const PARENT_PHRASE = { epic: 'an epic', feature: 'a feature', story: 'a story', task: 'a top-level task' };

/** The field that puts a new `itemType` item under `parent`. */
export function parentField(itemType, parent) {
  if (isSubtask(parent)) {
    throw new OrbitError('invalid', `${parent.item_key} is a subtask, and Orbit allows only one level of subtasks. Put the new item under ${parent.item_key}'s parent, or comment on ${parent.item_key} instead.`);
  }
  const allowed = PARENT_TYPES[itemType] || [];
  if (!allowed.includes(parent.item_type)) {
    const phrases = allowed.map((t) => PARENT_PHRASE[t]);
    const where = phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} or ${phrases.at(-1)}` : phrases[0];
    throw new OrbitError('invalid', where
      ? `A ${itemType} can go under ${where}, not under ${parent.item_key} (a ${parent.item_type}).`
      : `An epic can't go under another item (${parent.item_key} is a ${parent.item_type}).`);
  }
  return parent.item_type === 'task' ? 'parent_id' : `${parent.item_type}_id`;
}

// ─── Completion policy (2.3) ───────────────────────────────────────────────────────────────────

/** Why the item counts as carrying points right now, or null. */
function pointsOn(item) {
  // The creator always sees task points; if Orbit ever hides them, don't assume there are none.
  if (item.points_access?.can_view_task_points === false) return "Orbit doesn't show Claude its points";
  const found = [];
  if (Number(item.task_points) > 0) found.push(`task points ${item.task_points}`);
  if (Number(item.story_points) > 0) found.push(`story points ${item.story_points}`);
  // A non-admin viewer gets only their own allocation (`my_assignee_points`), never the array.
  if (item.assignee_points?.length || item.my_assignee_points) found.push('points allocated to assignees');
  return found.length ? `it carries points (${found.join(', ')})` : null;
}

/**
 * May Claude move this item into or out of `completed` (or into `cancelled`)? Only items this
 * server created (Orbit's own `created_via`), for this user, and — except for a plain cancel —
 * with no points at this moment. `item` must be a fresh /work-items/get read.
 */
export function completionCheck(item, me, { from, to }) {
  if (item.created_via !== 'claude') return { ok: false, reason: "it wasn't created through Claude" };
  if (item.created_by?.user_id !== me.userId) return { ok: false, reason: 'someone else created it' };
  if (from === 'completed' || to === 'completed') {
    const points = pointsOn(item);
    if (points) return { ok: false, reason: points };
  }
  return { ok: true };
}

/** Does a move from group `from` to group `to` go through the completion policy? */
export const isGuarded = (from, to) => from === 'completed' || to === 'completed' || to === 'cancelled';

/**
 * A refused move: what happens instead (plan 2.3 fallback table). Never moves an item into or out
 * of `completed`. Returns { moveTo: state | null, comment, summary }.
 */
export function handoff({ from, to, current, reason, states, reviewState }) {
  const where = current ? `"${current.name}"` : 'its current state';
  if (from === 'completed') {
    // Moving out of completed clears point allocations, so the state is never touched here.
    const verb = to === 'cancelled' ? 'cancelled' : 'reopened';
    return { moveTo: null, comment: `Not ${verb} by Claude: ${reason}. It stays in ${where}; a person needs to change it.`, summary: `left in ${where}` };
  }
  if (to === 'completed' && ['backlog', 'unstarted', 'started'].includes(from)) {
    const review = reviewTarget(states, reviewState);
    const lead = `Ready for review — not closed by Claude: ${reason}.`;
    if (review.state && review.state.id !== current?.id) {
      return { moveTo: review.state, comment: `${lead} Moved to "${review.state.name}"; a person needs to close it.`, summary: `moved to "${review.state.name}"` };
    }
    if (review.state) return { moveTo: null, comment: `${lead} A person needs to close it.`, summary: `left in ${where}` };
    return { moveTo: null, comment: `${lead} Left in ${where} (${review.error}); a person needs to close it.`, summary: `left in ${where} (${review.error})` };
  }
  const verb = to === 'cancelled' ? 'cancelled' : 'closed';
  return { moveTo: null, comment: `Not ${verb} by Claude: ${reason}. A person needs to do it.`, summary: `left in ${where}` };
}
