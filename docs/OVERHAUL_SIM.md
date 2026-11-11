# Overhaul — SIM workstream log

Part A of the brief, sim side (`docs/OVERHAUL.md` step 3). Written 2026-11-11.
What landed, the decisions made without asking (with reasons), every interface
change, the bot table, and what is not done or below standard. Numbers per
moment are in `docs/FEEL.md` → "Overhaul feel specs".

Nothing here has been felt by a person. Everything is measured, tested in
Node, and behind a toggle.

## What landed

| # | System | Where | Toggle(s) | Test |
| --- | --- | --- | --- | --- |
| 1 | Flat-footed, burst, pivot, ropes / corners, the angle | `sim/footing.ts`, `movement.ts`, `slip.ts` | `flatFootedOn` `burstOn` `pivotOn` `ropesOn` `anglesOn` | `footing_test` |
| 2 | The level, inside posture, 15 punch variants, feet per variant, aim, tells, feint | `sim/variants.ts`, `footing.ts`, `combat.ts`, `gloves.ts` | `levelOn` `postureOn` `variantsOn` `punchRootOn` `tellsOn` `feintOn` | `level_test` |
| 2 | Push-off, clinch | `sim/clinch.ts` | `pushOffOn` `clinchOn` | `level_test` |
| 3 | Hit grades, combination build | `sim/grade.ts`, `combat.ts` | `gradesOn` `comboBuildOn` | `grade_test` |
| 4 | Block stun, guard meter + break, chip, the guard's shape, the perfect block's hanging arm | `combat.ts`, `footing.ts`, `gloves.ts` | `blockStunOn` `guardWearOn` `chipOn` `guardShapeOn` | `guard_test` |
| 5 | Loaded counter, chained slips, the roll, the wrong way | `sim/slip.ts`, `combat.ts` | `slipLoadedOn` `slipChainOn` `rollOn` `wrongWayOn` | `slipx_test` |
| 6 | Winded (body hurt), liver fuse, counter flash, surviving, the get-up as a process | `sim/stun.ts`, `resources.ts` | `bodyHurtOn` `liverOn` `counterFlashOn` `hurtSurvivalOn` `getUpOn` | `danger_test` |
| 7 | Head / body damage ledgers, body wear (stamina ceiling, feet, guard) | `resources.ts`, `footing.ts` | `bodyDamageOn` | `attrition_test` |
| 8 | Fatigue numbers, whiff cost > land cost, work-rate wear | `footing.ts`, `combat.ts` | `fatigueOn` `whiffCostOn` | `attrition_test` |
| 9 | AI from a `StyleParams`; the tools | `src/ai/style.ts`, `index.ts` | `aiToolsOn` | `ai_tools_test` (`dummy_ai_test` pins the old heuristics with it off) |
| 10 | Bots + table | `scripts/bots/*`, `scripts/bot_table.mjs` | — | `ai_tools_test` §4 |
| 11 | Feel specs | `docs/FEEL.md` | — | `node scripts/_debug.mjs specs` |
| — | Determinism over all of it | — | — | `determinism_test` §3b |

All 32 toggles default on. With every toggle off the sim is the pre-overhaul
one except for four numbers that are keys, not toggles: `jabHealthFloor`
(0 = off), `punchAimTrack` (0 = off; it does nothing for the two reference
fighters anyway), and the retuned `stunFinishFrac` / `stunFlashFrac`.
`node scripts/_debug.mjs grades off` prints the pre-overhaul outcome grid.

## Inputs — the control scheme is extended by combinations, never replaced

Stick, the four-punch diamond, held block, flick-to-slip are unchanged. `level`
is the one new input. A FLICK is still a stick push released inside
`slipFlickMax` (0.18 s); what it does depends on what else is held:

| Input | Move | Notes |
| --- | --- | --- |
| lateral flick | slip (unchanged) | also LOADS the hand on that side for 0.9 s |
| back flick | pull (unchanged) | loads the rear hand |
| forward flick | nothing | arms the double-tap |
| flick, then push the same way again within 0.25 s, held 2 ticks with no punch press | **BURST** — a hop that way | forward / back / sideways. A punch pressed with that second push claims the stick instead (hand selection) |
| **level** + lateral flick | **ROLL** | head down and across in a U; holds its own level through the U; comes up into the rise window |
| **block** + lateral flick | **PIVOT** off the planted lead foot, toward the flicked side | an opponent within 1.1 m turns at 12% for 0.45 s |
| **block** + forward flick | **PUSH-OFF** | shoves a man within 0.8 m; smothers an uncommitted wind-up; breaks a clinch |
| **block + level** held ≥ 0.2 s within 0.75 m | **CLINCH** | referee breaks it at 1.4 s; 4 s cooldown for the one who grabbed |
| **block** pressed during a wind-up, before 60% of it | **FEINT** | the punch rewinds, 75% of its stamina back |
| lateral flick the other way while slipped | **CHAINED SLIP** | up to 3 deep; the last can be a roll |

