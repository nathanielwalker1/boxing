# Rig audit (branch anim/skeleton-and-feel, 2026-11-13)

Read-only audit of `src/rig/*`, the pose-feeding parts of `src/core` and `src/sim`, to design a rigid-skeleton rebuild against.
Every claim cites `file:line` (paths relative to `src/` unless they start with `scripts/` or `docs/`). "Unclear" means I could not
determine it from the code I read. Numbers marked "computed" are my arithmetic from default config at heightM 1.85, not measurements.

Files read end to end: rig/index, reads, ik, springs, feet, squash, mesh, skeleton, anatomy, geo, replay, debug; kit.ts and head.ts only
for their skin weights (grep + ranges). Not read: rig/materials, paint, atlas, spray (render only). Sim: punches, gloves, arms, reaction, chain,
footing, movement, slip, variants read fully; combat.ts only lines 200-310 and stun.ts by grep (it holds state, no points).

## 0. Shape of the system in five lines

- The SIM places points (head sphere, hips and shoulder-line capsule ends, two gloves, four arm joints) and a few scalars (twist, lean, crouch). It never places feet, knees, or any rotation except yaw and twist.
- The RIG reads those points, adds its own offsets and springs, derives every rotation, and writes absolute bone positions (rig/index.ts:392-1050, one function).
- Bones are not a hierarchy. 26 sibling bones under one group (rig/mesh.ts:90-98, rig/skeleton.ts:1-9). Nothing inherits anything.
- One SkinnedMesh, blended weights, inverse bind matrices are pure translations (mesh.ts:96).
- The ARM solve (shoulder, elbow) lives in `core/arms.ts` and runs in the sim (sim/arms.ts:60). The rig only re-solves arms in special cases (knockdown, clinch, cover). Legs are solved in the rig (index.ts:983).

## 1. Bone hierarchy and lengths

No parent-child chain. `BONE` ids at skeleton.ts:31-38; every bone is `group.add(b)` (mesh.ts:93). A "limb" is two or three sibling bones
whose positions are set from the same endpoints (placeChain, index.ts:283-306). Consequences: no length propagation, no inherited scale
(so a scaled bone does not scale a child, there are none), and no constraint ties one segment to the next.

| Segment | End A (computed each frame) | End B | Length preserved? | Evidence |
|---|---|---|---|---|
| Spine (hips to chest) | Hips bone = sim `bodyBox.a` lerped (index.ts:412) + `hipSway` spring + reads offsets (:539-541) | Chest bone = sim `bodyBox.b` (:413) + `spineBend` spring (:549), plus knockdown override (:710-716) | NO. Two independent points. Sim moves them by different amounts: hips take `reactionHipFollow` 0.6 of a hit, shoulders 1.0 (sim/reaction.ts:139-141); a slip moves shoulders 0.7 of the head's move, hips 0 (reaction.ts:135, config slipShoulderFrac); lean shifts shoulders 1x, hips 0.5x (reaction.ts:134-135). Computed: a full slip lengthens hip-to-shoulder from 0.574 m to 0.619 m (+8%). The spine bone is just the midpoint (index.ts:733) so the skin between hips and chest stretches. |
| Neck | Neck bone at `neckBase` = chest-frame point above S (:749) | Aimed at the head position `headL` (:774-785) | NO. Deliberately scaled. `scale.y = neckLen / neckBind` clamped to [0.3, rigNeckReach = 1.6] (:786; config rigNeckReach). Past 1.6x the neck BASE is dragged toward the head (:778-779). Bind length neck base to head centre is 0.24 m (computed, skeleton.ts:85), so 0.38 m at max. |
| Head | Bone origin = `headL` (:753) = sim `headBox` + rig-only offsets (see 11) | Orientation only | Head is a point + quaternion, no segment. Squash scales it (:766-769). |
| Upper arm | Shoulder = sim `arms[i].shoulder` (:816) + `sh.y += shrug + shrugLead - shoulderGive` (:824), + V2 chain drops (:826), + feint (:827), + clinch/cover/push IK (:832-851), + knockdown lerp (:858) | Elbow = sim `arms[i].elbow` (:817) from core/arms.ts:49, plus `armKick` (:854, 0.45 of kick) and cover/clinch lerps (:841, :850) | Sim: exact. `arms_test.mjs:37` pins |shoulder-elbow| = upperArm to 1e-6. Rig: NOT after its offsets. It moves shoulder (:824) and elbow separately, then `placeChain` sets upper bone scale (1,1,1) (:295), so the mismatch is absorbed as skin stretch across the elbow blend zone. Lerping two valid elbows (:841, :850, :863) also gives a chord shorter than L1. |
| Forearm | Elbow bone at the sim elbow | Glove bone at the sim glove, EXACT (:879) | Mostly. Sim places elbow at exactly forearm length from the glove while reachable (core/math.ts:163-167). If the glove is farther, forearm bone is stretched: `stretch = min(rigArmStretchMax, |elbow-glove| / forearm)` (:866-869), applied as `bL.scale.set(1, stretch, 1)` (:298). rigArmStretchMax = 1.15 (config:887). Beyond 1.15x the glove keeps its exact position and the bone falls short (ik.ts:6-8). arms_test.mjs:38 allows up to stretch. Also only ever lengthens, never shortens. |
| Thigh | Hip joint = `H + qHips * (0,0,+-hipJ)` (:964) | Knee = analytic IK mid (:983) | YES. `solveTwoBone(..., stretchMax = 1)` (:983), bone scales (1,1,1) (:295, :985). |
| Shin | Knee | Ankle = foot planter (:936) pulled in horizontally if farther than `rigKneeMax` 0.98 x (thigh+shin) (:966-979) | YES for lengths; the FOOT is what moves (ankle dragged off its planted spot, see 8). No minimum distance, so the knee can fold arbitrarily far. |
| Shoulder (deltoid) bone | Sim shoulder (:875) | Orientation = slerp(chest, upper arm, 0.5) (:876, config rigShoulderFollow) | Not a segment. |
| Glove | Sim glove (:879) | n/a | Squash scales it (:885-887). |
| Boot | Ankle (:1003) | n/a | Rotated by yaw and a heel-lift pitch (:1004-1006). |

