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

**After** (same probe, everything in this log on): 10.4% frozen, 37% of the
worst second, 24% of the worst two seconds; 3.4 frozen ticks per land where
it was 5.1 (more punches land now: 1.85 a second against 1.55); the longest
single stop is still 183 ms (a slipped punch into its counter — the read,
never cut). Twist jumps over 12°: 21 (12 not explained by an event, none of
those over 34°) where it was 34 (19, up to 90°); lean jumps 7 where it was 27.
**This is a smaller gain than I wanted**: the average moved by a fifth, the
worst second by a sixth. The big moments are the floor — a finisher, a rock
and a counter inside one second are 0.13 + 0.14 + 0.18 s by themselves. The
knobs if it still reads as dropped frames: `hitStopBigExtra` down, `hitStopScale`
up from 0.05 (a slow-motion beat instead of a full freeze), `hitStopBase` down.

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
shoulders' turn — two identical jabs move him differently (measured 7.7 vs
8.4 cm of head travel on a man on the ropes), the same fight replays
identically.

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

## Item 3 — hurt

### "I just went through a 3-round fight and couldn't hurt the other fighter"

**Measured** (`node scripts/hurt_table.mjs 3 all`, every polish toggle off;
3 × 60 s, medium, ratings and styles on).

| TODAY | AI v AI (60 fights) | legit bots v AI (45) | a person's pace v AI (30) |
| --- | --- | --- | --- |
| rocking shots a fight | 14.9 | 14.2 | 11.3 (all on HIM) |
| winded a fight | 4.8 | 6.1 | 5.6 |
| guard breaks a fight | 0.8 | 1.3 | 9.0 (all his) |
| knockdowns a fight | 1.6 | 2.3 | 3.1 |
| fights with a knockdown / with 3 or more | 63% / 27% | 69% / 40% | 73% / 60% |
| stoppages (all by three knockdowns) | 13% | 24% | 50% |
| counted out · one-punch finish | 0% · 0% | 0% · 0% | 0% · 0% |
| knockdowns by cause | finish 37, flash 31, body 26, health 2 | finish 58, body 34, flash 10 | finish 52, body 27, flash 7, health 6 |

"A person's pace" is `scripts/bots/human_pace.mjs`: guard up, walks to range,
a 1-2 / 1-2-3 / 1-1-2 / 1-2-body-hook every couple of seconds, presses 8 ticks
apart — 35 punches a minute. Against the AI, TODAY: **he rocked it 0.00 times
a fight, winded it 0.10, never floored it, hurt it at all in 7% of fights**
(2 of 30), won none — while it rocked him 11 times a fight, floored him 3 and
stuffed 31 of his punches a fight.

**Real cause.** Not that the game cannot hurt: between AIs somebody is rocked
every twelve seconds. It is that everything that hurts was out of a person's
reach:

1. The punch that rocks (a jab cannot; a standing cross is 272 N·s against a
   fresh bar of 450) is the hook or the uppercut at the END of a combination —
   and that punch whiffed in open ring, always (item 2a).
2. Every time the AI's jab touched one of his wind-ups the punch was erased:
   31 a fight (item 2c).
3. The bar sat above any standing punch (hook 391, uppercut ~380 vs 450), and
   the bonuses that get over it MULTIPLY — momentum × exposure × flush ×
   combination × the power rating, up to ~4.8× — which the AI, always moving
   and always catching a man mid-punch, stacks and a person standing in front
   of him does not. Its shots arrived at 2–4× a threshold his could not reach.
4. Nobody was ever counted out and no fight ended on one punch: a knockdown
   was one kind of thing, repeated until the third one stopped the fight.

**Changed** — the rates (`hurtRatesOn`; off = every scale 1):

| What | Was | Now | Key |
| --- | --- | --- | --- |
| The stun bar (fresh, chin 62) | 450 N·s | 405: a clean standing hook rocks him once he has lost a tenth of his health, or as punch two of a combination | `hurtStunBaseScale` 0.9 |
| Stacked impulses, for the stun checks only | counted in full | the part over 420 N·s counts at 45% (damage and knockback are untouched) | `stunSoftAt`, `stunSoftKeep` |
| Flooring a rocked man (the finish) | ≥ 1.3 × his worn bar | ≥ 2.1 × | `hurtFinishScale` 1.6 |
| A liver shot that drops instead of folds | ≥ 1.8 × the body bar | ≥ 2.3 × | `hurtBodyDropScale` 1.3 |
| How long a rock lasts | 1.6–3.0 s | 1.3–2.4 s | `hurtRockSeconds` 0.8 |
| The bar just after a hurt state ends | the same | × 2.2, fading over 6 s | `hurtAfterScale`, `hurtAfterSeconds` |

