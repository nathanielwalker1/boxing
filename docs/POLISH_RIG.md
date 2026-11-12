# Polish phase — MOTION workstream log

Items 4 (punch animation) and 7 (the clinch) of the polish phase
(`docs/OVERHAUL.md` "Polish phase"). Branch `worktree-agent-a205592bc08b9f7de`,
fast-forwarded to `overhaul/fight-and-look` at `3f52945` before any work (the
worktree had been created on `origin/main`). Written 2026-11-11. Nothing here
has been feel-tested.

How to A/B everything: `?tune=1`, groups **punch pose** and **rig chain**.
`hookV2`, `uppercutV2`, `straightV2`, `clinchV2` — off = the motion as it was.

Tools added: `scripts/chain_probe.mjs` (the chain in numbers, per tick, from
the real sim and the real rig), `scripts/filmstrip.mjs polish_<punch>_<hand>_<range> before|after`
(rows 1–2 the pair from the play camera, rows 3–4 the puncher, whole body in
frame, every 2 ticks from the press), `window.__rig[side].chain()`.

---

# Item 4 — punch animation

Nate: "Hooks and uppercuts look goofy and the body doesn't work together when
throwing."

## 1. Before — what the frames showed

Strips: `docs/polish/strip_<punch>_<hand>_<range>_before.png`. Frames read at
full size (`scripts/output/filmstrip/frames/pc_*`, not tracked).

**Lead hook, 0.85 m** (press t=2, hit test t=17)
- t=10: a small coil the wrong way, legs unchanged, the lead arm folding with
  the elbow coming forward.
- t=14 (three ticks before the hit): the whole man has already turned — his
  back is square to the ringside camera, BOTH feet have spun about 90° on the
  canvas, both heels are up — and the punching fist is still beside his own
  head. The body arrives, then the fist.
- t=18 (contact): pelvis turned further than the shoulders, both feet pointing
  along the ropes, the fist in front of his own face. From the play camera
  (behind his right shoulder) he has turned so far that you see his chest.
  He looks like a statue on a turntable.

**Rear hook, 0.85 m** — t=14: back square to the camera, the rear arm reaching
forward nearly straight, elbow low: a wide straight, not a hook. t=18: it
lands with the arm at shoulder height; same turntable legs.

**Lead uppercut, 0.55 m** — t=16 → t=20: the fist comes from low by the chest
to above the chin in four ticks while the body stays the same height by eye.
No visible sit and no visible leg drive; the torso is upright throughout.

**Rear uppercut, 0.85 m** — t=20: the arm reaches up and forward nearly
straight with the elbow ABOVE the shoulder, the fist over the other man's
guard at forehead height. It reads as lifting an arm over a fence. Legs
straight.

**Cross, 0.85 m** — t=14: reads as a cross (back turned, arm over, rear heel
up). The head stays bolt upright on the centre line. **Jab** — t=8: arm out,
body square, nothing wrong and nothing happening below the shoulders.

## 2. Before — the chain in numbers

