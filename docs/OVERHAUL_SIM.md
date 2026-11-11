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

---

# Phase 2 — ratings, styles, difficulty, drills (2026-11-11)

Items 1, 2, 3, 8, 9 and 11 of the list above are superseded by this section.

## What landed

- **Ratings** (`sim/ratings.ts`, `ratings_test`): power, speed, stamina and
  defense are read for both fighters (chin already was). One curve:
  `rated(f, which, span, cfg) = 1 + span × clamp((rating − ratingNeutral) / ratingRange, ±1)`.
  Toggle `ratingsOn`. Spans are the `rating…` config keys.
- **Styles as data** (`core/styles.ts`): `GUARDS: Record<GuardShape, GuardDef>`
  and `STYLES: Record<AiStyle, FighterStyle>`. Five guard shapes are real in
  the sim (hand rest / block poses, cover arc, head / body / uppercut cover,
  wear, block stun, raise time, jab time and reach, crouch, exposure, foot
  speed, slip). Applied by `spec.style` at `createState`; on the state as
  `FighterState.styleId` and `FighterState.guardShape`. Toggle `stylesOn`.
- **AI per style** (`ai/style.ts`): a full `StyleParams` per style
  (`styleParams(id, cfg, difficulty)`), signature combinations, ring use,
  inside defence, the shove under fire, the reply off the guard, the stiff
  jab on a man walking in, rush detection (by his misses), stamina
  discipline, tells, hurt and tired plans.
- **Difficulty** as data: `DIFFICULTY` (easy / medium / hard), config key
  `aiDifficulty` (0 / 1 / 2, default 1).
- **Drills** (`ai/drills.ts`, `drills_test`): seven, in order — jab-and-move,
  cut-off, get-inside, slip-timing, slip-counter, body-work, survive.
- **Bot × style matrix** (`scripts/bot_table.mjs N [easy|medium|hard] [detail]`).
- **Loose ends**: inside is earned (`jabStopOn`: a landed jab stops a man
  walking straight in); a clinch rewinds a punch in flight instead of
  dropping it; flush frozen-frame displacement probed (FEEL.md grade table).

## Interface changes

- `FighterState.styleId: AiStyle`, `FighterState.guardShape: GuardShape`
  (`'high' | 'shell' | 'peekaboo' | 'long' | 'low'`). **The rig must draw the
  guard from `GUARDS[f.guardShape]`** — `rest` and `block` hand poses
  (`HandPose { fwd, up, lat }` per hand) and `crouch`; the sim's glove
  positions already use them.
- `core/styles.ts` (re-exported from `core/index.ts`): `GuardDef`,
  `HandPose`, `GUARDS`, `FighterStyle { id, guard, stanceWidth, bounceHz,
  bounceAmp, range, desc, beat: [string, string, string] }`, `STYLES`,
  `fighterStyle(id)`.
- AI: `createAi(side, seed, cfg, style)`; `styleFor(spec, cfg, difficulty = cfg.aiDifficulty)`;
  `styleParams(id, cfg, difficulty)`; `withDifficulty(style, d)`;
  `DIFFICULTY`; `STYLE_IDS`; types `Difficulty`, `ComboStep`.
  **The call for main.ts: `createAi(side, seed, cfg, styleFor(spec, cfg))`.**
- Drills: `DRILLS: readonly Drill[]`, `drillById(id)`,
  `drillState(drill, specs, cfg, seed)`.
  `Drill { id, title, goal, seconds, placement(cfg) → { player, opponent },
  opponent?: Partial<FighterSpec>, setup?(state, cfg),
  policy(state, tick, seed, cfg) → FrameInput,
  metric(events, state, cfg) → { progress: 0..1, stat: string } }`. The host
  steps the sim with `[playerInput, drill.policy(state, tick, seed, cfg)]`,
  collects events, and calls `metric`.
