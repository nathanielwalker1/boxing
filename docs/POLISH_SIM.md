# Polish phase — SIM workstream log

Started 2026-11-11, after Nate's first play of the overhaul. For every item:
what was measured, what the real cause was, what changed (config keys and
toggles), before / after. Nothing here has been felt by a person. Every change
is behind a toggle (default = the new behaviour); with the toggles off the sim
is what it was (grade_test's combination section runs that way and passes
unchanged).

Probes (all headless, Node): `scripts/combo_probe.mjs` (where a combination
breaks), `scripts/feel_probe.mjs` (`motion` / `lockout` / `busy` / `grades`),
`scripts/stamina_probe.mjs` (`costs` / `pace` / `bots`), `scripts/hurt_table.mjs`.
Each takes `key=value` config overrides, so "before" is the same probe with the
toggles off.

## Item 2 — combinations and flow

### 2a. "I'll land two punches and then it's so hard to follow up"

**Measured** (`node scripts/combo_probe.mjs`, toggles off): a scripted 1-2-3
(jab, cross, lead hook) and 1-2-body-hook, presses 8 ticks apart, target
standing with a resting guard, 0.60 → 1.00 m.

| | open ring | target on the ropes |
| --- | --- | --- |
| 1-2-3, all three land | **0 of 9 distances** | 6 of 9 |
| 1-2-body hook | **0 of 9** | 8 of 9 |

What it is NOT: no press was dropped; the cross started the tick it was
pressed and the hook waited 2–3 ticks (the chain window opens at the start of
the cross's recovery); hit-stop ate no input (a press on a frozen tick starts
on that tick); stamina was full throughout.

**Real cause: knockback.** A clean jab moves a standing man 18 cm by the time
the cross arrives and the cross another 40 cm (0.80 → 0.98 → 1.39 m at the
three hit tests). A hook reaches about 0.80 m. In open ring the 3 was thrown
at a man half a metre out of reach, from every starting distance. On the
ropes it landed because the ropes held him there.

**Fix** (`sim/flow.ts`; all three are needed — measured alone, the hold lands
the 3 at 1 of 9 distances and the follow step at 0 of 9):

- **The hold** (`comboHoldOn`): from the SECOND clean land of a combination on,
  the target takes `comboHoldKeep` 0.3 of the knockback at once; the rest is
  banked and let go (× `comboHoldRelease` 0.3) when the combination ends — on
  its finisher, when the puncher misses or is blocked, when his hand is home
  with nothing queued, or when `comboWindow` lapses. Head and body reactions
  are untouched: he is still visibly hit, his feet just stay. The FIRST land
  shoves in full (`comboHoldFirst` 1), so a lone punch is exactly what it was
  (flow_test pins position equality).
- **The follow** (`comboStepOn`): a punch started inside `comboWindow` of a
  clean land takes a short step after the man — far enough to put the hit test
  at `comboStepRange` 0.76 of that punch's own reach given where his remaining
  stagger will carry him, at most `comboStepMax` 0.20 m, on the stagger
  channel like the step-in (never on top of it). Not when the ropes are behind
  him (measured: the step carried the puncher onto a man the ropes had bounced
  back and the cross was smothered).
- **The finisher** (`comboFinisherOn`): the clean / flush power punch (not a
  jab) that lands as punch `comboFinisherAt` 3 or later is the last and
  biggest: `punchLand.finisher`, × `comboFinisherPower` 1.2 on top of the
  build, everything held is let go with it, `comboFinisherHitStop` 0.13 s, the
  neck may travel `gradeNeckFinisher` 1.6× the clamp. The count restarts.

**After:**

| | open ring | on the ropes |
| --- | --- | --- |
| 1-2-3, all three land | 7 of 9 (0.60–0.90 m; at 0.90 the hook is glancing) | 9 of 9 |
| 1-2-body hook | 8 of 9 | 8 of 9 |
| the same at a slower cadence (presses 200 ms apart) | 6–8 of 9 | 9 of 9 |

The attacker travels up to 0.49 m through the three punches; the target ends
1.0–1.25 m from where he started (it was 0.71 m after two punches and a miss).
At 0.95–1.00 m the cross is at the end of the arm and the combination does not
form: that is range, not flow.

### 2b. "It feels kinda laggy, robotic sometimes"

