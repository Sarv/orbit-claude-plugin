---
name: orbit-tracking
description: Track multi-step coding work in Orbit, the team's work tracker. Use it at the start of a task with two or more separate pieces of work in a repo that has an .orbit.json file at its root, and when the user asks you to work on an Orbit item (e.g. "implement SBX-142"). Creates a parent item and one item per step, moves them through their states, and comments on progress. For a question about an item, just read it with orbit_get_work_item.
---

# Track work in Orbit

The repo's `.orbit.json` (written by `/orbit:link`) links it to an Orbit project. Track your own work
there so the team can see it, without being asked each time.

## When to track

- Track when the change needs two or more separate pieces of work a teammate would want to see
  (for example: the UI, the builder, and the wiring). Reading code, running tests and committing
  are not steps. Skip anything you'd finish in a few minutes.
- Track when the user asks you to work on an Orbit item.
- Don't track questions, explanations, reviews, or one-line edits.
- If the repo has no `.orbit.json`, don't track. If the user asks for tracking, say once that
  `/orbit:link <project URL>` links the repo.

## How to track

1. Read `.orbit.json` at the repo root. Use its `project` value as the `project` argument of every
   Orbit tool, and pass its `review_state` to every `orbit_set_status` call when it is set.
2. Find the parent:
   - The user named an item (e.g. "SBX-142", or an Orbit link): read it with `orbit_get_work_item`
     and use it. If it already has subtasks or child items, reuse the ones that match your plan and
     create only the missing steps. If the work on it is a single step, create no steps: track it on
     the item itself.
   - Otherwise create one task with `orbit_create_work_item`: a title that states the outcome in
     plain words, and a short description of the request.
3. Plan your steps, then create the missing ones in one `orbit_create_work_items` call naming the
   parent.
   - Aim for 15 steps or fewer (the tool takes up to 25); merge small ones. Use the same steps as
     your own plan.
   - The server decides how they attach. If it says the parent is a subtask and created nothing,
     track the job on that item with comments instead.
4. Before you start a step, set it to `started`. With the first step, include the parent in the same
   `orbit_set_status` call.
5. When a step is done, comment on it with `orbit_add_comment` (2–4 lines: what changed, the key
   files, the commit hash or PR link if there is one), then set it to `completed`.
6. When the whole job is done, comment a short summary on the parent and set it to `completed`.
7. The server decides whether Claude may close an item. "Handed to a person" is expected, not an
   error: tell the user in one line which items wait for them, and why.
8. If your plan changes, add the new steps with `orbit_create_work_items` under the same parent, and
   set dropped steps to `cancelled`.

## Rules

- Assign only the user who asked (the default). Name someone else only when the user asks for it.
- Never try to get around "handed to a person": no other state, no repeated attempts.
- Read every per-item result. Retry only the items marked ✗, and only when the error is about
  something you sent and can fix.
- If a create or comment is reported as unknown or not confirmed, don't send it again. Tell the
  user, with the link the result gives.
- You can't delete Orbit items. For a duplicate, offer to cancel it and comment which item it
  duplicates. Never blank or rename an item instead.
- If Orbit says it isn't connected, ask the user to click Allow on the page that opened (or give
  them the link). Carry on with the coding work, and rerun the Orbit call once they say so.
- If an Orbit call fails, tell the user in one line and keep doing the coding work. After two
  failures in a row, stop tracking this job and say so once. Orbit never blocks the actual job.
- Keep Orbit text plain and short. Never paste secrets, tokens or credentials into Orbit.