- Config, new: `ratingsOn`, `ratingNeutral`, `ratingRange`,
  `ratingPowerImpulse`, `ratingSpeedHands`, `ratingSpeedFeet`,
  `ratingStaminaCost`, `ratingStaminaRegen`, `ratingStaminaFatigue`,
  `ratingDefenseGuard`, `ratingDefenseBlock`, `ratingDefenseStun`,
  `ratingDefenseSlip`, `ratingChinBody`; `stylesOn`, `jabStopOn`,
  `jabStopSpeed`, `jabStopScale`, `jabStopStun`; `aiDifficulty`,
  `aiInsideGuard`, `aiInsideBlock`, `aiLeadPursuit`, `aiWildRate`, `aiCombos`;
  `guardWearLight`, `guardWornCover`, `staminaRegenDelayLight`.
  Retuned: `guardUppercutCover` and `guardBodyCover` 0.6, `liverMinImpulse`
  430 (was 330), `liverSeconds` 1.6, `liverStaminaLoss` 0.2,
  `staminaBodyHitMult` 1.2 (was 2).

## Decisions made without asking

1. **The neutral rating is 65, not 50.** Red and blue are rated 55–80; at a
   neutral of 50 both would be well above "today's numbers". At 65 ± 35 the
   roster straddles the old numbers. The pinned tests do not rely on it: see 2.
2. **The ported tests run neutral.** Fourteen legacy test files (arms, block,
   combo, counter, dummy_ai, fight, health, interrupt, movement, punch,
   reaction, slip, timing, stun) and the bot kit by default build their
   config with `ratingsOn: false, stylesOn: false`, so every ported number
   is exactly what it was. The new behaviour is pinned by `ratings_test`,
   `styles_test`, `drills_test` and `ai_tools_test` §5.
3. **Style → guard**: pressure → high (today's poses), outboxer → long,
   counter → shell, swarmer → peekaboo, slugger → low. The player's fighter
   gets his style's guard as well.
4. **A fresh guard blocks inside.** Uppercut and body cover went to 0.6 and
   a guard above `guardWornCover` 0.7 blocks them with heavy chip; a worn one
   splits. Before, a high guard was worth nothing at inside range.
5. **A jab wears a guard at `guardWearLight` 0.35** (seven jabs broke one).
6. **A liver shot needs something behind it** (`liverMinImpulse` 430): every
   clean standing lead body hook (391 N·s) used to light the fuse.
7. **A jab pauses the wind for a quarter of the usual delay**
   (`staminaRegenDelayLight` 0.25). At the full pause a man jabbing twice a
   second held the other's stamina at zero for the whole fight: the pressure
   styles threw 25 punches in 110 s and lost every fight to the jab. This one
   key moved jab-and-move from 97% to 62% across the board.
8. **The AI calls a rush by misses** (`aiWildRate`, misses per second), not
   by punches thrown: a clean combination is not a rush.
9. **The slip drills telegraph with a dip** (10 ticks down, 20 up, then the
   punch), so the punch goes to the head and a person can read it.

## Existing assertions changed, and why

| Test | Change | Why |
| --- | --- | --- |
| 14 ported tests (list above) | config built with ratings and styles off | they pin the pre-phase-2 numbers |
| `health_test` | also `staminaRegenDelayLight: 1`; one assertion added (a jab pauses the wind for the light share, a cross for all of it) | its regen-pause assertion hits with a jab |
| `guard_test` | uppercut / body shot on a FRESH guard is blocked with heavy chip; on a worn guard (0.3) it splits | decision 4 |
| `level_test` | the clinch-deny case uses a worn guard on the grabber | decision 4 |
| `danger_test` | a standing body hook does not light the liver fuse; the fuse cases hit 20% harder; the knockdown case ×4 (was ×3) | decisions 6 and `staminaBodyHitMult` 1.2 (the body threshold at the buckle is higher) |
| `ai_tools_test` | the hand-built outboxer style also turns off combinations, the hook going away, the reply off the guard and the shove; §5 added (style table, difficulty) | those phase-2 behaviours throw hooks |

No assertion was deleted.

## Bots versus the styles

`node scripts/bot_table.mjs 10 medium detail` — bot = side 0 in red's body,
AI = side 1 in blue's body with the style overridden, ratings and styles on,
3 × 30 s, 10 seeded fights a cell. Win %:

| Bot | Legit | pressure | outboxer | counter | swarmer | slugger | avg |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jab-and-move | yes | 20 | 100 | 90 | 30 | 70 | 62 |
| inside-fighter | yes | 90 | 100 | 100 | 80 | 40 | 82 |
| counter-puncher | yes | 70 | 70 | 100 | 30 | 100 | 74 |
| turtle | no | 0 | 0 | 0 | 0 | 0 | 0 |
| masher | no | 0 | 10 | 0 | 0 | 0 | 2 |

Targets: met except one. Every legitimate plan wins against at least one
style and is clearly worse against at least one; the masher is ≤ 15% and the
turtle 0% everywhere; the best plan against the swarmer (inside-fighter) is
not the best against the outboxer (jab-and-move). **Missed: the
inside-fighter wins 82% across the board (limit 80%)** — 41 of 50, one fight
over.

On hard (6 fights a cell, measured before decision 7, so stale): jab-and-move
87, inside-fighter 83, counter-puncher 70. Easy was not run.

## Not done / below standard (phase 2)

1. **The outboxer and the counter-puncher style lose every fight to the
   inside-fighter bot**, by stoppage in ~40 s (lands 35–10 and 27–10). A man
   who keeps punching stuffs their replies, and neither gets away from him
   for long. What I would turn next, in order: the outboxer's exit (the
   shove-then-leave covers too little ground: `pushDistance`, or a pivot out
   instead of a straight burst); the counter style's `blockCounter` reply
   being interrupt-proof for its first ticks; then `healthDamagePerImpulse`
   if stoppages are this quick against a person.