`PORT=5193 node scripts/chain_probe.mjs cfg:hookV2=false cfg:uppercutV2=false cfg:straightV2=false`
(0.85 m, red v blue; t = sim ticks, press at t=2; "fastest" = the tick of the
channel's peak rate before the hit test).

| Lead hook (hit t=17) | starts | fastest tick | extreme |
| --- | --- | --- | --- |
| shoulder yaw (sim twist) | t=4 | **t=12** | 83° — after first going 25° the WRONG way (t=7) |
| hip yaw (drawn) | t=6 | **t=15** | **100°** (more than the shoulders) |
| punching-side foot pivot | t=6 | t=15 | **129°** — and the other foot took the same |
| heel | t=11 | t=12 | 6 cm |
| hip height | — | t=16 | 80 → 87 cm in 3 ticks (a hop) |
| fist sideways | t=7 | t=13 | −20 → **+21 cm at t=14**, then back to +6 at the hit |
| fist forward | t=9 | t=16 | 38 → 66 cm in the last 3 ticks |

Reading: shoulders lead, hips follow 3 ticks later through a spring, the foot
last — the chain backwards. The hips out-turn the shoulders. The fist rides
the shoulders across the front of his own face to the FAR side before the
extension starts, and the extension then pokes it forward and back out: at
contact a left hook is travelling forward and to the left. That, the 129° feet
and the hop are the "goofy".

| Rear uppercut (hit t=20) | starts | fastest tick | extreme |
| --- | --- | --- | --- |
| hip height | t=4 | **t=19** | sits 7 cm over 13 ticks, bottom at t=16, then **+12.5 cm in 4 ticks** (5.1 cm a tick) |
| shoulder yaw | t=5 | t=15 | 49° |
| hip yaw | t=7 | t=17 | 35° |
| elbow angle | | | folds to **18°** at t=18 |
| elbow above shoulder | | | **+15 cm at the hit** (lead hand: +10) |
| fist height | t=5 | t=19 | drops 39 cm (159 → 120), then 21 cm a tick |

Reading: the sit is slow and shallow and all of the rise is inside the
extension — a pop. The arm collapses to 18° as the fist passes the shoulder and
finishes with the elbow above the shoulder — the wing in the t=20 frame.

Cross: shoulders fastest t=10, hips t=13, foot t=13 (backwards again, by 3
ticks); the elbow is 17.6 cm ABOVE the shoulder at t=9 (a wing in the wind-up
— sim side, not changed, see "still wrong"). Jab: shoulders t=7, hips t=9.

Head: on a lead hook the head is 24 cm BEHIND the lead shoulder at contact and
7.6 cm forward of the feet — already behind the shoulder. On rear-hand punches
it is 20–23 cm ahead of the LEAD shoulder (which has gone back) and behind the
punching one. Not the problem.

## 3. What changed

New file `src/sim/chain.ts` (pure curves) and a block at the end of
`src/sim/punches.ts`; `src/sim/arms.ts` (uppercut elbow); `src/rig/index.ts`
(hips, feet, knees, shoulders). Each punch has a timing in fractions of its
flight (press → hit test):

| | load done | hips done | shoulders start | legs start up |
| --- | --- | --- | --- | --- |
| hook (15 ticks) | 0.30 | 0.80 | 0.55 | 0.50 |
| uppercut (18 ticks) | 0.42 (the sit) | 0.88 | 0.55 | 0.58 |
| jab / cross | 0.15 | 0.75 | (sim's own: 0.22 / 0.30) | (sim's own) |

- **Hips lead, and turn less than the shoulders** (`rigChainHipFollow` 0.6,
  `rigChainHipRate`): the rig draws the hips from `chainHip`, ahead of the
  sim's shoulder line, instead of chasing the shoulders through a spring with
  ×1.6 on a hook.
- **One foot pushes, the other stays** (`rigChainOffFootPivot` 0.2): the rear
  foot for a rear hand and the jab, the lead foot for a lead hook / uppercut.
  Its heel comes up with the hip drive (it was keyed on the forward lean, which
  peaks with the fist), its knee turns in (`rigChainKneeIn`). In the load the
  hips shift 4.5 cm onto that foot (`rigChainLoadShift`).
- **Hook** (`hookV2`): shoulder turn 83° → 69° (`hookTurn` 1.2), coil 25° → 14°
  (`hookCoil`). The fist no longer rides the shoulders through the wind-up: it
  goes out beside the punching shoulder, low, elbow down (`hookCockFwd`,
  `hookCockOut`), and through the extension comes round and across to the SAME
  peak as before (`hookArcFwd`, `hookArcOut`, `hookArcLow`, `hookArrive`). The
  sit is 6 cm, done by 30% of the flight, and the legs straighten from 50% —
  not inside the last three ticks.
- **Uppercut** (`uppercutV2`): sit 12 cm (`uppercutLoadDip`; was 9; 14 put the rear knee nearly on the canvas in the pose grid) and at the bottom by 42% of
  the flight (was the last tick of the wind-up); the legs drive up from 58% to
  the hit test; the chest rolls 9° toward the punching side in the sit and the
  drawn shoulder drops 3 cm (`rigUppercutDropDeg`, `rigUppercutShoulderDrop`);
  the fist scoops forward and low before it rises (`uppercutScoopFwd/Low`); the
  elbow is back only while he sits, then comes forward under the fist and may
  not flare (`uppercutFlareMax`).
- **Jab / cross** (`straightV2`): the DRAWING only — hips ahead of the
  shoulders, the rear heel with the hip drive, the lead foot planted on a
  cross, the jab's lead foot steps 7 cm and its lead shoulder rises 2.5 cm
  (`rigJabStep`, `rigJabShrug`). The sim's shoulder line, dip and fist are the
  old ones to the digit (see decisions).

## Decisions (made for Nate, with reasons)

1. **The fist at the hit test is where it was.** Measured in Node
   (`scripts/_debug.mjs`, old v V2, 13 punch / variant cases × 3 ranges): the
   glove at the resolve tick is within 0.1–3.6 cm of the old one for every
   free-air case, and the range at which each outcome begins and ends (1 cm
   scan, 0.40–1.05 m) moves by at most 2 cm (hook whiff 88 → 90 cm, uppercut
   71 → 72). Timing is untouched (same tick). The one larger difference: a
   cross jammed at 0.55 m ended 8 cm from where the old one was pressed against
   him — that is why the straights' sim side was then left alone entirely.
2. **The straights are rig-only.** Giving the cross the new dip curve changed
   which guard glove it met inside smothering range (punch_test "a land
   through the hands" 1.116 → 0.391, stun_test's finish, heights_test
   cross→boiler). Outcomes the tests pin; so `straightV2` does not touch the
   sim.
3. **The hook's arc is narrower and lower than it should be by eye, on
   purpose.** A true round hook (`hookArcOut` ≥ 0.45, or level with the chin,
   `hookArcLow` ≤ 0.75) lands on the guard glove a man rests by his cheek —
   correct boxing, but danger_test's flush slip-counter hook (638 instead of
   > 900 N·s) and slipx_test's loaded hook then fail; and at `hookArcLow` ≥ 0.9
   it goes under a peek-a-boo block from an angle (styles_test). Width 0.05–0.36
   and height 0.80–0.85 keep every pinned outcome; the defaults are 0.3 and
   0.83. **The height window is 3 mm wide in practice — flagged below.**
