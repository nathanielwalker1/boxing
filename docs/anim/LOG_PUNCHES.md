# Anim Phase 1.4: punches as authored key poses

Toggle: `punchKeysOn` (needs `skelOn`). **Default OFF for now.** With it on, the keyed fist path changes
where punches land (reach, height, guard spots), and 7 Node test files move with it (listed below). Whether
the keys may reshape gameplay, or must ride the legacy glove path, is an open decision. Off = the legacy
punch motion; the full suite is green (52/52, port 5193).

Where it lives: `src/core/poses.ts` (keys, chain timing, torso layer, hand targets, swivel pole);
`src/core/config.ts` (`pose_<key>_<channel>` and `punchk_<punch>_<timing>` generated from the
`POSE_DEFAULTS` / `PUNCH_TIMING` tables, plus the `pose*` scalars); `src/sim/skel.ts` (keyed torso, legs
and arm fit); `src/sim/gloves.ts` (keyed hand targets, kinematic punching glove); `src/sim/reaction.ts`;
`src/rig/index.ts` (the planter obeys `footKey`). Measured with `node scripts/skel_probe.mjs --keys` (the
probe turns the keys on itself; add `--set punchKeysOn=false` for legacy). Asserted in
`scripts/skel_test.mjs` (punch keys block, run with the keys on).

## Decisions

- **Guard key absolute, punch keys deltas.** The guard is bladed (pelvis −35°, spine +12°). Punch keys are
  deltas with + = punching side forward, so one table serves both stances and hands.
- **Kinetic chain = per-group timing.** Feet and pelvis start first, then spine (+10–20 ms), clavicle
  (+20–35 ms), hand (+30–50 ms). The hand eases in as progress^`poseHandEase` (1.6) and returns inside its
  extension time. The punch clock, its phases and the hit-test ticks are unchanged (anim_measure A: same
  ticks for every punch).
- **The pelvis turn goes into the torso fit.** Applied after the fit, the 35° blade turned a slip's
  sideways lean 18% forward and sent a pull 15 cm sideways. The spine twist stays in the key layer, shared
  by each joint's rotation range (the fit's shares put the lumbar on its stop). The head starts facing the
  pelvis.
- **The punching glove is kinematic, held inside reach.** A spring chasing a hand that is fastest at
  arrival lagged it 13–18 cm short, so the glove goes exactly where the key puts it. Its target is cut only
  at the endpoint, and is held no further from the shoulder than the legacy target or `poseReachMax`
  (0.99) of the arm, nor closer than `poseReachMin` (0.55): closer, the forearm folded onto its stop. This
  also brought the keyed exchange inside give + 4 cm (it was 13.3).
- **The guard hands stay keyed,** held at the face against the turn (`poseOffhandHold` 0.45). On the
  legacy spots the rear glove drifted 9 cm through the jab and the lead forearm hit its stop through the
  cross. This moves the style guard spots, which is the styles_test failure.
- **The dip stays in the base body** (the sim's crouch: the head box ducks with it); the uppercut keys add
  none. The punch's lean shift is the keys' pelvis travel.
- **Hooks carry the arm in hook shape from the load,** so the turn carries the fist: shoulder-joint
  travel went from 80° to 23–28°.
- **Legs:** the feet stand at the rig's stance yaw, the knee follows the pelvis half way, and the heel
  lifts. `skelAnkleInv` went 20→25 and `skelAnkleDorsi` 35→40 because the blade held the rear ankle on its
  stop.
- **Rig:** the planter takes `footKey` (step, pivot about the ball, heel lift) in place of its own punch
  step. Torso and arms were already drawn from the sim's skeleton (1.1b).

## Key report, final (mid 0.84 m / inside 0.55 m)

| punch | mid: gap on hit tick, chain | inside | peak per tick at mid (shoulder°, elbow°, hand cm) | worst |
| --- | --- | --- | --- | --- |
| jab | 4.5 cm, ok | −1.3, ok | 43, 17, 24 | rear glove 3.8 cm off home (fine) |
| cross | 15.4 cm, ok | −4.7, ok | 42, 29, 24 | 15 cm short (body capsule in front of the face; legacy 14.4); lead glove 15.5 cm off home |
| lead hook | −1.5, ok | −0.3, hand peaks in load | 31, 8, 9 | inside the fist's fastest tick is the load |
| rear hook | −0.8, ok | 4.5, hand peaks in load | 32, 13, 11 | lead glove 13 cm off home |
| lead uppercut | 0.7, ok | 1.0, ok | 16, 2, 9 | 6.7 cm off the centre plane |
| rear uppercut | 2.6, ok | −0.7, ok | 16, 10, 8 | inside the return is slow (fall 19 ticks vs rise 4) |

Every case lands on its intended part (body uppercuts on the head by design). Spine flex is at most 12°.
Upper-body clamped ticks: 8 over 24 cases. Leg clamps (foot cones) remain; the sim's legs are placeholders
until 2.3. Legacy for comparison: shoulder up to 141°/tick, hand 36 cm/tick, chain order mostly out of
order.

## Tests

- skel_test: the 1.4 block is added (land, reach on the hit tick, chain order, retraction, rear glove in
  the jab, hook shoulder travel, uppercut plane, flex/drop, clamped ticks). PINNED: cross reach 16 cm
  (counterpart: it lands). One tick of slack on chain order (hand vs shoulder) and on retraction, because
  peaks are tick-resolved. Exchange is checked keys off and keys on, both at give + 4.
- `skelPoleTwist 1` pins: **still needed while the keys are off.** ai_tools and heights keep theirs.
  danger 4b passes without it.
- danger and heights also carry `punchKeysOn false` with the reasons below, so they stay pinned when the
  default flips.

**With keys on**, these move (Node, 30/37 files pass):
- ai_tools: counter-puncher 0–4.
- block: rear glove not pulled in on the block.
- counter: an out-of-range whiff opens a punish window.
- hurt: the trade-bonus hook.
- level: a jab on a ducked head whiffs. The keyed aim is the head centre, ~10 cm above the legacy chin line.
- punch: a punch lands beyond the glove's geometric reach, the southpaw lead glove side is wrong, and the
  one-tick stick push reaches 1.10 m.
- styles: the guard spots move.
- danger (pinned): body straights land at 0.70× (body cross 259 → 181 N·s). Lean and distance are equal on
  the land tick; the suspect is the keyed weight shift backing the defender off. Not confirmed.
- heights (pinned): a short man's head hook lands on the body.

Brief item (a): the hooks do not yet land at their intended ranges on the keys in every case.

## anim_measure A and F (keys on, before the final reach-hold changes; not written)

- **A:** same first-motion, extend, hit-test and end ticks for every punch as the baseline.
- **F:** cross and hook impulses are unchanged. Body cross 258.7 → 181.1 and body jab 165.5 → 115.9 N·s.
  After a hook, the struck head is not back within 10% inside 135 ticks (baseline 30); not diagnosed.
  Neck peaks are 4–11° lower and trunk bends 2–7° larger.