2. **The slugger is weak against the two plans that stay off him**
   (jab-and-move 70%, counter-puncher 100%): 23 lands a fight. His tells are
   long by design; his reach is not making up for it.
3. **The counter style beats nobody** (90–100% losses). It waits for
   openings the scripted bots rarely give; against a person it may play
   differently. `attackDelay` down or `feintChance` up are the knobs.
4. **Ten fights a cell is ±15 points.** The 82% is one fight over the line
   and the 20–30% cells could be 10–45%.
5. **Hard and easy are not balanced, only ordered** (`ai_tools_test` §5
   checks easy reacts slower, defends less, throws less; hard the other way).
   The hard matrix above predates the last sim change.
6. **The matrix uses blue's body for all five styles**, not the roster of
   eight: ratings and reach are held constant, only the style changes.
7. **Height dead band**: untouched, waiting for the roster of eight.
8. **Flush on the frozen frame**: probed and recorded (FEEL.md). Every flush
   power shot pins the neck clamp, so flush and clean differ on the frozen
   frame only by torso travel and freeze length. Not changed.
9. **`stun_check` fails its second half with ratings on** ("the player
   rocked" times out). It rocks red at 5% health with blue's standing cross.
   That cross was 272 N·s against a threshold of 269; blue's power rating
   (58) now makes it 259, so it lands clean and does not rock. Reproduced in
   Node (`_debug.mjs stunchk`: rocks with `ratingsOn` off, not with it on);
   the fix was not tried in the browser. The check is not this workstream's
   to edit: setting `window.__cfg.ratingsOn = false` beside its other config
   lines, or scripting a hook instead of the cross, should restore it.
10. **Nothing here was feel-tested or drawn.** Guard shapes move the sim's
   gloves and boxes; whether the rig draws them is the rig's.

---

# Phase 3 — heights, balance on the roster bodies, the loaded counter, fight length (2026-11-11)

Phase 2's "not done" items 1–7 are superseded by this section. Nothing in it
was feel-tested: it is measured in Node and by the bot matrix.

## 1. Heights

- **`punchAimDeadband` 0.08 → 0.** The lane tracks the opponent's standing
  height fully, head lane to head, body lane to body, and now includes the
  crouch of each man's guard (the peek-a-boo sits 4 cm down).
- **`hitBody(f, cfg)` (`sim/reaction.ts`), `bodyBoxChinSection` 0.78.** The
  body capsule has one radius, hips to shoulders. On the 112 kg man (bodyR
  23 cm) its top stood 15 cm above his chin and further forward than his
  face, so every cross, hook and uppercut at his head stopped on air above
  his chest and scored to the body. For FISTS only (the hit test, the glove
  clamp, the target cut) the capsule's top end comes down its own axis until
  the capsule is no wider than 0.78 × the head radius at chin height. Red
  (0.77) and blue (0.61) are untouched; body-to-body separation and the rig
  keep `bodyBox`. **For the rig:** this is a hit volume only, nothing to draw.
- **A body punch stopped on the guard is a body shot.** It was scored to the
  head (the shell's forearm lies across the ribs; every body cross on the two
  shell-guard men read "head, glancing").
- **Slipping into the hand is a rule** (`wrongWayShoulder` 0.08 m). It was
  geometry: red's lane sat 5.5 cm low on blue and clipped the capsule by 2 cm.
  With the lane on the head the fist clears the shoulder by ~6 cm, so a head
  punch going past a head that slipped TOWARD the punching hand is caught by
  the shoulder counted 8 cm higher. Same outcome as before (a body shot,
  wrong way), now for every pair of heights.
- **Tried and rejected: aiming at the chin** (`punchAimChin`, kept as a key
  at 0). At 0.055 — where red's punches used to arrive on blue — every
  ported red/blue number held without a rule, but hooks then landed on the
  shoulder of any thick-set man (14 of 392 pair × punch rows failing) and a
  jab landed clean on a ducked head of the same height.
- **`heights_test.mjs`** (24 checks): all 56 ordered roster pairs × seven
  punches (jab, cross, hook, uppercut, body jab, body cross, body hook),
  each scanned from 1.5 m to 0.45 m. Every punch lands on every opponent;
  head punches on the head and body punches on the body from the middle of
  the distances each lands from. Before (dead band 0.08, plain capsule):
  65 of 392 rows failed. Now 4, all the same case, pinned as a known limit.
  Short and tall: the 1.98 m man's jab and cross hit the standing 1.63 m man
  on the head, clean, from 7 of 10 landing distances (0.60–1.05 m); the
  1.63 m man's hit him from 4 of 6 and 4 of 7 (0.60–0.83 m). Reach: the tall
  man's jab lands from 1.125 m, where the short man's whiffs; his own longest
  is 0.825 m. With `punchAimTrack` 0 the tall man's cross finds the short
  man's head clean from 0 distances.

Re-measured red / blue assertions:

| Test | Was | Now | Why |
| --- | --- | --- | --- |
| `grade_test` "a cross into the other man's hook is flush" | into his REAR hook | into his LEAD hook | on his head lane the cross now meets the lead glove still at his chin, pins it and lands THROUGH the guard (clean). It used to pass 5.5 cm under that glove |
| `grade_test` third punch of a combination | `> 1.2 ×` | `> 1.15 ×` | measured 1.201 × |
| `slipx_test` "the loaded cross is harder" | loaded-off-the-slip vs a square cross | vs the same cross off the same slip with the load off | from the slipped position the cross pins his resting glove either way (measured 0.84 × a square cross); like is now compared with like, ratio = `slipLoadedPower` |
| `slipx_test` wrong way | with the rule off the shot clips the shoulder, glancing | with the rule off it is a clean dodge; `wrongWayShoulder` 0 no longer catches it | see above |
| `slip_test`, `punch_test`, `counter_test`, `level_test` | — | unchanged, all green | the shoulder rule restores the one `slip_test` case that moved |

## 2. Balance on the roster bodies

`bot_table.mjs` now fights each style on a roster body of that style, with
that man's ratings, reach and guard: pressure → monsoon, outboxer →
lighthouse (1.98 m), counter → alambre (southpaw), swarmer → boiler (1.63 m),
slugger → raffle (112 kg). The bot fights half of each cell as red and half as
blue (the two reference bodies, one each side of average). `on=counter:grandad`
swaps a body; `only=` / `cols=` run part of the matrix. It also prints the
AI's win share per column and the fight-length numbers.

What was wrong, in the order it was found (each measured in a trace, then
fixed):

1. **The AI's distances were blue's.** `styleFor(spec, cfg)` now scales every
   range it holds or commits from to the body's arm (`withReach`,
   `aiReachRefArm`, `aiReachPerArm`, `aiReachEager`). Where it stands only
   grows with the arm; hooks and uppercuts shrink less than straights.
