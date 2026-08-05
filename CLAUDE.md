# Boxing Game — Project Rules

## What this is
A physics-driven 2D boxing game, browser-based, mobile-first eventually. Retro-styled but built with procedurally rigged fighters (simple jointed shapes/limbs animated in code) — NOT hand-drawn pixel art sprites. No external art/asset files.

## Locked mechanics (do not redesign these — ask before changing)
- **Movement**: virtual joystick, free 2D movement inside the ring bounds (forward/back/side-to-side). Not a fixed-distance system.
- **Punch diamond**: 4 buttons — jab, cross, hook, uppercut — arranged in a diamond.
- **Hand selection**: jab and cross are joystick-direction-agnostic. Hook and uppercut use the joystick's current left/right hold to pick which hand throws (holding left = left hand, holding right = right hand).
- **Range gating**: punches only land within a defined distance band.
  - Too far = whiff, no contact.
  - Too close = smothered/blocked UNLESS it's a hook or uppercut (those work at close range).
- **Block**: single button, fully blocks while held. Blocking and punching are mutually exclusive — you cannot do both in the same instant, but switching between them should feel instant/responsive, not sluggish.
- **Head movement (later stage, not yet built)**: a quick FLICK of the movement joystick = a slip/duck (brief invincibility + repositions the head hitbox). A sustained HOLD in the same direction = normal footwork. Flick vs. hold is distinguished by input speed/duration, not a separate button.
- **Physics philosophy**: punch power/effect comes from the fighter's current momentum/weight-transfer state (are they advancing, retreating, planted), NOT from a per-punch precision meter or drag gesture. Damage/stagger = impulse (mass × velocity) applied to a spring-damped opponent rig, not a scripted animation lookup.

## Architecture rules
- **All tunable numbers live in one config file** (e.g. `config.js`). Never hardcode a gameplay constant (ranges, speeds, forces, timings) directly inside game logic — always reference the config.
- **Tuning panel**: a dev-only on-screen panel with sliders/number inputs bound LIVE to the config values. Dragging a slider changes the running game instantly, no reload, no file editing. This panel must exist before we build most gameplay systems — it's the primary tool for iterating on feel.
- **Tech stack**: Phaser.js (or plain HTML5 Canvas — pick whichever is simpler to set up) + vanilla JS. No 3D engine (this is 2D). Keep the build/tooling as minimal as possible — a single `npm run dev` should start a local server with live reload.
- **No external art assets.** Fighters are procedurally drawn/rigged (circles, rectangles, jointed limb segments), not sprite sheets.

## Workflow rules
- Build **one system at a time**. Stop after each stage and wait for playtesting feedback before moving to the next.
- **Commit to git after each stage is confirmed working.** Never leave multiple unrelated changes uncommitted.
- **Don't add features that weren't explicitly requested for the current stage**, even if they seem like natural next steps. Flag ideas instead of building them unprompted.
- If a design decision is ambiguous, ask rather than assuming — this project has a precise spec, don't improvise around gaps.

## Self-verification workflow (mandatory, every change)
Before reporting any task as done, you must self-check it — do not rely on me to catch basic breakage.