4. **timing_test was edited in two places**, both about pose authoring: the
   hook's peak twist is compared with `hookTurn` when `hookV2` is on (it was
   the table's 1.45), and "the head box drops with the crouch" samples the
   head at rest before the press (the V2 uppercut sits 7 mm in its first tick,
   which the test took as rest). `hookCoil` is 0.2 rather than the 0.12 I
   wanted because the same file wants the hook's coil larger than the cross's.
5. **The rig imports `chainPose` from `src/sim/punches.ts`** (pure functions of
   punch type / progress / config). `rig/replay.ts` already imports the sim;
   nothing in the sim imports the rig.
6. **Lateral weight in the sim (`lean.lat`) is unchanged** — it is set in
   `combat.ts` (not mine). The load onto the punching foot is drawn only.

## 4. After — the chain in numbers

`PORT=5193 node scripts/chain_probe.mjs` (same probe, toggles on).

| Fastest tick of each link | foot / heel | hips | shoulders | fist | hit test |
| --- | --- | --- | --- | --- | --- |
| lead hook, before | 15 / 12 | 15 | **12** | 16 | 17 |
| lead hook, after | **11 / 11** | **11** | 14 | 15–16 | 17 |
| rear uppercut, before | 17 / 15 | 17 | 15 | 19 | 20 |
| rear uppercut, after | 15 / 14 | 15 | 17 | 19 | 20 |
| cross, before | 13 / 10 | 13 | 10 | 13 | 14 |
| cross, after | 9 / 8 | 9 | 10 | 13 | 14 |
| jab, before | — | 9 | 7 | 7 | 8 |
| jab, after | — | 6 | 7 | 7 | 8 |