### Everywhere a bone is scaled or a length is not preserved

1. Forearm y-stretch up to 1.15: index.ts:298, :869, :872.
2. Elbow/knee helper bone widens in x by `rigJointMitre` up to 1.22: :301-304 (config:983-984).
3. Neck y-scale 0.3 to 1.6 and base follow: :778-786.
4. Chest scale: breath (rigBreathAmp 0.03) plus torso squash: :727-730 (squash.ts:28-35: perpendicular axes swell by half the squash).
5. Head squash along the hit impulse, amount capped 0.5, default 0.22: :381-386, :766-769.
6. Glove squash 0.3 along the forearm on the attacker's own land: :371-373, :885-887.
7. Spine length varies with sim hip/shoulder differential: :553-556, :733.
8. Upper arm endpoints disagree after rig offsets (:824-827, :854).
9. Legs preserve bone length but not foot position (:966-979).
10. Hem and hair bones swing on world-space springs and are clamped (:991-1001 rigClothMax 0.09 m; :799-805 rigTailMaxDeg 50). Not rigid; intended as cloth.

## 2. Joint limits

There are no joint limits as such. What exists is incidental:

| Joint | Limit present? | What prevents or fails to prevent a bad pose |
|---|---|---|
| Elbow hyperextension | No angle limit. Bend SIDE is fixed by a pole vector, so it cannot fold backward in the normal case. | `twoBoneMid` (core/math.ts:159-179) and `solveTwoBone` (ik.ts:18-45) pick the elbow on the pole side of the shoulder-glove line. The pole is built from config constants (core/arms.ts:45-48) and snaps to a different pole when the forearm would enter the torso (core/arms.ts:51-54), a discontinuity. If the pole is parallel to the arm a perpendicular is invented (math.ts:171-177). Full fold (glove on the shoulder) is allowed (d floor 1e-6, math.ts:162). Rig hinge axis is 97% previous + 3% new when the arm is straight (index.ts:288-290), so roll through a straight arm is arbitrary. |
| Shoulder leaves socket | Not a concept. | Arm root is a sim point: chest centre + (reach, lateral) yawed by twist (core/arms.ts:34-43), always at chest height, independent of the chest's pitch and roll. The chest bone rotates with `qChest` (index.ts:553-582) but the shoulder bone is NOT its child. Chest mesh corners are skinned 82% to the shoulder bones (anatomy.ts:155-161). Config text admits the shear: "past ~25 deg the chest corner shears visibly away from the shoulder it is skinned to" (config:1152). Spine spring offset is added to the chest (:549) but not to the shoulders (:564), so they drift by that spring's displacement. |
| Neck angle | No quaternion limit on the neck or the head as composed. | Head quaternion = yaw follow (:754) * tilt/tuck (:757) * reads yaw, pitch, roll (:761-765). Only the reads part is clamped: yaw +-70, pitch -40..+48, roll +-35 deg (reads.ts:393). The sim spin (x1.5, config rigHitHeadSpin), tilt x0.5 and shoulder-yaw follow are added outside that clamp. Neck bone orientation = half-way slerp then re-aimed at the head (:782-785): free twist. |
| Neck translation | Two clamps. | Sim: head offset from torso <= `reactionMaxNeck` 0.16 m (reaction.ts:81-82), x1.4 flush, x1.6 finisher (config:1361 text; sim/combat.ts:734 gradeNeck*). Rig: neck scale <= 1.6 then base follows (:778-779). |
| Hip / thigh swing | None. | Thigh direction is whatever hip-to-ankle IK says. Hip yaw = stance 26 deg (config rigStanceHipYawDeg) + chain/follow + reads (index.ts:542). |
| Knee | Bend side fixed by pole (:982); max reach 0.98 (:966); no minimum. | Pole is `rigKneePoleFwd/Out` constants rotated by foot yaw, minus slip/chain/reads knee-in (:982). Hyperextension prevented by the 0.98 clamp. Over-fold not prevented. |
| Ankle / foot | None. | Boot yaw free (:1004). |
| Torso twist, lean | Only what the sim's curves produce. | torsoTwist = turn x curve (sim/combat.ts:272), turn up to 1.45 rad for a hook (punches.ts:155). Rig adds blade, spin, reads on top (:567-582) with no total limit. |

## 3. Skinning

One body `SkinnedMesh` plus a second `SkinnedMesh` for the outline hull, same geometry (mesh.ts:100-114). Vertex weights: up to 4 bones,
heaviest four kept and normalised (geo.ts:42-49). Weights are functions of bind position, authored per part.