2. **Under fire it could not get its wind back.** A man under the
   inside-fighter bot went from 0.76 stamina to empty in 5 s and stayed
   there: no guard, no punches, three knockdowns in 26 s. `staminaHitCost`
   0.00026 → 0.00015; `knockdownStaminaRestore` 0.6 (he gets up with wind).
3. **The jab did a cross's damage.** Step jabs landed at 310–480 N·s on a man
   walking in (a standing cross is 272). `jabImpulseCap` 260.
4. **It stood armed and silent.** In `reset` (stepping out) it never threw —
   the outboxer started 12 punches in a 27 s fight, 51 against — and a
   straight armed for a man now chest to chest waited there for seconds. It
   now fights while stepping out if he is on top of it, jabs going away, and
   changes an armed punch that does not fit where he is for one that does.
5. **Any touch stopped its hands.** It threw nothing while "stumbling", at a
   bar (0.6–2.5 m/s) every jab clears. With the tools the bar is 4.5 m/s.
6. **It "slipped" punches that had already landed.** A slip or roll is now
   chosen only if the punch's tell less its own reaction leaves 0.05 s; what
   it cannot slip it blocks. The counter style reads at 0.13 s.
7. **Walking in behind the gloves was free.** `jabStopGuard`: a jab on the
   guard of a man walking in takes his forward speed (no stumble, no stun).