Punch buttons (priority left to right; `level` = held and the body is down):

| Button | level held | just came up (0.3 s) | stick back | inside range (< 0.68 m) | otherwise |
| --- | --- | --- | --- | --- | --- |
| jab | bodyJab | — | retreatJab | — | stepJab (stick forward) / jab |
| cross | overhand (stick forward) / bodyCross | — | — | — | cross |
| hook | bodyHook | risingHook | checkHook | shovelHook | hook |
| uppercut | risingUppercut | risingUppercut | — | insideUppercut | uppercut |

## Interface changes (for CONTRACT §13 and the rig / audio / camera reads)

### New types (`core/types.ts`, sim region)
`PunchVariant` (15 names above) · `HitGrade` ('glancing' | 'clean' | 'flush') ·
`RangeBand` ('outside' | 'mid' | 'inside') · `HurtKind` ('none' | 'head' |
'body') · `GetUpPhase` ('none' | 'down' | 'stir' | 'knee' | 'slump' | 'rise') ·
`SlipKind` ('slip' | 'pull' | 'roll').

### `PunchState` — new fields
- `variant` — what was actually thrown.
- `tell` — seconds from press to hit test for this punch as thrown.
- `timeMult` — fatigue slow-down on every phase (1 = fresh).
- `powerMult` — the variant's weight × a loaded counter's bonus.
- `moveScale` — walking speed while it is in flight.
- `loaded` — thrown with the hand a slip had loaded.
- `aim` — metres below its lane it is aimed (body shots; overhand and uppercuts aim at where the head was at the press).
- `feint` — cancelled, rewinding home.

