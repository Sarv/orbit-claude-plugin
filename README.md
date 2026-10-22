# Orbit for Claude Code

A Claude Code plugin. When you ask Claude Code for multi-step work in a repo linked to an Orbit
project, Claude tracks that work in Orbit: it creates a parent item, adds one subtask per step,
moves them through their states and comments on what changed. You don't have to ask each time.

Everything goes through Orbit's normal API **as you**, with your permissions. Orbit marks it
"via Claude". Claude only closes items it created that carry no points; anything else it hands to
a person with a comment.

This repo is the plugin's source, and also the Claude Code "marketplace" you install it from.

## Get it (once per developer)

1. **Node.js 22 or newer** (`node --version`). Claude Code starts the Orbit server and a small
   session-start hook with the `node` on its own PATH. If you installed Node with nvm and start
   Claude Code from a desktop app, check that this PATH includes nvm's Node.
2. **Add this repo and install the plugin**, in a terminal:

   ```bash
   claude plugin marketplace add Sarv/orbit-claude-plugin
   ```

   ```bash
   claude plugin install orbit@sarv
   ```

3. **Turn on auto-update**, so new versions reach you by themselves: in Claude Code, open `/plugin`
   → **Marketplaces** → `sarv` → **Enable auto-update**. It's off by default for marketplaces that
   aren't Anthropic's. Without it, run `/plugin marketplace update sarv` to get a new version.

That's all. New versions arrive the next time Claude Code starts (or after `/reload-plugins`).

It works in Claude Code (terminal, IDE extensions, the desktop app's Code tab). It doesn't work in
claude.ai chat.

### For a whole team repo (optional)

Commit this to a repo's `.claude/settings.json`, and everyone who opens that repo in Claude Code (and
trusts the folder) gets the plugin without typing the commands above:

```json
{
  "extraKnownMarketplaces": {
    "sarv": { "source": { "source": "github", "repo": "Sarv/orbit-claude-plugin" } }
  },
  "enabledPlugins": { "orbit@sarv": true }
}
```

## Use it

1. **Link the repo** (once per repo, by anyone on the team):

   ```
   /orbit:link https://app.orbitorg.com/u/0/org/<org>/ws/<workspace>/prj/<project>
   ```

   It asks which state is the "review state": where Claude puts finished work it isn't allowed to
   close. Then it writes `.orbit.json` at the repo root. **Commit it**, so the whole team shares the
   link. It holds no secrets.

2. **Work as usual.** The first time Claude needs Orbit, your browser opens an Orbit page asking to
   allow Claude Code. You're already signed in, so you click **Allow** once. That's all. The sign-in
   is kept in your Keychain (macOS), your keyring (Linux), or a private file.

| Command | What it does |
|---|---|
| `/orbit:link <project URL>` | Link this repo to an Orbit project (writes `.orbit.json`) |
| `/orbit:status` | Your open items in the linked project |
| `/orbit:login` | Connect now, or check which Orbit account Claude Code uses |
| `/orbit:logout` | Disconnect this computer from Orbit and forget the sign-in |

You can also see and disconnect every place Claude Code is connected on Orbit's **Connected apps**
page (avatar menu). Changing your Orbit password disconnects all of them.

## If something doesn't work