**Measured** (`node scripts/feel_probe.mjs motion | busy`, toggles off).

Press → first visible motion (glove > 1 cm or twist > 1°):

| Situation | jab | cross | hook | uppercut |
| --- | --- | --- | --- | --- |
| from rest, walking, releasing the block on the press | 0 ms | 0 | 0 | 0–17 |
| pressed 4 ticks into a jab that lands | 50 ms | 50 | 50 | 50 |
| pressed 4 ticks into a cross that lands | 133 ms | 133 | 133 | 133 |
| the tick after his punch lands on me | 17–67 ms | 33–67 | 33–67 | 33–67 |
| the tick after I block his cross | 133 ms | 133 | 133 | 133 |

Input is not the lag: a press is never eaten, the buffer does not run down
during a freeze. What waits is (a) a chained punch for the punch before it to
arrive (inherent), (b) the wind-up frozen by the hit-stop of the punch that
just landed (up to 4 ticks), (c) block stun (see 2c).

Hit-stop in busy exchanges (inside-fighter bot vs the swarmer AI, 8 seeds, to
the first knockdown): **13.1% of all ticks frozen, 45% of the worst second,
32% of the worst two seconds**, 374 stops for 305 lands, longest 183 ms. With
`hitStopScale` 0.05 a stop is a full freeze, so this is literally one frame in
eight not advancing — and nearly every second frame in the worst exchanges.

Single-tick pose jumps in the same fights: the torso twist stepped more than
12° in one tick 34 times (up to **90°**), the lean 27 times (up to 0.7).
19 + 8 of them were one bug: a CHAINED punch that was feinted or stuffed. Its
wind-up had blended out of the last punch's turn; when it rewound home (or
was hit) that carried turn was dropped at once.

**Fix:**

- **Hit-stop budget** (`hitStopBudgetOn`): freezes are paid from a bucket of
  `hitStopBudget` 0.13 s that refills over `hitStopBudgetWindow` 1.6 s (8% of
  a sustained exchange). A first hit after a quiet moment reads in full; the
  fifth in a second gets what is left, never under `hitStopMin` (one tick).
  The big moments — finisher, rock, knockdown — may overdraw it by
  `hitStopBigExtra` 0.10 s and no further. A slipped punch and the counter
  off it are always given in full (Nate tuned that read by hand).
- A clean jab's freeze is `hitStopJabScale` 0.5 of the power-scaled one (48 →
  24 ms): the most frequent land in a fight and the lightest.
- Inside a running combination a land's freeze is `comboHitStopScale` 0.5 of
  normal; the long one is the finisher's.
- **The pose unwind** (`carryFadeOn`, `poseSettleRate` 9 rad/s): a rewound
  chained punch keeps the carried pose while the fist comes home, and the body
  then unwinds at a bounded rate (80° in ~150 ms) instead of in one tick. A
  punch thrown while it is still unwinding blends out of it.

**After** (same probe): 9.7% frozen, 32% of the worst second, 20% of the worst
two seconds; longest stop 150 ms. Twist jumps over 12°: 17 (10 unexplained by
an event, none over 34°), lean jumps 7.

**Left, not mine to fix** (for the MOTION workstream — `feel_probe busy jumps=twist`
prints each): (1) `clinch.ts`'s push-off zeroes the pose of the wind-up it
smothers (the remaining `punchStuffed` jumps); (2) a shovel hook's torso turns
31–34° in the one tick its extension starts when it is thrown loaded and
chained; (3) a rising uppercut's glove moves 37–44 cm in the first tick of its
wind-up; (4) a feint's own rewind is 15–21° a tick by design (`feintRewindRate`).
The head "jumps" on every land are the impact pose (2026-09-19), deliberate.

### 2c. "The punch stun is a bit too much"

**Measured** (`node scripts/feel_probe.mjs lockout`, toggles off): real time
from a punch arriving until a punch of mine could START.

| What happened to me | Locked for | Held by |
| --- | --- | --- |
| clean jab / cross / hook, hands at rest | 17 ms (1 tick) | nothing |
| I block his jab / cross / hook / uppercut | 100 / 150 / 200 / 233 ms | block stun |
| I walk onto his jab (the jab stop) | 283 ms | its stun + the flush freeze |
| his jab touches the wind-up of my hook | 133 ms, **and the hook is gone** | stuffed, rewinding |
| his cross in the wind-up of my uppercut | 183 ms, uppercut gone | stuffed |
| his hook rocks me | 650 ms | `stunPunchLock` 0.5 s + the freeze |

