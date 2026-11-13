# Animation run 2026-11-13: design and working rules

Branch `anim/skeleton-and-feel`. This file is the shared spec every worker reads before its brief.
Nate's brief is the source of scope; `docs/RIG_AUDIT.md` is the evidence; `docs/anim/SOURCES.md` has the maths
(its joint-range and punch-timing tables are unsourced estimates: starting values, tuned against film).

## 1. What the audit found, and the rule that follows

The body is a set of independent point targets (hips, shoulder line, head, two fists, two feet) stitched by
two-bone IK and look-at, rotations derived afterwards, unclamped springs added on top, and bone scaling used to
hide the mismatches (neck 0.3x to 1.6x, forearm to 1.15x, spine +8% in a slip, shoulders not attached to the
ribcage, no joint limits). It is not per-segment physics, but Nate's diagnosis holds: nothing holds the body together.

**Rule for this run (amends "damage/stagger = impulse into a spring-damped rig"):**
AUTHORED POSE FIRST, PHYSICS SECOND. A rigid skeleton with fixed bone lengths and human joint limits is always
the source of truth. Motion comes from a small set of hand-authored key poses per action, blended and timed in
code. Springs and impulses are an ADDITIVE layer in joint space (offsets on chosen joints, clamped, critically or
near-critically damped) and can never break a bone length or a limit. Momentum still scales power and reaction size.

## 2. Architecture

### 2.1 One skeleton, in `src/core`, pure
`src/core/skeleton.ts` (no three.js, no clocks, no Math.random; deterministic arithmetic only):

    root (floor point, yaw)
      pelvis
        spine1 (lumbar) > spine2 (low thoracic) > chest (shoulder line)
          neck > head
          clavicle L/R > upperArm > forearm > hand
        thigh L/R > shin > foot

- Every joint has a FIXED offset from its parent, derived once from `BodyDims` (`core/body.ts`), and a local
  rotation. The only translations in a pose are the root (floor x, z) and the pelvis (crouch, weight shift,
  bounded by leg reach). Nothing is ever scaled.
- A pose (`SkelPose`) = root position + root yaw + pelvis offset + one local quaternion per joint.
- Limits: per joint, per axis, in degrees, in config (`skel*` keys; left and right share keys). Clamp by
  swing-twist decomposition: twist about the bone axis, swing split into two axes, each with its own min and max.
  Elbow and knee are hinges (flexion only, plus forearm twist). `clampPose(pose)` is the last step of every
  pipeline, in the sim and in the rig, so no layer can exceed a limit.
- `fk(pose)` gives world joint positions and orientations. `solveTwoBone` (analytic, pole vector, reach clamped
  so the limb never stretches and the hinge stays inside its limit) serves arms and legs.

### 2.2 Hit geometry comes from the skeleton
The sim keeps `headBox`, `bodyBox`, `gloves`, `arms` on `FighterState`, but with `skelOn` they are DERIVED from
the skeleton: head sphere on the head joint, capsule from pelvis to chest, glove on the hand, shoulder and elbow
from FK. So hit geometry = drawn geometry holds exactly, and the rig draws the sim's pose rather than inventing one.
`FighterState.skel` carries the pose; the rig interpolates it between ticks (slerp) and copies it into a real
three.js bone hierarchy.

### 2.3 Staging: the legacy motion becomes a target generator, then is replaced action by action
- **Stage A (Phase 1.1):** the existing sim curves and springs still produce their points. A `fit` step
  (`src/core/skelFit.ts`) turns those points into a legal `SkelPose`: pelvis at the hips point; the three spinal
  joints share the bend and twist needed to carry the chest toward the shoulder-line target at FIXED spine
  length; the neck (fixed length, limited) carries the head toward the head target, so a struck head ROTATES
  about the neck base instead of sliding; clavicles protract and lift with the punch reach; arms by two-bone IK
  to the glove, which is clamped to reach. The hit shapes are then rewritten from the fitted skeleton.
- **Stage B (Phase 1.4 onward):** each action gets key poses authored directly in joint space
  (`src/core/poses.ts`), blended by the sim with per-joint timing (the kinetic chain), and the legacy generator
  for that action is retired behind its toggle.
- **Additive layers** (hit reactions, breath, bounce, weave) become joint-space offsets with weights down the
  chain, clamped, then `clampPose`. Position springs on body points are retired as each is replaced.

### 2.4 Feet
Phase 1: the rig's foot planter stays; legs are solved by the core two-bone IK from the skeleton's hip joints,
knees limited. Phase 2.3 moves stepping into the sim (step-drag, lateral lead foot first, pivots, pelvis follows
the feet) so footwork is deterministic and layered with punches.

### 2.5 Transitions
Phase 2.1: inertialization in joint space on every state change (decay-spring offset per joint, exact damper,
`fastNegexp`, never `Math.exp`), plus a test that fails when any joint turns more than `skelMaxDegPerTick`
in one tick outside a hit impulse.

## 3. Toggles (every new system can be A/B'd)
`skelOn` (the whole skeleton pipeline; off = the pre-run body, tests for the old behaviour run with it off),
`skelDebug` (bones and limit cones over the mesh), then one per later system, named in its brief.
All in `src/core/config.ts` with a comment, all bound in the tuning panel.

## 4. Rules for every worker
- Read `CLAUDE.md` (shell discipline is mandatory) and this file. Read narrowly: grep, then a range.
- Write only in the folders your brief names. Do not commit unless the brief says so.
- Determinism: nothing in `src/core`, `src/sim`, `src/ai` may use `Math.random`, clocks, three.js, or
  `Math.exp/sin/cos` results that feed gameplay differently across engines beyond what the sim already does.
- No magic numbers: every tunable is a commented config key and appears in the tuning panel.
- No on-screen words, flashes or glows in the shipping game. Feedback lives in bodies, sound, crowd, camera.
- Tests: `npm run test:quick <names>` while iterating; say which you ran. Port 5173 belongs to another project.
  Use the port your brief gives you. `TEST_NO_REUSE=1 npm test` for the whole suite (about ten minutes).
- Judge motion from the PLAY camera with `PORT=<port> node scripts/anim_film.mjs <outDir> <scenario...>`,
  looking at individual frames at full size. Describe what is wrong, harshly. "Rendered OK" is not a finding.
- Debug budget: two diagnostic steps on a failure, then report what you found and what you would try.
- Log every decision you make, with the reason, in `docs/anim/LOG_<your workstream>.md`.
- Report back in under 300 words: what landed, numbers, file paths, what is below standard. No code.

## 5. Phase order
0 audit, baseline film and numbers, telemetry overlay ·
1.1 skeleton and fit · 1.2 skin and proportions · 1.3 trunks, faces, clipping check · 1.4 punches as key poses
· 1.5 hit reactions down the chain · 1.6 knockdowns and get-up ·
2.1 inertialization · 2.2 cancels and buffer · 2.3 footwork · 2.4 hit-stop instead of slow motion ·
3.1 guards with holes, block feel, AI by difficulty · 3.2 stamina · 3.3 counters · 3.4 reaction variety.
After each phase: re-film the baseline set, re-run `scripts/anim_measure.mjs`, fps before and after.