### `SlipState` — new fields
`kind` · `from` (offset the move started from) · `chain` (1 = single) · `dip` (m the head is down from this move: slip dip or the roll's U).

### `FighterState` — new fields (one line each; all plain data, all cloned)
- `level` 0..1 — how far the level modifier has the body down (× `levelDrop` 0.26 m; head, body capsule and hands ride it).
- `riseT` — seconds left in which a hook / uppercut counts as thrown coming up.
- `range` — outside / mid / inside by distance.
- `posture` 0..1 — inside posture, eased (× `insideCrouch` 0.05 m of real height). Draw: knees bent, head low, elbows in.
- `stillT` — seconds stood still.
- `flat` 0..1 — flat-footed. **1 − flat is the bounce to draw.**
- `ropes` 0..1 — ropes close BEHIND him. `cornered` — two walls.
- `angle` — radians the opponent stands off this fighter's facing line.
- `turned` — seconds of slow turning left after being pivoted on.
- `hop` — the burst's velocity channel. `burstT` — seconds since the burst began (hop + landing; 0 = none). `burstCd`.
- `pivot { t, dir, left, cx, cz }` — a pivot in progress and the planted lead-foot point (world) it turns about.
- `tap { dir, t }` — the last flick, for the double-tap (sim-private in spirit).
- `guardHp` 0..1 — the guard meter. `guardBroken` — seconds the hands cannot come up. `guardRest` — seconds since the guard was hit.
- `blockStun` — seconds of block stun left.
- `guardDroop` — metres the resting hands hang below the fresh guard (fatigue + body wear + winded). The sim's gloves are already there.
- `fatigue` 0..1 · `punchSlow` (≥ 1) · `staminaCap` · `wear` (work-rate part of the ceiling loss).
- `damage { head, body, liver }` — the fight-long ledgers, in health fractions.
- `hurtKind` — what `hurt > 0` is: head = rocked (legs), body = winded (folded, hands down).
- `buckle` 0..1 — the body folding (× `buckleDrop` 0.12 m of real height).
- `liverT` / `liverMag` — the liver fuse.
- `clinch { active, reach, t, by, cd }`.
- `pushCd`.
- `getUp { phase, t, tries, owed }` — the struggle while down; `owed` = the first try will fail.
- `loaded` (−1 lead / +1 rear / 0) and `loadedT` — which hand a slip loaded.
- `combo`, `comboT` — the live combination count and its clock.

### Events — changed
- `punchStart` + `variant`, `tell`.
- `punchLand` + `variant`, `grade`, `combo` (which punch of a clean combination), `liver`, `through` (came round / through a guard), `wrongWay` (target slipped into it).
- `punchBlock` + `variant`, `part`, `chip` (health let through), `guard` (meter after), `stun` (s).
- `perfectBlock`, `punchWhiff` + `variant`.
- `slip` + `kind`, `chain`.
- `knockdown.cause` + `'body'`.

### Events — new
`feint {side, punch, variant}` · `burst {side, x, y}` (fighter frame) ·
`pivot {side, dir}` · `escape {side, how: pivot|slip|roll}` (got off the
ropes) · `pushOff {side, target, hit}` · `clinch {side, target}` ·
`clinchBreak {side, reason: referee|pushOff|denied}` · `guardBreak {side, by,
seconds}` · `liverShot {side, by, delay}` · `bodyHurt {side, by, liver,
seconds}` · `getUpPhase {side, phase, tries}`.

### Sim exports added (`src/sim/index.ts`)
`VARIANTS`, `VARIANT_NAMES`, `pickVariant`, `stanceDrop`, `rangeBand`,
`bodyWear`, `angleExposure`, `bodyThreshold`, `punchReach`, `gradeProbe`
(last grade's parts, for probes), `getUpPhaseAt` (the get-up timeline as a
pure function — the rig can use it to pre-plan the fall).

### AI (`src/ai`)
`createAi(side, seed, cfg, style = null)`; `StyleParams` and
`defaultStyle(cfg)` in `src/ai/style.ts`. `AiState` gained `rngT` (the tools'
own stream), `style`, `macro`, `used` (tool-use counters), and bookkeeping.
`style: null` = the default style rebuilt from the live `ai…` config keys
every tick, so the tuning panel still drives it.

### Config
Groups added after `ai`: `footing`, `level`, `grade`, `guard`, `slipx`,
`danger`, `bodywork`, `fatigue`; keys added to `ai` (`aiToolsOn` …). Two
existing keys retuned: `stunFinishFrac` 0.5 → 0.65, `stunFlashFrac` 1.6 →
1.85 (reasons in their `desc`).

### What a viewer should be able to see, and where it is
level / crouch → `level`, `stanceDrop()` · posture → `range`, `posture` ·
guard wear → `guardHp`, `guardBroken`, `guardBreak` · guard droop →
`guardDroop` · flat-footed → `flat` · on the ropes → `ropes`, `cornered` ·
damage → `damage.head/body/liver` · hurt kind → `hurtKind`, `buckle` ·
clinch → `clinch` · get-up → `getUp`, `getUpPhase` · variant → `punch.variant`,
`punchStart/Land.variant` · grade → `punchLand.grade` · loaded side →
`loaded`, `punch.loaded` · pivot foot → `pivot.cx/cz` · burst → `burstT`, `burst`.

## Decisions made without asking

1. **The flick is a family.** One gesture, three modifiers (none → slip,
   level → roll, block → pivot / push-off). Reason: nothing new to learn with
   the thumb, and block + flick was dead input before.
2. **Burst = double-tap, confirmed for 2 ticks.** A "sharp push from neutral"
   would make every keyboard step a hop. The confirm exists because "slip
   left, lead hook" (stick left again + the button) was being read as a hop.
3. **Overhand = level + cross + stick forward; body cross = level + cross.**
   The brief gave both to level + cross; the stick breaks the tie (you step
   into an overhand).
4. **Rising hook / uppercut = within 0.3 s of letting the level go** (or a
   roll finishing). Level HELD is the body.
5. **Aim.** Straights and hooks keep a fixed lane (so ducking works).
   Overhands and uppercuts are thrown at where the head IS at the press
   (measured: an inside uppercut rose in front of a crouched man's face and
   whiffed on the one target it exists for). Ducking after the press still
   gets under them.
6. **Lanes track the opponent's standing height only beyond 8 cm**
   (`punchAimDeadband`). Full tracking moved the two reference fighters'
   jab 5.5 cm and broke the pinned slip-into-the-hand body shot and the
   southpaw jab. With the new roster's height spread the dead band matters:
   see "below standard" 4.
7. **A resting guard pinned on the face is no longer a block**
   (`guardPinnedCover` 0.4 → a land through the hands at 70%). Measured: the
   second punch of a 1-1 and the 3 of a 1-2-3 were "blocked" by a guard
   nobody held, so combinations could not build. Changes one `punch_test`
   assertion.
8. **A jab cannot empty the bar** (`jabHealthFloor`). The jab-and-move bot
   was scoring 4.6 knockdowns a fight with the jab alone. Stick-and-move now
   wins on points.
9. **Finish and flash bars rescaled** (0.65 T, 1.85 T): lands on an exposed
   man now carry flush × 1.15, and combinations land, so at the old numbers
   the next punch of any combination finished a rocked man.
10. **A man who slips INTO a punch is never graded glancing.** Otherwise the
    wrong-way shot (which clips the shoulder) hurt less than standing still.
11. **The liver is the hand's side, not the contact point.** In this sim a
    hook finishes across the front of the body, past the centre line.
12. **The get-up's timing is still the chin roll.** The struggle (stir, knee,
    slump, rise) is laid inside it and whether the first try fails is one
    extra seeded roll, made after the count roll so first-knockdown timings
    are unchanged.
