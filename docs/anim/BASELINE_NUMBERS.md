# Combat sim baseline, before the animation rebuild

Measured with `node scripts/anim_measure.mjs` (plain Node against the sim, no browser, fixed seeds, deterministic).
The tables between the GENERATED markers are written by `node scripts/anim_measure.mjs write`; re-run it after the
rebuild and diff this file. Everything outside the markers is hand-written.

How to read it: tick = 1/60 s = 16.7 ms. A, C, E, F use the two reference fighters with ratings and styles off (the
phase-1 baseline). B and D use the game as shipped (ratings and styles on). Hooks to re-measure each number are named
in the section text (`pressToMotion`, `secondPress`, `pressInHitStop`, `hostRun`, `staminaBudget`, `crossAtStamina`,
`dFight`, `slipCounterTrial`, `reactTrial`; all exported or plain functions in `scripts/anim_measure.mjs`).

Not measured, and why:
- The host loop (`src/main.ts` slow motion, replay, input sampling) was not run in a browser. `hostRun()` re-computes
  its arithmetic from reading main.ts:405-450 and ui/read.ts:73, so section B's slow-motion rows are a model of that
  code, not a capture. If main.ts changes, hostRun must be re-copied.
- The sim has no discrete foot-step state. "Feet step" in F is the floor-position shift (`pos`), which the rig turns
  into steps.
- Human input latency (the stick is sampled once per wall frame in main.ts) is not modelled; scripted inputs are per
  sim tick.

## Headlines

A. From guard, a press changes the pose on the very tick it is read (tick 0) for every punch and level: the sim has no
   input delay. The glove has moved 5 cm after 1-4 ticks (jab 3, cross 2, hooks 2, uppercuts 1-4). Hit test lands at
   tick 6 (jab, 100 ms), 11 (cross, 183 ms), 14 (hooks, uppercut, 233 ms), 16 for a body uppercut. A press during the
   previous punch is buffered for 0.3 s (18 ticks) and fires the first tick the chain window opens (immediately after a
   land or block; half-way through the stretched recovery after a miss); a press earlier than 18 ticks before the
   window opens is DROPPED (cross then hook pressed 1 tick after a miss: dropped). A press during hit-stop is neither
   buffered nor dropped: the punch starts that tick, but the punch clock then runs at 5% until the freeze ends.

B. Per 10 s of play, medium AI, shipped config: about 0.8-1.1 s frozen (19-26 hit-stop episodes, mean 44 ms, longest
   283-317 ms) plus 0.3-1.2 s of host slow motion. Game speed is 0.83-0.90 of real time. In a scripted slip-and-counter
   loop it is 0.51: 22% of the wall clock frozen, 57% in slow motion (modelled, see above).

C. A jab costs 1.6% of the tank, a cross 3.2%, a hook 3.7%, an uppercut 4.2%; a miss adds 4.1 to 6.5 more and wears the
   ceiling; taking a clean cross costs 4.1%. Regeneration is 35% per second whenever no punch is in flight. At the
   brief's pace (a punch per 0.6 s, 1 s gaps, a clean shot every 2 s) the tank never drops below 88% in 90 s: the
   floor is not reachable. It is reached at 43 s at 4 punches a quarter-second and 5 s when they all miss. At the floor
   nothing locks out: punches take 1.25x longer, hit at 30% of full power, wind up 2.5x slower below 25%.

D. Medium AI: blocks 22% of punches that reach it (hard 24%, easy 15%); 78% of reached punches land; 31% of thrown
   punches never reach it (distance, slips). The AI throws 85 punches a minute against the attacker's 46, and lands a
   punch within 0.3 s of 28% of the attacker's landed punches (hard 45%). Legitimate bot plans win 32% on medium, 23%
   on hard, 72% on easy.

E. A counter = a landing inside the window a successful SLIP opens (combat.ts:593). Cross as counter vs the same cross
   as a plain hit: impulse 595 vs 272 N s (2.18x), health lost 5.9% vs 2.7%, hit-stop 0.18 s vs 0.067 s, graded flush
   instead of clean. No rock in either.

F. A clean cross to a planted defender: head 0.49 m from rest in the world frame (3.3 head radii, mostly the whole man
   being shoved 0.36 m), 0.31 m (2.0 radii) bending from the feet; neck 30 deg; torso tilt 6.7 deg; back to within 10%
   in 28 ticks. Hook: 0.60 m (4.0 radii), 0.32 m from the feet, neck 37 deg, tilt 13 deg, yaw 38 deg.

## What the numbers say about the two complaints

"A human on medium can't get through the guard and gets knocked down" (D, measured with a scripted attacker that
throws a combination every 1.5-2.7 s, presses 8 ticks apart, no reads, no slips):
1. The guard is not a wall against the FIRST punch (88% of reached first punches land on medium) but it is against the
   follow-ups: the AI's reactive guard is armed by the first punch of a combination and held aiBlockWindow 0.45 s, which
   covers the rest of a 1-2-3. Reached 2nd punches land 68%, 3rd+ 63%; 31-37% are blocked (D.2b). Add the 31% of thrown
   punches that never reach it (it steps out of range, slips) and only ~54% of all thrown punches land on medium.
2. The AI out-throws the player: 85 punches a minute against the attacker's 46 (hard 128), and it lands a counter within
   0.3 s on 28% of the attacker's landed punches (hard 45%). The bots win 32% on medium and 23% on hard and are knocked
   down 0.37 and 0.68 times a fight (D.3).
3. What does get around a held guard is body shots and uppercuts (`through` flag: 12-22% of reached body shots and
   43-52% of reached uppercuts on medium/hard, against about 0-3% for jab and cross; combat.ts guardCover:
   guardBodyCover / guardUppercutCover 0.6, hooks by the arrival angle). A player who throws mostly 1-2-3 head
   punches is throwing exactly the punches the guard stops best.

"Counter slow-mo reads as lag" (B.3, modelled from main.ts): one slip and counter takes about 2.0 s of wall clock for
0.84 s of fight. In order: the slipped punch's 0.12 s hit-stop is always granted in full and stretches to 233 ms because
the 0.6x read window starts on the same frame; the counter's own 0.18 s freeze plays at 0.6x (300 ms wall); then the
0.3x counter slow motion (367 ms); and then the 0.6x window keeps running for another 683 ms because landing the
counter does not close the window (0.51 s of it is left). Three effects stack in the 300-1500 ms after the player's
slip, each tuned in isolation (the hit-stop budget cuts ordinary freezes but never the slip or the counter, which are
tier 2).

<!-- BEGIN GENERATED (node scripts/anim_measure.mjs write) -->

## A. Press-to-first-motion (ratings and styles off; tick 0 = the tick the press is read)

