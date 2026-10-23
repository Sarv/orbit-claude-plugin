---
name: undo
description: Cancel Claude's most recent Orbit job in this repo's project (its parent and steps), after you confirm. Give an item key to cancel that job instead.
argument-hint: "[item key]"
disable-model-invocation: true
allowed-tools: mcp__plugin_orbit_orbit__orbit_list_jobs mcp__plugin_orbit_orbit__orbit_get_work_item mcp__plugin_orbit_orbit__orbit_set_status mcp__plugin_orbit_orbit__orbit_add_comment
---

# Undo Claude's last Orbit job

Item: $ARGUMENTS

1. Read `.orbit.json` at the repo root. If there isn't one, say the repo isn't linked to Orbit and
   that `/orbit:link <project URL>` links it, then stop. Use its `project` value in every Orbit call.
2. Find the job:
   - No item above: call `orbit_list_jobs` with `state: "all"` and `limit: 1`. That's the most
     recent job. Its steps are Claude's; its parent is too, unless the line says "an item the user
     named".
   - An item key above: read it with `orbit_get_work_item`. The job is that item, if it says
     "via Claude", and those of its subtasks or child items marked "via Claude".
   - No job found: say so in one line and stop.
3. Only items created via Claude are cancelled. A parent the user named, and anyone's own items,
   stay as they are. If every item to cancel is already cancelled, say so and stop.
4. Show the user the job in a few lines: the parent (key and title) and each item that would be
   cancelled, with its current state. Ask: "Cancel these N items in Orbit?" Then end your turn.
   Don't call `orbit_set_status` or `orbit_add_comment` before the user answers.
5. Only if the user clearly says yes: call `orbit_set_status` once with all those items and
   `status: "cancelled"` (pass `.orbit.json`'s `review_state` when it is set). Then comment once on
   the job's parent with `orbit_add_comment`: "Cancelled with /orbit:undo: <the keys that moved>".
   Skip the comment when nothing moved. Any other answer: change nothing, and say so.
6. Tell the user the result in a few lines. Items "handed to a person" stay as they are (for example,
   a finished item that carries points): say which and why, and never try another status or a
   repeat. Cancelled items stay in Orbit, marked cancelled: Claude can't delete them.
