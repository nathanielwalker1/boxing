# Boxing Game — Visual Rules

Companion to `CLAUDE.md`. That file governs mechanics and workflow. This one governs
how things **look and move**. Read both.

> **State-of-the-code stamp.** Every "current state" block below was re-verified against
> commit `6723bdf` (2026-08-11, clean working tree). The ladder's *rules* are permanent;
> the *current state* notes are a snapshot and go stale every time a visual stage ships.
> Re-check before trusting one, and update it in the same commit that changes it.

## Why this file exists

"Make it look better" is not a usable instruction and will not produce a usable result.
Visual quality is a vocabulary problem, not a prompting problem: the agent needs to be
told *which specific layer* is deficient and *what the fix looks like in this codebase*.

So: **never ask for "better graphics." Name the layer.** The ladder below is the list of
layers, ordered by how thin each currently is in this project — thinnest first. That
order is specific to this repo and should be re-ranked as layers get filled in, not
treated as fixed.

---

## The ladder

### L1 — Silhouette & value contrast
**The rule:** a fighter must read as a distinct shape against the floor when the frame is
desaturated to greyscale. Colour differences do not create readability; *value*
differences do.

**Current state: failing, badly.** `ringFloorColor: '#c8a060'` against
`fighterSkinColor: '#e8a86a'` is a **1.18:1** contrast ratio. That is effectively
invisible in value terms — the fighters are the same brightness as the mat they stand on.
Trunks manage 2.61:1, gloves 1.41:1. The dummy is no better: it shares the player's skin
colour exactly (`dummySkinColor` is deliberately the same value — trunks and gloves carry
the whole identity read), so its skin is 1.18:1 too, its trunks 2.49:1, its glove 1.66:1.

Two things partly offset this and should not be re-invented:
- **The rear-side depth cue already doubles as contrast.** `rearLimbDarken: 0.35` pulls
  the away-side limbs to 1.89:1 (skin) / 2.84:1 (glove) / 4.41:1 (trunks). The rear half
  of the fighter reads; the near half does not.
- **Contact shadows shipped** (`shadowEnabled/shadowAlpha: 0.30/shadowRadiusX/Y`), so the
  figure is at least anchored to the mat rather than floating on it.

There is still **no stroke anywhere in `rig.js`** — no `lineStyle`, no outline, no rim.
Every part is a bare fill.

**How to check:** screenshot, desaturate, squint. If the figure dissolves into the floor,
this layer is still broken and nothing above it matters. Note that no script produces a
desaturated capture today — that step is currently manual.

**Levers:** `ringFloorColor`, `matShadeAlpha`, `matGlowAlpha`, `vignetteStrength`,
`matEmblemAlpha`, plus a dark contact outline or rim on the rig.

---

### L2 — Stance & proportion
**The rule:** the pose must read as *boxing* to someone who watches boxing, before any
rendering detail is added. A bladed stance (lead foot and shoulder forward, hips and
shoulders rotated off-square) is the single strongest signal.

**Current state: square below the neck, asymmetric above it.** Be precise about which
half, because they are not in the same state:

- **Arms: already asymmetric, and deliberately so.** The resting pose is a real guard
  (`LEAD_GUARD`/`REAR_GUARD` in `rig.js`) — lead fist out at `(+46, -38)`, rear fist by
  the chin at `(-17, -41)`. That asymmetry is **load-bearing, not decoration**: facing is
  expressed only by the `scaleX` mirror, so a symmetric rig mirrors into an identical
  silhouette and facing becomes unreadable. Any re-authoring of the guard must preserve a
  lead hand reaching well past the torso against a compact rear column.
- **Legs, hips, shoulders, torso: square-on.** At rest (`turn = 0`) the shoulders sit at
  `±SHOULDER_X` (17), hips and shins at `±HIP_X` (11), and the torso is a symmetric rect.
  Feet are parallel and level — no lead foot forward, no weight split. No boxer stands
  like this.

The rotation machinery exists and works (`REAR_SHOULDER_DRIVE`, `LEAD_SHOULDER_PULL`,
`HIP_DRIVE`/`HIP_PULL`, torso `turn`/`dip`, `TORSO_SHIFT`) — it is all driven by a punch's
`turn` value, which is **zero at rest**. Blading the stance means giving rest a non-zero
baseline, not building new machinery.

**Proportion note:** exaggerated reads better than anatomical at this scale. Wide
shoulders, narrow waist, oversized gloves, slightly small head.