Hook: pressToMotion(cfg, case, level) in scripts/anim_measure.mjs (steps sim.step, diffs the rig channels against an idle twin).
Channels: glove/elbow = hand and elbow position relative to the hips, > 2 mm from the idle twin; twist/lean/crouch > 1e-4. "0" = already moved on the tick that read the press (it is drawn on the next frame).

| punch | level | variant | state | glove >2mm | glove >1cm | glove >5cm | elbow | twist | lean | crouch | FIRST MOTION (ticks / ms) | extend phase at | resolve (hit test) at | ends at |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jab | head | jab | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 / 0.0 | 3 | 6 (100.0 ms, Land) | 14 |
| cross | head | cross | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 8 | 11 (183.3 ms, Land) | 25 |
| lead hook | head | hook | 0 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 11 | 14 (233.3 ms, Land) | 30 |
| rear hook | head | hook | 0 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 11 | 14 (233.3 ms, Land) | 30 |
| lead uppercut | head | insideUppercut | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 11 | 14 (233.3 ms, Land) | 28 |
| rear uppercut | head | insideUppercut | 0 | 0 | 0 | 1 | 0 | 0 | 0 | 0 | 0 / 0.0 | 11 | 14 (233.3 ms, Land) | 28 |
| jab | body | bodyJab | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 / 0.0 | 3 | 6 (100.0 ms, Land) | 14 |
| cross | body | bodyCross | 0 | 0 | 0 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 9 | 12 (200.0 ms, Land) | 25 |
| lead hook | body | bodyHook | 0 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 11 | 14 (233.3 ms, Land) | 30 |
| rear hook | body | bodyHook | 0 | 0 | 1 | 2 | 0 | 0 | 0 | 0 | 0 / 0.0 | 11 | 14 (233.3 ms, Land) | 30 |
| lead uppercut | body | risingUppercut | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 | 0 / 0.0 | 12 | 16 (266.7 ms, Land) | 32 |
| rear uppercut | body | risingUppercut | 0 | 0 | 0 | 3 | 0 | 0 | 0 | 0 | 0 / 0.0 | 12 | 16 (266.7 ms, Land) | 32 |

### A.2 Phase lengths as they exist (config keys; ticks measured from the press, from the hit run and the miss run)

| punch | cock s (key) | extend s (key) | recover s (key) | hold frac (key) | tell s = press to hit test | phase ticks measured, landed (cock/extend/recover) | phase ticks measured, missed (cock/extend/recover) | chain opens (ticks after press), landed | chain opens, missed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jab | 0.060 (jabCock) | 0.050 (jabExtend) | 0.100 (jabRecover) | 0.2 (jabHoldFrac) | 0.110 (6.6 ticks; hooks/uppercuts floored by tellMinHeavy 0.17) | 3/3/8 | 3/3/10 | 6 | 11 |
| cross | 0.150 (crossCock) | 0.050 (crossExtend) | 0.150 (crossRecover) | 0.35 (punchHoldFrac) | 0.200 (12.0 ticks; hooks/uppercuts floored by tellMinHeavy 0.17) | 8/3/14 | 8/3/19 | 11 | 21 |
| lead hook | 0.190 (hookCock) | 0.060 (hookExtend) | 0.160 (hookRecover) | 0.35 (punchHoldFrac) | 0.250 (15.0 ticks; hooks/uppercuts floored by tellMinHeavy 0.17) | 11/3/16 | 11/3/23 | 14 | 26 |
| rear uppercut | 0.240 (uppercutCock) | 0.060 (uppercutExtend) | 0.170 (uppercutRecover) | 0.35 (punchHoldFrac) | 0.252 (15.1 ticks; hooks/uppercuts floored by tellMinHeavy 0.17) | 11/3/11 | 14/3/28 | 14 | 31 |

Global: punchTimeScale 1, punchChainAt 0.5 (chain after a MISS, fraction of the stretched recover), punchChainOnHit 0 (after a land/block), comboCockScale 0.6 (wind-up of a chained punch), whiffRecoveryMult 2.2 (x per-type jabWhiffScale 0.55 etc.), punchBuffer 0.3 s, punchBufferDepth 2, feintCommit 0.6 (block in the first 0.6 of the wind-up cancels it), tellMinHeavy 0.17.

### A.3 A press during the previous punch (buffer): ticks from the press to the next punchStart. "x" = dropped (no start within 80 ticks)

First punch LANDS:

| first -> second | press tick: delay until the second punch starts | buffer keeps a press for (s) |
| --- | --- | --- |
| jab -> cross | 1:+6 3:+4 5:+2 7:+0 9:+0 11:+0 13:+0 15:+0 17:+0 19:+0 21:+0 23:+0 25:+0 27:+0 29:+0 31:+0 33:+0 35:+0 37:+0 39:+0 | 0.3 |
| cross -> lead hook | 1:+11 3:+9 5:+7 7:+5 9:+3 11:+1 13:+0 15:+0 17:+0 19:+0 21:+0 23:+0 25:+0 27:+0 29:+0 31:+0 33:+0 35:+0 37:+0 39:+0 | 0.3 |
| lead hook -> cross | 1:+14 3:+12 5:+10 7:+8 9:+6 11:+4 13:+2 15:+0 17:+0 19:+0 21:+0 23:+0 25:+0 27:+0 29:+0 31:+0 33:+0 35:+0 37:+0 39:+0 | 0.3 |
| jab -> jab | 2:+5 4:+3 6:+1 8:+0 10:+0 12:+0 14:+0 16:+0 18:+0 20:+0 22:+0 24:+0 26:+0 28:+0 30:+0 32:+0 34:+0 36:+0 38:+0 40:+0 | 0.3 |

First punch MISSES (stretched recovery):

| first -> second | press tick: delay until the second punch starts | buffer keeps a press for (s) |
| --- | --- | --- |
| jab -> cross | 1:+11 4:+8 7:+5 10:+2 13:+0 16:+0 19:+0 22:+0 25:+0 28:+0 31:+0 34:+0 37:+0 40:+0 | 0.3 |
| cross -> lead hook | 1:x 4:+18 7:+15 10:+12 13:+9 16:+6 19:+3 22:+0 25:+0 28:+0 31:+0 34:+0 37:+0 40:+0 | 0.3 |
| lead hook -> cross | 1:x 4:x 7:x 10:+17 13:+14 16:+11 19:+8 22:+5 25:+2 28:+0 31:+0 34:+0 37:+0 40:+0 | 0.3 |
| jab -> jab | 2:+10 5:+7 8:+4 11:+1 14:+0 17:+0 20:+0 23:+0 26:+0 29:+0 32:+0 35:+0 38:+0 | 0.3 |

### A.4 A press during hit-stop (cross lands, freeze granted; second press k ticks after the land tick)