| Part | Influences and blend | Evidence |
|---|---|---|
| Torso, trapezius and the neck skin (one lofted grid) | By height: hips (<= hy + 0.3 spine) -> hips/spine smoothstep -> spine/chest -> chest -> chest/neck/head over the neck rows. Plus a shoulder-corner override: within 3 x upper-arm radius of a shoulder joint, 0.82 x bump toward that arm's shoulder bone, the rest scaled down. | anatomy.ts:141-163 |
| Upper arm | Deltoid cap: shoulder bone up to 0.8 blended to upper arm by height; below insertion upper / elbow-helper / forearm over +-1.15 x radius. At most two influences per vertex. | anatomy.ts:269-278, hingeWeights :199-208, config rigJointBlend 982 |
| Leg | thigh / knee-helper / shin over +-1.15 x 0.85 x thigh radius. The leg mesh starts 0.9 R above the hip joint with 100% thigh weight; there is no hip blend into the pelvis (torso is 100% hips there). | anatomy.ts:297-298, :335, :344-347 |
| Head | 100% head; underside of the jaw at the back 50% neck. | head.ts:178-182 |
| Hair | head to tail bone (spring) by height, 0.6-0.85 max. | head.ts:376, :413, :475-477 |
| Glove | 100% glove bone; cuff blends glove/forearm 50%. | kit.ts:39, :66, :84, :100 |
| Boot | 100% boot; shaft top blends to shin. | kit.ts:258, :276, :294 |
| Trunks | Body panel hips 0.7-1 plus hem 0-0.3; leg panels hips <=0.3, hem <=0.8, thigh remainder. | kit.ts:134, :162-166, :192-198 |
| Bow tie (referee) | chest | kit.ts:340 |

Helper bones: `spine` (midpoint, index.ts:732-735), `elbow` and `knee` (half-way rotation, widened x, :301-304), `shoulder` (deltoid, :874-877), `hem` (:987-1001), `tail` (:790-806).

Where pinch and balloon come from (cause, not confirmed visually):
- **Elbow/knee**: linear blend skinning. The only volume compensation is the helper bone's x widening, `rigJointMitre` 0.22, capped 1.22 (index.ts:301; config:983 says 0 "pinches"). A fully folded elbow (glove to shoulder, allowed) is beyond what a 1.22 widen can fill.
- **Forearm stretch** scales every vertex weighted to the forearm bone along y from the elbow origin, which also lengthens the wrist and the cuff blend (kit.ts:100). Glove bone is not scaled, so a gap/overlap opens at the cuff.
- **Chest scale** is non-uniform and applies to every chest-weighted vertex including the yoke: breath and squash make the torso balloon (:727-730).
- **Neck**: stretch scales the skin between chest and head along y only, so a long neck stays the same radius (thin look), a compressed one (min 0.3) is a stub.
- **Shoulder corners**: 0.82 weight to a bone that does not rotate with the ribcage (see 2).
- **Hips/thigh overlap**: thigh mesh above the hip joint is 100% thigh while pelvis is 100% hips; they pass through each other as the stance yaws and the thigh swings. Trunks hide it.

## 4. Springs, impulses, clamps

### Sim side (affects the drawn pose because the rig draws these points)

| What | Acts on | Keys (default) | Clamped? | Evidence |
|---|---|---|---|---|
| Reaction head spring (3D offset) | Head sphere position relative to torso | reactionHeadK 160, C 9 | +-reactionMaxNeck 0.16 m x grade neck multiple | reaction.ts:92, :81-82 |
| Reaction torso spring (3D offset) | Shoulder capsule end full, hips 0.6 | reactionTorsoK 220, C 11; reactionHipFollow 0.6 | +-reactionMaxOffset 0.49 m | reaction.ts:93, :139-141, :83 |
| Tilt, spin | Rig chest pitch (tilt) and yaw whip (spin); head x1.5 | reactionTiltK 150 C 8; reactionSpinK 180 | tilt 0.6 rad, spin 0.9 rad | reaction.ts:94-95, :84-85; index.ts:418-419, :571, :573, :754 |
| Sink spring | Whole body sits down: head, hips and shoulders (`c`) | reactionSinkK 260 | <= 0.1 m | reaction.ts:96, :86, :117 |
| Impact pose | Part of the kick applied as displacement at once | reactionImpactPose 0.02 s (torso 0.012) | via clampReaction | reaction.ts:65-72 |
| Glove springs | Glove position toward authored target; punching hand k x chainPunchK 6 | chainK 2500, chainC 80 | No reach limit; contacts push out of head/body/arms (gloves.ts:267-283) | gloves.ts:211-214, :241-245 |
| Elbow pole lags | Hook level, uppercut back, flare (first-order) | rigElbowK 110 (x2 fast) | 0..1 targets | sim/arms.ts:49-58 |
| Slip | Head lateral offset, LINEAR rise 0.05 s, hold, return 0.12 s | slipRise 0.05, slipDuration 0.25, slipReturn 0.12, slipHeadOffset 0.33 | by construction | slip.ts:161-172 |
| Stagger | Floor velocity -> `pos` | staggerDecay 8 | decays | movement.ts:70-75, :79 |
| Eased scalars | level, posture, buckle | levelTime etc. | approach() | footing.ts:115, :121, :131 |
| Pose settle | torsoTwist/lean/crouch unwind to 0 after a punch | poseSettleRate 9 | rate-limited | combat.ts:217-220 |

### Rig side

