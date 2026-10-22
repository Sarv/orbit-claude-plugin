# Orbit MCP server

Runs on the developer's laptop, started by Claude Code over stdio. It turns Claude's tool calls
into Orbit API calls as the signed-in user.

Needs Node.js 22+.

## Run it against dev

Put your dev Orbit's addresses in place of `<dev API host>` and `<dev app host>`:

```bash
npm install
ORBIT_API_URL=https://<dev API host>/v2 ORBIT_APP_URL=https://<dev app host> npm run inspect
```

`npm run inspect` opens the MCP Inspector. The first tool call opens the browser at Orbit's
consent page; click Allow, then call the tool again.

Non-interactive:

```bash
npx @modelcontextprotocol/inspector@2.11.0 --cli -e ORBIT_API_URL=https://<dev API host>/v2 -e ORBIT_APP_URL=https://<dev app host> node src/index.js --method tools/call --tool-name orbit_whoami
```

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `ORBIT_API_URL` | `https://api.orbitorg.com/v2` | Orbit API |
| `ORBIT_APP_URL` | `https://app.orbitorg.com` | Orbit web app (consent page, links) |
| `ORBIT_TOKEN_STORE` | `auto` | `keychain` (macOS), `secret-tool` (Linux), or `file` |
| `ORBIT_OPEN_BROWSER` | on | `0` = never open a browser; the sign-in link is still in the tool result |
| `CLAUDE_PLUGIN_DATA` | `~/.orbit-claude` | Lock files, and the token file when no keychain is available |

The refresh token is the only secret kept between sessions: in the Keychain on macOS (service
`orbit-claude-code`, account = the API host), else `secret-tool`, else an owner-only file. Dev
and prod connections are stored separately.

## Tests

```bash
npm test
```

`node:test`, no network: unit tests with a mocked `fetch`, plus an end-to-end test that runs the
real server over stdio against a fake Orbit API (`test/fakeOrbitServer.js`). The tool tests
(`test/writeTools.test.js`, `test/setStatus.test.js`) drive the same fake through `toolHarness()`
in `test/helpers.js`, which can lose a request before it reaches Orbit (`timeout`) or after Orbit
did the work (`drop`).

## Tools

Read: `orbit_whoami`, `orbit_list_projects`, `orbit_resolve_url`, `orbit_get_project_config`,
`orbit_search_work_items`, `orbit_get_work_item`, `orbit_list_comments`.

Write: `orbit_create_work_item`, `orbit_create_work_items` (the steps of a job, max 25),
`orbit_update_work_item` (no status field), `orbit_set_status`, `orbit_add_comment`. No tool
deletes anything.

`orbit_logout` is only for `/orbit:logout`: it revokes this computer's connection in Orbit and
forgets the stored sign-in.

`npm run build` writes the single-file bundle `dist/index.js` (committed; the plugin runs it), and
`npm run test:dist` runs the stdio end-to-end test against it.

The rules the server enforces itself, so they don't depend on Claude following the skill:

- **Completion policy** (`src/policy.js`): Claude may close, reopen or cancel only items it created
  (Orbit's own `created_via: "claude"`) for this user, and close or reopen them only while they carry
  no points, checked on a fresh read before every move. Anything else is handed to a person with a
  comment; an item is never moved into or out of `completed` as a fallback.
- **Hierarchy**: steps become tasks under a story, feature or epic, and subtasks under a top-level
  task. A subtask gets no new items; a milestone is refused.
- **Write contract** (`src/writes.js`): assignees are checked against the project's members before
  anything is sent. After a lost answer, creates and comments are **never resent**; a read-only
  check reports what landed, by the request id stamped in each item's `metadata`. Status and field
  updates are retried once.
- **Markdown in, HTML out** (`src/markdown.js`), kept inside Orbit's sanitizer allowlist: raw HTML
  is shown as text, h4–h6 become h3, and images become links.
