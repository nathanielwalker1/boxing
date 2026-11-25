# Boxing v2 — Project Rules

`CONTRACT.md` is the spec (what gets built, where it lives, interfaces, stage plan).
This file is how you work. Read both at the start of every session. `legacy/` is v1
(Phaser, 2D) — the read-only source of truth for mechanics and test assertions. Never
edit it, never import it at runtime. It is self-contained (`legacy/index.html`,
`legacy/src`, `legacy/scripts`, `legacy/VISUALS.md`); `npm run legacy` serves it on
port 5175 for side-by-side feel comparison. `spike/gym` is a throwaway three.js rig
experiment (port 5174) — reference only, not a code base to extend.

## Who you're working with
Nate. Uses Claude Code daily. Plain language over jargon; concrete next steps over
theory. He is the judge of *feel* and *look* — you are the judge of *does it run*.

## Locked mechanics (ask before changing any of these)
- **Movement:** joystick, free 2D movement on the ring floor inside the bounds.
- **Punch diamond:** jab, cross, hook, uppercut.
- **Hand selection:** jab/cross ignore joystick direction; hook/uppercut use the sign of
  the joystick's x at press to pick the hand.
- **Range gating:** too far = whiff; too close = a straight punch still lands but loses
  power (ramping down to a floor at body contact); hooks and uppercuts keep full power.
  (Changed 2026-09-03 from v1's no-contact smother, Nate's call.)
- **Block:** held button, full block while held, mutually exclusive with punching,
  instant to switch.
- **Head movement:** joystick FLICK = slip (brief head-hitbox offset + invincibility);
  HOLD = footwork. Distinguished by duration, detected in the sim.
- **Physics:** punch force from momentum / weight transfer, not a precision meter.
  Damage/stagger = impulse into a spring-damped rig.
- **Determinism:** the sim is pure, fixed-step, seeded. No `Math.random`, no clocks, no
  three.js inside `src/sim` or `src/ai`. See CONTRACT §3.

## Architecture rules
- **One config.** Every tunable lives in `src/core/config.ts` with a comment saying what
  it does and, where ported, which `legacy/src/config.js` key it came from. Never a
  magic number in sim/rig/render.
- **Tuning panel** (lil-gui, `?tune=1`) binds every config key live. It exists before
  systems are built, not after.
- **Ownership.** You only write inside the folders your workstream owns (CONTRACT §2).
  If you need something from another folder, it goes through `src/core` or a contract
  addition. Sub-agents never edit each other's files.
- **Hit geometry = drawn geometry.** Radii come from `src/core/body.ts`, used by both
  sim and rig. One source.
- **No external assets, except the fighters.** Meshes, textures, sounds, fonts — all generated
  in code. Lifted for the fighters only (Nate, 2026-11-15): body mesh, skin textures and
  motion-capture pose data, listed with licences in `docs/ASSETS.md`. Raw Mixamo FBX files
  never go in git; only baked pose data does.
- **Stack:** three.js + TypeScript (strict) + Vite + lil-gui + Playwright. Nothing else
  without asking.

## Workflow rules
- **One stage at a time** (CONTRACT §12). Stop at each gate and wait for Nate's feel-test.
- **Within a stage, report at every sub-part boundary** — one or two lines: what landed,
  what's next. If a part runs past 15 minutes, say what it's doing and why. A heartbeat,
  never a silent hour.
- **Commit after each confirmed sub-part.** Small commits, one concern each. Nate pushes.
- **Don't add unrequested features.** Flag ideas in one line; don't build them.
- **Ambiguity → ask.** The spec is precise; gaps are questions, not license.
- **Porting rule:** a v1 system is ported when its `legacy/scripts/*_test.mjs` assertion
  has a passing v2 equivalent in `scripts/`. Behaviour first, then make it look good.
- **Visual work is one layer at a time** (see `legacy/VISUALS.md` L1–L7). Never fix
  silhouette and re-author motion in the same task; Nate can't feel-test which half worked.

## Self-verification (mandatory, every change)
1. **Match the check to the change.** If it can alter what's on screen (`src/rig`,
   `src/render`, `src/ui`, any config feeding a draw), run `scripts/verify_check.mjs` and look
   at the screenshot and its `_grey` sibling. If it provably cannot (sim logic, tests,
   comments), verify via console output plus the relevant behavioural test. One capture
   per verified state, never per iteration.
2. **For anything touching the rig or animation, run `scripts/pose_grid.mjs`** and read
   the contact sheet: each punch × both facings × 7 progress values. Say what you see —
   "the glove passes through the torso at p=0.6 facing left" — not "rendered OK."
3. **Console must be clean.** Zero errors, zero warnings, or you're not done.
4. **Report which kind of done:** "verified renders / no errors / tests green" vs. "ready
   for you to feel-test." Never blur the two.
5. **Debug budget.** When verification fails: at most 2 diagnostic steps, then report
   what you found and what you'd try. Never run the same test more than twice in a row.
   Ask before any investigation needing more than 3 shell commands.
