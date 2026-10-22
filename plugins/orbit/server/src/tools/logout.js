import { z } from 'zod';

export default {
  name: 'orbit_logout',
  title: 'Disconnect Orbit',
  description: 'Disconnect this computer from Orbit: ends the Claude Code connection in Orbit and forgets the '
    + 'stored sign-in. Use it ONLY when the user runs /orbit:logout or plainly asks to disconnect Orbit; never to '
    + 'fix an error. The next Orbit call starts a new browser sign-in.',
  inputSchema: z.object({}),
  readOnly: false,
  idempotent: true,
  async handler(_args, { auth, config, resolvers }) {
    const result = await auth.logout();
    resolvers.clearCache();
    const where = `Orbit (${config.apiHost})`;
    if (!result.wasConnected) return `This computer wasn't connected to ${where}, so there was nothing to disconnect.`;
    if (result.revoked) return `Disconnected from ${where}: the connection is ended in Orbit and forgotten on this computer. The next Orbit call will ask you to sign in again.`;
    return {
      isError: true,
      text: `Forgot the sign-in on this computer, but couldn't reach ${where} to end the connection there. `
        + `It stays listed under Connected apps until you disconnect it: ${config.appUrl}/u/0/connected-apps`,
    };
  },
};