**After** (`node scripts/hurt_table.mjs 3 all`; the person's-pace column
`… 3 human`):

| NOW | AI v AI | legit bots v AI | a person's pace v AI |
| --- | --- | --- | --- |
| hurt episodes a fight (a man not hurt becomes hurt) | 22.9 | 20.5 | 18.7 |
| rocking shots / winded a fight | 18.9 / 8.7 | 18.2 / 9.1 | 13.6 / 12.0 |
| knockdowns a fight | 1.18 | 1.84 | 1.33 |
| fights with a knockdown / 3 or more | **55%** / 20% | 67% / 31% | 63% / 20% |
| stoppages | 13% | 22% | 20% |
| counted out or waved off | 5% | 13% | 3% |
| **one-punch finish** | **2%** | **4%** | 3% |
| kinds of knockdown | heavy 53, knee 14, out 3, flash 1 | heavy 72, out 6, knee 3, flash 2 | heavy 39, out 1 |

And the person: **rocks the AI 3.1 times a fight, winds it 3.9, floors it
0.13; hurt it at least once in 100% of fights (it was 7%), floored it in 10%
(0%)**; lands 86 a fight (33), is stuffed 7 times (31), wins 13% (0%).

Against the targets: somebody visibly hurt once or twice — yes, in every
fight; a knockdown in 35–55% of fights — AI v AI 55%, the bots' fights 63–67%
(over); a one-punch finish in 2–5% — 2 / 4 / 3%.

**Worse than I wanted, and why I stopped:**

- **Too many rocks.** 19 rocking shots a fight between AIs (15 before): a
  hurt episode every 8–9 s. Lowering the bar so a person's hook counts lowers
  it for the AI too; the compression and the raised bar after a hurt took the
  knockdowns down (1.6 → 1.2 a fight, three-knockdown stoppages 13% → 8%) but
  not the rocks, because any stacked power shot still clears a fresh bar. The
  honest next step is in the AI or in the bonuses (stop them multiplying), not
  another scale here. First knobs: `hurtAfterScale` up, `hurtStunBaseScale`
  back toward 1.
- **A person still wins 13%** against medium at this stand-in's level (no
  slips, no reads, guard broken 8.6 times a fight). His guard breaking that
  often is its own finding: `guardWearPerImpulse` — not in this brief, not
  changed.
- **Flash knockdowns are rare** (1–2 in 100): with the compression a one-shot
  knockdown of a man with health left needs a ~2000 N·s punch. The kind
  exists and is tested; fights rarely produce it. `hurtFlashScale` down if
  they should.

### Variety — what the sim now distinguishes (`hurtVarietyOn`)

All of it is in state and on events, seeded (never the clock, never
`Math.random`), and tested in `hurt_test`.

- **Every land**: `punchLand.zone` and `.vary` (2d above), and the reaction
  springs vary with it.
- **Rocked, three kinds** (`FighterState.hurtStyle`, event `hurtStyle`):
  `legs` — the legs are gone: he moves at `hurtLegsMove` 0.6 of the rocked
  speed; `reach` — reaching for balance: the hands come `hurtReachGuard` 1.8×
  further off the head and exposure is × `hurtReachVuln` 1.2; `cover` —
  covering up: the hands stay on the head, a held guard is a real guard
  (`hurtCoverBlock` 1 instead of `stunBlockScale` 0.5), and his punch lock is
  `hurtCoverLock` 2× as long. A shot `hurtOverLegs` 0.5 or more over the bar
  is legs or reach, never cover; hooks and uppercuts lean toward the legs.
  In fights: legs ~45%, reach ~31%, cover ~24%.
- **Winded, three kinds**: `fold`; `elbow` — an elbow clamped down (the liver
  side, mostly): the hands hang `hurtElbowDroop` 1.6× further, the feet are
  better (`hurtElbowMove` 1.4); `knee` — sinking toward a knee: the fold is
  `hurtKneeBuckle` 1.6× deeper in real height, the feet `hurtKneeMove` 0.5.