**Debt to fix when touched:** the whole skeleton is hardcoded in `rig.js` —
`SHOULDER_X/Y`, `UPPER_LEN`, `UPPER_W`, `FORE_LEN`, `FORE_W`, `HIP_X`, `TORSO_H/CY`,
`THIGH_W/H/CY`, `SHIN_W/H/CY`, `TRUNK_TORSO_H`, `TRUNK_FLARE`, `WAISTBAND_H`, and the
head radius (a bare `13` at the `fillCircle` call site). The in-code position is that
these are *pose geometry* rather than gameplay tunables and so belong with the skeleton;
that argument does not survive a task whose entire purpose is dragging proportions
around. Any task that touches proportions must migrate the ones it tunes to `config.js`
as sliders — and note that `SHIN_CY` is coupled to `config.shadowOffsetY`, so moving the
legs means retuning the shadow.

---

### L3 — Volume & form
**The rule:** a limb should read as a solid object, not a flat swatch. In 2D that means
each surface of a shape catches light at a different value.

**Current state: flat.** `seg()` and `cr()` are plain `fillRect` — constant width, square
caps, one flat fill per part. `shade()` exists but applies a single uniform darken to the
whole rear side, which is a *depth* cue, not lighting. Head is `fillCircle(13)` plus a
smaller circle for an ear, with no neck.

The only two value breaks anywhere on the body are the trunks split — each thigh owns a
trunks segment above bare skin, and the torso owns the waistband — plus a single white
`0.22` highlight strip along the top of the waistband. Both exist to make hip rotation
readable, not to describe form.

**Two valid approaches — pick one, do not mix:**
- **Faceted (pseudo-3D):** each part draws as multiple quads at different values (front /
  side / top). Gives real volume and lets stance blading turn in space.
- **Flat-with-shading:** tapered shapes, rounded caps, a light-side/dark-side split per
  part. Cheaper, keeps everything 2D.

---

### L4 — Keyframe density & per-punch timing
**The rule:** authored motion needs enough keys and enough per-punch timing variation that
each punch has its own rhythm.

**Current state: three keys, but the timing half is done.** Split the two:

- **Per-punch timing: shipped** (Stage 18b part 2). Every punch authors its own three
  phases in ms — jab `80/45/108`, cross `105/50/104`, hook `160/60/113`, uppercut
  `170/62/118` (cock / extend / recover), under one global `punchTimeScale`. The
  telegraph ordering below is already satisfied: no two punches share a timing profile.
  `rig.js` owns the *shape* of each punch; `config.js` owns the *durations*.
- **Keyframe density: unchanged and thin.** The `PUNCHES` table still runs
  rest → cock → peak → rest, with two easing functions total (`easeOut` into both the
  cock and the strike, `easeIO` on the recovery). Nothing looks good in this few
  interpolated frames.

**Rule of thumb:** wind-up length is a character trait. A jab barely telegraphs; an
uppercut should visibly load. If two punches share a timing profile, one of them is wrong.

---

### L5 — Secondary motion: overlap, lag, follow-through
**This is the single biggest cause of stiffness in this project.**

**The rule:** body parts must not start and stop on the same frame. Motion propagates:
hips lead → spine follows → shoulders follow → arm → fist arrives last. Each link is
offset in time and overshoots slightly before settling.

**Current state: none.** One shared timeline, one shared curve, every joint. The
shoulders and hips *do* move — they just move in perfect lockstep with the fist, which is
why a punch reads as an arm on a hinge bolted to a static box.

The hit *reaction* (`reaction.js`) is the closest thing to a counter-example, and it is
worth understanding exactly how far it gets: head, torso and tilt each run their own
spring-damper, and the chain descends in **amplitude** (torso takes a per-punch fraction
`s.torso` of the head's impulse; hips take `0.35`/`0.65` of the torso's offset). But all
three springs share one `reactionStiffness`/`reactionDamping`, so they descend in size
while staying in phase. That is a *scaled* chain, not a *lagged* one — mechanism 2 below
is the missing half, and the reaction is where to prototype it.

**Mechanisms, cheapest first:**
- Per-joint phase offset on the existing timeline (a few frames of delay up the chain)
- Spring-damper per joint chasing a target angle, with **descending stiffness** up the
  chain (hips stiffest, head loosest) — gives lag and overshoot for free
- Different spring constants / phase on left vs right so limbs never move identically
  ("avoid twinning")
- Low-amplitude idle oscillators for breathing (note `guardBobAmplitude`/`guardBobFrequency`
  already exist, but scale to zero when standing still — a stationary fighter is perfectly
  static)

---

### L6 — Impact framing
**The rule:** a landed punch must be punctuated, not merely resolved. Anticipation before,
freeze on contact, displacement after.

**Current state: further along than the rest of the ladder.**
- **Hit-stop: good.** `hitStopBase: 0.015` → `hitStopMax: 0.10`, scaled by force via
  `hitStopPerForce: 0.00012`, at `hitStopScale: 0.05` timescale.