13. **The AI's tools draw from a second rng stream** so the legacy heuristics
    replay as they did; `dummy_ai_test` pins them with `aiToolsOn` off.
14. **The AI never flicks by accident**: it tracks its own stick the way the
    sim does, will not complete a double-tap, and keeps the stick under the
    push threshold behind its guard. Flicks are macros.
15. **Clinch needs `levelOn`** (its input is block + level).

## Existing assertions changed, and why

| Test | Change | Why |
| --- | --- | --- |
| `counter_test` | whiff-stretch section runs with variants off and grade hit-stops 0 | at CLOSE a hook / uppercut is now the faster inside variant; a smothered jab is glancing with its own hit-stop |
| `counter_test` | "ordinary block still takes chip health" → a blocked jab takes none, a blocked cross does | chip is for heavy shots |
| `counter_test` | slip-counter impulse ratio and hit-stop | the counter is flush: × `gradeFlushPower`, flush hit-stop tier |
| `counter_test`, `slip_test`, `health_test`, `fight_test` | config `jabHealthFloor: 0` | they use a jab as the knockdown blow; `attrition_test` pins the floor |
| `health_test` | regen-in-flight sampled before the resolve; + miss / land stamina checks | a miss now costs extra and a land refunds |
| `health_test` | blocked-hit health uses a cross; + blocked jab = 0 | chip |
| `movement_test` | gassed top speed measured over 2.5 s | gassed = flat-footed push-off |
| `fight_test` | "equal lands, power decides": side 1 steps back in before its cross | the jab knocks it to the end of its reach, where the cross is glancing |
| `punch_test` | step-in jab from 1.10 m (was 1.15) | from 1.15 it arrives on the end of the arm: glancing |
| `punch_test` | close hook / uppercut are the shovel hook / inside uppercut; base ordering checked with variants off | variants |
| `punch_test` | close cross: a land through the hands, not a block | decision 7 |
| `timing_test` | backing-off cross leans < 0.9× (was 0.85×) | a cross plants the feet |
| `stun_test` | the under-the-finish-bar cross uses mult 0.17 (was 0.2) | flush on a rocked man |
| `dummy_ai_test` | `aiToolsOn: false` in its base config | it pins the pre-overhaul heuristics |

No assertion was deleted.

## Bots versus the AI

`node scripts/bot_table.mjs 20` — bot = side 0 (red), AI = side 1 (blue),
default config, 3 × 30 s, 20 seeded fights each:

| Bot | Legit plan | W | L | D | KO-W | KO-L | Lands / fight | Taken / fight | Land % | Knockdowns for–against | Avg s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jab-and-move | yes | 20 | 0 | 0 | 0 | 0 | 94.0 | 11.4 | 58% | 0 – 2 | 110 |
| inside-fighter | yes | 18 | 2 | 0 | 17 | 2 | 20.1 | 7.5 | 42% | 57 – 7 | 32 |
| counter-puncher | yes | 18 | 2 | 0 | 9 | 1 | 31.4 | 17.2 | 37% | 76 – 11 | 85 |
| turtle | no | 0 | 20 | 0 | 0 | 7 | 0.0 | 31.9 | 0% | 0 – 81 | 93 |
| masher | no | 6 | 14 | 0 | 5 | 14 | 31.1 | 26.1 | 29% | 27 – 59 | 58 |

AI tool use over those 100 fights: body 711 · slip 39 · roll 12 · pivot 285 ·
push 215 · burst 394 · feint 169 · clinch 137 · cut-off ticks 46 433.