8. **A guard held inside was broken in one combination** and the shots after
   it landed at 680–1165 N·s. `guardWearPerImpulse` 0.0008 → 0.0006,
   `guardBreakVuln` 0.8 → 0.5. The AI now covers a COMBINATION (first one
   lands, guard up a reaction later, stays up while he keeps throwing, then
   it fires back): `aiCoverOn`.
9. **The big man could not throw.** Every slow punch he started was stuffed
   by whatever touched him first; the masher beat him 67%.
   `interruptPoise` 14 N·s per kg over `interruptPoiseMass` 90: he throws
   through jabs and a standing cross; a flush cross or any hook still stuffs
   him. Slugger style: comes forward, commits from the end of his reach.
10. **Counters were thrown away.** The opening was dropped whenever its guard
    was up or it was stepping out. It now takes it from both, once his punch
    has been and gone. Against a jab the answer is the jab with the cross
    behind it.
11. **Difficulty did nothing.** Scaling reaction, defence and tempo moved the
    legitimate bots' average from 57% (easy) to 54% (hard). `Difficulty` now
    also has `hesitate` (set and in range, it waits a beat instead of
    throwing) and `offence` (× the stiff jab, the reply off the guard, the
    shove). The styles as written are close to hard; medium gives a little
    away.

## 3. The loaded counter

`stunFlashFrac` 1.85 → 3.0 (× `counterFlashScale` 0.95 = 2.85 for a counter).
The probe (blue jabs at 0.79 m, red slips to the lead side, lead hook) lands
flush, counter, loaded: **1046 N·s**. Pinned in `danger_test` §4b:

