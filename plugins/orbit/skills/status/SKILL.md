---
name: status
description: Show my open Orbit items, and Claude's jobs in progress, in the project this repo is linked to.
disable-model-invocation: true
allowed-tools: mcp__plugin_orbit_orbit__orbit_search_work_items mcp__plugin_orbit_orbit__orbit_list_jobs
---

# My open Orbit items

1. Read `.orbit.json` at the repo root. If there isn't one, say the repo isn't linked to Orbit and
   that `/orbit:link <project URL>` links it, then stop.
2. Call `orbit_list_jobs` and `orbit_search_work_items` with its `project` value and their defaults
   (open jobs; items assigned to me and open).
3. Show both results as they came back: first "Claude jobs in progress" (skip it when there are
   none), then "My open items". Add at most one line, only if something needs the user's attention
   (for example, items waiting in the review state).