- **Anticipation: partly covered by L4.** The long `cockMs` telegraph is the anticipation
  beat; what is missing is anticipation on the *defender*, not the attacker.
- **Screen shake: exists, counters only.** `counterShakeIntensity` was raised `0.006 →
  0.018` in Stage 19 part 3 (~23 px at peak vulnerability, zoom-normalised in
  `_shakeCamera`), so it is no longer too timid to register. But it fires **only on
  counter hits** and scales with the defender's vulnerability, not with impulse — an
  ordinary heavy landed punch still shakes nothing.
- **Flash on a clean hit: deliberately absent.** The old body-centred burst+ring was
  removed in favour of the localized rig reaction; the blue overlay survives only for
  blocked hits, where it reads a distinct game state. Counter hits do get their own spark
  at the fist (`makeSpark`, `counterFlashColor`). Do not "restore" the generic hit flash
  without arguing against that decision first.
- **Contact squash: absent.** `gfx.setScale` squashes only for slip (`0.7`-ish) and
  knockdown (`0.35`). Nothing squashes on being hit.

**Full checklist:** anticipation frame, hit-stop, screen shake scaled by impulse, hit
flash, contact squash on both rigs, camera punch-in, glove deformation.

---

### L7 — Atmosphere
Beams, haze, crowd, motion trails, particles, post-processing. Already partly built
(`arenaHazeAlpha: 0.28`, `beamCount: 3`, crowd colours and highlight chance).
**Do not spend time here while L1–L6 have gaps** — atmosphere on top of unreadable
silhouettes and stiff motion makes things worse, not better, by adding visual noise.

---

## Validation protocol

`CLAUDE.md` rule 5 covers "does it render without errors" and explicitly excludes
appearance. That gap is why this project's mechanics are deep and its visuals are not.
For any task that touches a layer in this file, the following is **additional** to the
existing verify step:

1. **Capture across the envelope, not one hero frame.** For motion work, render the pose
   at evenly spaced points across `p = 0 → 1` and tile them into a single contact-sheet
   image. One screenshot of a punch mid-flight proves nothing.
2. **Freeze the inputs.** Deterministic pose, fixed camera, fixed timestep. A capture that
   varies run to run cannot be compared against the previous run.
3. **Both facings.** Every capture must be taken facing left *and* facing right (see the
   mirroring constraint below). Asymmetry bugs only appear in one of them.
4. **Value check for anything touching L1–L3.** Produce a desaturated copy of the
   screenshot alongside the colour one.
5. **Report what the capture shows, and flag anything that looks wrong**, rather than
   reporting "rendered successfully." If the grid shows a limb passing through the torso,
   say so — do not leave it for the feel-test.

**Steps 1–3 are already built: use `scripts/pose_grid.mjs`** (driving the scrubber in
`src/poseDebug.js`). It captures 4 punch types × 2 rig slots × 2 facings × 7 progress
values plus an assembled labelled grid per type, at a pinned zoom and a frozen opponent,
and it drives the shipped `drawRig()`/`computePose()`/`punchKey()` path rather than
re-deriving poses. Extend it rather than writing a second capture harness. **Step 4 has no
tooling** — nothing in the repo produces a greyscale copy today; whoever needs it first
should add it to the capture path, not do it by eye.

Captures go to `scripts/output/` (gitignored).

---

## Hard constraints

- **All visual constants live in `config.js` as tunable values.** Same rule as gameplay
  constants. Colours are CSS hex strings converted at the draw site (`cssHex`). The
  skeleton constants in `rig.js` are the standing exception — see the L2 debt note.
- **Mirroring:** `container.scaleX = -1` mirrors the entire rig for leftward facing, and
  the rig thinks in `lead`/`rear` geometric slots at `+x`/`-x`, not left/right anatomy.
  **Any directional visual treatment — light direction, face shading, rim light, drop
  shadow offset — will flip with the fighter and end up on the wrong side.** Directional
  lighting must be resolved in world space, after the mirror, not baked into local-space
  draw code. This is the most likely place for a visual task to silently break. (The
  contact shadow already dodges this by living on its own layer outside the fighter
  containers.)
- **The drawn thing and the hit geometry must agree.** `fistRadius` is both the drawn
  glove and the circle `_resolveAttack` tests. Keep it that way; never let a visual change
  desync the two.
- **No external art assets currently.** Everything is procedurally drawn. If this changes
  it must be a deliberate, recorded decision, not drift.
- **One layer at a time.** Do not fix silhouette and re-author animation in the same task
  — a combined change cannot be feel-tested for which half worked.
