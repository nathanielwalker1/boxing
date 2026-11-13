# LOG — Phase 1.1, the rigid skeleton (skeleton workstream)

Branch `anim/skeleton-and-feel`. Every decision with its reason. Spec: `docs/anim/DESIGN.md` §2.1–2.3.

## Structure

- **Joints** (`src/core/skeleton.ts`): pelvis, spine1 (lumbar), spine2 (low thoracic), chest (mid ribcage), neck, head,
  clavicle / upperArm / forearm / hand ×2, thigh / shin / foot ×2 — 20 joints, limbs indexed lead/rear like the sim.
  Parents precede children, so an FK prefix (`fk(def, pose, upTo)`) is self-contained and cheap.
- **Frames**: every joint frame in the bind is axis-aligned with the root (+x forward, +y up, +z right — the rig's
  frame). The root is a rotation about world +y by −yaw. Limbs hang down −y in the bind, so the bind = every local
  rotation identity, and the rig's inverse binds stay translations.
- **Offsets** from BodyDims: spinal joints at 0.15 / 0.45 / 0.70 of hips→shoulder line (`skelSpine1At/2At/ChestAt`);
  the shoulder line is a chest-frame point (the body capsule's top); neck joint at shoulderY + 0.05 chestLen (= the
  rig's old neckBase); head joint (skull on C1) 0.6 headR below the head centre (`skelHeadPivot`) — so the head nods
  about its pivot and the head centre is a head-frame point; clavicle from 0.25 × half shoulder width
  (`skelClavicleInset`) to the shoulder joint, so the bind shoulder is exactly the sim's old one; upper arm, forearm,
  thigh, shin are BodyDims' own (reach unchanged, arms_test's upper-arm length holds).
- **SkelPose** = `{ root: [x, z, yaw, pelvis fwd, up, right], q: 4 × 20 }`, plain number arrays (slice to clone, JSON-safe).
  Lengths are not in the pose, so a pose cannot stretch.
- **Limits**: swing-twist about the bone axis (y, or z for the clavicle). Twist has [min, max]. The swing was first a
  box on the exponential map's two components; MEASURED that inflated combined motions (a hook's 30° horizontal
  extension at 90° abduction read as 48° of "extension" and clamped, dropping the fist onto the body). Now an
  ELLIPTICAL CONE per quadrant built from the same per-axis keys (PhysX-style); outside points are scaled back radially
  (idempotent). Hinges (elbow, knee) have a zero-width side axis and zero twist: flexion only, ≥ 0, no hyperextension.
  Left joints are mirrored (z → −z, quaternion (−x, −y, z, w)) so left and right share keys.
- **Forearm twist** (pronation) is carried by the HAND joint's twist (`skelForearmPronate/Supinate`), not the elbow:
  the rig rolled the glove, not the forearm, and twisting the forearm bone would candy-wrap the elbow skin.

## Limit values (degrees; SOURCES §9, unsourced estimates, split across joints that share a motion)

| joint | values | why |
|---|---|---|
| lumbar / low thoracic / chest | flex 30/25/20, ext 15/12/10, lateral 15/18/15, rot 8/15/22 | totals 75 / 37 / 48 / 45. Lateral raised from 15/15/12 (42): a slip leans the shoulders 0.7 × 33 cm, ≈ 47° of arc; thoracolumbar side bend is 50–60 clinically. Lumbar rotation small (5–10 clinical). |
| neck / head (C2–C7 / C1–C2) | flex 30/20, ext 40/25, lateral 30/12, rot 45/40 | cervical totals 50 / 65 / 42 / 85 |
| clavicle | protract 25, retract 20, elevate 35, depress 10, roll 5 | |
| shoulder | flex 170, ext 60, abd 170, add 70, int rot 80, ext rot 100 | ext 50 → 60 and ext rot 90 → 100 after measuring the legacy hook (91° ext rot at its peak; thrower range is 100–110) |
| elbow | flex 150 (hinge) | |
| wrist | flex ±30, dev ±15 | gloved, taped |
| hip | flex 120, ext 25, abd 50, add 30, rot ±45 | |
| knee | flex 150 (hinge) | |
| ankle | dorsi 35, plantar 50, inv ±20, turn ±30 | dorsi 25 → 35: the rear foot of the stance sat on its stop 99 % of a fight (weight-bearing lunge reaches 35–45) |

