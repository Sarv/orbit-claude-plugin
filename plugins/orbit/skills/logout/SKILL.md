---
name: logout
description: Disconnect this computer from Orbit and forget the stored sign-in.
disable-model-invocation: true
allowed-tools: mcp__plugin_orbit_orbit__orbit_logout
---

# Disconnect from Orbit

Call `orbit_logout` once, and tell the user its result in one line.

Don't call any other Orbit tool afterwards in this turn: that would start a new browser sign-in.
