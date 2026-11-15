# LOG_SMOOTH: slice A1, one-tick joint jumps (measurement only)

Tool: `node scripts/joint_jump_probe.mjs` (Node, sim only, no browser). No file under `src/` changed. Not committed.

## Method
- Pose measured: `f.skel` of the measured fighter after each `sim.step` (local quaternion per joint, 20 joints).
- turn = angle between this tick's and last tick's local rotation of a joint, degrees. dv = |turn_t - turn_(t-1)|, deg/tick^2.
- Default config with `punchKeysOn` forced on (skelOn, hitChainV2 on). ROSTER red vs blue, 0.84 m (1.4 m for walks), 30 idle ticks first.
- rel tick 0 = the state change: the press, the flick release (the tick the `slip` event fires), the block release, the impulse tick (`punchLand`).
- Windows: press rows = rel 0..+3; punch-to-guard rows = -8..+4 around the first tick `punch.type` is null; combo rows = -1..+3 around the 2nd press, pressed at the earliest gap the sim accepts (searched, 1..70 ticks).
- "peak mid-punch" = fastest turn of any joint on any tick of a single-punch run (combos, slip>punch and block>jab rows show 0 or are skipped: their peak is the jump itself).

## Table as measured (worst joint, turn deg/tick @ rel tick, worst dv deg/tick^2)
| scenario | worst turn | dv | peak mid-punch |
|---|---|---|---|
| guard>jab | upperArm0 9.1 @+3 | 5.6 | 38.1 forearm0 |
| jab>guard | forearm0 38.1 @-3 | 28.9 hand0 @-4 | |
| guard>cross | upperArm0 4.7 @+2 | 2.2 | 33.9 forearm1 |
| cross>guard | forearm1 33.9 @-5 | 20.3 | |
| guard>lead hook | upperArm0 8.3 @+3 | 3.5 | 22.3 forearm0 |
| lead hook>guard | forearm0 22.3 @-5 | 18.2 | |
| guard>rear hook | upperArm1 12.1 @+2 | 5.9 | 66.5 upperArm1 |
| rear hook>guard | upperArm1 66.5 @-3 | 39.8 @-2 | |
| guard>uppercut lead / rear | hand 11.4 @+3 | 4.2 | 18.0 |
| uppercut>guard (both) | upperArm0 4.5 / 5.0 | 1.4 / 1.1 | |
| jab>cross (2nd at +9t) | hand0 55.0 @+1 | 55.0 | |
| jab>cross>lead hook (2nd at +1t after cross) | hand0 49.9 @0 | 49.9 | |
| cross>lead hook (2nd at +15t) | upperArm1 125.9 @+1 | 125.5 | |
| hit cross, impulse tick | upperArm0 11.3 | 10.4 neck | allowed |
| hit cross, after (+1..+20) | upperArm0 6.9 @+6 | 10.7 @+1 | |
| hit hook, impulse tick | shin0 4.2 | 4.2 | allowed |
| hit hook, after | forearm0 8.9 @+3 | 8.8 | |
| slip left / right / back onset | upperArm0 28.2 / 30.6 / 22.2 @0 | 27.1 / 29.5 / 21.3 | |
| slip return (+4..+40) | 9.5 / 9.0 / 10.4 | 6.8 / 5.4 / 4.8 | |
| slip > jab / cross, earliest accepted (slip-1) | 20..33 @0..+3 | 17..31 | |
| block raised / dropped | upperArm0 33.4 @+1 / 28.4 @0 | 26.4 / 28.1 | |
| block drop > jab same tick | upperArm0 63.0 @0 | 62.7 | |
| walk start / stop (fwd, back, side) | 0.8..1.8 | 0.5..1.0 | |
| jab mid-walk (fwd, back, side) | upperArm0 15.8 / 8.3 / 15.3 @0 | 15.5 / 7.9 / 14.9 | |

Reference: the fastest legitimate single-punch turn is 66.5 deg/tick (rear hook, upperArm1), but that one is itself a suspect (see below); jab/cross forearm peaks are 34 to 38, hooks/uppercuts 18 to 22.