| | before | after |
| --- | --- | --- |
| hook: hip turn / shoulder turn | 100° / 83° | 41° / 69° |
| hook: pushing foot / other foot pivot | 129° / 129° | 54° / 8° |
| hook: fist sideways through the punch | −20 → +21 (t=14, the far side) → +6 | stays on the punching side until the extension, then across to +6; 18 cm a tick at t=15 |
| hook: hip height | 80 → 87 cm in 3 ticks | sits to 76 by t=6, up from t=9 at ≤ 1.9 cm a tick |
| hook: fist at the hit test (fwd, up, across) | 65.9, 161.7, 6.2 cm | 65.9, 161.6, 6.3 cm |
| uppercut: the sit (drawn hips) | 7 cm, bottom at t=16 | 12 cm, bottom at t=10 |
| uppercut: fastest rise of the hips | 5.1 cm a tick (t=19) | 3.1 (t=17) |
| uppercut: elbow above the shoulder at the hit | +15 cm rear, +10 lead | −5 rear, −4 lead |
| uppercut: tightest fold of the arm | 18° | 33° |
| head past the lead shoulder (lead hook) | −24 cm | −24 cm |

## 5. After — the frames, honestly

Strips: `docs/polish/strip_<punch>_<hand>_<range>_after.png`.

**Lead hook 0.85 m.** t=14: he has turned about half as far as before — you
see his back three-quarter, not flat — the lead foot is up on its ball with
the heel out, the rear foot has not moved, the knees are bent, and the fist is
low and out beside the lead hip, not by his head. t=18: the fist is on the
head, the elbow level with it, hips visibly behind the shoulders, lead knee
turned in. It reads as a hook thrown off the front foot. From the play camera
(t=16) the punching arm is hidden behind his own body and what you see is his
chest coming round and his rear glove — less of the chest than before, but the
lead hook is still mostly read from the body, not the arm, at that camera.
**Rear hook 0.85 m.** t=16–18: back three-quarter, rear heel up and turned,
lead foot planted, the arm comes round with the elbow level. The arm is still
long — it reads as a wide hook.
**Lead uppercut 0.85 m.** t=12: a real sit — thighs angled, hips low, the fist
down out of sight. t=18: coming up, the fist forward at chest height with the
forearm rising, lead heel up. t=20: standing tall, legs straight, the fist at
chin height with the elbow under it. This is the clearest improvement.
**Rear uppercut 0.85 m.** t=20: the elbow is no longer above the shoulder, but
at this range (it is a miss: the uppercut reaches 0.71 m) the arm still reaches
forward at shoulder height. A long uppercut still looks like a reach.
**Body hook 0.7 m** (t=28): crouched, the torso bends into it, the glove is on
the ribs — not in them — and the lead foot has turned. **Shovel hook 0.55 m**
(t=16): compact, the fist comes up between the gloves onto the head, the head
goes. **Scenario strips**: `flush_counter` re-filmed and read (`inside` was re-filmed and NOT read; the uppercut strips were shot at the 14 cm sit, before it was eased to 12; fps was not measured — nothing new is drawn, the cost is one `chainPose` call per fighter per frame): the counter
hook lands at t=24–27, the head whips, sweat comes off, he staggers; nothing
passes through an arm or a torso.
**Jab, cross.** Hard to tell from before at strip size: the cross's rear heel
is up earlier and the lead foot stays put; the jab's step and shoulder are a
few centimetres and I cannot see them at the play camera.

**Pose grid** (`scripts/pose_grid.mjs`, side-on, hitboxes on, low mesh; read at the 14 cm sit, before it was eased to 12). Hook, lead and rear, both sides: p=0.15–0.3 the knees bend; p=0.45 the body has started round and the punching glove is low and out wide at chest height (a visible wind-up — see "still wrong"); p=0.6 the fist is on the head, the glove sphere on the glove, the head sphere on the skull, the body capsule inside the torso; nothing passes through a torso. Uppercut: p=0.3–0.45 a deep sit with the fist by the hip — on the rear uppercut at p=0.45 the rear knee was nearly on the canvas, which is why the sit was eased; p=0.6 standing tall, fist at head height in front, elbow under it. Jab and cross sheets were written and not read.