| Target | × his threshold after the shot | Result |
| --- | --- | --- |
| fresh blue (chin 62) | 2.69 | rocked 2.6 s, health 1.00 → 0.79, not floored |
| the same man, the next clean hook while rocked | — | down (finish) |
| worn to 80% health | over 2.85 (not printed) | down on the land tick (flash) |
| worn to 60% health | over 2.85 (not printed) | down on the land tick (flash) |
| chin 90, fresh | 2.32 | rocked |
| chin 40, fresh | over 2.85 (not printed) | down (flash) |
| thrown by a power-90 man (1207 N·s) | over 2.85 (not printed) | down (flash) |
| thrown by a power-40 man (841 N·s) | under 2.85 (not printed) | rocked |

Before: 1046 N·s against a bar of 1.85 × floored a fresh blue every time, on
the land tick. The margin is thin: 2.69 against 2.85 for the fresh man, and
80% health is already over it. A few percent of power, chin or wind decide
it, so retuning damage or wind will move this — the test will say so.

Side effect: the flash is now rare outside counters and worn men. The other
routes down are the finish (rocked for `stunFinishGrace` 0.3 s, then a shot
at `stunFinishFrac` 0.85 × threshold — was the very next punch at 0.65) and
the bar running out.

## 4. Fight length

Turned: `healthDamagePerImpulse` 0.0003 → 0.0002, `stunFinishFrac` 0.65 →
0.85 with `stunFinishGrace` 0.3 s, `knockdownHealthRestore` 0.35 → 0.5,
`knockdownStaminaRestore` 0.6, `guardBreakVuln` 0.8 → 0.5,
`guardWearPerImpulse` 0.0008 → 0.0006, `jabImpulseCap` 260, `staminaHitCost`
0.00015.

Fights between the three legitimate bots and the medium AI, default rounds
(3 × 30 s), roster bodies:

| | Before (start of phase 3, 90 fights) | After (300 fights) |
| --- | --- | --- |
| End by stoppage | 54% | 30% |
| Median stoppage, seconds of boxing | 40 | 51 |
| Stopped in round 1 | 26% | 10% |
| Reach the last round | 57% | 77% |
| Knockdowns a fight (both men) | 3.2 | 3.1 |

All five bots (the turtle and the masher included): stoppages 58% → 41%,
median 26 s → 46 s, round-1 stoppages 29% → 18%, reaching the last round
49% → 66%.

Knockdowns a fight did not fall. Fewer come from the bar running out and
from the finish, but a man now gets up with half a bar and wind and is in the
fight again, so fights that used to end on the third knockdown go on. If
three a fight is too many for a 90-second fight, `healthDamagePerImpulse`
again, or `knockdownsForTko`.

## The three matrices

`node scripts/bot_table.mjs 20 medium detail`, `… 10 easy`, `… 10 hard`. Win
% for the bot. "AI" is the AI's share of the fights against the three
legitimate bots in that column.

**Medium, 20 fights a cell**

| Bot | pressure (monsoon) | outboxer (lighthouse) | counter (alambre) | swarmer (boiler) | slugger (raffle) | avg |
| --- | --- | --- | --- | --- | --- | --- |
| jab-and-move | 0 | 0 | 100 | 65 | 0 | 33 |
| inside-fighter | 75 | 100 | 90 | 65 | 80 | 82 |
| counter-puncher | 65 | 0 | 100 | 0 | 95 | 52 |
| turtle | 0 | 0 | 0 | 0 | 0 | 0 |
| masher | 5 | 0 | 0 | 20 | 15 | 8 |
| AI | 43 | 67 | 3 | 50 | 42 | |

Legitimate plans average 56%.

**Easy, 10 fights a cell**

| Bot | pressure | outboxer | counter | swarmer | slugger | avg |
| --- | --- | --- | --- | --- | --- | --- |
| jab-and-move | 70 | 100 | 100 | 80 | 70 | 84 |
| inside-fighter | 90 | 100 | 100 | 90 | 100 | 96 |
| counter-puncher | 60 | 80 | 100 | 20 | 100 | 72 |
| turtle | 0 | 0 | 0 | 0 | 0 | 0 |
| masher | 10 | 0 | 0 | 20 | 50 | 16 |
| AI | 17 | 7 | 0 | 30 | 3 | |