**Real cause:** not being hit as such — a man hit clean with his hands at rest
was never locked. The "stun" is (1) the interrupt: ANY clean touch in the
first 70% of a punch's flight killed it, so a jab erased every hook, cross and
uppercut it met; (2) block stun and the jab stop holding the hands for their
whole length.

**New rule** (`hitNerfOn`):

- A landed punch opens a **hit window** on its target (`hitWindow` 0.35 s;
  severity by grade: `hitSevGlancing` 0.35, `hitSevClean` 0.7, `hitSevFlush` 1,
  a heavy shot on the guard `hitSevBlocked` 0.3). A punch he starts inside it
  comes out **nerfed** by severity × what is left of the window: wind-up up to
  `hitNerfSlow` 0.5 longer, reach up to `hitNerfReach` 14% shorter, impulse up
  to `hitNerfPower` 50% less. It is flagged: `PunchState.nerf`,
  `punchStart.nerf`, `punchLand.nerf`; the window itself is `FighterState.hitT`
  / `hitSev`.
- **The ceiling**: block stun and the jab stop keep the hands for at most
  `hitLockMax` 0.13 s of real time (one jab's tell and a tick: being hit costs
  the tempo of one jab, never two). The feet stay slow for the whole stun.
- **The interrupt**: a punch is STUFFED only by a FLUSH land during its
  wind-up (`interruptStuffEarly` 1 = the whole wind-up; the extension is never
  stuffed). Anything else lets it through with `interruptPowerLoss` × severity
  × the share of the flight still to go. **Measured** (`_debug.mjs
  flushsweep`): a man's exposure stays under 0.2 through his own wind-up, so a
  STANDING man cannot be hit flush in it, nor one throwing a hook (it plants
  his feet). The man who can is the one coming forward as he winds up — a
  cross thrown walking in — or one who is hurt or inside a slip's punish
  window. So a stuff is now a stop-hit or a counter, not a touch.
- A punch that was hit in flight and then falls short (the hit moved its
  thrower back) comes home at the normal rate and pays no whiff cost.
- **Rocked / winded** stay real hurt states; their punch locks are
  `hurtPunchLockScale` 0.4 as long (0.2 s / 0.24 s) and what is thrown while
  hurt is at least `hitNerfHurt` 0.6 nerfed.

**After:**

| What happened to me | Locked for |
| --- | --- |
| clean land, hands at rest | 17 ms |
| I block his jab / cross / hook / uppercut | 100 / 133 / 133 / 133 ms |
| the jab stop | 133 ms |
| his jab in the wind-up of my hook | the hook still comes (it may fall short: he moved me) |
| his jab late in my cross | the cross lands, nerf 0.12 |
| his hook rocks me | 350 ms |

### 2d. Landing: the grade gap and the finisher (sim side)

`node scripts/feel_probe.mjs grades` — one land, target standing.

| Case | Grade | N·s | Freeze | Head | Torso | Feet knocked | Before (head / torso / knocked) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jab at 1.00 m | glancing | 117 | 17 ms | 2.9 cm | 0.2 | 9 cm | 3.9 / 0.3 / 15 |
| jab at 0.80 m | clean | 195 | 24 ms (was 48) | 6.8 | 0.5 | 26 | 6.6 / 0.5 / 26 |
| jab on a rocked man | flush | 220 | 130 ms | 10.8 | 0.8 | — | 7.4 / 0.5 |
| cross at 1.03 m | glancing | 163 | 17 ms | 5.2 | 1.9 | 13 | 7.9 / 2.8 / 22 |
| cross at 0.80 m | clean | 272 | 67 ms | 12.4 | 4.4 | 36 | 13.1 / 4.7 / 36 |
| cross on a rocked man | flush | 412 | 130 ms | **22.5** | 9.7 | — | 16.0 (the neck clamp) / 7.1 |
| hook at 0.72 m | clean | 391 | 96 ms | 9.4 | 3.2 | 52 | 10.3 / 3.4 / 52 |
| the hook of a 1-2-3 | clean, **finisher** | 581 | 130–140 ms | 20.2 | 5.8 | 124 (the whole combination) | whiffed |

