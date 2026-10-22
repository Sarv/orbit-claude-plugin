---
name: login
description: Connect Claude Code to Orbit now. The browser sign-in also starts by itself the first time Claude needs Orbit.
disable-model-invocation: true
allowed-tools: mcp__plugin_orbit_orbit__orbit_whoami
---

# Connect to Orbit

Call `orbit_whoami`.

- If it answers with an account, say in one line which Orbit account Claude Code is connected as.
- If it says Orbit isn't connected, it has opened the browser (or returned a link). Tell the user to
  click Allow on the Orbit page, then run `/orbit:login` again to check. Show the link if the result
  has one.

To switch to another Orbit account, the user runs `/orbit:logout` first.