1. **After writing or editing code, verify it — but match the check to the change.** If the change can alter what's drawn on screen, run `scripts/verify.js` and look at the screenshot. "Can alter what's drawn" is broad: any edit to `rig.js`, `arena.js`, `camera.js`, `hud.js`, or any config value feeding a draw call — when in doubt, screenshot. If the change provably cannot (test scripts, tuning-panel wiring, config values that only feed logic, comments), skip the screenshot and verify via console output plus targeted tests. Capture **one screenshot per verified state, not per iteration** — never re-capture a state you have already confirmed.
2. Look at the resulting screenshot yourself. Confirm it matches what was asked for — no blank canvas, no obviously broken layout, no missing elements.
3. Check the captured browser console output for errors or warnings. If there are any, fix them before reporting back — do not report "done" with unresolved console errors.
4. Only after both checks pass, tell me what you built and what to test. If either check fails, keep iterating on your own until it passes, then tell me — within the debugging budget in rule 9.
5. This does NOT replace me playtesting for feel — it only covers "does this render and run without errors." Always be clear about which of the two you're reporting: "verified rendering/no errors" vs. "ready for you to feel-test."
6. **Ad-hoc debug/verification scripts** (one-off Playwright checks mid-session, not permanent test scripts like `verify.js`/`punch_test.mjs`) go in a single reused file, `scripts/_debug.mjs` — overwrite it in place each time rather than creating a new uniquely-named file. This keeps the permission allowlist in `.claude/settings.json` (which grants `Write(scripts/**)`) effective without needing approval for each new filename. It's gitignored, so its contents don't need to be meaningful between sessions.
7. **Parameter sweeps and repeated test cases go inside the debug script as a loop, not as a bash loop wrapping script regeneration.** A bash `for` loop that rewrites `scripts/_debug.mjs` via heredoc each iteration trips the shell's expansion-obfuscation guard. If you need to test multiple values (a duration sweep, a range of config overrides, repeated trials), write one `scripts/_debug.mjs` with the loop in plain JS (a `for` loop or `.forEach` over the values, one browser launch, reused or reloaded pages as needed) and run it once with `node scripts/_debug.mjs`.
8. **Never use glob patterns in bash `rm`/delete commands** — this trips a separate built-in guard against glob-pattern deletes. Either enumerate exact filenames (`rm -f scripts/output/a.png scripts/output/b.png`), or if genuinely pattern-based, do it inside a Node script (`fs.readdirSync()` + `.filter()` + `fs.unlinkSync()`) instead of a shell glob passed to `rm`.
9. **Debugging budget when verification fails.** Spend at most 2 diagnostic steps before reporting back with what you found and what you'd try next. Never run the same test more than twice in a row. Ask before starting any investigation that needs more than 3 shell commands.
11. **Confirmation runs are budgeted like diagnostics.** Rule 9 bounds work when verification fails; this bounds work confirming it succeeded. Derive trial counts from the observed failure rate, don't pick a round number: ~95% confidence that a 1-in-N intermittent failure is fixed needs roughly 3N consecutive passes, so a 1-in-4 flake needs ~10 and a 1-in-7 flake needs ~20. Because that many full-suite runs is unaffordable, isolate the single assertion into `scripts/_debug.mjs` as a loop in ONE browser session (rule 7) and run the trials there. **Hard cap: if confirmation will exceed 5 minutes of wall clock, stop, report the trial count you achieved and the confidence it implies, and let me decide whether to spend more.**
12. **Never block a shell on a sleep-poll.** Constructs like `until [ ... ]; do sleep 30; done` burn wall clock in 30-second quanta and occupy a shell doing nothing. Run background work in the background, then check its status once. If it isn't finished, say so and report what you have — do not wait for it.
13. **Read narrowly.** `src/` is ~6,000 lines (`main.js` 1,195, `rig.js` 832, `config.js` 831). Reading those three whole costs ~35k tokens and is almost never necessary. Grep for the symbol or config key first, then read only the surrounding range. Never re-read a file you just edited.
14. **Never restate code in chat.** Do not paste back code you wrote or edited — I can read the diff. No code blocks in summaries unless I ask, or it's five lines or fewer illustrating one decision. Summaries are prose: what changed, which file, what to test. Restating large blocks is what makes runs hit the output token cap and loop.
15. **Report at every sub-part boundary, not just at the end.** When a stage has numbered parts, post one or two lines when each part completes — what landed, what's next. If any single part exceeds 15 minutes, post a line saying what it's doing and why it's taking that long. I would rather have a heartbeat than a silent hour, and I should never have to ask whether you're stuck.

## Current stage
See the most recent prompt in the conversation for what's being built right now. This file holds the permanent rules; it does not track stage-by-stage progress.
