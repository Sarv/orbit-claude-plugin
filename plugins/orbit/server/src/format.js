// Compact text for Claude: a few lines per item, never raw API JSON (it wastes context).

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Orbit stores descriptions and comments as HTML; Claude reads them as plain text. */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(ul|ol)>/gi, '\n\n')
    .replace(/<\/(p|div|h[1-6]|pre|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => {
      if (ENTITIES[e]) return ENTITIES[e];
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return m;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Epoch millis → YYYY-MM-DD (UTC), or '' */
export function day(ms) {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString().slice(0, 10) : '';
}

/** "a, b and c" */
export function list(names) {
  const xs = names.filter(Boolean);
  return xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** One line per work item: key, type, state, title, assignees, due date, "via Claude". */
export function itemLine(item, { states, names }) {
  const state = states.get(item.state_id)?.name || stateGroupName(item.state_group) || 'no state';
  const people = (item.assignees_user_arr || []).map((id) => names.get(id) || 'someone');
  const bits = [people.length ? people.join(', ') : 'unassigned'];
  if (item.due_date) bits.push(`due ${day(item.due_date)}`);
  if (item.created_via === 'claude') bits.push('via Claude');
  return `${item.item_key} [${item.item_type}] ${state} — ${truncate(item.title, 120)} · ${bits.join(' · ')}`;
}

const STATE_GROUP_NAMES = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'];
const stateGroupName = (n) => STATE_GROUP_NAMES[Number(n) - 1] || null;
