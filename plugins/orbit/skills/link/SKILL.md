---
name: link
description: Link this repo to an Orbit project, so Claude tracks its multi-step work there. Writes .orbit.json at the repo root.
argument-hint: <Orbit project URL>
disable-model-invocation: true
allowed-tools: mcp__plugin_orbit_orbit__orbit_resolve_url mcp__plugin_orbit_orbit__orbit_get_project_config Bash(git rev-parse --show-toplevel)
---

# Link this repo to an Orbit project

Project URL: $ARGUMENTS

1. If no URL was given above, ask the user to open the project in Orbit and paste the address from
   the browser (it looks like `https://app.orbitorg.com/u/0/org/<org>/ws/<workspace>/prj/<project>`).
   Wait for it.
2. Call `orbit_resolve_url` with the URL. If it fails, show the error in one line and stop. If it says
   Orbit isn't connected, tell the user to click Allow in the browser, then run `/orbit:link` again.
3. Call `orbit_get_project_config` for that project (item type `task`). Its "States" line lists each
   state with its group in brackets.
4. Ask the user which state is the **review state**: where Claude puts finished work it isn't allowed
   to close (for example, items that carry points). Offer only the task states in the `started`
   group, plus "none". If one of them has "review" in its name, suggest it.
5. In the "Custom fields" lines, find the fields marked `required` that have no default. Claude can't
   create a task without them, so ask the user for one value each, offering the choices the line
   shows (a date as YYYY-MM-DD, a person by email). Never guess a value. Skip this step when there
   are none.
6. Find the repo root with `git rev-parse --show-toplevel` (if that fails, use the current folder).
   Write `.orbit.json` there, replacing any earlier one, with exactly these fields:

   ```json
   {
     "project": "<the Project URL line from orbit_resolve_url>",
     "org_id": "<org_id>",
     "workspace_id": "<workspace_id>",
     "project_id": "<project_id>",
     "review_state": "<the chosen state's name, or null for none>",
     "defaults": { "task": { "fields": { "<field name>": "<the user's value>" } } }
   }
   ```

   Leave out `defaults` when step 5 asked nothing. If the earlier file had the same `project_id`,
   keep its `confirm_plan` and each item type's `labels` and `priority` under `defaults`; a link to
   another project starts without them.
7. Tell the user, in two lines, that the repo is linked to the project (by name), with the values
   step 5 saved if any, and that they should commit `.orbit.json` so the whole team shares the link.
   It holds no secrets: each person's sign-in stays on their own computer.