## Still wrong / worse than wanted

- **The hook is not round.** The arc is 0.3 shoulder-widths wide and travels
  low (decision 3). By eye a hook should come round level with the chin and
  land on the side of the head. It cannot while a resting guard glove sits by
  the cheek and the tests pin that the slip-counter hook goes past it.
- **`hookArcLow` sits in a 3 mm window** (0.80–0.85 of a head radius). Any
  change to guard heights, head radius or the aim tracking can push the counter
  hook onto the glove or under a block. Whoever next touches guards should
  re-run danger_test and styles_test and, better, decide which outcome is
  wanted and widen it (see "pinned numbers").
- **The hook's fist drops ~13 cm in the wind-up** (6 of it is the sit). It is a
  tell, deliberately low to clear the glove; it may read as a dropped hand.
- **A long uppercut still reaches.** The peak is pinned; an uppercut thrown
  from 0.85 m finishes with the arm out in front. Only the range can fix it.
- **The cross's elbow is 17.6 cm above the shoulder at t=9** (a wing in the
  wind-up). Sim side; left alone because the cross's contacts are pinned.
- **The head does not go off the centre line on a cross.** The head sphere is
  placed in `reaction.ts` `computeBoxes` (not mine); a drawn-only offset would
  break "hit geometry = drawn geometry". Wanted: a lateral head shift per unit
  of a punch's sway, in the sim, toward the punching side's opposite.
- **Lead-hand punches are hidden from the play camera** by the puncher's own
  body. That is the camera, not the motion.