| What you see | What to do |
|---|---|
| Claude doesn't track anything | Check the repo has `.orbit.json` at its root (`/orbit:link`), and start a **new** session: the link is read when a session starts. Quick questions and one-line edits are skipped on purpose |
| `/mcp` shows `plugin:orbit:orbit` as failed, or the Orbit tools are missing | Run `node --version`: it must be 22 or newer, on the PATH Claude Code uses (see "Get it"). Then restart Claude Code |
| "Orbit isn't connected" | Your browser opened Orbit's Allow page (or Claude showed the link): click Allow, then ask again |
| Signing in over SSH | The Allow page sends you back to `127.0.0.1:<port>` on the computer where Claude Code runs. Forward that port (it's in the link's `redirect_uri`) with `ssh -L <port>:127.0.0.1:<port> …`, or sign in on that computer once |
| The plugin isn't under `/plugin` | Run the two commands under "Get it" again, then restart Claude Code. `orbit` from the `sarv` marketplace should be installed and enabled |
| A new version doesn't arrive | Turn on auto-update ("Get it", step 3), or run `/plugin marketplace update sarv`, then restart Claude Code |
| "You don't have permission to do that in this project" | Claude acts with your own Orbit permissions. Check you're a member of the project and your role can create and edit work items |
| Items wait in the review state with a "handed to a person" comment | Expected: Claude doesn't close items it didn't create, or items that carry points. Close them yourself in Orbit |
| Items land in the wrong Orbit (dev vs production) | `ORBIT_API_URL` / `ORBIT_APP_URL` in the shell where Claude Code started decide which one. Unset, it's production |
| You need a different Orbit account | `/orbit:logout`, then `/orbit:login`: the Allow page lets you switch account |

## Against dev

The plugin talks to production by default. To use a dev Orbit, set its addresses in your shell
**before** starting Claude Code, in place of `<dev API host>` and `<dev app host>`:

```bash
export ORBIT_API_URL=https://<dev API host>/v2 ORBIT_APP_URL=https://<dev app host>
```

Dev and production sign-ins are stored separately.

## For maintainers

```
.claude-plugin/marketplace.json   the "sarv" marketplace → ./plugins/orbit
plugins/orbit/
  .claude-plugin/plugin.json      name, version, description
  .mcp.json                       starts the server: node ${CLAUDE_PLUGIN_ROOT}/server/dist/index.js
  hooks/                          SessionStart: tells Claude when the repo is linked
  skills/orbit-tracking/          the behaviour (model-invoked)
  skills/{link,status,login,logout}/   the /orbit:* commands (user-invoked only)
  server/                         the MCP server: src/, test/, and the committed bundle dist/index.js
dev/try-skill.mjs                 a real Claude Code session against a fake Orbit
dev/qa-dev.mjs                    the plan's QA checklist (Appendix C, parts 2–3) against dev
```

**QA on dev:** with dev's URLs in your shell,
`node dev/qa-dev.mjs --project <org>/<workspace>/<project> --human-task <KEY> --human-done <KEY>`
runs every checklist case a script can drive and prints PASS / FAIL / SKIP per line. The keys are
a task and a done task made in the web app, not by Claude. It uses your Orbit connection (the
browser opens once if needed), titles everything "[QA <time>] …", refuses production, and awards
2 points once: one case closes a task that carries points, as a person would.
`node dev/qa-dev.mjs --fake` runs it against the local fake Orbit, which checks the script itself.

The server is described in `plugins/orbit/server/README.md`.

**Try the skill without a backend:** `node dev/try-skill.mjs "<a multi-step request>"` runs
`claude -p` with this plugin in a throwaway repo linked to a fake Orbit, then prints what Claude
created, moved and commented. It needs a logged-in `claude` CLI, and runs that one session with
permission prompts off, inside the throwaway repo.

**Try your local copy** (testing changes before a release): start Claude Code with the plugin folder
for one session. Nothing is installed:

```bash
claude --plugin-dir plugins/orbit
```

Use one route at a time: if you also installed the plugin from the marketplace, disable that copy
under `/plugin` while you test, or the plugin loads twice.

**Release:**

1. In `plugins/orbit/server`: `npm ci`, `npm test`, `npm run build`, `npm run test:dist` (the bundle,
   over stdio). Smoke-test the bundle under Node 22 and Node 24.
2. Bump `version` in `plugins/orbit/.claude-plugin/plugin.json`. Claude Code only offers an update
   when this number changes; a push without it reaches nobody.
3. `claude plugin validate --strict .` and `claude plugin validate --strict plugins/orbit`.
4. Commit, including `server/dist/index.js`, and push to `main`. Developers with auto-update get it
   the next time Claude Code starts; the rest when they run `/plugin marketplace update sarv`.

**This repo is public.** Everything you push, tests and commit messages included, is visible to
anyone: no tokens, no real people or data from Orbit, no internal addresses or project paths.
