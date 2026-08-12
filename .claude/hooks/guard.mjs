#!/usr/bin/env node
// PreToolUse guard for Bash commands.
//
// This session runs in bypassPermissions mode, which means the permissions
// `deny` list no longer applies. Hooks still run, so this is the only remaining
// backstop against the handful of commands that git cannot undo:
//
//   - force-push          rewrites remote history; the backup stops being a backup
//   - rm -rf              takes untracked/ignored files with it
//   - git clean -f        deletes untracked files (new scripts, new src modules)
//   - git reset --hard    discards uncommitted work, possibly another session's
//   - git checkout/restore over a whole path — same, quieter
//
// Everything else runs unprompted. Add patterns here rather than reaching for
// the permission prompt.

const RULES = [
  {
    re: /\bgit\s+push\b[^\n]*(--force(?!-with-lease)|(?<![\w-])-[a-zA-Z]*f(?![\w-])|\s\+[\w./-]*:)/,
    why: 'force-push rewrites remote history — the one thing the remote backup cannot protect you from. Use --force-with-lease, or push a new branch.',
  },
  {
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)(?![\w-])/,
    why: 'recursive force-delete also removes untracked and gitignored files. Delete exact paths, or use fs.unlinkSync() in a Node script.',
  },
  {
    re: /\bgit\s+clean\b[^\n]*(?<![\w-])-[a-zA-Z]*[fdx]/,
    why: 'git clean deletes untracked files — the ones that have never been committed and exist nowhere else.',
  },
  {
    re: /\bgit\s+reset\s+[^\n]*--hard/,
    why: 'git reset --hard discards uncommitted work, including whatever another session has open right now.',
  },
  {
    re: /\bgit\s+(checkout|restore)\s+[^\n]*(--\s+\.(\s|$)|(?<![\w-])-[a-zA-Z]*f(?![\w-]))/,
    why: 'this discards uncommitted changes across the whole tree, including another session\'s work.',
  },
];

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let cmd = '';
  try {
    cmd = JSON.parse(raw)?.tool_input?.command ?? '';
  } catch {
    process.exit(0); // unparseable payload: never block on a guard bug
  }

  const hit = RULES.find((r) => r.re.test(cmd));
  if (!hit) process.exit(0);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Blocked by .claude/hooks/guard.mjs: ${hit.why}`,
      },
    }),
  );
  process.exit(0);
});