- **A beat late**: `bodyHurtLateChance` 0.35 of body hurts do not show at
  once — `FighterState.hurtDelay` counts down 0.25–0.5 s, then he folds
  (`hurtStyle` event with `late: true`). The liver shot already did, always.
- **Knockdowns, four kinds** (`knockdown.kind`, `FighterState.downKind`):
  `flash` — one shot on a man with ≥ `knockdownFlashHealth` 0.4 left: up
  `knockdownFlashEarly` 3.5 counts early (at two to four), never slumps;
  `heavy` — everything else: up `knockdownHeavyLate` 1 count late, or not;
  `knee` — taken by choice (below); `out` — the instant KO.
- **The instant KO**: a head shot of `stunOutFrac` 3.3× his bar as it stands
  (or `stunOutFinishFrac` 2.4× on a man already rocked): `knockdown` with
  `kind: 'out'` and `fall` `'stiff'` (a hook or cross on an upright man) or
  `'crumple'` (an uppercut, or a man already gone), and on the same tick
  `ko` with `waved: true`. No count, no `countTick`, no get-up phases; his
  `downT` runs in the `over` phase so the fall has time to play.
- **Taking a knee** (`takeKneeOn`): a hurt fighter holding BLOCK + LEVEL for
  `takeKneeHold` 0.4 s, without pushing the stick forward, with nobody within
  `clinchRange` + `takeKneeClear` 0.25 m, goes down by choice. A knockdown on
  the cards and toward the three-knockdown rule; the hurt state ends, he is
  up at `takeKneeCount` 7 (± a half) with `takeKneeStamina` 75% wind. In
  clinch range the same hold ties up. The AI takes one when rocked under
  `aiKneeHealth` 30% health with no knockdown yet, `aiKneeChance` 0.3 (14 in
  60 AI v AI fights). First cut fired on the AI's walk-in clinch (169 knees
  in 40 fights): hence the stick and distance conditions.

## Balance — the bot matrix

`node scripts/bot_table.mjs 8` (3 × 30 s, medium, 8 fights a cell — small):

| Bot | Before (toggles off) | After items 2 + 6 + 3 |
| --- | --- | --- |
| jab-and-move | 65% | 63% |
| inside-fighter | 55% | 40% |
| counter-puncher | 30% | **8%** |
| masher | 0% | 0% |
| turtle | 0% | 0% |
| legitimate plans, average | 50% | 37% |
| knockdowns a fight (legit) | 1.3 | 0.9 |

Masher and turtle still lose every fight (the guard being nearly free did not
save the turtle: 0 wins in 55 fights across both tables). **Balance did move, against the
scripted plans**: the AI uses what changed better than they do — it throws
combinations (which now land and finish), and the bots' jabs no longer erase
its punches. The counter-puncher bot fell furthest (it does not win ≥ 50%
against any style now; target not met), and the outboxer wins 79% across the
legitimate plans (target ≤ 75%). Not retuned: the bots were written against
the old interrupt, and the fix belongs with whoever next touches the AI's
difficulty curve. `ai_tools_test` is green.

## Gym drills

