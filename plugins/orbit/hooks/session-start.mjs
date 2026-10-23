// SessionStart hook: when the session's repo is linked to Orbit (an .orbit.json at its root, written
// by /orbit:link), tell Claude, so it tracks multi-step work without the developer asking. Claude
// Code doesn't list a repo's files at session start, so without this Claude wouldn't know the repo
// is linked. Prints nothing in any other repo, and never fails the session.
//
// .orbit.json comes from the repo, so the only value passed on is the project, and only when it
// looks like what /orbit:link writes (an Orbit project URL or org/workspace/project). The skill
// reads the rest of the file itself; `"confirm_plan": true` (exactly true) only adds a fixed
// sentence. From the branch name, only an item key of the linked project's own prefix is passed on
// (jatin-142-csv-export → JATIN-142), never the name itself.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_URL = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/u\/\d+\/org\/[\w-]+\/ws\/[\w-]+\/prj\/[\w-]+\/?$/;
const PROJECT_SLUGS = /^[\w-]+\/[\w-]+\/[\w-]+$/;
// Same minimum as the server (server/src/index.js). The hook runs on the same `node`, and a server
// that exits at startup only shows as "failed" under /mcp, so this is where Claude learns why.
const MIN_NODE_MAJOR = 22;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

// Walk up from the session's folder to the repo root (the folder holding .git).
function findLinkFile(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const file = path.join(dir, '.orbit.json');
    if (fs.existsSync(file)) return file;
    if (fs.existsSync(path.join(dir, '.git')) || path.dirname(dir) === dir) return null;
  }
}

// The linked project's key prefix is its slug (the last part of the URL or of org/ws/project), so
// "release-2026" or "fix-12" never pass for a project called "web".
function branchItemKey(dir, project) {
  const slug = project.replace(/\/+$/, '').split('/').pop();
  let branch;
  try {
    branch = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null; // no git, not a repository, or a detached HEAD
  }
  const m = branch.match(new RegExp(`(?:^|[^A-Za-z0-9])${slug.replace(/[-_]/g, '[-_]')}-(\\d{1,9})(?![0-9])`, 'i'));
  return m ? `${slug.toUpperCase()}-${m[1]}` : null;
}

function contextFor(file) {
  let link;
  try {
    link = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    link = null;
  }
  const project = typeof link?.project === 'string' ? link.project.trim() : '';
  if (!PROJECT_URL.test(project) && !PROJECT_SLUGS.test(project)) {
    return `${file} doesn't hold a valid Orbit link, so Orbit tracking is off. /orbit:link <project URL> fixes it.`;
  }
  const linked = `This repo is linked to the Orbit project ${project} (${file}).`;
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    return `${linked} But Orbit's tools can't start: this computer has Node.js ${process.versions.node}, and Orbit for `
      + `Claude Code needs Node.js ${MIN_NODE_MAJOR} or newer. Don't track work in Orbit; if the user asks for Orbit, `
      + 'tell them to install a current Node.js LTS and restart Claude Code.';
  }
  const key = branchItemKey(path.dirname(file), project);
  return `${linked} For a task with two or more separate pieces of work, track it in Orbit with the orbit-tracking `
    + 'skill. Skip it for questions and quick edits.'
    + (link.confirm_plan === true ? ' This repo asks for a plan preview: before creating any Orbit item, show the user '
      + 'the parent and the steps, and wait for their OK.' : '')
    + (key ? ` The current branch is named after ${key}: unless the user names another item, track the work under ${key} (read it first).` : '');
}

try {
  const file = findLinkFile(readInput().cwd || process.cwd());
  if (file) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: contextFor(file) } }));
  }
} catch {
  // Tracking is optional; a broken hook must never get in the way of the session.
}