Legitimate plans average 84%.

**Hard, 10 fights a cell**

| Bot | pressure | outboxer | counter | swarmer | slugger | avg |
| --- | --- | --- | --- | --- | --- | --- |
| jab-and-move | 0 | 0 | 100 | 70 | 0 | 34 |
| inside-fighter | 80 | 90 | 20 | 60 | 40 | 58 |
| counter-puncher | 40 | 10 | 80 | 0 | 90 | 44 |
| turtle | 0 | 0 | 0 | 0 | 0 | 0 |
| masher | 0 | 0 | 0 | 0 | 20 | 4 |
| AI | 50 | 67 | 23 | 57 | 57 | |

Legitimate plans average 45%.

Against the targets, on medium:

| Target | Result |
| --- | --- |
| Every legitimate plan wins against ≥ 1 style and is clearly worse against ≥ 1 | met (jab-and-move 100 / 0; inside-fighter 100 / 65; counter-puncher 100 / 0) |
| No legitimate plan over 80% overall | **missed**: inside-fighter 82% |
| Masher ≤ 15%, turtle ≤ 5% everywhere | turtle met; **masher 20% against the swarmer** (4 of 20) |
| No style loses over 85% to any one legitimate plan | **missed** in six cells: the counter to all three (100 / 90 / 100), the outboxer to the inside-fighter (100), the slugger to the counter-puncher (95) — and, the other way, three bot cells at 0% |
| No column under 25% or over 75% for the AI | **missed** for the counter (3%); the other four are 42–67% |
| The best plan against the swarmer is not the best against the outboxer | met (jab-and-move; inside-fighter) |
| Easy ≥ ~75%, hard ≤ ~45% for the legitimate plans | met: 84%, 45% (medium 56%) |

## Interface changes (phase 3)

- **Call for main.ts, unchanged in shape:** `createAi(side, seed, cfg, styleFor(spec, cfg))`.
  Pass the WHOLE roster spec: with `heightM`, `reachM` and `massKg` present
  `styleFor` now scales the style's ranges to that body. A bare
  `{ style }` still works and gives the distances as written.
- No export was renamed. Added: `withReach(style, spec, cfg)` (ai);
  `hitBody(f, cfg)` (sim, internal to the hit test).
- `Difficulty` gained `offence` and `hesitate`; `StyleParams` gained
  `hesitate`. `DIFFICULTY[1]` (medium) is no longer the identity: the styles
  as written sit near hard.
- `AiState` gained `oppQuiet` and `coverT` (plain numbers, serialisable).
- No `FighterState` field was added in phase 3. Nothing new for the rig to
  draw; `hitBody` is a hit volume only.
- Config, new: `punchAimChin` (0), `bodyBoxChinSection`, `wrongWayShoulder`,
  `jabImpulseCap`, `jabStopGuard`, `interruptPoiseMass`, `interruptPoise`,
  `stunFinishGrace`, `knockdownStaminaRestore`, `aiReachRefArm`,
  `aiReachPerArm`, `aiReachEager`, `aiCoverOn`. Changed: `punchAimDeadband`
  0, `stunFlashFrac` 3, `stunFinishFrac` 0.85, `healthDamagePerImpulse`
  0.0002, `staminaHitCost` 0.00015, `knockdownHealthRestore` 0.5,
  `guardWearPerImpulse` 0.0006, `guardBreakVuln` 0.5.

## Existing assertions changed in phase 3, and why

Beyond the four re-measured red / blue rows under "Heights":