| first -> second | k | freeze at land (s) | freeze left at press (s) | ticks press -> second punchStart | freeze left at start (s) |
| --- | --- | --- | --- | --- | --- |
| cross -> jab | 0 | 0.067 | 0.000 | 1 | 0.050 |
| cross -> jab | 1 | 0.067 | 0.067 | 0 | 0.050 |
| cross -> jab | 2 | 0.067 | 0.050 | 0 | 0.034 |
| cross -> jab | 4 | 0.067 | 0.017 | 0 | 0.000 |
| cross -> jab | 6 | 0.067 | 0.000 | 0 | 0.000 |
| lead hook -> cross | 0 | 0.096 | 0.000 | 1 | 0.079 |
| lead hook -> cross | 1 | 0.096 | 0.096 | 0 | 0.079 |
| lead hook -> cross | 2 | 0.096 | 0.079 | 0 | 0.063 |
| lead hook -> cross | 4 | 0.096 | 0.046 | 0 | 0.029 |
| lead hook -> cross | 6 | 0.096 | 0.013 | 0 | 0.000 |

## B. Frozen or slowed time (shipped config: ratings and styles on)

Mechanisms, found by grep for hitStop / freeze / slowMo / timeScale / hold in src/sim, src/main.ts, src/render, src/ui, src/ai. "In sim" = measured here by stepping the sim; "host" = src/main.ts and src/ui/read.ts, modelled here from reading them (hostRun() copies the loop arithmetic) and NOT measured in a browser.