`gradeSpreadOn`: `gradeReactGlancing` 0.7 / `gradeReactFlush` 1.3 on the
reaction springs, `gradeStumbleGlancing` 0.6 / `gradeStumbleFlush` 1.3 on the
knockback, `gradeNeckFlush` 1.4 on the neck clamp (every flush power shot used
to show the same 16 cm). Damage is untouched — the gap is in what the body
does. (Clean numbers move by a few % from the seeded variation, below.)

Every land also carries a **hit zone** (`punchLand.zone`: chin / jaw / temple /
nose / forehead; solar / ribs / liver / belly — from where the fist rests on
the struck surface and how sideways it was travelling) and a **seeded
variation** (`punchLand.vary`, −1..1, from the fight seed and the tick, not
from the rng stream). `reactionVary` 0.14 scales the reaction with it: one
number trades the head's snap back against its lift and whip, a second the
shoulders' turn — two identical jabs move him differently (measured 6.8 vs
7.6 cm), the same fight replays identically.

## Item 6 — stamina

**Measured** (`node scripts/stamina_probe.mjs all staminaPolishOn=false`).
Costs, % of the tank: any punch thrown 4.0 (jab = uppercut), landed 2.5 (the
1.5 refund), blocked 4.0, missed 9.0 and 0.6 off the ceiling; taking a jab /
cross / hook 2.9 / 4.1 / 5.9, a body hook 7.0 (+1.3 ceiling); blocking a jab /
cross / hook 0.6 / 0.8 / 1.2; **holding the guard 8.0 a second**; walking and
slipping 0; burst 1.5; pivot 1.5; clinch 5; push-off 3. Regeneration 35 a
second — but only while NOT punching, NOT holding the guard, and 0.6 s after
being hit.

A scripted human, 3 × 60 s (1-2s and 1-2-3s on a beat, a quarter of them out
of range, a partner hitting back on a beat):

| Pace | Guard up | Avg tank | Tired | Gassed | Lowest |
| --- | --- | --- | --- | --- | --- |
| 25 / 32 / 40 a minute, hands down between bursts | 9–17% | 94–96% | 0% | 0% | 68–73% |
| **32 a minute, guard up between bursts** | 90% | **7.5%** | **95%** | **88%** | 0% |
| 60 a minute, guard up between bursts | 82% | 7.1% | 95% | 89% | 0% |

The scripted bots against the pressure AI throw 62–156 a minute (the AI
72–102): inside-fighter average tank 45%, tired 67% of the fight; turtle
(guard up 71%) average 24%, gassed 59%.

**Real cause:** not the price of punching. At bursts-and-rests the tank never
went under 66%. It is the GUARD: holding it cost 8% a second and stopped all
regeneration, so anyone who keeps his hands up between combinations — the
normal way to play — was empty in twelve seconds and stayed there. Second:
wind did not come back during any punch, so a man working behind a busy jab
held his breath all round. Third: a jab cost what an uppercut cost.

**Changed** (`staminaPolishOn`; off = the old costs exactly):

| What | Was | Now | Key |
| --- | --- | --- | --- |
| Holding the guard | 8% /s, no regeneration | 0.8% /s, regeneration at 40% | `staminaGuardHold` 0.1, `staminaGuardRegen` 0.4 |
| A jab on the guard | 0.6%, pauses the wind | 0.15–0.2%, no pause | `staminaBlockedLight` 0.25 |
| A cross / hook on the guard | 0.8 / 1.2% | 2.0 / 2.9%, wind paused 0.3 s | `staminaBlockedHeavy` 2, `staminaBlockedDelay` 0.5 |
| Throwing | 4% any punch | jab 1.6, cross 3.2, hook 3.7, uppercut 4.2 | `staminaThrowScale` 0.8, `stamina…Weight` |
| Landed (after the refund) | 2.5% | jab 0.1, cross 1.7, hook 2.2 | — |
| Missed | 9% + 0.6 ceiling | jab 4.1 (+0.3), cross 8.2 (+0.6), hook 9.4 (+0.7), uppercut 10.7 (+0.8); wind paused 0.45–1.2 s | `staminaWhiffByWeight`, `staminaWhiffDelay` 0.9 |
| Wind during a punch | none | 35% of the rate in the recovery of a punch that touched something | `staminaPunchRegen` |

