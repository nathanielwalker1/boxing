# Feel — principles, evidence, and where each one lives

How the fighters are supposed to move and hit, why, and which knob does it.
Written 2026-09-16 after three feel-test rounds with Nate and a research pass on
Fight Night (Round 3/4/Champion), EA UFC, Thrill of the Fight, Undisputed and
boxing biomechanics. `CONTRACT.md` says what gets built; this says what it must
feel like. Read it before touching `src/sim/punches.ts`, `src/sim/reaction.ts`,
`src/ai`, or the motion layer of `src/rig`.

## The six principles (cross-cutting — every system obeys all of them)

1. **Ground up.** Every action starts at the feet. A punch is a push off the
   rear foot; a step is a push-off, not a glide. Kinetic chain: heel → hip →
   shoulder → fist. Elite boxers differ from novices mostly in *hip* rotation
   on hooks and uppercuts (PMC7739747).
2. **Load, drive, follow-through.** Weight goes *back* before it comes forward.
   The body is turning into the punch before the fist leaves; the fist leaves
   last; the body holds with the fist on the target, then unwinds with it.
3. **Nothing is instant.** Humans react in 0.15–0.25 s. Instant reactions read
   as cheating (Street Fighter II's input-reading AI is the cautionary tale).
   Bodies have mass: acceleration curves, springs that overshoot, hits that
   play out over half a second.
4. **Spacing is a conversation.** Probe → read the other fighter's commitment →
   punish or reset. Distance held is a by-product of that loop, never a
   controller setpoint (that is the "magnet"). Fight Night's R.E.A.L. AI and
   EA UFC pick spacing behaviour *per style*; Ring Generalship is a per-fighter
   slider.
5. **Tempo.** Bursts and lulls. Real exchanges are two or three punches, then
   space. An even cadence of single punches is a metronome.
6. **Stamina flattens everything.** Movement, footwork looseness, punch speed
   degrade off the same bar (Undisputed's loose → flat-footed).

Plus one rule of the rig: **hit geometry = drawn geometry.** The head sphere,
the gloves and the body capsule are the sim's; the rig draws on them. Anything
that should change what a punch can hit goes in the sim (lean shift, slip,
pull, dip), not the drawing.

## What each principle became (config key → file)

**Movement** (`src/sim/movement.ts`, `src/rig/feet.ts`)
- Momentum: `moveAccel` 7, `moveFriction` 8 (top speed in ~0.4 s, a glide on
  release). Direction: `moveBackScale` 0.8, `moveLateralScale` 0.9.
- Footwork: the foot nearest the travel steps first, the other drags shorter and
  lower; sideways is a shuffle; the leading foot's sideways step is longer
  (`rigShuffleLead`). Hips surge and bob with each push-off (`rigStepSurge`,
  `rigStepBob`). The torso leans into travel, the head leads sideways
  (`rigMoveLeanDeg`, `rigMoveHeadLead`).
- Stamina: `moveTiredScale` 0.65 on speed and push-off; `rigRhythmTired`.
- Head off the centre line at rest: `rigWeaveAmp` 0.045 (drawn head only).

**Punches** (`src/sim/punches.ts`, `combat.ts`, `gloves.ts`)
- The load: per-punch `load` × `punchLoad` sends `lean.fwd` negative and the
  hips counter-turn (`coil`) through the first 40% of the wind-up
  (`CHAIN_LOAD_AT`); the drive runs from there to the peak. Twist and lean
  HOLD with the fist (`punchHoldFrac` 0.35) and unwind with it.
- The weight transfer moves the *body*: `punchLeanShift` 0.18 moves head and
  shoulder boxes and the glove targets forward per unit lean (hips half). So
  a straight reaches ~10 cm further and the head is over the front knee.
- Hooks and uppercuts are authored in the **torso frame** (`torsoFrame`,
  `yawPose`): the fist rides the shoulders' turn, the wind-up is compact
  (fist by the chin), the arc *is* the rotation. Their impulse direction is the
  turn's tangent (`swing` 0.5 ≈ 45°).
- Turn: jab 0.45, cross 1.15, hook 1.45, uppercut 0.85 rad. Hips follow 0.7
  (`rigPunchHipFollow`), pivot on the ball of the foot (`rigPivotBall`,
  `rigPunchFootPivot` 1.3), heel lifts with the drive (`rigHeelLiftLean`).
  Shoulder reaches out of the chest (`rigPunchShoulderReach`), chin tucks.
- The jab is the whip: no pull-back, one-tick hold (`jabHoldFrac` 0.2), fist
  snapped home as hard as it went out (`jabChainRecoverK` 5). Cross/hook/
  uppercut wind-ups and recoveries are ~45% longer than v1 so the chain reads.
- Context: `punchLeanMove` (advancing leans more, retreating less),
  `punchStepIn` (a straight with the stick forward lunges 15 cm and the lunge
  is momentum), `punchRollWith` + `punchRetreatStumble` (hit while backing off:
  less impulse, longer stumble).
- The hit test sweeps the last `punchSweepLen` 0.3 m of the fist's line.
  Tick-boundary epsilon in `advancePunch` (`PHASE_EPS`); the glove target
  arrives at `chainArrive` 0.8 of the extend so the spring has settled.

**Hit performance** (`src/sim/reaction.ts`, `src/rig/index.ts`, `src/ui/audio.ts`)
- Springs ~2.5x slower than v1 (`reactionHeadK` 160 / C 9 …): jab settles in
  0.23 s, cross 0.32, hook 0.58, uppercut 0.62.
- `ReactionState.spin`: a yaw whip from the sideways impulse (`hookReactSpin`
  1.0, `reactionSpinScale`); the drawn head whips 1.5x the shoulders.
- `reactionHipFollow` 0.45: a hit bends the body back from the waist (the rig's
  `rigTorsoBend` draws the chest along the capsule).
- `staggerDecay` 8: the stumble is long enough that the feet step to catch it.
- Audio is synthesized (no files): sharp / heavy / body / blocked / counter
  sting / whiff / knockdown / bell. Camera punch-in and `camShake` per hit.
- Numbers: `healthDamagePerImpulse` 0.0003 (~14 crosses), `healthRegen` 0.06
  after `healthRegenDelay` 1.5 s up to a per-round cap (`healthCapLoss` 0.35).

**Defence** (`src/sim/slip.ts`, `punches.ts` guard/block)
- Lateral flick = slip (`slipHeadOffset` 0.33, dips `slipDip`), back flick =
  the pull (`slipBackOffset` 0.28, dir 2). Shoulders follow `slipShoulderFrac`
  0.7. The 0.33 / 0.7 pair is pinned by `slip_test`'s slip-into-the-hand body
  shot; the margins are ~2 cm.
- Guard vs block are two different poses (`guardLocal` relaxed, face visible;
  `blockLocal` covered, hunch 18°, chin tuck).

**AI** (`src/ai/index.ts`)
- Footwork modes on a seeded timer: press / probe (1.05 m) / circle / hold /
  reset (1.3 m after 40% of throws or a solid hit). Steer on the *perceived*
  position lagged by `aiReactionTime` 0.2 with `aiLookahead`.
- Reads the player: rushed → give ground or fire a jab (`aiGiveGroundChance`);
  fast retreat → `aiChaseDelay` before following. Bursts of up to
  `aiComboMax` 3 through the sim's combo window. Guard comes up
  `aiReactionTime` after it notices a punch (jabs get through, hooks meet it).
- Per-fighter styles = these weights and distances per roster entry (not yet).

## How to judge a motion change (the method that found the real problems)

1. **Measure before you tune.** `scripts/_debug.mjs` as a Node probe against
   the sim: per punch, peak head displacement / tilt / spin / torso, settle
   time, hit-stop, stumble distance, damage. The 2026-09-16 probe showed hits
   settling in 0.17–0.37 s with 0–6° of tilt and no step — that, not any
   slider, was why "combinations don't land".
2. **Filmstrips from the play camera**, close on one fighter (`__replay`,
   `__focus`, `camDistMin` 2.4, `camLookY` 1.25), every 2–3 ticks. The pose
   grid is side-on and hides what Nate sees. Look at individual frames, say
   what they show ("the elbow folds inward at t=14").
3. **Check the chain in numbers**: print twist and the glove's local position
   per tick. A hook that reads as a pop shows the twist going 0 → 1 inside the
   3-tick extend; a hook from the body shows it moving through the wind-up.
4. **One layer per commit.** Never re-author motion and change hit geometry in
   the same change without a test pinning the geometry (`punch_test`,
   `slip_test`, `counter_test` hold the measured reach/dodge margins).

## Feel-test log (Nate)

- 2026-09-16 morning: "robotic and stiff… AI magnetized… jab looks off… body
  doesn't twist and shift enough." → movement momentum, AI modes, jab whip,
  spring stiffness. Verdict: "don't see much improvement."
- 2026-09-16 afternoon: principles applied across the board (footwork, load,
  longer heavies, step-in, AI reads you, stamina). Then, with Fight Night
  screenshots: health regen, floating cross, camera too high, guard = block,
  slip too soft, punches don't stretch. → all six done.
- 2026-09-16 evening: "still clunky… punches not satisfying… can't feel
  combinations land… lead hook elbow twists inward… too much damage… not
  enough head movement… hooks should come from the legs." → analysis first,
  then the five-item pass (hit performance + audio, kinetic chain, numbers,
  weave, context variants). Verdict: **"feels much better already, but still
  needs changes and improvements."**

## Open

- Per-fighter styles (the roster's `style` field is unread).
- The AI reads none of the new hit states (spin, stumble) and has no per-punch
  hit-stop; hit-stop is power-scaled only.
- At Nate's ~0.85 m play distance a straight's fist stops at the head before
  full stretch (contact hold); the stretch shows at ~1.0 m.
- The weave is drawn-head only (up to 5 cm off the hit sphere) — a deliberate
  bend of the hit-geometry rule; if it ever matters, move it into the sim.
- Sources for the research are in the memory file
  `fighting-ai-research-2026-09-16` (Fight Night R.E.A.L. AI, EA UFC 6 deep
  dive, Thrill of the Fight interview, Undisputed reviews, PMC7739747).