## 10 worst individual jumps (impulse ticks excluded)
1. 125.9 deg, cross>lead hook, upperArm1, rel +1
2. 90.3, cross>lead hook, upperArm0, rel +1
3. 66.5, rear hook>guard, upperArm1, rel -3 (52.8 on rel -4)
4. 63.0, block drop>jab same tick, upperArm0, rel 0
5. 55.0, jab>cross, hand0, rel +1
6. 55.0, cross>lead hook, hand1, rel +1
7. 54.0, cross>lead hook, pelvis, rel +1
8. 53.1, cross>lead hook, forearm0, rel +1
9. 52.8, rear hook>guard, upperArm1, rel -4
10. 49.9, jab>cross>lead hook, hand0, rel +1

## What it says
- Clean single-punch starts are gentle (5 to 12 deg/tick on the first ticks). The big jumps are the CUTS: a second punch pressed during the first (combo rows, 50 to 126 deg in one tick, dv equal to the turn, i.e. from standing-still-ish to full speed in one tick), block release into a jab (63), and every slip onset / block raise / drop (22 to 33 deg on the first tick, guard arms snapping to a new shape).
- Slip and block change the guard shape in ONE tick on the arms (upperArm0/1), pelvis stays small. That is the biggest everyday source of "not smooth" because it happens on every defensive move.
- Walking itself is smooth (about 1 deg/tick); a jab thrown mid-walk starts at 8 to 16 deg on tick 0 (the press tick), more than the same jab from standing (4.7 to 9).
- Rear hook returning to guard turns upperArm1 66 deg in a tick at 3 ticks before the punch ends: the arm re-settles as a snap rather than a glide (likely the arm pole / hook-level lag releasing; not investigated).
- Hit impulse ticks are small here (4 to 11), the hit chain is gentle; after-impulse ticks stay under 11 deg.

## Where an inertialization layer goes
(a) The final per-tick pose: `f.skel` is written by `fitSimTorso` (src/sim/skel.ts:107, called at the end of `computeBoxes`, src/sim/reaction.ts:254; the keyed layer applies at skel.ts:129, hit chain at skel.ts:132, legs 151, `clampPose` 154) and the arms by `fitSimArm` (src/sim/skel.ts:467, called from `stepArms`, src/sim/arms.ts:63). Hit shapes (headBox, bodyBox) are rewritten from the fit at skel.ts:160-162; gloves/arms in `fitSimArm`. Order in the tick: src/sim/index.ts:126 (computeBoxes), 131 (stepGloves), 132-134 (stepArms, integrateGloves, stepArms again), 135 (resolvePunch), 139-143 (re-derive after a land). So the pose is only final after the last `stepArms` (index.ts:134, or 142 after a land); an inertialization pass over `f.skel` must run after that and then re-derive the hit shapes, or it must be inserted inside `fitSimTorso` / `fitSimArm` before the shape rewrite.
(b) The rig does NOT draw `f.skel` as is, except for heavy/flash knockdowns (src/rig/index.ts:729). Otherwise it lerps prev/next `skel` (slerp, rig/index.ts:541-549) only to seed head/hip/shoulder/glove points, then re-runs its own layers (hip, spine, shoulder-yaw, elbow-flare, hook-level, up-back, block hunch, move-lean, rhythm bounce, breath, squash springs; declared at rig/index.ts:197-234) and RE-FITS a fresh skeleton from them (`poseSkeleton`, rig/index.ts:431-462, called at 1175). So an inertialization in the sim does not by itself smooth what is drawn: the rig's spring layers can add their own motion, and the arms are refit with `fitArm` from rig-side targets (rig/index.ts:457).
(c) State kept per joint between ticks: `f.skel` itself persists (src/core/types.ts:382) but is mostly overwritten each tick (fitTorso takes targets, not the old pose); the arms read last tick's pose from punch P 0.75 on (skel.ts:273). No velocity or offset per joint is kept. Related state exists only for the old generators: per-arm pose lags `level/back/flare` (arms.ts:48-60, `armPose`), `torsoTwist`, the reaction springs, `HEAD_SHIFT` (skel.ts:103, derived each tick), `f.footKey`.