## The fit (`src/core/skelFit.ts`), stage A

- **Spine**: the turn is shared 25/35/40 (`skelSpineShare*`) by water-filling inside each joint's rotation range. The
  bend: natural arc = shares of one swing, iterated (8, fixed) so the chord points at the shoulder-line target at FIXED
  length. With an orientation hint (the rig's qChest) the shares of the hint's swing plus a chord-only mode (lumbar
  one way, chest the other) for 4 iterations, then natural shares. Joints are clamped INSIDE the loop; a joint at its
  stop drops out and the rest take the correction (MEASURED: chest flex/ext at the stop 7.6 % → 0.7 % of a fight).
- **Neck/head**: a swing w (chest frame) carries the head centre about the neck BASE onto the target; the neck takes
  `skelNeckShare` (0.6) of w and of the hint's own tilt, the head joint the rest; the head's turn is shared
  (`skelNeckTwistShare`). Clamped inside the loop so the neck takes over from a head at its stop. w capped at 90°.
- **Arms**: the clavicle swings toward a chest-frame target (the bind shoulder + reach forward + lift), so the shoulders
  ride the ribcage; two-bone IK from the FK shoulder to the glove, reach clamped (no stretch, `skelIkStraightDeg` 3°
  straight margin); after a shoulder clamp the elbow re-aims the forearm at the glove within its hinge.
- **Legs**: IK from the FK hip to the ankle target with the knee pole; the foot takes a world orientation, clamped.
- `clampPose` is idempotent; it ends every pipeline.

## Sim integration (`src/sim/skel.ts`)

- `computeBoxes` (reaction.ts) computes the legacy points as before, then (skelOn) `fitSimTorso` fits and REWRITES
  headBox, bodyBox.a/b from the FK. The pelvis takes `skelHipTwistShare` 0.5 of the torso twist (more if the spine would
  pass its rotation range). Head hint: turned `rigHeadFollow` of the twist (the rig's old head follow). Legs stand at
  the rig's stance spots (sim has no feet until 2.3).
- `stepArms` still runs `solveArm` (its pole logic and torso clearance) for the HINT; `fitSimArm` places the arm and
  rewrites arms[i] and the glove from the FK. A glove the fit moved loses its velocity component along the move.
- **Pole turned with the torso twist** (decision): solveArm builds its pole in the fighter's FLOOR frame; with a chest
  that turns 66° into a lead hook, "elbow out" pointed 33° behind the shoulders, past the shoulder's range, and the
  clamp folded the fist onto the body (heights_test: hooks landing on the body). The same pole turned by torsoTwist is
  the skeleton analogue. Cost: the hook's elbow sits ~9 cm below the shoulder (legacy: level) with a near-vertical forearm.
- Tick order unchanged (hooks inside existing functions). Clone carries `skel` only when present.
- **skelOn false is bit-identical**: 2,400 AI-vs-AI ticks of state + events JSON compared against HEAD (scratch worktree): identical.
- Tried and removed: one extra contact settle after the final arm fit (cut arm penetration 10.2 → 6.5 cm) — it flipped
  two uppercut outcomes in heights_test.

## Measured fit residuals (65 s bot fight, 7,800 fighter-ticks, vs the legacy targets)

- Shoulder line: p50 0.00, p95 4.5, max 8.5 cm — ALL along the chord (the legacy target chord ran 55.8–62.2 cm against
  a 57.4 cm spine: the rubber spine). Across the chord: 0.
- Head centre: p50 0.02 cm; while slipping p95 10.9 / max 31 cm, while hit p95 11 / max 30 cm — targets that need the
  neck to shrink or the head to slide.
- Gloves at full reach (clamped): 68 of 15,600 glove-ticks.

## Rig (`src/rig/*`)

- `rig/skeleton.ts`: three new bones (spine2, clav0, clav1; BONE_COUNT 29), `BONE_PARENT` (the hierarchy), `JOINT_BONE`,
  `skelBindPose` (bone origins = the core rest FK). `mesh.ts` builds the hierarchy with skelOn (inverse binds still
  translations); skelOn and the skeleton layout keys are in rigGeomKey (toggle = rebuild).
- Skin (`anatomy.ts`, skelOn): torso by height over hips / spine1 / spine2 / chest, blended ± `skelSkinBlend` around
  each joint; the shoulder corners weight to the CLAVICLE; the deltoid cap's top 0.5 clavicle / 0.3 deltoid helper / rest arm.
- `rig/index.ts` (least invasive): the 650-line solver runs unchanged and produces targets. Changes: with a sim skeleton
  the base points (head, hips, shoulder line, gloves, shoulders, elbows) come from the sim pose `lerpPose`d to the frame
  instead of lerped boxes; the targets the loops overwrite are captured (ankle, knee pole, boot orientation, hem
  spring, reach/shrug per arm, head and hair orientation); `poseSkeleton` at the end re-fits everything through
  skelFit + clampPose and writes the hierarchy: pelvis position + rotation, every other bone its fixed offset + local
  rotation, helpers (deltoid slerp rigShoulderFollow, elbow / knee half-way, hem in the thigh frame, hair at the head
  centre). Every bone scale 1 every frame: breath, squash, neck stretch, forearm stretch and the joint mitres are off.
  It re-fits rather than copies everywhere, because every frame carries some rig motion (breath bob, rhythm, weave, blade).
- Probes: `head()` reads the tail bone (head centre); arms / kneeIn report the fitted joints.
- Referee: same view; no sim skeleton on his state, so the fit starts from his boxes.
- `skelDebug` (`rig/debug.ts SkelDebugView`): bones, joints, the head centre, each joint's swing cone outline (four
  spokes) and each hinge's arc, in magenta, drawn on top. Three draw calls, only when on.

## Pinned tests (skelOn: false, one-line reason each in the file) and their skeleton counterparts (skel_test §4)

| test | pinned | why | counterpart |
|---|---|---|---|
| reaction_test | file | headBox = rest + offsets exactly | a cross displaces the struck head 29.5 cm; neck swing 20°; head-to-neck-base distance held within 0.2 cm |
| slip_test | file | head exactly slipHeadOffset, shoulders exactly 0.7, dip exactly, slip-into-hand caught by the shoulder | head 31.7 of 33 cm both ways both stances; shoulders 0.65 of the head; hips 0; dip 10.7 ≥ 8 cm; pull 26.2 of 28 cm; a slipped jab is dodged |
| slipx_test | file | roll U depth exactly; wrong-way slip caught by the shoulder | roll 36.1 of 40 cm (≥ 0.85) |
| arms_test §2 exchange | section | forearm-into-forearm 5.6–6.0 / glove-into-forearm 6.5–10.2 cm vs bound 4.4 | 16 pairings @0.75 m: 3.1 / 4.5 cm, bound give + 4 cm (LOOSER, on purpose) |
| counter_test §5 | section | post-slip counter graded clean not flush | (behavioural shift, below) |
| danger_test §4 | section | same exchange: the counter no longer rocks | (behavioural shift) |
| interrupt_test §3 | section | the jab after the cross's shove falls short (no stretch) and whiffs | (behavioural shift) |
| punch_test close cross | section | the close cross no longer meets the pinned guard; lands clean | (behavioural shift) |

## Behavioural shifts with skelOn (outcomes that changed)

- **Slip INTO the jab hand is now a dodge**, not a body shot: the rigid spine arcs, so the shoulder line ends 6 cm lower
  and 2.4 cm less lateral (0.207 vs 0.231 m); the jab clears it by 5.8 cm (legacy: caught at 1.5 cm). slipCrouch's
  config note says it was capped exactly to keep this catch. Needs Nate: accept, or move the hips into the slip.
- **Post-slip counter cross grades clean, not flush** (×1.33 impulse instead of flush; no rock in danger_test): the
  whiffed jab is held in line at full reach and the counter brushes the rear guard glove ("through the guard").
- **Close cross (0.5 m) lands clean** instead of through the pinned guard (power 0.391 vs midCross 1.116).
- **A jab after a cross's shove at 0.72 m whiffs**: it relied on the 15 % forearm stretch.
- **Hook head tilt vs cross**: 0.228 vs 0.118 (1.93×; the pinned test wants > 2×).
- **Arm penetration in exchanges** rises (above).
- Unchanged and green with skelOn: heights (after the pole fix), ai_tools, attrition, block, body, combo, drills, flow,
  footing, guard, grade, health, hurt, level, ratings, stamina, stun, styles, timing, fight, determinism.

## Evidence (port 5193)

- Film: `docs/anim/p1_1/` (11 scenarios × play camera + side), compared frame by frame with `docs/anim/baseline/`.
  Console clean. Pose grid: `scripts/output/pose_grid/`. Real GPU: `scripts/output/gpu_fight.png` lit, 3/3, referee
  drawn. skelDebug: `scripts/output/skel_debug.png`.
- fps, real GPU (M1, overlay, AI fight): skelOn off 60 / 16.66 ms, on 60 / 16.66 ms — vsync-capped, so it shows no
  drop below 60 but cannot resolve the fit's cost (headless software GL: 8 fps either way, not a desktop number).

### What the strips show (harsh)

- Better: shoulders sit on the ribcage — the baseline's peaked, sheared shoulder corner seen from behind
  (upper_rear_mid t016) is gone; the torso bends as one spine in slips and body shots (counter t006, hit_body t031);
  a struck head ROTATES about the neck (jab_mid t014: chin lifts) where baseline slid an upright head; nothing
  stretches; knockdown holds together (no detached head or gloves on the fall).
- Worse / wrong:
  - hit_head t016–t020: the head is thrown back ~60°, face to the ceiling, crown behind the shoulders, no neck
    visible — the legacy 16–25 cm head offset is now realised as rotation to the neck + head extension limits. Reads
    as a broken neck. Same on the get-up (knockdown t164–t180). Phase 1.5 (joint-space reactions) must replace the
    offset; until then skelNeckExt / skelHeadExt could come down.
  - The head sits LOW in the shoulders in every hit and slip frame: little visible neck (counter t006, jab_mid t014).
  - Blue's idle lead arm (every strip, e.g. upper_rear_mid_side t016, cross_mid_side t012): upper arm lifted toward
    horizontal, lead glove at brow height off his face, where baseline hung the elbow by the ribs. The sim's guard
    elbow is unchanged (1.19 vs 1.18 m measured), so this is the RIG re-fit — most likely the legacy 20° chest blade
    now turning the shoulder with it plus a shoulder clamp. Not diagnosed.
  - Red's right shoulder from behind (hit_head t018) comes to a point where the clavicle-weighted skin meets the
    deltoid; the deltoid cap reads flat-topped side-on (upper_rear_mid_side t016).
  - Rear uppercut (upper_rear_mid t016) ends at the sternum under the guard — legacy motion, same in baseline.
  - Pose grid, facing right, rear hook p=0.45: the drawn red glove stops a few cm short of its green hit sphere (the
    fixture asks for more than arm length; the fixture states have no sim skeleton, the rig clamps). Facing left the
    rear hook at p=0.6 sends blue's glove over his own head — the fixture's target, hit sphere there too.

## Phase 1.1b — review fix-ups (2026-11-13)

Tool: `scripts/skel_probe.mjs` (permanent; `node scripts/skel_probe.mjs [punch hand] [--table] [--set key=val]`):
per tick, elbow flexion, shoulder swing/twist, clavicle, joints ON a limit, glove target → hand error, the
clearance-pole blend and whether core/arms.ts would snap, upper-arm / flexion change and elbow travel per tick; with
`--set skelOn=false` the legacy joints.

1. **Hook elbow ("dislocated").** MEASURED, lead hook t16–22 (the film's ticks): no joint clamped, the pole switch never
   fired. With the pole turned by the FULL torso twist (my 1.1 fix) the elbow sat 29 cm forward, 10 cm below the
   shoulder and 13 cm ACROSS the midline, 72° abduction, ~80° external rotation: a vertical forearm standing across the
   face on a low, crossed elbow — the fit obeying a bad POLE (mine). Unturned (the legacy pole) the elbow goes 21 cm out
   in the floor frame, 55° of horizontal extension behind 66°-turned shoulders: the shoulder sits on its cone t16–23 and
   the hook whiffs — a bad legacy TARGET combination. `skelPoleTwist` 0.5 (new key): elbow 11 cm outside, 5–7 cm below
   the shoulder, no clamp, lands on the head; upper arm ≤ 23°/tick (was 25), elbow ≤ 17 cm/tick (legacy 18.8).
   Pole switch: replaced in the skeleton path by a continuous blend of the same two poles over ± `skelClearBlend`
   (sim/skel.ts armPole; core/arms.ts untouched, skelOn off unchanged). It now engages only on the lead uppercut (0.07, t17).
   Bad LEGACY targets for Phase 1.4 (fit obeys them): hook t11–13 shoulder twist −31 → −70 → −94° (40°/tick) as the glove
   sweeps ~20 cm/tick while the level lag rises; hook glove targets 20–30 cm above the shoulder (the head CENTRE), so a
   level elbow cannot also have a level forearm; uppercut 60–63°/tick upper-arm swing (elbow 36–38 cm in a tick) when
   uppercutV2's binary "back" target flips into the fast lag; cross 45°/tick at the extension.
   Shifts at 0.5: danger_test §4b slip-counter lead hook whiffs; heights_test hook→boiler body shots miss; ai_tools
   inside-fighter 0–8. Those sections are pinned to `skelPoleTwist: 1` (comments in the files).
2. **Whiplash.** Neck + head extension 65° → 35° (neck 22 + head 13), flexion 40, lateral 30, rotation 70 (config). The
   unreachable sideways / fore-aft part of the head target is carried by the spine (`skelHeadSpineCarry` 1: the chest
   target moves by it, one more spine + neck pass). Clean cross (skel_test): neck + head ≤ 22.5° extension, spine 16.2°,
   head travel 30.1 cm (29.5 before).
3. **Head sunk into the shoulders.** Cause: a head target CLOSER than neck + head reach (a slip's dip, a sink, a drop the
   neck base did not share) was aimed at along its own direction, which tilts the neck far over and drops the head into
   the trapezius. Fix: aim at the point on the head's reach sphere straight above the target (sideways and fore-aft
   offsets tilt the neck; a pure drop is not chased). Head centre to neck base held within 0.1 cm.
4. **Chicken-wing guard.** Two causes. Rig: the drawn arm was re-fitted from the rig's bladed chest (item 5). Sim: the
   flare term flares the elbow as the glove rises above the SHOULDER, and a guard holds the gloves 15–25 cm above it.
   `skelGuardFlareFree` 0.3: the glove's height counts only above that (−1 = the legacy flare). Idle lead elbow below its
   shoulder: red 15.5 → 18.4 cm, blue 11.2 → 15.0 cm. Still a legacy TARGET: blue's guard glove sits 6–8 cm under his
   head centre (eye level; style guard) — 1.4. heights_test pinned to −1 (monsoon's uppercut on raffle misses at 0.3).
5. **Drawn shoulders off the sim's.** MEASURED (probe.skelDiverge, cross_mid): drawn − sim shoulder 8.8 / 13.0 cm idle
   (red / blue), elbow 12–13 cm, hand up to 7.7 cm mid-cross. Fix: no rig blade with skelOn; standing, the drawn arm IS
   the sim's (clavicle to the sim shoulder, hand to the sim glove, elbow to the sim elbow), blending to the rig's own arm
   targets only by the knockdown weight. After: shoulder / elbow 0.9–2.3 cm (red mid-cross 4.4 cm, one tick: the
   clavicle cannot reach from the rig's chest), hands 0. Drawn-only arm reads (armKick, cover, clinch drawn arms,
   shrug / give / feint) are therefore off standing with skelOn — they return as sim-side joint reactions (1.5).

## Deferred / below standard

- Joint-limit boxes are now cones, but the shoulder is still a single exp-map cone; a proper plane-of-elevation model
  (ISB) is a later refinement if the hook still clamps after authored key poses (1.4).
- Head targets the skeleton cannot reach (slips, flush hits) are just missed; nothing hands the residual to the spine
  or the hips. Stage B (joint-space reactions, 1.5) replaces those targets.
- (Resolved in 1.1b, item 5: the blade is gone with skelOn and the drawn arms are the sim's standing. If the stance
  blade is wanted back it goes into the sim's fit, where the hit shapes carry it.)