| What | Acts on | Keys | Clamped? | Evidence |
|---|---|---|---|---|
| `hipSway` spring3 | Hips position (also the feet's rest spot x, :900) | rigHipK 700, zeta 0.55 | No | index.ts:171, :532 |
| `spineBend` spring3 | Chest position | rigSpineK 240, zeta 0.5 | No | :172, :533 |
| `hipYaw` | Hips yaw: first-order follow when a V2 chain is on, spring otherwise; `v` zeroed | rigChainHipRate 60; rigHipK | No | :441-444 |
| `blockAmt`, `moveLean`, `rhythmGate`, `hookDrive` | Scalars/offsets that scale other terms | rigSpineK, rigHipK | No | :180, :425, :431, :485, :509 |
| `fallAmt` | Blend factor stand pose <-> fall timeline | 25 / rigGetUpTime^2, zeta 0.9 | 0..1 | :589 |
| Reads channel springs | chest pitch/roll/yaw, shrug, hip fwd, hip yaw | K 260, zeta 0.75 | No (kicks stack) | reads.ts:375-379, :381, :384 |
| Reads hips | hipDrop k420 z0.7; hipLat k120; buckle k160 | | `max(0, kSag)` only | reads.ts:380, :382, :276 |
| Reads kicks | whip yaw 90/.38, whip pitch 70/.4, head roll 80/.4, rock 150/.5, fold pitch 120/.45, fold roll 110/.4, chest yaw 120/.45, sag 70/.6, hip lat 110/.5, hip back 110/.55, shoulder 140/.6, arm 90/.5 (k / zeta) | | shoulder and arm floored at 0; **head yaw/pitch/roll clamped** | reads.ts:376-393 |
| Hem, hair | World-space springs on the hem and tail bones | rigClothK 70 z 0.28; rigTailK | rigClothMax 0.09 m; rigTailMaxDeg 50 | index.ts:996-1001, :796-805 |
| Squash | Sine-envelope bone scale on head, chest, glove | rigSquashAmount 0.22 (cap 0.5), rigGloveSquashAmount 0.3 | cap 0.5 | squash.ts; index.ts:385, :373 |
| Dead code | `shoulderYaw` spring computed then discarded (`void yawS`); `elbowFlare`, `hookLevel`, `upBack` declared, never used | | | index.ts:173-176, :536, :755 |

Rig springs are unclamped additive layers on an already position-driven pose. Only head angles and the cloth have limits.

### How a head hit moves the body (rigReactV2 on by default, config:1351)

1. Sim `applyReaction` kicks head, torso, tilt, spin, sink springs and applies 0.02 s of the kick as displacement immediately (reaction.ts:41-72). Hit-stop then freezes that pose.
2. **Head**: sphere moves by the head spring (<= 0.16 m x grade multiple). Rig puts the head bone on it (index.ts:753), then adds whip yaw/pitch/roll from reads kicks by zone (reads.ts:151-175, :389-393), sim spin x1.5 (:754), squash along the impulse (:381-386).
3. **Neck**: nothing of its own. Re-aimed and rescaled from chest to head each frame (:773-786).
4. **Chest**: shoulder-line end moves by the full torso spring (reaction.ts:141); rig pitches the chest by sim tilt (:573) and reads rock/fold, yaws by spin and kChestYaw (:571), rolls by kFoldRoll (:575).
5. **Pelvis**: hips end moves 0.6 of the torso spring (reaction.ts:140), then kSag drops it, kHipLat/kHipBack shift it (reads.ts:380-382; index.ts:541), `sink` lowers everything (reaction.ts:117).
6. **Feet**: nothing directly. Stagger velocity moves `pos` (movement.ts:79); planted feet stay in world until the rest spot drifts 0.12 m (feet.ts:83) or the leg clamp drags the ankle (index.ts:966-979). Only `toeUp` (rigComboV2, off) touches the boots (:1006).
7. Drawn arm: `armKick` pushes the DRAWN glove away from the sim glove by up to (-0.35, -0.45, +-0.85) x kick (:854), so the drawn hand is not on the hit sphere for that beat.

## 5. Transitions

| Transition | Mechanism | Evidence |
|---|---|---|
| punch -> punch (chain) | Sim blends the carried twist/lean/lat/crouch over `comboBlend` of the flight (smoothstep), glove springs continuous. Rig: `hipYaw.x` continuous. BUT `pushFoot`, `cp.on` and the per-foot `pivot` factor switch in one frame, so foot yaw and heel lift step by (factor change x hipYawS or cp.push) (magnitude unclear). | combat.ts:282-290; index.ts:437-444, :940, :960 |
| punch -> block | Sim glove target switches to `blockLocal`; spring-smoothed. Rig `blockAmt` chased (k 240). Whether a block can start mid-punch is decided in stepActions (not read): unclear. | gloves.ts:76; index.ts:425 |
| block -> slip | Mutually exclusive; flick with block held is a pivot/push-off, not a slip. So block must release first; `blk` eases out. | slip.ts:89-94 |
| slip | Sim head offset: LINEAR lerp over 0.05 s (3 ticks) to 0.33 m, velocity kink at both ends; return linear 0.12 s. Rig hip spring follows `slipLat` (index.ts:530-532). | slip.ts:167-171 |
| step -> punch | No blend. Feet planter keeps any step in progress (it cannot be interrupted); sim roots feet by `moveScale`. Punch body motion is additive on hipSway. A step jab forces a quick lead step (`stepNow`, 0.6 x duration). | feet.ts:93-100, :62-69; footing.ts:83; index.ts:926-930 |
| hit -> recovery | Underdamped springs (zeta 0.38-0.6) return to zero on both sides; squash envelope 0.1 s x grade. | reaction.ts:92-97; reads.ts:376-391 |
| stand -> knockdown | `fallK = 1` the tick `next.down` is true (index.ts:588-589). Hips/chest/head then come from the fall timeline at t = downT (~0), so they start near standing, BUT gloves are replaced outright by the chest-frame flop point (`gloveL.lerp(gloveF, 1)`, :713) and the head is rebuilt at rest neck length over the fallen chest (:665-672) instead of the reaction-displaced head. Both are a one-frame jump (size not measured; head jump up to the reaction offset, glove jump from guard height to hip-ish height). Exceptions: rigDownV2 'out stiff' and 'knee' keep the guard (off by default). | index.ts:710-716, :682-688 |
| knockdown -> get-up | `fallAmt` eases to 0 over rigGetUpTime 0.8 s (:589) after the sim's `down` clears; `reads.up` spring runs the stir/knee/slump/rise phases (reads.ts:405-410). Sim boxes never fell (:586-587), so while the rig is mid-rise the hit spheres are standing: drawn != hit geometry for ~0.5 s. | index.ts:586-589; reads.ts:405-410 |
| step / pivot | Planter lerps feet with smoothstep, 0.22 s, sine lift; teleport reset above 1.0 m; hop (`airborne`) snaps feet to target every frame; pivot's lead foot takes a 4-tick quick step then snaps if within 3 cm. | feet.ts:24, :79, :93-100; index.ts:910-924 |

## 6. Data flow

Sim tick order (sim/index.ts:90-143): slip -> actions (punch clock) -> footing -> locomotion -> separation -> facing -> advancePunch (twist, lean, crouch)
-> stun -> reaction springs -> `computeBoxes` -> `stepGloves` targets -> `stepArms` -> glove spring integration with contacts -> `stepArms` -> hit resolve
(and a re-derive of boxes/arms on a land).

Rig frame (index.ts:392-1050), in order:

| # | Rig step | Inputs from sim | Output |
|---|---|---|---|
| 1 | Root yaw and position | `pos`, `yaw` (:402-408) | root transform |
| 2 | Lerp targets into the fighter frame | `headBox`, `gloves[].pos`, `bodyBox.a/b` (:409-413) | headL, gloveL, hipL, shoulderL |
| 3 | Chain pose and hip yaw | `punch.type/hand/progress` via sim's `chainPose` (:436) | hipYawS (:441-444) |
| 4 | Reads | state + events (:450) | pose channels |
| 5 | Idle life: breath, rhythm bob/sway, weave, move lean | `vel`, `stamina`, `range`, `flat` (:471-523) | offsets on head/hips |
| 6 | Hip and spine springs | `lean`, slip offset, reads (:530-533) | hipSway, spineBend |
| 7 | Hips pose | hipL + hipSway + reads; yaw = stance + chain + reads (:539-542) | bone `hips` |
| 8 | Chest pose | shoulderL + spineBend; quaternion from bend, shoulder-line yaw, blade, spin, tilt, lean, roll (:549-582) | bone `chest` |
| 9 | Knockdown override | `down`, `downT`, `downKind`, `fall` (:588-717) | rewrites H, S, headL, gloves, qHips, qChest |
| 10 | Spine bone, neck base | midpoint; chest-frame offset (:732-749) | bones `spine` |
| 11 | Head bone, neck bone | headL; rotations from yaw, tilt, reads (:753-786) | bones `head`, `neck` |
| 12 | Hair spring | head frame (:790-806) | bone `tail` |
| 13 | Arms | sim `arms[]` + gloves + rig offsets; IK only in fall/clinch/cover (:814-888) | bones shoulder, upper, elbow, fore, glove |
| 14 | Feet | `pos`, `vel`, `pivot`, stance constants, hipSway.x, reads (:893-932) | feet[i].out (world) |
| 15 | Leg IK, hem spring, boot | H, qHips, ankle; poles (:933-1012) | bones thigh, knee, shin, boot, hem |
| 16 | Face, skin, damage atlas | reads, events (:1027-1046) | morph targets, uniforms |

Who owns which point:

| Quantity | Owner | Detail |
|---|---|---|
| Pelvis position | SIM base, RIG offsets | `bodyBox.a` (reaction.ts:134-140) + rig hipSway/rhythm/reads/fall (index.ts:539-541). Hips WORLD position follows sim `pos` exactly. |
| Pelvis rotation | RIG | stance 26 deg + chain/spring + reads (:542). Sim only has `torsoTwist`. |
| Torso yaw | SIM line, RIG blade | atan2 of the two sim shoulder joints (:565-566) + `rigStanceChestYawDeg` blade 20 deg (:570) + spin + reads. |
| Torso lean (pitch/roll) | RIG (from sim scalars) | bend from capsule slope (:553-558), `lean.fwd` x deg (:573), block hunch, move lean, reads. |
| Shoulder positions | SIM | core/arms.ts:39-43, then rig offsets (:824-827). |
| Fist positions | SIM | gloves.ts:241-245. Rig draws exactly there except armKick/clinch/cover/fall (:822-854, :713). |
| Elbow positions | SIM | core/arms.ts:49-54 with lagged pole (sim/arms.ts:49-58). Rig only in fall/clinch/cover. |
| Head position | SIM base, RIG offsets | `headBox` + rig weave/rhythm/clinch/move-lead (index.ts:463, :499-501, :535). |
| Foot positions | RIG | feet.ts planter from `pos` + stance constants (index.ts:895-931). Only the pivot point (footing.ts:203-210) and `hop` come from the sim. |
| Knee positions | RIG | `solveTwoBone` with pole constants (index.ts:982-983). |

## 7. Punch motion

Authored in `sim/punches.ts`, as target points for the glove, not joint angles.

| Punch | Timing keys (default s: cock / extend / recover) | Path (fn, lines) | Space |
|---|---|---|---|
| jab | jabCock .06 / jabExtend .05 / jabRecover .10 (config:252-254) | `straightPath(..., 0.04)` :133, :263-271 | Fighter frame (fwd, up, lat) |
| cross | .15 / .05 / .15 (config:258-260) | `straightPath(..., 0.35)` :142, :263-271 | Fighter frame |
| hook | .19 / .06 / .16 (config:261-263) | `hookPath` :285-307; `hookPathV2` :497-512 (hookV2 default true): cocked, via, peak authored in the fighter frame and inverse-rotated by the chain twist | Torso frame: yawed by current `torsoTwist` (:361-363, :379), so the arc is the shoulders turning |
| uppercut | .24 / .06 / .17 (config:264-266) | `uppercutPath` :321-339; `uppercutPathV2` :515-531 | Torso frame |

Shape: `punchLocal` (:349-381). Cock = smoothstep mix guard -> cocked; extend = smoothstep over `chainArrive` 0.8 of the extend phase, linear mix or a
quadratic through `via` (:252-260, :369-371); hold; recover = smoothstep mix back. Variants bend it (`shapePath`, variants.ts:123-131). Aim lane
tracks the opponent's height (gloves.ts:55-65). Extend is **3 to 4 sim ticks** at 60 Hz (config SIM_HZ 60). Curves, not keyframed poses: three or four points per punch, interpolated.

What chases what: the path gives a glove TARGET (gloves.ts:199-201); the glove is a spring toward it (:241-245); the arm is then solved from shoulder to that glove (sim/arms.ts:60). The path is measured from the fighter's centre, not the shoulder (punches.ts:16-19).

Body during a punch:

| Part | What drives it | Evidence |
|---|---|---|
| Shoulder line (twist) | SIM: `torsoTwist` = turn x `punchTwist` (turn: jab .45, cross 1.15, hook 1.45, uppercut .85) | combat.ts:272; punches.ts:132-168, :426-430; chain for hook/uppercut chain.ts:79 |
| Weight / lean | SIM: `lean.fwd`, `lean.lat` (sway) | combat.ts:270-271; punches.ts:438-440; boxes shift by `punchLeanShift` .18 (reaction.ts:123, :129-135) |
| Dip | SIM: `crouch`, everything sits down by it | combat.ts:273; punches.ts:448-455; reaction.ts:117 |
| Hips | RIG: `chainPose` (rig imports sim: index.ts:37) hip lead ahead of shoulders; first-order follow rate 60/s; non-chain: `twist x rigPunchHipFollow .7 x hook drive` through the hip spring | index.ts:436-444; punches.ts:543-556; chain.ts:71-76 |
| Feet | RIG: push foot = rear for rear hands and jab, lead foot for a lead hook/uppercut (:437); foot yaw = hipYawS x pivot factor, ball-of-foot arc (:940-950); heel lift rigPunchHeelLift .06 x push (:960); jab steps off the lead foot (:896) | index.ts:896-1006 |
| Knees | RIG: IK pole, pushing knee turns in `rigChainKneeIn` (:982) | index.ts:982 |
| Head | RIG: yaw follow 0.35 x shoulder yaw, chin tuck by lean, plus reads | index.ts:754-758 |
| Shoulder reach | SIM `reach` (sim/arms.ts:54, rigPunchShoulderReach .07) for the arm joint; RIG drops/raises the drawn shoulder in V2 (:826) | |

## 8. Footwork

Feet are not in the sim. `rig/feet.ts` `FootPlanter` holds a world position and yaw per foot.

- Rest spot per foot = `pos` + stance (lead fwd `rigStanceFwd` .20, rear back `rigStanceBack` .24, lat `rigStanceLat` .17) + `hipSway.x` (index.ts:895-901). Desired spot adds `vel x rigStepLead` .15 s for the leading foot (:903-905).
- A foot starts a step when desired drifts > `rigStepThreshold` 0.12 m or yaw turns > 0.6 rad, and the OTHER foot is not mid-step (feet.ts:83). Step = smoothstep lerp over `rigStepDur` 0.22 s with sine lift `rigStepLift` .05 (:93-100). Trailing foot goes to the rest spot, 0.8 x duration; lateral = shuffle (stepRoles feet.ts:32-38; index.ts:514).
- Between steps the foot is exactly planted, so hips glide on a velocity while feet move in discrete 0.22 s hops. No sliding when still.
- Slides that DO exist: (a) the ankle is pulled toward the hip horizontally when the hip-ankle distance exceeds 0.98 of leg length (index.ts:966-979), so the drawn foot leaves its planted spot (planter state is not updated). Triggered by hips travelling, stagger, rig sway, knockdown slide. (b) a foot cannot step while the other steps (feet.ts:83), so a late foot is dragged by (a).
- Pivot: sim plants the lead foot `pivotReach` ahead and swings `pos` about it (footing.ts:203-232). Rig quick-steps to the point then snaps (index.ts:910-920).
- Hop (burst): both feet snapped to desired each frame and lifted `footLift` (:921-924).
- Hips bob on beats while feet are planted; the knees bend only because IK moves the hip, not because a foot-contact model asks them to (:488, :532).

## 9. Knockdown and get-up

All in rig/index.ts:584-717. The sim's boxes stay standing (:586-587); only the drawing falls.
- Trigger: event `knockdown` captures `fallDir` from the finishing punch's impulse (:357-369). A body-shot cause forces forward (:365); uppercut forces back (:363).
- Default path (rigDownV2 off): `kind = null` (:602). Hips fall under `rigFallGravity` 5 m/s^2 to a floor (shin or bodyR height) (:605-609) and slide along `fallDir` by `rigFallSlide` .35 (+ lay slide) (:612-614). Torso tips about the hips with `rigFallTip` 8 rad/s^2 to 88 deg (66 body, 42 flash) with a damped bounce (:616-621). Hook adds a spin (:624-627).
- The head is rebuilt over the chest at REST neck length, `rigFallHeadLag` .12 further round (:669-672).
- Gloves: go to a chest-frame flop point; once the torso is past 70 deg they lerp to lying on the canvas; on get-up they lerp to a push position; clamped to arm reach from the shoulder (:679-709). Arms re-solved by `solveTwoBone` with the pole down (:858-864).
- Legs: feet stay planted (lift scaled by `1 - fallK`, :961); hip distance grows, so (a) of 8 drags the feet toward the hips.
- Blend: `H.lerp(Hf, fallK)` etc. (:710-716). `fallK` = 1 while `down`, else eases out over `rigGetUpTime` (:589).
- Get-up: `reads.up` spring from sim `getUp.phase` with stir 0.22, knee 0.55, slump 0.14 targets (reads.ts:405-410, config:1195-1197); hips rise to kneeling before the torso (:609); a sine struggle sway (reads.ts:410).
- OFF by default (rigDownV2): flash sit-down, knee, out-stiff plank, out-crumple (:629-658).

## 10. Toggles that gate animation

| Key | Default | Gates | Evidence |
|---|---|---|---|
| rigReactV2 | true | Head reactions by zone, grade, vary: `reactV2` instead of one whip + fold. Body hits only with rigReactBodyZones. | config:1351; reads.ts:214 |
| rigReactBodyZones | false | rigReactV2 for body shots. Built, not verified. | config:1352 |
| rigHurtV2 | false | Rocked/winded sub-kinds in the DRAWING (legs, reach, cover, fold, elbow, knee, hurtDelay still). Built, not filmed. | config:1362; reads.ts:343-360 |
| rigDownV2 | false | Knockdown kinds (flash, knee, out stiff, out crumple); also knee dip and get-up speed. | config:1368; index.ts:602; reads.ts:362, :408 |
| rigNerfV2 | false | Nerfed punch (hips barely turn, weight back) and the flinch. | config:1372; reads.ts:364-368 |
| rigComboV2 | false | Combination rock-back and the attacker's follow step. | config:1375; reads.ts:235, :371-374; index.ts:925 |
| hookV2 | true | Hook re-authored in SIM (`rigOnly: false`: twist, dip, path change) and rig chain. | config:1313; punches.ts:469, :497 |
| uppercutV2 | true | Same for uppercut; also the sim's uppercut elbow pole (sim/arms.ts:41). | config:1314; punches.ts:470 |
| straightV2 | true | Jab/cross chain in the DRAWING only (`rigOnly: true`): hips ahead, rear foot pushes, jab steps. Sim values unchanged. | config:1315; punches.ts:467-468 |
| stylesOn | true | Guard shape and stance width/bounce per fighter (shell, peekaboo, long, low). | config:820; reads.ts:39, :320 |
| clinchOn / clinchV2 | false / false | Clinch absent by default; V2 is an experiment. | config:673, :1379 |
| hurtVarietyOn | true | Sim-side mechanical differences by hurt kind. | config:1264; footing.ts:62 |
| levelOn, variantsOn, anglesOn, rollOn | true | Crouch level, contextual punch variants, angle exposure, roll. | config:594, :605, :611, :743 |
| debugSkeleton | false | Overlay of 16 joints and 15 lines. | config:844; index.ts:1015 |
| rigQuality | (config:146) | Low tier = fewer segments; referee always low. | mesh.ts:61 |

There is no single "punch animation V2" key; the three punch-pose toggles above are it.

## 11. Hit geometry coupling (what a rebuild must not break)

Drawn = hit (CLAUDE.md rule), and exactly where:

| Hit-test shape | Drawn counterpart | Exact? | Evidence |
|---|---|---|---|
| Head sphere `headBox` (r = body.headR) | head bone | NO: the drawn head = headBox + rig offsets: clinch shift (index.ts:463), rhythm bob (rigRhythmBob .035 x rigRhythmHead .8, :499), weave (rigWeaveAmp .045 lateral + .02 forward, :500-501), circling lead (rigMoveHeadLead .03, :535). Up to roughly 7 cm lateral (computed from amplitudes) off the sphere. | index.ts:753 |
| Glove sphere `gloves[].pos` (r = gloveR) | glove bone | Yes, except armKick (:854), clinch/push (:832-842), cover (:845-851), portrait, knockdown (:713). | index.ts:879 |
| Body capsule `bodyBox` (a, b, bodyR) | hips and chest bones | Hips/chest centres include rig springs and reads (cm). Radius vs drawn torso: chest depth `rigChestDepth` x bodyR etc. (skeleton.ts:73-82). | |
| Shoulder and elbow segments (arm contacts) | upper arm / forearm bones | Joints yes; the arm contact radii are `bodyR x rigUpperArmR` / `rigForearmR` read in the SIM (gloves.ts:270, :311-312). | |
| Fall | none | The sim never falls (index.ts:586-587). | |

Couplings a rebuild must preserve or consciously move:
- **Rig config keys are consumed by the sim**: `rigUpperArmR`, `rigForearmR` (gloves.ts:270, :311), `rigElbow*`, `rigArmStretchMax`, `rigElbowClearance` (core/arms.ts), `rigPunchShoulderReach`, `rigHeelLiftLean` (sim/arms.ts:23, :54), `rigStanceFwd/Lat` (footing.ts:203-204), `rigHookElbow*`, `rigElbowK`. Changing a rig radius changes sim contacts.
- **Rig imports sim code**: `chainPose` from `sim/punches` (index.ts:37).
- The SIM owns arm IK; the rig draws it. A rig-owned skeleton cannot reshape arms without a sim change or a documented break of the rule.
- Hit-stop, `alpha` interpolation: rig lerps world points prev->next (index.ts:402-413).
- Probes used by film scripts: `window.__rig[side]` head, gloves, arms, feet, chain, footPos, feed, freeze, override, portrait (index.ts:66-98, :320-351, :1064-1073); `__rigReplay` (rig/replay.ts). Used by scripts/chain_probe.mjs, replay_check.mjs, filmstrip.mjs, anim_film.mjs, lookbook.mjs. The referee uses `createFighterView` with `opts.key` (index.ts:137-139).

Node sim tests that assert pose-related values (do not read rig output; they read `headBox`, `bodyBox`, `arms`, `gloves`, `torsoTwist`, `lean`, `crouch`):
- `arms_test.mjs:36-41` bone lengths, stretch, elbow below shoulder, clearance from torso.
- `reaction_test.mjs:100-110` headBox = rest + torso + head offsets every tick; bodyBox follows `reactionHipFollow`.
- `body_test.mjs:35-47` rest box positions; cross/hook glove positions.
- `slip_test.mjs:55-64, :119` shoulders lean `slipShoulderFrac`, hips stay, head dip; `slipx_test.mjs:87` roll U depth.
- `level_test.mjs:26-31` head and capsule drop by `levelDrop`.
- `timing_test.mjs:95, :124, :144-145` lean/sway/twist/crouch return to 0; load; dip.
- `combo_test.mjs:158` chained peak twist/lean/crouch agree with a snapped start.
- `punch_test.mjs:61, :102, :298-313` glove-vs-head overlap, contact on the surface.
- Also reference these fields (assertions not individually read): danger, hurt, flow, attrition, block, guard, interrupt, stun, styles tests.
- No Node test asserts anything the rig draws. Playwright `*_check.mjs` only; of those `replay_check.mjs` uses `__rig`. There is no `rig_check.mjs` (index.ts:18 mentions one; it is absent).

## 12. Verdict

**Claim under test: "physics drives each segment independently so nothing holds the body together."**

Partly true, and the true part is not "physics".

TRUE:
- Nothing holds the body together **structurally**. Bones are flat siblings (skeleton.ts:1-9); each is placed absolutely from its own point.
- The torso is three independent points (hips, chest, head) from the sim hit capsule and head sphere, with different follow weights, so spine length and neck length change every hit and slip (reaction.ts:134-141; index.ts:774-786). The neck is literally scaled to close the gap.
- The shoulders are not on the chest (core/arms.ts:39-43 vs index.ts:553-582). The gloves are spring-chased points authored from the body centre, not the shoulder (punches.ts:16-19; gloves.ts:241); the arm is solved afterwards.
- There are no joint limits beyond a pole side, a knee reach clamp, and head-angle clamps on one channel (reads.ts:393).

NOT TRUE:
- Segments are not independent in length everywhere. Upper arm and both leg bones are exactly constant lengths (arms_test.mjs:37; index.ts:983). Forearm is constant up to 15% stretch.
- It is not segment physics. The pose is KINEMATIC from authored curves (punches.ts, chain.ts) and the sim's position springs. The springs are few: 5 per fighter in the sim (reaction.ts), 2 per glove, ~10 reads kicks, hips/spine, and cloth. No spring acts on a bone angle in a chain, no joint torques, no ground contact.
- Arms and head are not "falling apart": sim arm IK is analytic and consistent, head offset is clamped to 0.16 m (reaction.ts:81).
- The rig ADDS to an already sim-posed body: one layer of offsets over the sim's points. The looseness is from stacking, not from a solver.

Better description: **a set of point targets (hips, shoulder line, head, two fists, two feet) stitched together by two-bone IK and per-frame look-at, with rotations derived after the fact, additive unclamped springs on top, and non-uniform bone scaling used to hide the mismatches.**

### Top 10 causes of the play-doh look (ranked by my judgment; ranking is not measured)

1. **Pose is positions, not rotations.** Hips, chest, head and gloves are set absolutely; every in-between length and angle is derived. Segment lengths between them vary. rig/index.ts:721-735, :749-786; sim/reaction.ts:134-141.
2. **The neck is a stretchy bone.** Scale 0.3 to 1.6 plus base follow; the head can leave the shoulders by 0.16 m x 1.4-1.6 and the neck just grows. index.ts:778-786; reaction.ts:81-82; config rigNeckReach.
3. **The head moves as a translated sphere, not a head turning on a neck.** Hits kick a 3D offset spring (reaction.ts:92, :130-132) that the rig reads as a position; rotation is a separate layered set of kicks. A real head pivots near C7; this one slides then looks back at the camera.
4. **Shoulders are detached from the ribcage.** Arm roots come from the sim's horizontal shoulder line, the chest rotates on its own, and chest corners are skinned 82% to the arm bone. core/arms.ts:34-43; index.ts:553-582, :824; anatomy.ts:159; config:1152.
5. **Squash and stretch as a deliberate effect.** Head, chest, glove, forearm and elbow helper all scale non-uniformly, with breath on the chest. index.ts:298, :304, :385, :727-730, :766-769, :885-887.
6. **Unclamped stacked springs.** Sim reaction springs plus rig hipSway, spineBend, ~12 reads kicks all add into chest pitch, roll, hip drop and shift, and only head angles are clamped. Underdamped (zeta 0.38-0.6). reads.ts:375-393; index.ts:532-533.
7. **Gloves are free points; arms are solved to fit.** Targets are authored from the body centre with 3-4 tick extensions, springs and contact pushes move them, then forearm stretches up to 1.15 and the glove is placed exact even out of reach. punches.ts:269, :369; gloves.ts:241; index.ts:866-879. Elbow pole snap: core/arms.ts:51-54.
8. **Linear blend skinning with soft zones and weak volume repair.** Elbow/knee mitre 0.22, 1.22 cap; shoulder corner 0.82 to a non-chest bone; thigh/pelvis overlap. anatomy.ts:141-161, :199-208; index.ts:301-304; config:983.
9. **Snaps and linear ramps in transitions.** Knockdown replaces gloves and head on frame 1 (index.ts:713, :665-672); slip is a linear 3-tick move (slip.ts:167-169); foot pivot/push factor flips between punches (index.ts:437, :940); feet teleport/snap on hop and pivot (index.ts:920-924; feet.ts:79).
10. **Feet are not part of the body model.** Rig-invented, world-planted, stepping in 0.22 s hops under continuously gliding hips; a leg clamp drags the ankle off the planted spot. There is no weight, support or contact logic, so the body floats on its feet and the legs reach/bend to follow hips rather than carry them. index.ts:895-1012, :966-979; feet.ts:83.

Unclear / not determined:
- Whether a block can begin mid-punch (combat.ts stepActions not read).
- Magnitude of the foot-yaw/heel snap at punch-to-punch and of the knockdown frame-1 jump (not measured; mechanism only).
- How often the forearm stretch cap is hit in real play (no log).
- Visible severity of each skinning artefact (cause identified from weights, not filmed).
- Contents of rig/materials.ts, paint.ts, atlas.ts, spray.ts (not read; not pose-related).
