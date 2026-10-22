import { z } from 'zod';

export default {
  name: 'orbit_whoami',
  title: 'Who am I in Orbit',
  description: 'Show which Orbit account Claude Code acts as, and that user\'s organisations (with their '
    + 'employee id in each). Use it to check the Orbit connection. If Orbit isn\'t connected yet, this '
    + 'starts the one-time browser sign-in. Don\'t call it just to check before tracking: any Orbit tool connects '
    + 'when needed.',
  inputSchema: z.object({}),
  readOnly: true,
  async handler(_args, { resolvers }) {
    const [me, orgs] = await Promise.all([resolvers.me(), resolvers.orgs()]);
    const name = me.displayName || me.fullName || me.email;
    const lines = [`Connected to Orbit as ${name} <${me.email}> (user id ${me.userId}).`];
    lines.push(orgs.length ? 'Organisations:' : 'Not a member of any organisation yet.');
    for (const o of orgs) lines.push(`- ${o.orgName} (${o.orgSlug}) — employee id ${o.empId}`);
    return lines.join('\n');
  },
};
