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
