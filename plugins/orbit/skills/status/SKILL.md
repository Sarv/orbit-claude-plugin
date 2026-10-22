---
name: status
description: Show my open Orbit items in the project this repo is linked to.
disable-model-invocation: true
allowed-tools: mcp__plugin_orbit_orbit__orbit_search_work_items
---

# My open Orbit items

1. Read `.orbit.json` at the repo root. If there isn't one, say the repo isn't linked to Orbit and
   that `/orbit:link <project URL>` links it, then stop.
2. Call `orbit_search_work_items` with its `project` value and the defaults (assigned to me, open).
3. Show the result as it came back. Add at most one line, only if something needs the user's
   attention (for example, items waiting in the review state).