| Test | Change | Why |
| --- | --- | --- |
| `stun_test` flash | the flooring cross is × 6 (was × 3.5) | `stunFlashFrac` 3 |
| `stun_test` | added: a cross inside `stunFinishGrace` of the rock does not finish | new rule |
| `danger_test` §4 | `counterFlashScale` 0.4 makes the counter a flash (was 0.7) | `stunFlashFrac` 3, less wind lost per hit |
| `danger_test` §6 | the get-up section pins `stunFlashFrac` 1.85 for its one big cross | it is about the get-up, not the flash |
| `danger_test` | added §4b (the loaded counter) and the wind-on-getting-up check | new |
| `health_test` | regen-resumes bound 0.03 → 0.02; "at 0 stamina" is "at or just over 0" | a jab now takes 0.029 wind |
| `attrition_test` | the jab-floor case starts at 0.03 health (was 0.04) | a jab now takes 0.039 health |
| `ai_tools_test` | "it slipped or rolled" is checked on the counter style and must make punches miss; difficulty check reads "medium makes some mistakes, hard none"; reach scaling added | slips need time; medium is no longer the identity |
| `interrupt_test`, `styles_test` | added: weight, the jab on the guard, the jab cap | new rules |

No assertion was deleted.

## Not done / below standard (phase 3)

1. **The counter style loses to everything.** 3% across the legitimate bots
   on medium (2 wins in 60), 23% on hard. On alambre (62 kg, power 52) it is
   out-landed two to one and loses decisions; on grandad it was no better
   (0 of 18 at 6 a cell). Measured causes, from two traced fights: 29% and
   42% of its punches were stuffed (any clean touch stuffs a light man), it
   cannot slip a jab on reaction, and its counters do not hurt. It does make
   the inside-fighter pay more than it did (1.0 knockdowns a fight on the
   bot, was 0.2) but not enough. What I would turn next: a counter that is safe from the stuff for
   its first ticks when thrown into a recovery; a pull-counter against the
   jab (step back out of it, cross over the top) rather than a slip; then
   his body — a counter-puncher with power 52 has nothing to counter with.
2. **The inside-fighter is at 82% on medium** (limit 80) and beats the
   outboxer 20 of 20. The 1.98 m man is harder to get to than he was (fights
   now go 71 s of boxing, were 18; most are decisions) but he is knocked down
   4.5 times a fight once the bot is on his chest: chin 52. He ties up when
   hurt and the finish now needs a beat, and it was not enough. Next: his
   exit after the shove (a pivot out instead of a straight hop), and the
   clinch cooldown (4 s) for a style built on it.
3. **The jab-and-move bot wins 0 of 60 against pressure, outboxer and
   slugger.** Against the slugger it is stopped 18 times in 20 (he walks
   through the jab and lands the cross). That is the matchup the brief
   describes for the outboxer, and too much for the other two. The bot does
   not move its head or change range when the same answer keeps landing; a
   person would. `interruptPoise` and the slugger's `intercept` are the knobs
   if a person finds him unfair.
4. **The masher wins 20% against the swarmer** (4 of 20; limit 15) and 50%
   against the slugger on easy.
5. **The slugger loses 95% to the counter-puncher bot.** Slow, loud punches
   are what that bot is for; 95% is still outside the target.
6. **Uppercuts thrown down at the 1.63 m man land on his chest** for four of
   the seven opponents (pinned in `heights_test` as a known limit). His chest
   capsule is thicker than his head and directly under it. It lands, on the
   wrong part.
7. **Easy and hard are 10 fights a cell** (± 15 points a cell; the averages
   over 150 fights are firmer). Medium is 20.
8. **The matrix is one body per style.** Red (pressure), blue (outboxer) and
   grandad (counter) as AI were only spot-checked.
9. **Three knockdowns a fight** on medium, unchanged (see Fight length).
10. **Southpaw.** Alambre is the only southpaw and the bots assume an
    orthodox opponent when they circle "away from the power hand". Not
    examined; it may be part of item 1.
11. **None of this has been played.** Every number here is bots against the
    AI. In particular the new rules a person will feel at once — the jab cap,
    the jab holding off a guarded walk-in, the big man walking through jabs,
    the 0.3 s before a rocked man can be finished, health lasting half as
    long again — are unfelt.