The target as stated is met: every legitimate plan wins, the masher and the
turtle lose. It is not a balanced table — see "below standard" 1 and 2.

## Not done / below standard

1. **The default AI is too easy for a competent plan.** Legit bots win
   90–100%. The inside fighter stops it in ~32 s (57 knockdowns in 20 fights:
   29 finishes, 17 on health); the jab-and-move bot lands 94 jabs a fight and
   takes 11. The AI does not defend the inside fight (it trades or stands in
   the pocket) and cannot cut off a mover. Knobs, in the order I would turn
   them: per-style `blockChance` / `crowdClinch` / `pushOffRate` up for
   styles that hate the inside; `aiSlipShare` (it slips 39 times in 100
   fights — too few); a proper cut-off (it mirrors sideways movement, it
   does not take away the ring); then `healthDamagePerImpulse` if stoppages
   are still this quick against a real person. This is the style / difficulty
   pass (OVERHAUL.md step 6), not done here.
2. **The masher still wins 30%.** Its wins are early trades (flash and
   finish knockdowns while it is fresh). `tiredPowerLoss` 0.5 and
   `staminaWhiffCost` 0.05 make it harmless after ~3 s, but the AI does not
   punish the first seconds. Knob: `aiCounterChance` up, or the AI's opening
   posture (guard up at the bell against a rush).
3. **"Inside is earned" is not a rule.** Nothing stops a fighter walking
   inside; getting there behind a jab or off a slip is only safer (block
   stun, the loaded hand). No mechanic enforces it.
4. **Height.** Lanes track the opponent's standing height only beyond 8 cm.
   Against a much taller or shorter man the first 8 cm is uncorrected, and
   "ducked" is relative to the thrower's lane: at 0.26 m a red jab on a
   ducked blue (5.5 cm taller) still lands clean, on a ducked red it is
   glancing. With a roster of eight heights the slip / punch margins should
   be re-measured and the dead band taken to 0.
5. **In open ring the third punch of a combination usually whiffs**: the
   first two knock a free target out of the hook's reach (measured, 0.74 m).
   Combinations build on the ropes or when stepped in behind. A drift-in
   between punches (a small auto step on a chained punch) would fix it; not
   built — it is a feel decision.
6. **The get-up's slump rarely plays at the default numbers**: it needs
   ~0.4 s of room before the rise, which only the longer counts (≥ ~5.5)
   have. `getUpSlumpSeconds` down or `getUpRiseSeconds` down makes it
   commoner.
7. **The clinch is minimal.** No inside work in the clinch, no referee
   warning for holding, both fighters simply freeze (a punch in flight is
   dropped with a pose pop) and are sent apart by a hop. The referee figure
   (UI) knows nothing about it.
8. **Guard shapes**: there is one guard (high). `StyleParams.guard` is a
   placeholder; the pass-through rules read the shape through three numbers
   (`guardArc…`, `guardUppercutCover`, `guardBodyCover`), not per-fighter.
9. **Ratings.** `power`, `speed`, `stamina`, `defense` are still unread
   (chin only). Not in this workstream's list; the hooks are obvious
   (`powerMult`, `timeMult`, `staminaCap`, `guardHp` rates).
10. **Nothing is drawn or heard.** See FEEL.md "Open". In particular a winded
    fighter draws the rocked wobble, a pivot / burst / clinch has no
    animation beyond what the feet solver does with the positions, and the
    level drop moves the boxes without any authored crouch.
11. **Flush frozen-frame displacement was not probed** (the spec table says
    so). The flush rows are from `grade_test` / `counter_test`, not the probe.
12. **Tests the SIM workstream does not own**: `input_check` fails 50/51 —
    "diamond + block buttons exist" expects 5 `.touch-btn` elements and there
    are 6 since the LOW touch button (UI, core commit d025eb8). Not a sim
    change; I did not run it at the baseline commit, so "it failed before" is
    inferred from the assertion, not observed. The browser checks also time
    out at boot (15 s) when the runner starts a cold dev server on this
    machine while other work is running; against a warm server, one at a
    time, `verify`, `read`, `stun`, `referee`, `flow` and `arena` pass.
    `referee_check` floors its dummy with one jab at
    `healthDamagePerImpulse 1`; the jab floor does not bind for a jab worth a
    whole bar, so it passes.
13. **`run_tests.mjs` prints "Not a test by convention: bot_table.mjs"** — a
    warning only; that file is the runner's (TEST) to list.