`src/ai/drills.ts` (registered in `src/ui/drills.ts`: controls, and the
drill's own `tune` passed through). Thirteen now; the six new ones:

| Drill | What it is for | The stat it shows |
| --- | --- | --- |
| `combinations` | a partner who stands in front, hands at rest, stands still while you work and comes back after: 1-2-3, 1-2-body-hook | finishers, third clean punches, longest combination |
| `combinations-ropes` | the same man with his back on the ropes | the same |
| `trading` | he hits you on a 0.9 s beat (jab, cross, jab, hook): throw through it | thrown while being hit, how many landed, how many were stuffed |
| `stamina-pace` | a minute, a partner who blocks half the time and never hits back | thrown, missed, tank and ceiling |
| `stamina-guard` | hold your guard: 15 s of jabs, then hooks and crosses | light / heavy shots on the guard, tank, guard meter |
| `hurt` | a worn man (60% health, a worked body): rock him, fold him, floor him | rocked / winded / floored and every kind seen |

Partners in the working drills are durable (a fifth of the health per punch,
a tripled bar) and every drill that can reach a count runs it at 0.3× the
length. **The three known faults:** `survive` — an idle player is no longer
floored in a second (the finish needs a real shot now), and its progress
counts clean shots taken, so standing there still fails; a knee taken by
choice is not "went down". `cut-off` — the partner now runs ALONG the ropes
toward the open side instead of backing into them, and progress is punches
landed while he is on them; walking straight at him no longer finishes it.
Dead counts — the quick count above (`tune` on the drill).

## Tests

Added: `flow_test` (47), `stamina_test` (19), `hurt_test` (34); `drills_test`
grew to 79. Probes kept: `combo_probe`, `feel_probe`, `stamina_probe`,
`hurt_table`; `scripts/bots/human_pace.mjs` (the stand-in for a person — not
in the bot matrix).

A finding from writing that bot, not acted on: BLOCK pressed inside the first
60% of a wind-up is a feint (`feintCommit`). A player who goes back to his
guard the instant he has pressed the last punch of a combination cancels it —
the bot did, on every third punch, until it was told to wait. If Nate's thumb
does the same, "it's so hard to follow up" has a second cause that nothing
here touches.

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
  the weighted throw cost. `ratings_test`: ten missed jabs separate a
  stamina-90 and a stamina-40 man by 18 points, not 30 (a missed jab costs
  half).
- `stun_test`, `danger_test`, `fight_test`: `hurtRatesOn` / `hurtVarietyOn`
  off — they pin the rocked formula, the liver drop, the counter flash and
  the get-up counts as designed, with one kind of knockdown. `hurt_test`
  pins the scales and the kinds.
- `drills_test`: thirteen drills; a drill's `tune` is applied; checks for the
  three faults.

All 36 Node sim tests pass (`TEST_NO_REUSE=1 npm run test:quick` with the
names) and `tsc --noEmit` is clean. The browser checks (`*_check.mjs`) are not
mine and I did not run the set, but two share a name with a Node test and ran
with it, and both fail one assertion each:

- `flow_check`: "the gym lists the seven drills and free sparring (14)". Mine:
  there are thirteen drills now. The check needs its number changed (UI's
  file); everything else in it passes, including a drill running.
- `stun_check`: "the scene is in slow motion for the beat" (game/wall 0.86
  mid-way through this work, 1.02 at the end; it wants < 0.85). The host's
  slow motion is started by the `rocked` event for a fixed wall time
  (`main.ts`), which I did not touch, and the check times it over two long
  headless frames. I did NOT establish whether it fails without my changes.
  If it does not, the suspects are the shorter rock freeze under the budget
  and the extra `hurtStyle` event on the same tick.

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
| The kind of rocked | `FighterState.hurtStyle` `'legs' \| 'reach' \| 'cover'`; event `hurtStyle {side, kind: 'head', style, late}` | legs: knees buckling, stumbling steps; reach: arms out for balance, head exposed; cover: both gloves clamped on the head, hunched |
| The kind of winded | `hurtStyle` `'fold' \| 'elbow' \| 'knee'`; event `hurtStyle {kind: 'body'}` | fold: bent at the waist; elbow: one elbow pinned to the side that was hit (`punchLand.zone` / `liver` says which), leaning onto it; knee: sinking, one knee toward the canvas (the sim's body is already 1.6× lower) |
| A body shot that lands late | `FighterState.hurtDelay` > 0 (s until he folds); then `bodyHurt` + `hurtStyle {late: true}` | hold the upright pose, a beat of stillness, then the fold — and the sound of the breath going |
| The kind of knockdown | `knockdown.kind` `'flash' \| 'heavy' \| 'knee' \| 'out'`, `FighterState.downKind`; `knockdown.over` (× his bar, head shots) | flash: sits down, straight back up, annoyed; heavy: the full struggle (`getUp` phases); knee: goes down under control, one knee, looks at his corner; out: below |
| Out before he lands | `knockdown.kind === 'out'`, `knockdown.fall` / `FighterState.fall` `'stiff' \| 'crumple'`; `ko.waved === true` on the same tick; `downT` keeps running in the `over` phase | stiff: falls like a plank, arms where they were; crumple: the legs fold under him. The referee waves it off — no count audio, no count UI |
| Taking a knee | `FighterState.kneeT` (s the input has been held; goes down at `takeKneeHold`), then `knockdown.kind === 'knee'` | the dip as he decides (kneeT / takeKneeHold is a 0..1 ramp), then the knee; controls card: BLOCK + LOW, held, nobody in reach |
| The raised bar after a hurt | not in state as a field (sim-private); `sim.stunThreshold(f, cfg)` returns it | nothing to draw — if a read is wanted for "he has his legs back", compare that against the fresh value |
