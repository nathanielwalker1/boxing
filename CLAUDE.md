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

1. After writing or editing code, run the project's screenshot script (see `/scripts/verify.js` — set this up in Stage 0 if it doesn't exist yet, using Playwright) to capture the current state of the running page.
2. Look at the resulting screenshot yourself. Confirm it matches what was asked for — no blank canvas, no obviously broken layout, no missing elements.
3. Check the captured browser console output for errors or warnings. If there are any, fix them before reporting back — do not report "done" with unresolved console errors.
4. Only after both checks pass, tell me what you built and what to test. If either check fails, keep iterating on your own until it passes, then tell me.
5. This does NOT replace me playtesting for feel — it only covers "does this render and run without errors." Always be clear about which of the two you're reporting: "verified rendering/no errors" vs. "ready for you to feel-test."
6. **Ad-hoc debug/verification scripts** (one-off Playwright checks mid-session, not permanent test scripts like `verify.js`/`punch_test.mjs`) go in a single reused file, `scripts/_debug.mjs` — overwrite it in place each time rather than creating a new uniquely-named file. This keeps the permission allowlist in `.claude/settings.json` (which grants `Write(scripts/**)`) effective without needing approval for each new filename. It's gitignored, so its contents don't need to be meaningful between sessions.
7. **Parameter sweeps and repeated test cases go inside the debug script as a loop, not as a bash loop wrapping script regeneration.** A bash `for` loop that rewrites `scripts/_debug.mjs` via heredoc each iteration trips the shell's expansion-obfuscation guard. If you need to test multiple values (a duration sweep, a range of config overrides, repeated trials), write one `scripts/_debug.mjs` with the loop in plain JS (a `for` loop or `.forEach` over the values, one browser launch, reused or reloaded pages as needed) and run it once with `node scripts/_debug.mjs`.
8. **Never use glob patterns in bash `rm`/delete commands** — this trips a separate built-in guard against glob-pattern deletes. Either enumerate exact filenames (`rm -f scripts/output/a.png scripts/output/b.png`), or if genuinely pattern-based, do it inside a Node script (`fs.readdirSync()` + `.filter()` + `fs.unlinkSync()`) instead of a shell glob passed to `rm`.

## Current stage
See the most recent prompt in the conversation for what's being built right now. This file holds the permanent rules; it does not track stage-by-stage progress.
