# Guard payoff log (branch anim/guardpay)

Nate: "my punches just go into this blocked guard, they feel so awful ... nothing strategic or cool about that."
One toggle, `blockPayoffV2` (default on; off = the old block exactly). All keys are in `src/core/config.ts`, group "block payoff".

## What changed (src/sim/combat.ts only, plus config)
1. Weight: hit-stop on a blocked punch is per type (jab 2, cross 3, hook 4, uppercut 4 ticks); push is a per-type multiplier
   (jab x1.7, cross x1.8, hook and uppercut x1.1). A clean head land by a cross, hook or uppercut gets +2 stop ticks so a
   block stays under the land.
2. Who goes next: the thrower's rebound off a block is per type and may now be under 1 (the arm comes home sooner);
   the blocker's stun is per type. Blocker readiness is capped by hitLockMax (8 ticks), so the lever is the thrower.
3. The guard opens under a combination: the guard meter (guardHp, the existing wear/break mechanism) is charged per punch
   (jab 0.30, cross 0.40, hook 0.50, uppercut 0.50; a shot that comes round the guard costs 0.7x), recovers fast once the
   pressure stops (0.5 s delay, +1.2/s), and an empty meter breaks the guard for blockPayoffOpenSeconds (0.5 s) instead of 1.1 s.
4. The rig already draws it: see below.

## Rig (not edited)
The opening is the existing guard break: `guardBroken > 0`. Drawn at src/sim/gloves.ts:82-84 and 89-90 (hands drop
guardBreakDrop, 0.15 m, and half that wide), src/rig/reads.ts:255-257 (guardBreak event: head/rock kick and wince),
reads.ts:283, 314, 318 (torso leans back and slumps while broken). The new 0.5 s opening sets guardBroken, so all of it fires.

## Measured (scripts/ai_feel_probe.mjs, payoff=0 vs payoff=1, 6 seeds, table C and new table G)
Table C blocked, off to on: jab 2 t / 6 cm / adv +2 to 2 t / 11 cm / adv -2; cross 2 t / 9 cm / +4 to 3 t / 16 cm / 0;
hook 2 t / 21 cm / +5 to 4 t / 23 cm / +10; uppercut 2 t / 28 cm / +3 to 4 t / 31 cm / +8. Clean lands: jab 3 t, cross 5 t, hook 5 t.
Guard openings per fight (AI guard opened by the human), medium: mixer vs pressure 1.5, swarmer 4.8, slugger 1.8, counter 0, outboxer 0.3;
jabber 0 to 1.0 (swarmer 1.0). The HUMAN's guard is opened by the AI 2 to 9 per fight at medium and 8 to 15 at hard: the scripted
humans hold block all the time, so the AI wears them down. Below target: mixer vs pressure (1.5, aim 2) and the mixer's clean share
vs pressure (41% to 42%, no visible margin). Wins are 6-fight cells, so single-cell swings of 2 to 3 fights are noise.

## Tests
scripts/block_payoff_test.mjs (new). See the run notes in the commit and the report for the probe tables.