## Not measured, and why
- Browser/rig layer: the rig's own springs and re-fit can jump separately; per the brief, no browser measurement was built.
- Rear-hook upperArm1 66 deg: could be real fast motion or a quaternion branch / limit flip; one diagnostic not spent on it.
- Hit scenarios use one distance (0.84 m) and one idle receiver; no block-absorbed hit, no knockdown.
- Combo "earliest accepted gap" is the first gap where the new punch is the active one the tick after the press (jab>cross>hook accepted the hook only 1 tick after the cross press, which looks like a cancel and may deserve a look).
- Joint turn uses the local quaternion angle; the pelvis local includes the yaw, so a fighter turning to face the other man would show there (not seen here, opponent stationary).

## Decisions
- Measured side 0 only; hit scenarios throw from side 1.
- Impulse rows reported separately and excluded from the worst-10 list, as asked.
- `punchKeysOn` forced on in the probe (as skel_probe does) in case the config default is off.

# Slice A2: the inertialization layer (src/sim/inertia.ts)

Config (group 'smooth'): inertiaOn (true), inertiaMaxAccel (12 deg/tick^2), inertiaHalfLife (0.05 s), inertiaMaxOffset (90 deg). State: FighterState.inertia (per joint: last output rotation, last output turn, lag offset and its rate). Applied in sim/index.ts after the last stepArms and before resolvePunch; a land tick re-fits the pose, so the pass is redone from a snapshot (the struck man, hit or blocked, is exempt and takes his pose as it is).

## How it works
Per joint: a critically damped spring (exact, own negexp, no Math.exp) pulls the lag offset to zero; the output is the pose underneath times the offset; then the output turn may differ from last tick's output turn by at most inertiaMaxAccel, the rest goes into the offset. A cut is therefore a ramp, not a step. Quiet joints are the pose underneath bit for bit. Past inertiaMaxOffset the lag is pulled back a quarter of the excess per tick (a hard clamp was itself a snap: it left an 80 degree turn on a 126 degree cut). After smoothing the joints are clamped to the human limits again, and head, body capsule and arm joints are rewritten from the smoothed skeleton.

## Decision: the gloves are not moved
Rewriting gloves[i].pos from the smoothed hand fed the lag back into the glove physics: Hard vs idle man landed 13% fewer punches, Hard vs Hard 22% fewer and 3 knockdowns became 0. Leaving the gloves on the physics gives identical fights (idle vs Hard 206/206 landed; Hard vs Hard 691 to 661, 3 and 3 knockdowns, 5 of 6 seeds identical). Cost: after a cut the smoothed hand trails the glove by a few cm for a few ticks, so skeleton FK is no longer exactly the gloves (skel_test is pinned to inertiaOn=false for that reason).

## Probe, off to on (worst one-tick change in turn, deg/tick^2; worst single-tick turn in brackets)
cross>lead hook 125.5 (125.9) to 12.0 (20.5); jab>cross 55.0 to 12.0 (20.0); block drop>jab 62.7 (63.0) to 11.9 (16.6); rear hook to guard 39.8 (66.5) to 12.0 (20.3); slip onset 27 to 12; block raised/dropped 26-28 to 11.9. Fastest turn anywhere outside impulse ticks: 33.4 (cross returning to guard). Punch resolution ticks unchanged (jab 8, cross 14, hooks 17, uppercuts 20; second punch of jab>cross 20, cross>hook 28).

## Rear-hook finding
The 66 deg/tick at the end of the rear hook is NOT a quaternion sign or angle wrap (dot product between ticks stays +0.84 or more). The elbow itself moves 44 cm in one tick (t23 of the hook): the elbow pole swings across as the arm returns, a real snap of the arm IK (swivel pole), not a flip. Not a one-line fix; the inertia layer takes it down to 20 deg/tick. The cause is upstream in the key/pole fit (src/sim/skel.ts, swivelPole).