- **Palm in on the uppercut** was not done (the glove still pronates with the
  arm's extension).
- The jab's step is drawn by moving the lead foot's rest point 7 cm; the foot
  planter decides when to take it. Not measured, not visible in the strips.

## Pinned numbers I think should move (for the orchestrator)

1. **The guard glove at the cheek vs. the hook** (danger_test 4b, slipx_test
   "lead hook off a slip", styles_test "hook from 12° off his line"). Today the
   pinned outcome is "a hook passes the resting rear glove and lands flush".
   A round hook lands ON that glove — a muffled land through the hand. If hooks
   are to look like hooks, either the resting rear glove moves 3–4 cm forward
   of the cheek, or those three tests accept the land-through. Then set
   `hookArcOut` 0.55, `hookArcLow` 0.
2. **`timing_test` "a hook turns the torso to its own turn"** — now compares
   with `hookTurn` (edited). If `hookV2` stays, drop `PUNCHES.hook.turn` 1.45 →
   1.2 and delete the toggle branch.
3. **The cross inside smothering range** (punch_test "a land THROUGH the
   hands", stun_test finish, heights_test cross→boiler): these flip on a 3 cm
   change of fist height mid-extension. They are why the straights could not
   get the sim-side dip and shoulder timing.

---

# Item 7 — the clinch

Nate: "The clinch animation is awful, it's like they're making out."

**Outcome: the clinch is taken out** (`clinchOn` false by default). A re-build
was written, measured and filmed, does not look like two boxers tied up, and
is left in the tree behind `clinchV2` (default off) as an experiment.

## Before — measured (`node scripts/_debug.mjs clinch`, old clinch)

- Entry: none. At the tick it takes, both men stop where they stand (0.60 m in
  the probe) — no reach, no pull.
- Bodies: square to each other, 0° off the line, no lean in the sim at all.
- Heads (as drawn: the sim's sphere + the rig's 9 cm slide forward and to the
  lead side): centres 0.46 m apart, surfaces 17 cm; each man is looking 23° off
  the other's head — face to face. The drawn chest pitches 22° on top, which
  closes it further on screen.
- Arms: the sim leaves the gloves at the guard; the rig draws them round the
  other man. `strip_clinch_before.png`, play camera t=60: blue's face a few
  centimetres from red's, looking into it; red's right glove comes out of
  blue's back.
- Duration 1.40 s; ends with the referee's break, a hop to 1.20 m. No turn, no
  footwork.

## The attempt (`clinchV2`, `src/sim/clinch.ts`, `src/sim/gloves.ts` `clinchLocal`)

The tie-up moved into the sim: over 0.3 s the pair are pulled to 0.70 m, both
turn 30° the same way round (lead shoulder in) and lean 32 cm in
(`lean.fwd` 1.8), the pair turn about their midpoint at 0.45 rad/s, the hands
aim at the other man's flank (lead, under) and the back of his shoulder (rear,
over), and the lean and hands release over 0.25 s after the break.

Measured: heads 0.36 m apart at lean 1.5 (surfaces 7 cm), each man looking
**80°** off the other's head — no longer face to face; yaw 30° off the line;
glove depth in the other body 0–3.9 cm, worst 5.4 cm during the pull; break at
1.40 s to 1.19 m; level_test's clinch section passed unchanged.

Filmed (`docs/polish/strip_clinch_v2_attempt.png`, play camera and from above,
t=30 and t=60): **it does not read as a clinch.** The two stand upright, turned
side-on, pressed past each other like two people squeezing through a doorway,
facing nearly opposite ways; the torsos merge by several centimetres; red's
hands are still up in his own guard rather than on blue. It is not "making
out" any more, and it is not boxing either.

Why, and why I stopped:
- In the sim the head rides rigidly above the middle of the shoulder line
  (`computeBoxes`). To put a head over the other man's shoulder the whole
  shoulder line has to go there, so the chests overlap: with the heads level
  the shoulder centres are 33 cm apart and the torso capsules are 40 cm wide.
  A real clinch needs the head to move off the shoulders (a neck), which is a
  change to `reaction.ts` — not this workstream's file this phase.
- The lean is along each man's own facing, so turned bodies shear past each
  other instead of leaning INTO each other.
- The glove targets are cut along the puncher's forward axis so a fist stops
  on a face; that same rule keeps a hand from going round a body.

## What was done instead

- `clinchOn` defaults to **false**: block + level together ties nobody up, and
  the AI never tries (every AI use is already gated on `cfg.clinchOn`;
  `ai_tools_test` now asserts it uses the clinch 0 times).
- `level_test` section 9 switches `clinchOn` on for itself and still pins the
  mechanic; a new check pins the default.
- `clinchV2` defaults to false, so switching `clinchOn` back on gives the old
  clinch exactly.
- Not mine, for the orchestrator: `src/ui/controls.ts` still says the push-off
  "breaks a clinch"; the Survive drill's test bot (`scripts/lib/drill_bots.js`)
  holds block + level to tie up (drills_test still passes — it now just
  crouches behind the block); `clinchHurtRecover`, the crowd's clinch grumble
  and the `clinchThud` sound are unreachable while it is off. A hurt AI's
  `hurtPlan: 'clinch'` falls through to nothing — worth a look at what it does
  instead (cover, presumably).

## What a real clinch would need (if it comes back)

1. `computeBoxes`: a head offset relative to the shoulder line while tied up —
   forward ~12 cm and ~15 cm toward the head's outside — so the heads pass with
   the chests touching, not merged.
2. The lean taken along the LINE to the other man, not the facing.
3. Hands placed by the sim on the other man's back with their own rule
   (exempt from the forward-axis cut), elbows out.
4. Then the entry, turn and release already in `clinchV2`.

---

# Drills wanted (for `src/ai/drills.ts` — not mine)

**Punch animation, "Bag work".** Partner: stands still in the high guard at
0.75 m, never punches, never moves; health does not drop. Two minutes. The
card: "Throw each punch slowly, one at a time: lead hook (stick left + hook),
rear hook, lead uppercut, rear uppercut, cross, jab. Then step to 0.55 m and
do the hooks and uppercuts again." What to look at: does the foot turn before
the shoulders; does he sit before the uppercut and come up through it; does
the hook come round or poke; is the head behind the shoulder. With `?tune=1`
flip `hookV2` / `uppercutV2` / `straightV2` and throw the same punch again.

**Clinch.** Only if it comes back: partner walks in to 0.6 m and holds block +
level every 4 s; the player does nothing for the first one (watch the entry,
the heads, the hands, the turn, the break), pushes off the second.


---

# Phase B — hit, hurt, floored (rig only) — CUT SHORT

Nate asked for a wrap-up part-way through part 1. State at the stop:

| Part | Code | Toggle (default) | Filmed |
| --- | --- | --- | --- |
| 1. Landed punches by zone / grade / vary — HEAD | `rig/reads.ts` `reactV2` | `rigReactV2` (on) | yes: `strip_react_head_after`, `strip_react_grade_before/after` |
| 1. …BODY zones | same | `rigReactBodyZones` (**off**) | one strip, badly framed — not verified |
| 1. …blocked cross / hook / worn guard told apart | same | rides `rigReactV2` (on) | **not filmed** |
| 1. …`vary` | same | `rigReactVary` | **not filmed** |
| The neck follows the head past `rigNeckReach` | `rig/index.ts` | always | seen only in the head strips |
| 2. Rocked / winded sub-kinds, `hurtDelay` | written | `rigHurtV2` (**off**) | no |
| 3. Knockdown kinds, stiff / crumple, `kneeT` | written | `rigDownV2` (**off**) | no |
| 4. Nerfed punch, flinch | written | `rigNerfV2` (**off**) | no |
| 5. Combination: heels, follow step | written | `rigComboV2` (**off**) | no |

Parts 2–5 have never been drawn in front of anyone, me included: treat them as unreviewed code, not as features.
Film scenarios for all of them are in `scripts/filmstrip.mjs` (sheets `react_head`, `react_body`, `react_grade`,
`react_vary`, `react_block`, `hurt_rocked`, `hurt_body`, `kd_fall`, `kd_up`, `nerf`, `polish_combo`), each a real sim
outcome checked in Node (flash = `stunBase` 96, out + stiff = 60 with a cross, out + crumple = 60 with an uppercut,
heavy = `healthDamagePerImpulse` 0.006, a knee by choice at t=26, a nerfed cross at nerf 0.70, a late body hurt at t=55).
`rig/replay.ts` gained `land` (re-label punchLand for the views) and `init` (start a side hurt in the sim).
A sheet takes 2–3 minutes on software GL; that, not the code, is what ran out.

**What the strips show.** `strip_react_head_after` (one clean cross, re-labelled per zone, close on the man hit):
chin — the head goes back, face tipped up; jaw — the head TURNS away, you see the side and back of the skull; temple —
it tips sideways; nose and forehead — back, less than the chin, and hard to tell from each other and from a small
chin shot. The first cut pointed the face at the ceiling on a clean chin shot; the pitch was cut and the neck angles
clamped. `strip_react_grade_after` (play camera): glancing — the head stays level; clean — it tips back, a few
droplets; flush — thrown well back, more spray; finisher — I cannot tell it from flush. Against
`strip_react_grade_before` the three grades are a little further apart, not dramatically. These strips re-label
one sim punch, so the sim's own bigger head travel on a real flush land is NOT in them.
`strip_react_body_after`: the camera framed the puncher; the four rows look the same. Hence the off-by-default key.

`hurt_test` (the SIM agent's, merged) failed on the integrated branch because the clinch is off by default now; its
"the hold is a clinch, not a knee" check runs with `clinchOn` on.

Not done from phase A: the uppercut after-strips are still the 14 cm ones; jab / cross pose-grid sheets unread; no fps
measurement. The `inside` strip was read: shovel hook lands at t=15–21 with spray, the uppercut and body hook follow,
blue's hook comes back at t=30–36; nothing passes through a torso; at t=24–27 blue's lead glove is flung high and wide
(the sim's knocked guard).