6. **Confirmation runs are budgeted too.** For a 1-in-N flake, ~3N consecutive passes ≈
   95% confidence. Isolate the assertion into `scripts/_debug.mjs` as a JS loop in ONE
   browser session. Hard cap 5 minutes wall clock; then report the count and confidence.
7. **Ad-hoc scripts** go in `scripts/_debug.mjs`, overwritten in place (gitignored).
   Never a new uniquely-named file per experiment.
8. **Use the runner.** `npm run test:quick <names>` while iterating, `npm test` once at
   the end. The runner discovers tests by name: `scripts/*_test.mjs` run in Node against
   the sim (`load.mjs` + `check.js`, no browser — this is where ported assertions go);
   `scripts/*_check.mjs` run in Playwright against the dev server (render only).
   Waits go through `scripts/waits.js` (`gameTime`/`until`/`settled`/`frames`),
   never fixed sleeps — fixed sleeps are the #1 source of flakes and parallel runs turn
   flakes into failures.
9. **Frame-time is a test.** Any render/rig change reports fps from the overlay on the
   reference scene before and after. A regression below 60 on desktop is a failure.
10. **Read narrowly.** Grep for the symbol or config key, read the surrounding range.
    Never read a whole large file; never re-read a file you just edited.
11. **Never restate code in chat.** No code blocks in summaries unless asked, or ≤ 5 lines
    illustrating one decision. Summaries are prose: what changed, which file, what to
    test. Restating code is what hits the output cap and loops.

12. **Session start and slow checks (added 2026-11-24 after a session lost its first hour).**
    When the prompt names memory files, open and read each one in full before the first
    command; the index line is not the memory. Browser scripts draw on the real GPU by
    default (`scripts/devUrl.js` loads `scripts/gpu_preload.mjs`); if any probe or film
    takes over 2 minutes, stop it and find out why before running another. Find a tuning
    value with config overrides in one run, not by editing source and re-booting per value.

## Sub-agents
When a stage's work is split by workstream, the orchestrator: (a) confirms `src/core` is
frozen, (b) writes each sub-agent a brief that names its folders, its deliverable from
CONTRACT, the interfaces it consumes, and the tests it must leave green, (c) forbids
writes outside those folders, (d) integrates and runs `npm test` before reporting.
Sub-agents inherit every rule in this file, especially shell discipline.

## Shell discipline — never trigger a permission prompt (mandatory)

Interrupting Nate to approve a shell command is a planning failure, not a checkpoint.
Some prompts come from content-based safety guards that fire regardless of the allowlist
in `.claude/settings.json` — you can't allowlist your way out, you have to not write the
command. Assume every prompt below is avoidable and that avoiding it is your job.

**Governing rule: the shell runs one whole thing; it is not for assembling a pipeline.**
Iteration, capture, parsing, branching → JavaScript in `scripts/_debug.mjs` (or a real
test script) that prints exactly the answer. One invocation, one clean stdout.

### Banned in bash — no exceptions
1. **Shell variable expansion of any kind.** No `$i`, `$VAR`, `$?`, `$(...)`, backticks,
   `${...}`. Write full literal paths. Read exit status from the tool result.
2. **Shell loops and job control.** No `for`/`while`, no `&` + `wait`, no subshells. Loop
   in JS. Long-running work uses the Bash tool's `run_in_background`, never `&`.
3. **`sed` for reading or extracting.** Use `grep -A/-B/-C`, the Read tool, or Node. To
   edit, use the Edit tool — never `sed -i`.
4. **`awk` programs.** Use `grep`, Read, or Node.
5. **Heredocs and `>`/`>>` redirection to write source.** Use Write/Edit — allowlisted for
   `scripts/**` and `src/**`.
6. **Glob patterns in `rm`.** Enumerate exact filenames, or delete in Node.
7. **Chained `;` commands mixing unrelated work.** One command per call; independent calls
   can go in one message.
8. **`cd` in a compound command.** Absolute paths.

### The positive patterns
- **Reading code:** Read, Grep, Glob. Not `cat`/`head`/`tail`/`sed`/`awk`.
- **Running the suite:** `npm test` / `npm run test:quick <names>`. The runner's output
  *is* the summary; don't tee and grep it back.
- **Repeated trials:** a JS loop in `scripts/_debug.mjs` that prints `12/12 passed`.
- **A number out of long output:** have the script print the number.

### The guard hook is a hard stop
This project runs in bypass-permissions mode. `.claude/hooks/guard.mjs` blocks the five
commands git can't undo: force-push, `rm -rf`, `git clean -f`, `git reset --hard`,
whole-tree `git checkout`/`git restore`. If it blocks you, **stop and ask.** Do not route
the same intent through `fs.rmSync`, a Node script, or a rephrased flag. Untracked files
exist in exactly one place; no commit brings them back.

### When you need a new shell shape
Don't guess-and-prompt. Either restructure it into a Node script under `scripts/`, or tell
Nate in one line what shape you need and why so it goes on the allowlist once. If the same
prompt fires twice in a session, stop and say so.

## Current stage
See the most recent prompt in the conversation. This file holds permanent rules only.
