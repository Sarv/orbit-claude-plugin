// Input fields several tools share. Descriptions are instructions to Claude.
import { z } from 'zod';
import { ITEM_TYPES } from '../resolvers.js';

export const projectField = z.string().min(1).describe(
  'The Orbit project: its URL (…/org/<org>/ws/<workspace>/prj/<project>) or "org/workspace/project". '
  + 'In a repo linked with /orbit:link, use the "project" value from .orbit.json.',
);
export const itemField = z.string().min(1).describe('A work item key like "SBX-142" (preferred) or its id.');
export const itemTypeField = z.enum(ITEM_TYPES);

// Write tools. Limits mirror Orbit's (title 3–200), so a bad input is refused before it's sent.
export const titleField = z.string().trim().min(3).max(200).describe('A short title that states the outcome in plain words.');
export const markdownField = z.string().trim().min(1).max(20_000);
export const assigneesField = z.array(z.string().trim().min(1)).max(10).describe(
  'Who to assign: "me" (the developer you work for), or a project member\'s email (safest) or name as Orbit shows '
  + 'it. A name that matches no one, or several people, changes nothing and returns suggestions. Name other people '
  + 'only when the developer asked for them.',
);
export const dayField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
// Orbit takes at most 20 labels per item.
export const labelsField = z.array(z.string().trim().min(1)).min(1).max(20).describe(
  'Label names, among the item type\'s labels (orbit_get_project_config lists them; labels differ per item type). '
  + 'Pass the matching item type\'s labels from .orbit.json (defaults.<item type>.labels) and any the user asked for.',
);
export const priorityField = z.string().trim().min(1).describe(
  'A priority name such as "High". Pass .orbit.json\'s defaults.<item type>.priority when it is set, unless the user '
  + 'asked for another.',
);
/** ", labels a and b, priority High" for a result line; '' when neither was given. */
export const labelsAndPriority = ({ labels, priority }) => [labels?.length && `, labels ${labels.join(', ')}`,
  priority && `, priority ${priority}`].filter(Boolean).join('');
/** Result note when custom field values were given but Orbit shows this user no fields. */
export const unseenNote = (names) => (names.length
  ? `\nNot set: ${names.join(', ')}. Orbit doesn't show you this project's custom fields; they got the project's defaults, if any.`
  : '');

export const fieldsField = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])).describe(
  'Custom field values by field name, e.g. {"Client": "Acme", "Release": "2026-11-01"}: a select takes its option label '
  + '(a list for multi-select), a person field "me" or a member\'s email, a date YYYY-MM-DD. Pass the matching item '
  + 'type\'s values from .orbit.json (defaults.<item type>.fields) and any the user gave; never guess one. orbit_get_project_config lists '
  + 'the fields, which are required and their defaults.',
);
