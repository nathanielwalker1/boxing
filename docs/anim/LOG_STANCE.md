# LOG_STANCE — stanceV2 (2026-11-15)

Nate: "there's still no like fighter stances, bouncing, lean. It's just like upright two fuckers in the ring."

## Before (measured from the sim skeleton, scripts/_debug.mjs, red vs blue, idle, stanceV2 off)
- Trunk (pelvis → neck) pitch from vertical: 0.0°. Bolt upright.
- Hips 1.7 % of standing height below the straight-legged stance (pose_guard_pelUp −0.03).
- Head centre at 0.902 of standing height; 2.7 cm forward of the stance centre.
- Feet 44 cm front-to-back × 34 cm apart sideways.
- Sim skeleton holds dead still: 0.0 cm of hip / head travel over a second; gloves 2 cm.
- Rig idle life existed (rigRhythmBob 3.5 cm, weave 4.5 cm) but with skelOn the rig's arm fit aims the clavicles
  at the SIM's shoulders and the hands at the SIM's gloves (Phase 1.1b, hit = drawn), so only the hips and head
  bobbed under arms that held still, and the breath (a chest scale) was dropped with skelOn (no bone scales).
  From the play camera: a mannequin with its hands up.

## Decisions
1. The stance is in the SIM guard key (core/poses.ts applyStance, deltas over every guard shape so styles keep
   their character): knees −7.5 cm, pelvis tips 9°, spine bends 10°, hips sit back 7 cm, chin −6° relative to the
   (now pitched) chest, lead shoulder up 9°, both shoulders rolled forward 7°, elbows 6° in, feet 3 cm longer
   and 3 cm wider each, rear heel 2 cm higher, weight +0.05 to the rear. Hit shapes go with it (head sphere,
   body capsule): that is the locked rule for anything that moves more than a couple of cm.
2. No glove spot change: the resting glove rides the HEAD in sim/gloves.ts (home = guard spot + key head shift),
   so the gloves drop and come forward with the head. Glove keys I first added were no-ops and were removed.
3. aimPoint's guard drop now includes the stance's knee bend (guardStanceDrop), so punches aim at the lower head.
4. Idle life stays in the rig (cyclic, a few cm): the existing rhythm / weave × stanceLife 1.4, and NEW — the
   shoulders and gloves ride it (stanceArmsRide), the shoulders lift on the breath (stanceBreathLift), the gloves
   pump on the beat lead/rear alternating (stanceGlovePump) and circle slowly on the weave clock (stanceGloveDrift).
   Drawn gloves leave the sim's by those few cm only (as the head bounce already did).
6. stanceShiftBack 0.08: first version put the head 8.5 cm further forward of the fighter's position and an idle man
   took 80 % more lands from Hard. The whole stance (feet and hips) now sits 8 cm back so the pitched head ends
   3.2 cm forward (was 2.7). Cost: the hips / body capsule are ~15 cm further back — body shots reach less.
5. Walking lean: the existing rigMoveLean* × stanceMoveLean 1.6, and the head target goes with the leaning chest.

## After (stanceV2 on, same measure)
- Trunk pitch 12.1°; hips 5.8 % of height below straight-legged; head at 0.841 of height (11 cm lower), 3.2 cm
  forward of the position; feet 50 × 40 cm; knees 65° lead / 84° rear.
- Rig: bounce, weave, glove pump and breath now carry the arms; visible between idle frames side-on.

## Gameplay (scripts/_debug.mjs game, 6 seeds, Hard = aiDifficulty 2)
- Idle man vs Hard: lands 289 → 398 (+38 %), knockdowns 9 → 15. The Hard AI STARTS 380 → 713 punches (+88 %);
  its land rate per punch falls 76 % → 56 %. So the AI decides to throw far more at the new stance (src/ai reads
  something — likely the body capsule / head position — as "in range"); not owned here.
- Hard vs Hard: lands 642 → 653 (+1.7 %), knockdowns 8 → 5, the same winner in all 6. Body lands 182 → 139 (−24 %).

## Tests (stanceV2 on) — RED, not pinned (these are behaviour, not the old pose)
- smooth: cross>lead hook 16.1 deg/tick² (limit 15; 12.0 off).
- heights: boiler's uppercut misses lighthouse / alambre; raffle's uppercut lands on the body of four men; boiler's
  cross no longer finds lighthouse's head clean.
- styles: the 12° hook round the shell / peek-a-boo / high guard check.
- flow_test: the 1-2-3 and 1-2-body3 third punch whiffs at the far distances; contact zones.
- skel: not read (truncated). flow_check: "Multiple instances of Three.js" console warning (likely the linked
  node_modules in the worktree, not this change; unverified).
