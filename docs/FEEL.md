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
- Combos (2026-09-17, principle 5 — tempo is bursts): the **hit confirm**.
  A punch that touched something opens the chain window the tick after its
  hit test (`punchChainOnHit` 0); a miss waits for `punchChainAt` 0.5 of its
  stretched recovery. A chained punch winds up `comboCockScale` 0.6 as long
  (the body is already turned). The buffer queues `punchBufferDepth` 2
  presses in order. Measured 1-2: cross pressed at 50 ms started at 217 ms
  and landed at 400; now 117 / 283. Hit-stop still freezes the attacker's
  follow-up for ~3 ticks per land (deliberate; `hitStopBase`).
- Hooks and uppercuts come home in the torso frame (`punchLocal` recovery):
  the fist folds toward the chin as the shoulders unwind and carry it. The
  rig's level elbow pole ends with the hold, so the elbow drops with the fist.
- **Solid bodies** (2026-09-18, `contactSolid`, `gloves.ts`): the glove's
  spring target is cut back along the forward axis until its path clears the
  other fighter's head and body, then the glove is pushed out of them to
  `contactSquash` × gloveR (2.9 cm, the leather) with its inward velocity
  dropped. The target stays on the free-air peak through the hold, so the
  fist presses on the skull and rides the head back — the follow-through.
  Measured before: a jab at 0.85 m sat 11 cm inside the head; at 0.7 m the
  fist passed 13 cm beyond the head centre ("fists go through the head like
  it's translucent… light and cheap"). After: ≤ 2.9 cm everywhere, never
  behind the head.
- **Soft arms** (2026-09-18, `simArms`, `resolveGloveContacts`): the sim
  has arms now — shoulders on the twisted shoulder line, elbows from
  `twoBoneMid` (a pure twin of the rig's solver) with the guard pole. Upper
  arms are solid; forearms and gloves are soft contacts resolved by share:
  block `contactBlockShare` 0.05, punching fist `contactPunchShare` 0.12,
  guard hand `contactGuardShare` 0.3, retracting arm 1. A jab through a
  relaxed guard knocks the hand aside; a fist stops at a block (and still
  counts as blocked — `touchedBlock`); no hand enters its own head. Method
  lesson: measure a knocked guard hand in the DEFENDER's frame — in world
  terms the stumble and the head snapping back off the gloves look like a
  40 cm shove and cost an hour of chasing a wiper effect that wasn't there.
- **The sim owns the arms** (2026-09-19, `core/arms.ts`, `sim/arms.ts`,
  `FighterState.arms`): shoulders and elbows are placed by the sim with the
  rig's old pole logic (lags in `moveHist[19..24]`) and the rig draws
  exactly them — hit geometry = drawn geometry for arms too. Contacts:
  forearm/forearm, glove/forearm (capped lever), gloves out of upper arms;
  all of it inside the glove springs' sub-steps (`integrateGloves`) —
  once-per-tick contacts let the jab's 5× snap-back re-drive 10 cm into a
  forearm every tick. Not forearm vs upper arm (deflecting a cross along
  the lead shoulder threw it off the chin). A fist stopped on a guard hand
  pinned against the face, when the punch was going to arrive (the target
  was cut), is a plain block. Measured: 20 exchange pairings ≤ 3.4 cm; a
  20 s spar 1 tick in 1064 beyond give + 1 cm. Filmstrips with both sides
  scripted: `__replay(dist, script0, ticks, script1)`.
- **The hook elbow** (2026-09-18): the level elbow pole was on from the first
  tick, so the wind-up had the elbow at shoulder height, 28 cm out, the arm
  folded to 30° — the wing Nate saw. `rigHookElbowRiseAt` 0.4 keeps it down
  through the load; the cocked fist sits a hand's width in front of and
  below the chin so the fold is ~55°. The rig probe `arms()` (shoulder /
  elbow / glove / clearance flag) is how to check an elbow in numbers.

**Hit performance** (`src/sim/reaction.ts`, `src/rig/index.ts`, `src/ui/audio.ts`)
- Springs ~2.5x slower than v1 (`reactionHeadK` 160 / C 9 …): jab settles in
  0.23 s, cross 0.32, hook 0.58, uppercut 0.62.
- **The impact pose** (2026-09-20): `reactionImpactPose` 0.02 s of the kick
  (0.012 for torso/tilt/spin) is applied as displacement on the land tick,
  so the hit-stop freeze shows the snapped head and bent body; the velocity
  that follows is scaled so the pose does not stack on the swing. Measured
  before: the freeze showed < 5 cm, then a 17 cm jump in one tick ("laggy,
  a few frames"). After: 18 cm on the frozen frame for a cross.
- **A coherent body**: `reactionMaxNeck` 0.16 (was 0.17 with the torso at
  10 — the head left the body), torso shares up (jab 0.12, cross 0.6, hook
  0.55, uppercut 0.5), `reactionHipFollow` 0.6, `crossReactTwist` 0.7, lifts
  cut to 0.04–0.06 on non-uppercuts (heads "bobbed too high"). The rig bug
  that made it worse: the chest added the torso offset twice.
- **The legs give**: `ReactionState.sink` — a hit sits the body down
  (`reactionSinkScale`: cross ≈ 5 cm, hook 7) and springs back; the hips
  carry it so the knees bend. "Real physics with punches."
- Method: `scripts/_debug.mjs` probe per punch — frozen-frame displacement,
  peak neck vs torso, sink, rise, tilt, biggest single-tick head jump.
- `ReactionState.spin`: a yaw whip from the sideways impulse (`hookReactSpin`
  1.0, `reactionSpinScale`); the drawn head whips 1.5x the shoulders.
- `reactionHipFollow` 0.45: a hit bends the body back from the waist (the rig's
  `rigTorsoBend` draws the chest along the capsule).
- `staggerDecay` 8: the stumble is long enough that the feet step to catch it.
- **The interrupt** (2026-09-22, Nate: "when you punch the opponent mid
  wind-up, that should break their punch momentum"; principle 2 — a punch is
  a committed load-and-drive, and a clean hit into the load takes it away).
  A clean land on a fighter still in their flight: at or before
  `interruptStuffBefore` 0.7 of it the punch is STUFFED — the clock runs
  backwards at `interruptRewindRate` 1.6, so the fist and the whole body
  retrace their path (measured: 12 cm/tick home vs 7 out, no jump in lean or
  twist), nothing chains off it and the guard waits until the arm is home
  (~5 ticks for a hook caught half-way). Later in the flight the punch
  still lands minus up to `interruptPowerLoss` 0.5 of its impulse, fading to
  none at the arrival (a jab into a cross at 0.83 of its flight took 28%
  off). A same-tick trade lands clean both ways. `punchStuffed` event; no
  audio/flash consumer yet. `scripts/interrupt_test.mjs`.
- Audio is synthesized (no files): sharp / heavy / body / blocked / counter
  sting / whiff / knockdown / bell. Camera punch-in and `camShake` per hit.
- Camera (2026-09-17, Fight Night Champion): `camFollow` 1 orbits on the
  player→opponent line, centred `camBehindDeg` 30 round from side-on toward
  the player's back. The player is always screen-left and nearest the lens.
  Before, the fixed seat put the player between the lens and the opponent
  whenever the pair circled into a line ("I'm blocked, I don't even see my
  fighter"). Three cuts the same night: (1) a smoothed chase (lambda 2.5,
  140 °/s cap) — "moves way too much"; (2) a soft dead zone + 30 °/s cap —
  calmer but the lag let it fall 60°+ behind: "still blocked"; (3) **the
  band** (`camOrbitBandDeg` 20): the camera sits wherever the line last
  left it and is hard-clamped to 30 ± 20° behind, so it moves only when
  dragged and can never fall far enough behind either fighter for one to
  cover the other. `camOrbitLambda` 0 = no recentre drift. Measured in a
  seeded 20 s AI spar: behind-angle 26–50°, still 84% of samples (47% with
  the dead zone). The fighters' circling sets total travel (~200°/20 s with
  the AI alone). The stick maps against the line side-on
  (`Stage.inputAzimuth`), never the raw orbit.
- "Panning in and out" was the dolly: it chased the fighters' distance at
  4/s over 4.2–6.5 m and lunged `camPunchIn` 0.18 m on every hit — with
  combos landing every 0.15 s that was constant. Now 4.5–5.8 m at 0.8/s,
  FOV 36–40, punch-in 0.08 (max 0.25). Dolly travel in the spar 10.5 → 3.9
  m. The shake carries the hit.
- Numbers: `healthDamagePerImpulse` 0.0003 (~14 crosses), `healthRegen` 0.06
  after `healthRegenDelay` 1.5 s up to a per-round cap (`healthCapLoss` 0.35).

**Defence** (`src/sim/slip.ts`, `punches.ts` guard/block)
- Lateral flick = slip (`slipHeadOffset` 0.33, dips `slipDip`), back flick =
  the pull (`slipBackOffset` 0.28, dir 2). Shoulders follow `slipShoulderFrac`
  0.7. The 0.33 / 0.7 pair is pinned by `slip_test`'s slip-into-the-hand body
  shot; the margins are ~2 cm.
- Guard vs block are two different poses (`guardLocal` relaxed, face visible;
  `blockLocal` covered, hunch 18°, chin tuck).
- The slip's legs (2026-09-20): the sim takes the whole body down
  `slipCrouch` 0.02 (capped: the shoulder must still catch a jab slipped
  into the hand), the rig shifts the drawn hips toward the slip
  (`rigSlipHipShift`), dips them (`rigSlipDip`) and turns the loaded knee
  in (`rigSlipKneeIn`).
- The read (2026-09-18/19): a slipped punch adds `slipDodgeHitStop` 0.08 s
  as the fist passes the ear, plays `slipNear` (the whiff, close and
  bright), and the thrower lunges `slipOverreach` 0.18 m past your ear off
  balance into the counter window. Nothing drawn — Fight Night's beat.
  First cut (0.05 s + sound only) was "still unnoticeable".
- THE READ (2026-09-22, `src/ui/read.ts`, config group `read`; Nate: "I
  still can't tell if I slipped a punch successfully"). Researched first:
  Fight Night Champion marks the window with a whiff-then-FREEZE and
  flashes the screen white when the counter lands — its "simulation"
  presentation setting exists to turn exactly those two off; Round 4 gave a
  landed counter a yellow glow (on the fighter) and a dazed state;
  Undisputed flashes white on every counter. FIRST CUT (screen wash +
  SLIPPED / COUNTER! words + an amber edge glow on the frame) — verdict:
  "remove the words, the flashing on the screen, too arcadey; the yellow
  frame looks really ugly; Fight Night's is way more subtle." SECOND CUT,
  nothing on the screen: the fighter a slip has left exposed catches a
  warm rim light (`readGlowStrength` 0.5, `readGlowColor`, drawn by the
  rig through `FighterView.highlight`, per-fighter toon material) at the
  window's remaining fraction, so it fades as the window closes; the
  freeze `slipDodgeHitStop` 0.12; the `counterOpen` ping under the whoosh;
  the counter sting on the land. Both fighters (when the AI slips you, your
  own rim warms). `scripts/read_check.mjs` scripts a real slip + counter
  (`__sim.script`) and screenshots the window.
- THE COUNTER RULE (same verdict: "why is it saying counter when I never
  slipped? I should only ever have a counter if I've successfully slipped
  a punch"): a landing is a COUNTER (flag, event, sting, extra hit-stop)
  only inside the window a SLIP opened (`punishSource`). Hitting someone
  mid-punch or inside a perfect block's window still hits harder for the
  exposure (`counterImpulseBonus` on `vuln` is unchanged — punch physics)
  but is not called a counter and gets no read. counter_test §3 pins it.
  Not done: Fight Night's dazed state on the countered fighter (a
  mechanic — ask).

**AI** (`src/ai/index.ts`)
- Footwork modes on a seeded timer: press / probe (1.05 m) / circle / hold /
  reset (1.3 m after 40% of throws or a solid hit). Steer on the *perceived*
  position lagged by `aiReactionTime` 0.2 with `aiLookahead`.
- Reads the player: rushed → give ground or fire a jab (`aiGiveGroundChance`);
  fast retreat → `aiChaseDelay` before following. Bursts of up to
  `aiComboMax` 3 through the sim's combo window. Guard comes up
  `aiReactionTime` after it notices a punch (jabs get through, hooks meet it).
- Per-fighter styles = these weights and distances per roster entry (not yet).
- Reads the hit states (2026-09-22; before, none of vuln / stumble / stuff):
  COUNTER — the player's exposure crossing `aiCounterVuln` 0.5 (their punch
  deep in its flight, a whiffed recovery hanging, the punish window after a
  slip or perfect block) is an opening; one roll at `aiCounterChance` 0.6,
  the decision lands `aiReactionTime` later and arms a straight on the spot
  (cross if still wide open, else jab). Measured: a whiffed jab's exposure
  is gone before a 0.2 s reaction, a whiffed uppercut's (stretched recovery)
  is countered and lands as a counter. COVER — its punch stuffed or a solid
  shot taken → `aiCoverChance` 0.5 the guard comes up for `aiCoverTime` 0.5
  (the sim raises it the tick after the rewound arm is home) and the armed
  punch / burst is dropped. FOLLOW-UP — an opponent stumbling above
  `aiStumbleSpeed` 0.6 m/s drains the attack timer `aiAggressionMult`
  faster (stacks: unguarded × stumbling = 3.24×); it throws nothing while
  stumbling itself. This is what makes range, slips and the block the
  competitive edge: over-commit and the AI now takes it.

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
- 2026-09-17 night: "it feels much better now." Three specifics: a 1-2 is
  "not snappy enough, there's a delay after the jab where my cross doesn't
  come out even after I've clicked"; the hook is "really weird — the way the
  elbow bends, the fist, and how it reverts back"; the camera left him
  blocked behind his own fighter. Measured first (the cross started 167 ms
  after its press; the hook's return was a straight-armed swing in the
  fighter frame, filmstrip t=22–26). → hit confirm + chained wind-up + queue,
  torso-frame recovery, follow camera. NOT yet feel-tested.
- 2026-09-18: "punches go through their heads… fists go through the head
  and body like it's translucent… exchanges feel light and cheap.
  Exchanges should be fast and thunderous." → measured 11 cm of
  penetration, then solid bodies (target cut + position clamp). The
  "thunderous" half — hit-stop, sound and flash tiers on a solid landing —
  is not done; the numbers are unchanged. NOT yet feel-tested.
- 2026-09-18, later: "punches still go through their arms… the hook
  elbow looks really bad… I can't tell if I've slipped a punch — very
  subtle, like Fight Night." → soft arms, the elbow diagnosed in numbers
  (wing: level pole from tick 0) and fixed, the slip beat + close whoosh.
  NOT yet feel-tested.
- 2026-09-19: "arms still go through each other when exchanging punches…
  meat and bone… the slip is still unnoticeable." → the sim owns the arms
  and draws them, contacts in the sub-steps, forearm/forearm; the slipped
  puncher over-reaches past the ear, longer beat, louder whoosh. NOT yet
  feel-tested.
- 2026-09-20: "shoulder is a ball separated from the arm… getting punched
  looks glitchy, body parts out of sync, the head bobs too high, cartoonish,
  laggy like a few frames… slips: the whole body lower, the lead knee bends
  in." → shoulder balls on the arm roots; the chest's double torso offset
  fixed; the impact pose; a coherent body; the legs give; slip legs. NOT
  yet feel-tested.
- 2026-09-22 (no feel-test possible; Nate's direction: better punch
  animation, combos that land, realism, movement/slips as the competitive
  edge, and "punching them mid wind-up should break their punch momentum")
  → the interrupt (sim + test only; nothing new drawn or heard). Then, on
  "what's next you can work on, can't test": the chained-body blend
  (`comboBlend`: a 1-2's twist reversals 2 → 0, start step 0.37 → 0.02
  rad) and the AI reading the hit states (counter / cover / follow-up).
  All sim-side, all NOT yet feel-tested. If the AI now feels unfair, turn
  `aiCounterChance` down first, then `aiCoverChance`.
- 2026-09-22, later: "improve the slip time window for counters, I still
  can't tell if I slipped successfully… see how Fight Night does it" →
  research, then the read drawn (wash + window glow + tags + ping, freeze
  0.12). Verdict, same night: **"nope, not it. Remove the words, the
  flashing on the screen — too arcadey. Why is it saying counter when I
  never slipped? The yellow frame looks really ugly; Fight Night's is way
  more subtle."** → second cut: nothing on the screen, the exposed
  fighter's rim warms; counters are slip-only. NOT yet feel-tested.

## Open

- Per-fighter styles (the roster's `style` field is unread).
- Follow camera near a corner: a ring post can sit in the foreground as the
  orbit comes round (see `camera-never-shows-outside-the-ring` in memory —
  the overscan decision is still open). A post-avoidance nudge on the
  azimuth, or a shorter dolly near the ropes, if it bothers him.
- If the follow camera is still too much: widen `camOrbitBandDeg` (up to
  ~25 before the player can start to cover the opponent at the far edge),
  less AI circling, or a longer dolly so the background parallax per degree
  drops.
- Hit-stop is power-scaled only, no per-punch tiers; no audio / flash tiers
  on a solid landing, and no read (sound or flash) for a stuff or a counter
  the AI takes. (The chained-twist snap and the AI's blindness to the hit
  states were closed 2026-09-22.)
- At Nate's ~0.85 m play distance a straight's fist stops at the head before
  full stretch (contact hold); the stretch shows at ~1.0 m.
- The weave is drawn-head only (up to 5 cm off the hit sphere) — a deliberate
  bend of the hit-geometry rule; if it ever matters, move it into the sim.
- Sources for the research are in the memory file
  `fighting-ai-research-2026-09-16` (Fight Night R.E.A.L. AI, EA UFC 6 deep
  dive, Thrill of the Fight interview, Undisputed reviews, PMC7739747).