| # | mechanism | where | trigger | duration / rate (config keys) | is input read while it runs? |
| --- | --- | --- | --- | --- | --- |
| 1 | Hit-stop on a land or block | sim: combat.ts:745-752, flow.ts addHitStop | every punchLand / punchBlock | clean: hitStopBase 0.06 s x power, capped hitStopMax 0.1; glancing hitStopGlancing 0.017; flush hitStopFlush 0.13; a jab x hitStopJabScale 0.5; a land inside a combination x comboHitStopScale 0.5; finisher comboFinisherHitStop 0.13; counter + vuln x counterHitStopBonus 0.05. Sim time runs at hitStopScale 0.05 (not zero) for the freeze, which counts down in REAL ticks | YES. step() reads both inputs every tick. A press starts a punch at once (A.4: +0 ticks) but the punch clock then runs at 5%, so it is drawn nearly still until the freeze ends; the AI is stepped in real ticks too |
| 2 | Hit-stop budget (cuts #1) | sim: flow.ts addHitStop / stepHitStopBudget | every request | bucket hitStopBudget 0.13 s refilling over hitStopBudgetWindow 1.6 s; floor hitStopMin 0.017; big moments (finisher, rock, knockdown) may overdraw by hitStopBigExtra 0.1; tier 2 (slip, counter) always in full | n/a (it only shortens the freeze) |
| 3 | Hit-stop on a slipped punch | sim: combat.ts:491 | a punch missed because of a slip (the "read") | slipDodgeHitStop 0.12 s, tier 2: always granted in full | YES, as #1 |
| 4 | Hit-stop on a perfect block | sim: combat.ts:739 | block raised within perfectBlockWindow of the impact | perfectBlockHitStop 0.05 s | YES, as #1 |
| 5 | Hit-stop on a rock / knockdown | sim: combat.ts:770 | a clean head shot that clears the stun threshold | stunHitStop 0.14 s (tier 1) | YES, as #1 |
| 6 | Counter slow motion | host: main.ts:442 | any 'counter' event, either side | readCounterSlowMo 0.3x for readCounterSlowMoSeconds 0.35 wall s; waits for #1 to finish (showSlowAfterStop true, main.ts:414) | the host feeds the sim 0.3 of a frame, so ticks (and so the input being applied) come 3.3x less often; the human stick is sampled once per wall frame |
| 7 | Rocked slow motion | host: main.ts:443 | any 'rocked' event | readRockedSlowMo 0.4x for 0.4 wall s | as #6 |
| 8 | Finisher slow motion | host: main.ts:444 | punchLand with finisher (3rd+ clean land of a combination, a power punch) | showFinisherSlowMo 0.45x for 0.3 wall s (showFinisherOn true) | as #6 |
| 9 | Knockdown slow motion | host: main.ts:446 | any 'knockdown' event | knockdownSlowMo 0.3x for knockdownSlowMoSeconds 1.2 wall s; replaces the others | as #6 (the man down cannot act; the other cannot punch him during the count) |
| 10 | Counter-window slow motion (the READ) | host: ui/read.ts:73 -> main.ts:415 | while a slip of the PLAYER (side 0) has the AI's counterWindow open | readWindowSlowMo 0.6x for as long as the window is open (slipPunishDuration 0.7 s of SIM time, so 1.17 wall s), min() with the others | as #6, and it is exactly when the player is meant to press the counter |
| 11 | Knockdown replay | host: main.ts:451-457 startReplay | after a knockdown, once the count reaches flowReplayAtCount (flow only) | flowReplaySeconds 1.5 s before + flowReplayAfterSeconds 0.5 s after, at flowReplaySpeed; the sim is HELD (main.ts:393 held=true) | NO: the sim does not step and held buttons are swallowed until released (main.ts:398-402) |
| 12 | Menus, cards, pause, pose grid | host: main.ts:392-393 | flow.holdsSim, posed fighters | while up | NO, same swallow rule |
| 13 | Intro / between rounds / count phases | sim: index.ts:81 | round.phase is not fighting | introSeconds 5, betweenRoundSeconds 5, the referee count | NO: step() replaces both inputs with NULL_INPUT outside the fighting phase (no buffering) |

Not a time freeze, but named "hold": flow.ts stepHold / applyKnock (THE HOLD) delays knockback during a combination; it never stops the clock.

### B.2 Measured: ms of each kind per 10 s, shipped config, medium AI (host model; fighting phases only)

"freeze" = frames where the sim has hitStop > 0 (picture near-still). "slow" = frames at less than real time from the host timers or the read window. Per 10 s of WALL time and per 10 s of SIM time. Seeds 1-3, one 3 x 30 s fight each (a KO ends it early; the scripted exchange runs 3 x 60 s); the bots drive side 0, the AI (monsoon, pressure, medium) side 1.

| scenario | wall s measured | sim s advanced | FREEZE ms / 10 s wall | SLOW ms / 10 s wall | normal ms / 10 s wall | game speed (sim s per wall s) | FREEZE ms / 10 s of sim | SLOW ms / 10 s of sim | wall s to play 10 s of sim | freeze episodes /10 s wall (mean, max ms) | slow episodes /10 s wall (mean, max ms) | counters / rocks / finishers / knockdowns | read-window frames |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| inside-fighter vs AI | 292.2 | 249.1 | 1141.7 | 678.1 | 8180.2 | 0.85 | 1339.3 | 795.4 | 11.7 | 25.9 (44.1, 283.3) | 2.1 (330.3, 933.3) | 15/17/32/9 | 294 |
| human-pace vs AI | 299.7 | 270.2 | 831.9 | 349.2 | 8819.0 | 0.90 | 922.9 | 387.4 | 11.1 | 19.5 (42.7, 233.3) | 1.3 (261.7, 416.7) | 4/1/27/0 | 113 |
| counter-puncher vs AI | 320.3 | 267.4 | 1096.4 | 1231.1 | 7672.5 | 0.83 | 1313.5 | 1474.9 | 12.0 | 19.4 (56.5, 316.7) | 2.7 (453.3, 1300.0) | 26/4/13/1 | 2794 |
| masher vs AI | 253.1 | 218.2 | 1036.5 | 637.5 | 8326.0 | 0.86 | 1202.4 | 739.5 | 11.6 | 22.7 (45.7, 183.3) | 1.9 (343.3, 416.7) | 19/17/32/6 | 0 |
| SCRIPT: side 0 slips every jab and lands the counter cross every 1.5 s | 354.3 | 180.0 | 2233.7 | 5716.1 | 2050.2 | 0.51 | 4396.6 | 11251.2 | 19.7 | 8.5 (263.8, 316.7) | 8.5 (675.2, 1266.7) | 150/0/0/0 | 16902 |

### B.3 One slip-and-counter on the wall clock (the scripted exchange above; frames of 16.7 ms; "sim ms" = how much fight time passed in that stretch)

| stretch | kind | rate | wall ms | sim ms | events inside |
| --- | --- | --- | --- | --- | --- |
| 1 | normal | 1.00x | 116.7 | 116.7 | punchStart1 slipFlick punchStart0 punchWhiff1 slipDodged |
| 2 | freeze | sim x0.05 (hit-stop) | 233.3 | 6.7 | - |
| 3 | slow | 0.60x | 300.0 | 183.3 | punchLand0 counter0 |
| 4 | freeze | sim x0.05 (hit-stop) | 300.0 | 9.2 | - |
| 5 | slow | 0.30x | 366.7 | 100.0 | - |
| 6 | slow | 0.60x | 683.3 | 416.7 | - |
| 7 | normal | 1.00x | 483.3 | 483.3 | punchStart1 slipFlick punchStart0 punchWhiff1 slipDodged |
| 8 | freeze | sim x0.05 (hit-stop) | 216.7 | 6.7 | - |
| 9 | slow | 0.60x | 316.7 | 183.3 | punchLand0 counter0 |
| 10 | freeze | sim x0.05 (hit-stop) | 300.0 | 9.2 | - |
| 11 | slow | 0.30x | 350.0 | 100.0 | - |
(The cycle begins at the AI's jab press; side 0 flicks the same tick. Stretches after the last row are normal speed until the next jab, 1.5 s of sim time per cycle.)

Hook: hostRun({ s, c, inputs }) in scripts/anim_measure.mjs. After the rebuild re-run to see the same table; if the host loop in main.ts changes, hostRun must be re-copied from it.

## C. Stamina (reference fighters, ratings and styles off; stamina_probe.mjs costs() is the measuring hook for 1-14)

| action | stamina cost, % of the tank | plus ceiling loss | config keys |
| --- | --- | --- | --- |
| jab thrown and LANDED | 0.10% | 0 | staminaPunchCost x staminaThrowScale 0.8 x staminaJab/Hook/UppercutWeight (0.5/1/1.15/1.3), minus staminaLandRefund 0.015 |
| jab thrown and MISSED | 4.10% | -0.30% | throw cost + staminaWhiffCost 0.05 x weight (staminaWhiffByWeight); whiffCapLoss 0.006 on the ceiling; regen paused staminaWhiffDelay |
| jab thrown and BLOCKED | 1.60% | 0 | throw cost (the attacker pays it whether or not it is blocked) |
| cross thrown and LANDED | 1.70% | 0 | staminaPunchCost x staminaThrowScale 0.8 x staminaJab/Hook/UppercutWeight (0.5/1/1.15/1.3), minus staminaLandRefund 0.015 |
| cross thrown and MISSED | 8.20% | -0.60% | throw cost + staminaWhiffCost 0.05 x weight (staminaWhiffByWeight); whiffCapLoss 0.006 on the ceiling; regen paused staminaWhiffDelay |
| cross thrown and BLOCKED | 3.20% | 0 | throw cost (the attacker pays it whether or not it is blocked) |
| hook thrown and LANDED | 2.18% | 0 | staminaPunchCost x staminaThrowScale 0.8 x staminaJab/Hook/UppercutWeight (0.5/1/1.15/1.3), minus staminaLandRefund 0.015 |
| hook thrown and MISSED | 9.43% | -0.69% | throw cost + staminaWhiffCost 0.05 x weight (staminaWhiffByWeight); whiffCapLoss 0.006 on the ceiling; regen paused staminaWhiffDelay |
| hook thrown and BLOCKED | 3.68% | 0 | throw cost (the attacker pays it whether or not it is blocked) |
| uppercut thrown and LANDED | 4.16% | 0 | staminaPunchCost x staminaThrowScale 0.8 x staminaJab/Hook/UppercutWeight (0.5/1/1.15/1.3), minus staminaLandRefund 0.015 |
| uppercut thrown and MISSED | 10.66% | -0.78% | throw cost + staminaWhiffCost 0.05 x weight (staminaWhiffByWeight); whiffCapLoss 0.006 on the ceiling; regen paused staminaWhiffDelay |
| uppercut thrown and BLOCKED | 4.16% | 0 | throw cost (the attacker pays it whether or not it is blocked) |
| body hook landed (level held) | 2.18% | 0 |  |
| overhand missed (level + stick forward) | 8.20% | -0.60% | throw cost + whiff |
| a feinted cross | 0.80% | 0 | staminaPunchCost x weight x (1 - feintRefund 0.75) |
| BLOCKING his jab (the shot itself) | 0.17% | 0 | impulse x staminaHitCost 0.00015 x staminaBlockedHitMult 1 x staminaBlockedLight 0.25 (a jab) / staminaBlockedHeavy 2 |
| TAKING his jab clean | 2.92% | 0 | impulse x staminaHitCost 0.00015 (body: x staminaBodyHitMult 1.2) |
| BLOCKING his cross (the shot itself) | 2.02% | 0 | impulse x staminaHitCost 0.00015 x staminaBlockedHitMult 1 x staminaBlockedLight 0.25 (a jab) / staminaBlockedHeavy 2 |
| TAKING his cross clean | 4.09% | 0 | impulse x staminaHitCost 0.00015 (body: x staminaBodyHitMult 1.2) |
| BLOCKING his hook (the shot itself) | 2.91% | 0 | impulse x staminaHitCost 0.00015 x staminaBlockedHitMult 1 x staminaBlockedLight 0.25 (a jab) / staminaBlockedHeavy 2 |
| TAKING his hook clean | 5.86% | 0 | impulse x staminaHitCost 0.00015 (body: x staminaBodyHitMult 1.2) |
| BLOCKING his uppercut (the shot itself) | 6.29% | 0 | impulse x staminaHitCost 0.00015 x staminaBlockedHitMult 1 x staminaBlockedLight 0.25 (a jab) / staminaBlockedHeavy 2 |
| TAKING his uppercut clean | 3.46% | 0 | impulse x staminaHitCost 0.00015 (body: x staminaBodyHitMult 1.2) |
| taking a body hook clean | 7.04% | -1.30% | impulse x staminaHitCost 0.00015 (body: x staminaBodyHitMult 1.2) |
| holding the guard up, per second | 0.80% | 0 | staminaBlockDrain 0.08 x staminaGuardHold 0.1 per second (regen also runs at staminaGuardRegen 0.4 - the probe has regen off) |
| walking, per second | 0.00% | 0 | none (no stamina cost for walking; moveTiredScale slows the feet when tired) |
| a slip | 0.00% | 0 | none in sim/slip.ts |
| a burst (double-tap) | 1.50% | 0 | burstStaminaCost 0.015 |
| a pivot (block + flick) | 1.58% | 0 | pivotStaminaCost 0.015 (+ guard hold) |

Regeneration: staminaRegen 0.35/s (35.0% of the tank per second) whenever NOT blocking and no punch in flight (or a punch that touched something is in its recovery, x staminaPunchRegen 0.35); behind a held guard x staminaGuardRegen 0.4; paused staminaRegenDelay 0.6 s after any hit (x staminaRegenDelayLight 0.25 after a jab; x staminaBlockedDelay 0.5 on a heavy shot on the guard; 0 for a light shot on the guard); paused after a miss by staminaWhiffDelay 0.9 x weight. Ceiling: staminaCap = max(staminaCapFloor 0.45, 1 - wear) where each miss adds whiffCapLoss; between rounds betweenRoundStaminaRestore 0.6. (sim/resources.ts stepStamina, combat.ts startPunch/missed, footing.ts)

Measured (fresh, 3 m apart): standing idle from 20% for 1 s regains 35.0%; behind a held guard from 20% for 1 s: 13.2% (net of the guard's own cost).

### C.2 Speed and power against stamina (a cross, ratings off, regen off)

| stamina | fatigue (0..1) | punchSlow (phase x) | gassed wind-up (x2.5 below lowStamina) | cross tell, press to hit test (s) | ticks to hit test | impulse N·s | power vs full tank | walk speed scale (moveTiredScale) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100.0% | 0.00 | 1.00 | no | 0.200 | 11 | 272.4 | 100.0% | 1.00 |
| 60.0% | 0.00 | 1.00 | no | 0.200 | 11 | 265.1 | 97.3% | 0.86 |
| 45.0% | 0.25 | 1.06 | no | 0.200 | 11 | 231.1 | 84.8% | 0.81 |
| 30.0% | 0.50 | 1.13 | no | 0.200 | 11 | 197.0 | 72.3% | 0.76 |
| 25.0% | 0.58 | 1.15 | no | 0.200 | 11 | 185.7 | 68.2% | 0.74 |
| 20.0% | 0.67 | 1.17 | yes, x2.5 | 0.425 | 25 | 174.3 | 64.0% | 0.72 |
| 10.0% | 0.83 | 1.21 | yes, x2.5 | 0.425 | 25 | 91.0 | 33.4% | 0.69 |
| 0.0% | 1.00 | 1.25 | yes, x2.5 | 0.425 | 25 | 81.7 | 30.0% | 0.65 |

At the floor (stamina 0): nothing locks out - a punch still starts (stamina is clamped at 0, combat.ts startPunch). The punch phases run 1.25x longer, the impulse loses tiredPowerLoss 0.5, a gassed wind-up (below lowStamina 0.25) runs lowStaminaCockMult 2.5x longer, the legs go (moveTiredScale 0.65 of walking speed), the guard droops, and the AI smells it (aiAggressionMult). The tank cannot refill past the ceiling (staminaCapFloor 0.45).

### C.3 Budget: 4-punch combinations (jab, cross, hook, cross) a press every 0.6 s, 1 s rest after each, while taking a clean cross every 2 s. Health damage off; pinned at range.

| scenario | punches thrown | clean shots taken | first tired (s) | first gassed <25% (s) | FLOOR (<=0.5%) at (s) | lowest tank | tank every 5 s (%) | ceiling at end |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all land, guard down in the rests | 112 | 45 | never | never | not in 90 s | 87.8% | 100.0 96.3 100.0 99.5 96.6 98.0 99.2 99.7 93.4 99.7 91.0 99.7 94.6 99.7 91.0 99.7 95.4 98.2 | 99.7% |
| all land, guard UP in the rests | 112 | 36 | never | never | not in 90 s | 87.8% | 100.0 96.3 100.0 99.5 100.0 98.0 99.2 99.7 93.4 99.7 91.0 99.7 94.6 99.7 91.0 99.7 93.6 98.2 | 99.7% |
| a quarter missed (out of range), guard down | 112 | 35 | 63.5 | never | not in 90 s | 53.0% | 100.0 96.3 100.0 82.7 94.4 69.0 95.6 95.6 71.5 93.4 78.6 91.2 86.1 72.3 80.5 84.9 78.1 85.6 | 84.7% |
| half missed, guard down | 112 | 25 | 31.4 | never | not in 90 s | 37.7% | 100.0 80.7 93.9 80.5 81.6 64.7 82.6 84.8 64.9 58.1 69.9 82.5 75.2 60.8 49.3 70.9 64.9 69.9 | 69.3% |
| faster: 0.4 s between punches, 0.5 s rest, all land | 170 | 43 | never | never | not in 90 s | 87.0% | 100.0 100.0 93.0 100.0 95.5 95.1 95.8 98.5 93.6 98.4 93.6 98.8 99.0 96.3 98.4 96.8 96.5 99.4 | 99.4% |
| no shots taken (the same, alone) | 112 | 1 | never | never | not in 90 s | 90.2% | 100.0 96.3 100.0 99.5 100.0 98.3 100.0 100.0 99.0 100.0 96.3 100.0 99.1 100.0 96.8 100.0 100.0 98.5 | 100.0% |
| HARD PACE: 0.25 s between punches, 0.4 s rest, all land | 265 | 45 | 16.4 | 38.3 | 43.1 | 0.0% | 100.0 69.8 69.9 61.8 57.2 54.7 47.0 33.4 22.2 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 | 99.1% |
| HARD PACE, all missed | 159 | 0 | 2.0 | 3.4 | 5.4 | 0.0% | 100.0 6.5 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 | 45.0% |
| HARD PACE, all missed, no shots taken | 159 | 0 | 2.0 | 3.4 | 5.4 | 0.0% | 100.0 6.5 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 0.0 | 45.0% |

## D. The AI by difficulty (shipped config; the fixed scripted attacker; 20 seeded fights per difficulty, the AI as each of the five styles in turn)

Difficulty table (src/ai/style.ts:320-327 DIFFICULTY, applied by withDifficulty; selected by cfg.aiDifficulty 0/1/2): easy {reaction x1.5, defence x0.5, counter x0.4, tempo x1.8, combo x0.5, mistake 0.35, offence 0.35, hesitate 0.65}; medium {reaction x1.2, defence x0.8, counter x0.7, tempo x1.35, combo x0.85, mistake 0.18, offence 0.7, hesitate 0.3}; hard {reaction x0.85, defence x1.15, counter x1.15, tempo x0.8, combo x1.2, mistake 0, offence 1.2, hesitate 0}. Base aiReactionTime 0.2 s, aiBlockChance 0.35, aiInsideBlock 0.8 (per-style values override: ai/style.ts STYLE_OVERRIDES).

Block decision in the AI (src/ai/index.ts:728-759): when the attacker starts a punch inside engageStraight, a timer of st.reaction starts; when it expires the AI rolls blockChance (insideBlock at close range, 1 against a rush) x (1 - mistake); on success the guard is held blockWindow 0.45 s, or it slips/rolls instead. Block coverage in the SIM (src/sim/combat.ts:373-392 guardCover, 620-622): a held block covers the punch fully only if it arrives within guardArcFullDeg 50 of the blocker's facing, fading to nothing by guardArcNoneDeg 85 (a hook arrives from the side); an uppercut x guardUppercutCover 0.6; a body shot x guardBodyCover 0.6; a worn guard (guardHp) x up to guardWornCover 0.7; with the guard shape on, a hand-pinned resting guard counts x guardPinnedCover 0.4; cover below guardThroughAt 0.5 = "through": a LAND on the held guard (the event's `through` flag) at the strength the guard left (blockReduction 0.75 x cover absorbed). Per-shape numbers (arc, headCover, bodyCover, uppercutCover, raise) are in src/core/styles.ts GUARDS and apply when stylesOn.

| difficulty | attacker punches | reached the AI (land+block) | BLOCK RATE of those | perfect-block share | LAND share | whiff / slipped / stuffed (share of thrown) | guard already up at the punch start | REACTION p10 / median / p90 / mean (ticks) [ms] | guard up before the hit test (of blocks) | COUNTER land rate (any punch) | counter attempt rate | counter land after a block | counter land after a land | AI punches / min | attacker punches / min |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| easy | 1553 | 1153 | 14.9% | 5.6% | 85.1% | 19.3% / 4.3% / 2.1% | 16.4% | 1 / 6 / 10 / 5.9 [100.0 ms median] | 95.9% | 17.0% | 37.5% | 2.9% | 15.7% | 48.9 | 48.7 |
| medium | 1475 | 1019 | 21.9% | 6.5% | 78.1% | 21.4% / 5.9% / 3.4% | 20.8% | 0 / 4 / 10 / 5.0 [66.7 ms median] | 93.3% | 25.2% | 47.5% | 5.4% | 27.8% | 85.3 | 45.6 |
| hard | 1228 | 772 | 24.4% | 7.3% | 75.6% | 26.7% / 6.2% / 3.5% | 20.5% | 2 / 5 / 11 / 6.7 [83.3 ms median] | 94.7% | 35.0% | 59.7% | 6.4% | 44.9% | 127.8 | 39.1 |

Reactive block, per difficulty:

- easy: of 172 blocked punches, 26.2% were the REACTIVE block (the AI's reaction timer fired: ai.blockTimer > 0 at the hit test), the rest a shell / cover / inside-hold guard that was up anyway. Reactive-timer fire, ticks after the attacker's punchStart, for blocked punches: p10 0 / median 6 / p90 11 (100.0 ms median). Configured reaction x difficulty: 0.300 s = 18.0 ticks (before per-style scaling). Punches that landed although the reaction had already fired: 4 of 981.
- medium: of 223 blocked punches, 30.0% were the REACTIVE block (the AI's reaction timer fired: ai.blockTimer > 0 at the hit test), the rest a shell / cover / inside-hold guard that was up anyway. Reactive-timer fire, ticks after the attacker's punchStart, for blocked punches: p10 1 / median 4 / p90 10 (66.7 ms median). Configured reaction x difficulty: 0.240 s = 14.4 ticks (before per-style scaling). Punches that landed although the reaction had already fired: 9 of 796.
- hard: of 188 blocked punches, 43.1% were the REACTIVE block (the AI's reaction timer fired: ai.blockTimer > 0 at the hit test), the rest a shell / cover / inside-hold guard that was up anyway. Reactive-timer fire, ticks after the attacker's punchStart, for blocked punches: p10 1 / median 7 / p90 11 (116.7 ms median). Configured reaction x difficulty: 0.170 s = 10.2 ticks (before per-style scaling). Punches that landed although the reaction had already fired: 13 of 584.

Definitions: attacker punch = a side-0 punchStart (feints dropped). Reached = it landed or was blocked (a whiff or a slipped punch never reached). Block rate = (punchBlock + perfectBlock) / reached. Reaction = ticks from the attacker's punchStart to the first tick the AI's `block` is true, for punches the AI blocked and whose guard was not already up at the start. "Guard already up" = block was true on the tick before the start. Counter land rate = share of the attacker's resolved punches after which an AI punchLand arrives between that punch's hit test and 18 ticks (0.3 s) after its recovery ends. Counter attempt = an AI punchStart in the same window.

### D.2 What gets through the guard, by punch type (the same attacker; of the punches that REACHED the AI: land / block / perfect)

| difficulty | punch type | thrown | reached | land % | of which `through` a held guard (came round or through) | land with the AI's guard DOWN at the hit test | block % | perfect % | whiff/slip/stuff % of thrown |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| easy | jab | 594 | 491 | 92.5% | 0.2% (18 flagged through) | 92.3% | 6.1% | 1.4% | 17.3% |
| easy | cross | 474 | 359 | 77.2% | 0.3% (66 flagged through) | 76.9% | 15.0% | 7.8% | 24.3% |
| easy | hook | 250 | 150 | 80.7% | 0.7% (16 flagged through) | 80.0% | 10.7% | 8.7% | 40.0% |
| easy | uppercut | 71 | 25 | 64.0% | 8.0% (9 flagged through) | 56.0% | 12.0% | 24.0% | 64.8% |
| easy | body cross | 89 | 78 | 97.4% | 0.0% (12 flagged through) | 97.4% | 1.3% | 1.3% | 12.4% |
| easy | body hook | 75 | 50 | 74.0% | 14.0% (14 flagged through) | 60.0% | 6.0% | 20.0% | 33.3% |
| easy | ALL | 1553 | 1153 | 85.1% | 1.0% (135 flagged through) | 84.0% | 9.3% | 5.6% | 25.8% |
| medium | jab | 585 | 468 | 84.4% | 0.2% (23 flagged through) | 84.2% | 12.6% | 3.0% | 19.8% |
| medium | cross | 445 | 309 | 70.2% | 1.3% (34 flagged through) | 68.9% | 20.1% | 9.7% | 30.3% |
| medium | hook | 233 | 117 | 65.0% | 0.9% (9 flagged through) | 64.1% | 23.1% | 12.0% | 49.4% |
| medium | uppercut | 57 | 21 | 81.0% | 42.9% (10 flagged through) | 38.1% | 14.3% | 4.8% | 61.4% |
| medium | body cross | 93 | 65 | 96.9% | 12.3% (18 flagged through) | 84.6% | 0.0% | 3.1% | 30.1% |
| medium | body hook | 62 | 39 | 71.8% | 15.4% (10 flagged through) | 56.4% | 15.4% | 12.8% | 37.1% |
| medium | ALL | 1475 | 1019 | 78.1% | 2.8% (104 flagged through) | 75.3% | 15.4% | 6.5% | 30.6% |
| hard | jab | 513 | 375 | 78.1% | 0.3% (22 flagged through) | 77.9% | 16.5% | 5.3% | 26.3% |
| hard | cross | 371 | 226 | 66.8% | 2.7% (27 flagged through) | 64.2% | 23.5% | 9.7% | 38.5% |
| hard | hook | 194 | 78 | 66.7% | 6.4% (16 flagged through) | 60.3% | 20.5% | 12.8% | 58.8% |
| hard | uppercut | 37 | 21 | 95.2% | 52.4% (11 flagged through) | 42.9% | 4.8% | 0.0% | 43.2% |
| hard | body cross | 72 | 46 | 93.5% | 21.7% (17 flagged through) | 71.7% | 0.0% | 6.5% | 33.3% |
| hard | body hook | 41 | 26 | 96.2% | 11.5% (9 flagged through) | 84.6% | 0.0% | 3.8% | 36.6% |
| hard | ALL | 1228 | 772 | 75.6% | 4.7% (102 flagged through) | 71.0% | 17.1% | 7.3% | 36.4% |
### D.2b By position in the attacker's combination (a punch starting within 30 ticks of the previous one is a follow-up)

| difficulty | position | thrown | reached | land % | block + perfect % | guard already up at the start | whiff/slip/stuff % of thrown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| easy | 1st or lone | 735 | 612 | 93.5% | 6.5% | 6.9% | 16.7% |
| easy | 2nd | 546 | 367 | 79.3% | 20.7% | 26.2% | 32.8% |
| easy | 3rd or later | 272 | 174 | 67.8% | 32.2% | 22.1% | 36.0% |
| medium | 1st or lone | 717 | 545 | 88.1% | 11.9% | 10.6% | 23.7% |
| medium | 2nd | 518 | 324 | 68.2% | 31.8% | 30.9% | 37.1% |
| medium | 3rd or later | 240 | 150 | 63.3% | 36.7% | 29.6% | 37.5% |
| hard | 1st or lone | 617 | 427 | 80.3% | 19.7% | 13.3% | 30.1% |
| hard | 2nd | 428 | 248 | 67.3% | 32.7% | 29.2% | 41.1% |
| hard | 3rd or later | 183 | 97 | 76.3% | 23.7% | 24.6% | 46.4% |


## D.3 Win / knockdown rates against the existing scripted bots (scripts/bot_table.mjs fight(): five bots x five styles, 6 fights per cell, 3 x 30 s, ratings and styles on)

| difficulty | bot | bot wins | bot wins by stoppage | AI wins | AI wins by stoppage | draws | bot knockdowns suffered / fight | AI knockdowns suffered / fight | landed by bot / by AI per fight | boxing s per fight |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| easy | jab-and-move | 93.3% | 0.0% | 6.7% | 0.0% | 0.0% | 0.00 | 0.00 | 56.6 / 22.1 | 95.6 |
| easy | inside-fighter | 53.3% | 3.3% | 46.7% | 0.0% | 0.0% | 0.33 | 0.60 | 107.0 / 76.2 | 97.2 |
| easy | counter-puncher | 70.0% | 0.0% | 30.0% | 0.0% | 0.0% | 0.00 | 0.07 | 53.5 / 44.0 | 97.2 |
| easy | turtle (not a plan) | 0.0% | 0.0% | 63.3% | 0.0% | 36.7% | 0.00 | 0.00 | 0.1 / 10.5 | 91.5 |
| easy | masher (not a plan) | 0.0% | 0.0% | 100.0% | 16.7% | 0.0% | 0.67 | 0.00 | 61.3 / 65.6 | 87.0 |
| easy | **legitimate plans (jab-and-move, inside-fighter, counter-puncher)** | 72.2% | 1.1% | 27.8% | 0.0% | 0.0% | 0.11 | 0.22 | 72.4 / 47.4 | 96.7 |
| medium | jab-and-move | 56.7% | 0.0% | 43.3% | 3.3% | 0.0% | 0.07 | 0.00 | 54.5 / 38.6 | 96.6 |
| medium | inside-fighter | 23.3% | 3.3% | 70.0% | 0.0% | 6.7% | 0.97 | 0.60 | 96.6 / 103.7 | 95.0 |
| medium | counter-puncher | 16.7% | 0.0% | 80.0% | 0.0% | 3.3% | 0.07 | 0.13 | 52.1 / 66.7 | 98.5 |
| medium | turtle (not a plan) | 0.0% | 0.0% | 76.7% | 3.3% | 23.3% | 0.17 | 0.00 | 0.0 / 19.0 | 92.1 |
| medium | masher (not a plan) | 0.0% | 0.0% | 100.0% | 30.0% | 0.0% | 1.90 | 0.00 | 47.5 / 86.1 | 80.7 |
| medium | **legitimate plans (jab-and-move, inside-fighter, counter-puncher)** | 32.2% | 1.1% | 64.4% | 1.1% | 3.3% | 0.37 | 0.24 | 67.7 / 69.6 | 96.7 |
| hard | jab-and-move | 36.7% | 0.0% | 60.0% | 0.0% | 3.3% | 0.10 | 0.00 | 54.5 / 53.8 | 97.7 |
| hard | inside-fighter | 23.3% | 0.0% | 70.0% | 6.7% | 6.7% | 1.20 | 0.80 | 90.8 / 122.6 | 90.5 |
| hard | counter-puncher | 10.0% | 3.3% | 90.0% | 0.0% | 0.0% | 0.73 | 0.17 | 43.5 / 85.9 | 96.3 |
| hard | turtle (not a plan) | 0.0% | 0.0% | 73.3% | 6.7% | 26.7% | 0.93 | 0.00 | 0.0 / 27.7 | 87.7 |
| hard | masher (not a plan) | 0.0% | 0.0% | 100.0% | 13.3% | 0.0% | 2.37 | 0.00 | 41.0 / 108.6 | 87.6 |
| hard | **legitimate plans (jab-and-move, inside-fighter, counter-puncher)** | 23.3% | 1.1% | 73.3% | 2.2% | 3.3% | 0.68 | 0.32 | 62.9 / 87.4 | 94.8 |

## E. Counters

Definition: a counter is a punchLand whose target has `counterWindow > 0` AND `punishSource === PUNISH_SLIP` AND `vuln > 0` (src/sim/combat.ts:593). The window is opened only by a successful SLIP of a punch that missed because of the slip (combat.ts:500, applyPunish(attacker, slipPunishVuln, slipPunishDuration, PUNISH_SLIP)). A perfect block opens an exposure window too (combat.ts:738) but a landing in it is NOT a counter (exposedImpulseBonus applies instead).
Multipliers on a counter: impulse x (1 + vuln x counterImpulseBonus) = 1 + 1 x 0.9 (combat.ts:598); a non-counter exposure uses exposedImpulseBonus 0.45; hit-stop + vuln x counterHitStopBonus 0.05 s, tier 2 = always granted in full (combat.ts:749-752); the stun flash threshold x counterFlashScale 0.95 when counterFlashOn true (stun.ts:103). Window: slipPunishDuration 0.7 s, slipPunishVuln 1. The slipped punch also gives hit-stop slipDodgeHitStop 0.12 s (combat.ts:491) and the attacker lunges slipOverreach 0.18 m. Host side (not in the sim): main.ts:442 slow motion readCounterSlowMo 0.3x for readCounterSlowMoSeconds 0.35 wall s; ui/read.ts:73 readWindowSlowMo 0.6x for the whole open window when the PLAYER slipped.

Trial found by search: side 0 jabs at tick 0; side 1 flicks at tick 0 (slip dodged at tick 6), crosses at tick 6; distance at the counter's press 0.781 m.

| case | grade | impulse N·s | x normal | health lost | x normal | hit-stop at land (s) | rocked? | knockdown? | target vuln at land |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| normal cross (target idle) | clean | 272.4 | 1.00 | 0.027 | 1.00 | 0.067 | no | no | 0.00 |
| COUNTER cross (after a slip) | flush | 594.7 | 2.18 | 0.059 | 2.18 | 0.180 | no | no | 1.00 |

Predicted impulse ratio (1 + vuln x counterImpulseBonus) x flush 1.15 if flush vs measured 2.18. Counter-window left at the land: 0.510 s.

Other counters (same slip, different counter punch):

| counter punch | landed as | grade | impulse | x normal | health lost | hit-stop (s) | rocked? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jab | counter | clean | 154.0 | 0.79 | 0.015 | 0.069 | no |
| jab | normal | clean | 194.7 | 1.00 | 0.019 | 0.024 | no |
| hook | counter | flush | 853.9 | 2.18 | 0.085 | 0.180 | no |
| hook | normal | clean | 390.9 | 1.00 | 0.039 | 0.096 | no |

## F. Hit-reaction magnitudes (fresh, planted defender; ratings and styles off; clean landed punch)

Hook: reactTrial(cfg, punch, stick, level, dist) in scripts/anim_measure.mjs. Head = headBox centre against an idle twin run (same ticks, no punch). Neck = angle between the head-to-shoulder (bodyBox.b) vectors of the two runs. Trunk = angle between the hips-to-shoulders (bodyBox a->b) axes. Tilt/torso/spin/sink = the reaction springs (state.fighters[1].reaction). Feet = floor position (pos) shift against the idle twin; the sim has no discrete foot-step state, the rig derives steps from pos/stagger. "Back within 10%" = last tick the head is still more than 10% of its peak away, counted from the punch press (and in sim seconds from the land, which includes the hit-stop slowdown).

| punch | part / zone | grade | impulse N·s | head peak vs idle twin, whole man incl. shove (m) | x head radius | HEAD vs FEET peak, the bend (m) | x head radius | peak at (ticks after land) | neck peak (deg) | trunk bend peak (deg) | tilt spring peak (deg) | torso spring peak (m) | yaw spin peak (deg) | sink peak (m) | feet shift peak / end (m) | head-vs-feet back within 10% (ticks after land / sim s) | neck back within 10% (ticks after land) | freeze at land (s) | rocked/hurt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jab | head / chin | clean | 194.7 | 0.273 | 1.82 | 0.145 | 0.96 | 5 | 25.6 | 0.6 | 0.6 | 0.015 | 0.0 | 0.032 | 0.257 / 0.257 | 30 / 0.47 | 30 | 0.024 | no |
| cross | head / nose | clean | 272.4 | 0.488 | 3.25 | 0.305 | 2.03 | 9 | 30.5 | 5.7 | 6.7 | 0.145 | 0.0 | 0.046 | 0.361 / 0.361 | 28 / 0.39 | 40 | 0.067 | no |
| lead hook | head / jaw | clean | 390.9 | 0.600 | 4.00 | 0.324 | 2.16 | 10 | 37.4 | 4.3 | 13.1 | 0.111 | 37.6 | 0.067 | 0.518 / 0.518 | 30 / 0.41 | 41 | 0.096 | no |
| rear hook | head / jaw | clean | 390.9 | 0.600 | 4.00 | 0.324 | 2.16 | 10 | 37.4 | 4.3 | 13.1 | 0.111 | 37.6 | 0.067 | 0.518 / 0.518 | 30 / 0.41 | 41 | 0.096 | no |
| uppercut (rear) | head / chin | glancing | 230.7 | 0.204 | 1.36 | 0.110 | 0.74 | 7 | 10.3 | 1.1 | 1.9 | 0.038 | 0.0 | 0.027 | 0.183 / 0.183 | 135 / 2.22 | 30 | 0.017 | no |
| body cross | body / solar | clean | 258.7 | 0.467 | 3.11 | 0.293 | 1.96 | 8 | 30.5 | 5.2 | 6.9 | 0.133 | 0.0 | 0.044 | 0.342 / 0.342 | 27 / 0.39 | 39 | 0.064 | no |
| body hook (lead) | body / liver | clean | 390.9 | 0.625 | 4.17 | 0.351 | 2.34 | 10 | 39.4 | 4.9 | 13.4 | 0.124 | 33.5 | 0.067 | 0.518 / 0.518 | 30 / 0.40 | 42 | 0.096 | no |
| body jab | body / solar | clean | 165.5 | 0.231 | 1.54 | 0.114 | 0.76 | 5 | 20.7 | 0.5 | 0.5 | 0.011 | 0.0 | 0.028 | 0.218 / 0.218 | 30 / 0.47 | 30 | 0.020 | no |

Reference: head radius 0.150 m. Reaction magnitudes are set by config keys *React* (jabReactBack/Lift/Twist/Torso/Snap/Spin, crossReact*, hookReact*, uppercutReact*), reactionSpring* / reactionHipFollow, gradeReact*, gradeNeck*; see src/sim/reaction.ts applyReaction.
<!-- END GENERATED -->