**After:**

| Pace | Avg tank | Tired | Gassed | Lowest | Round ends |
| --- | --- | --- | --- | --- | --- |
| 25 / 32 / 40 a minute | 96–97% | 0% | 0% | 78% | 96–98% |
| 32 a minute, guard up between bursts | 98% | 0% | 0% | 87% | 99% |
| 60 a minute, guard up between bursts | 97.5% | 0% | 0% | 84% | 99% |
| wild: 56 a minute, most missed | 89% | 0% | 0% | 73% | 92 / 88 / 86% (the ceiling) |
| 30 s of nothing but missed power punches | — | > 60% | > 30% | — | ceiling < 80% |

Bots vs the pressure AI: jab-and-move average tank 75 → 83%, inside-fighter
45 → 65% (tired 67 → 36%), counter-puncher 64 → 76%, turtle 24 → 78%, masher
26 → 25% (still gassed 59% of the fight — throwing 153 a minute and missing).

`stamina_test` pins the targets. **Softer than I wanted:** a wild but not
non-stop puncher (56 a minute, most missed) loses ceiling and dips to 73% but
is never "tired" — regeneration at 35% a second out-runs everything but
non-stop work. The first knob if wild throwing should bite harder is
`staminaRegen`, which I left alone because the complaint ran the other way.

## Tests

Added: `flow_test` (47), `stamina_test` (19). Probes kept: `combo_probe`,
`feel_probe`, `stamina_probe`.

**Pinned assertions changed on purpose:**

- `interrupt_test`: rewritten to the new stuff rule (section 0 sweeps it; the
  rewind / lock-out sections now use a jab landing flush on a man walking in
  with a cross; the late-in-flight power loss follows the new formula). The
  weight and loaded-counter sections run with `hitNerfOn` off — they pin WHO
  can be stuffed, not when.
- `dummy_ai_test` cover-after-a-stuff section: `hitNerfOn` off (it pins the
  AI's cover, and needs a stuff to cover from).
- `stun_test`, `danger_test`: the rocked / winded punch lock is
  `hurtPunchLockScale` as long and the punch that follows is nerfed (+ a
  check that `hitNerfOn` off restores the full lock).
- `reaction_test`, `grade_test`: a clean jab's hit-stop × `hitStopJabScale`.
  `grade_test`'s combination-build section runs with the polish toggles off
  (it pins the build ratios alone).
- `combo_test` "the old settings drop presses": the old settings now include
  the old hit-stop.
- `health_test`, `attrition_test`: `staminaPolishOn` off (they pin the
  original stamina formulas key by key). `level_test`: the feint refund is of
  the weighted throw cost.

## Needs drawing / sound (for the next phase)

State and event fields the sim now produces that nothing draws or voices yet:

| What | Field / event | What to do with it |
| --- | --- | --- |
| A nerfed punch | `PunchState.nerf` 0..1, `punchStart.nerf`, `punchLand.nerf` | an arm punch: less hip and shoulder, the head back, off the back foot; a duller, shorter whoosh and impact |
| Being hit, still throwing | `FighterState.hitT` (s left), `hitSev` 0..1 | the flinch he is punching through |
| The finisher | `punchLand.finisher` | the biggest impact sound, camera push and crowd pop of the exchange; `combo` is its position |
| Knockback held, then let go | visible as stagger: the target stays put through punches 2…n and goes on the last | feet planted / rocking on the heels during the combination, the stumble on the finisher |
| The follow step | `stagger` on the attacker toward the target | the lead foot steps with the punch |
| Hit zone | `punchLand.zone` (chin, jaw, temple, nose, forehead, solar, ribs, liver, belly) | pick the reaction clip / head direction / sound by zone |
| Seeded variation | `punchLand.vary` −1..1 | pick among reaction variants; the sim's springs already move with it |
| A flush land's bigger head travel | head offset up to 1.4× `reactionMaxNeck` (1.6× on a finisher) | the rig's neck must allow it |
| The pose unwind | `torsoTwist` / `lean` non-zero with `punch.type === null` | nothing special — draw it; it used to be impossible |
| Hit-stop is shorter and uneven | `SimState.hitStop` | audio / camera should key off the events, not the freeze length |
