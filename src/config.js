// All tunable gameplay constants live here.
// Import this object and read from it at runtime — never hardcode values in game logic.
export const config = {
  // Ring dimensions (pixels)
  ringWidth: 500,
  // Stage 15: shallower than it is wide, on purpose. A square play area inside
  // a 3:2 viewport forces the camera to zoom out to frame the pair; a shallow
  // walkable band (the beat-em-up arrangement) is what gives the zoom solve
  // room to work. GAMEPLAY-VISIBLE — fighters reach the top/bottom ropes far
  // more often at 300 than at 500.
  ringHeight: 300,

  // Ring visuals
  ringFloorColor: '#c8a060',
  ringRopeColor:  '#cc2222',
  ringPostColor:  '#e9e9f2',
  ringRopeCount:  3,          // strands PER SIDE (was: lines drawn across the mat)
  ringBorderThickness: 5,     // canvas trim line where the mat meets the deck

  // ── Arena dressing (Stage 12) ───────────────────────────────────────────────
  // Everything below is consumed only by arena.js. None of it is read by
  // movement, hit resolution, the camera clamp or the HUD — the ring bounds rect
  // is unchanged, this layer just draws around it. Colours follow the project
  // convention: CSS hex strings, converted at the draw site.

  // Ropes. Strand 0 sits ON the ring bounds rect and the rest step outward, so
  // the multi-strand look never moves the line the fighters clamp to.
  ringRopeColor2:    '#e8e8ee',
  ringRopeColor3:    '#2b46a8',
  ringRopeSpacing:   7,      // px between adjacent strands
  ringRopeThickness: 3.5,    // px

  // Corner posts + turnbuckle pads. A/B are the two left and two right corners
  // (your side / theirs) rather than the usual diagonal pair — at this zoom the
  // diagonal arrangement reads as random colours.
  ringPostSize:  16,
  ringPadSize:   30,
  ringPadColorA: '#2b4a9e',
  ringPadColorB: '#a8202a',

  // Apron: the deck outside the ropes, and the skirt hanging off its near edge.
  ringApronWidth:   34,      // px of deck on all four sides
  ringSkirtHeight:  34,      // px of skirt below the near edge only
  apronDeckColor:   '#7d5f3e',
  apronSkirtColor:  '#1d2a63',
  apronStripeColor: '#c9a24a',

  // Canvas mat surface.
  matGrainAlpha:  0.10,      // fabric speckle
  matShadeAlpha:  0.30,      // darkening toward the mat's own edges
  matGlowAlpha:   0.22,      // overhead pool of light on the mat
  matTrimColor:   '#f0e6d2',
  matEmblemAlpha: 0.09,      // 0 = no centre mark
  matEmblemColor: '#7a5628',

  // Crowd. Baked once at boot into a RenderTexture; changing these needs a
  // reload (or Arena.rebuildCrowd()) rather than taking effect live.
  crowdRowGap:    30,        // px between rows
  crowdSeatGap:   26,        // px between figures within a row (scaled by depth)
  crowdHeadScale: 1.0,
  crowdFarColor:  '#242439', // top of frame — hazed toward the backdrop
  crowdNearColor: '#08080f', // bottom of frame — near-black silhouette
  crowdHighlightColor:  '#7b7fa8',   // the few figures catching the ring light
  crowdHighlightChance: 0.055,       // 0..1

  // Backdrop + atmosphere.
  arenaVoidColor:   '#06060d',
  arenaHazeColor:   '#3a3f7a',   // dim lift centred on the ring
  arenaHazeAlpha:   0.28,
  vignetteStrength: 0.70,        // 0 = off
  beamAlpha:        0.24,        // per-beam additive strength
  beamCount:        3,           // 0-3

  // ── Follow camera (Stage 11) ────────────────────────────────────────────────
  // Viewport only — see camera.js. Nothing here affects ring bounds, hit
  // geometry or input; it is purely what the world camera scrolls/zooms to.
  //
  // Zoom is DERIVED (Stage 15), not authored: camera.js solves each frame for
  // the loosest framing that still holds both fighters + camFighterExtent +
  // padding, then clamps. The old static camZoom is retired — these bound and
  // shape that solve instead.
  //
  // ASSUMPTION — all six of the framing numbers below are first-pass guesses.
  // At the ring defaults the solve lands around 1.41 (fighters at opposite
  // ropes) to ~2.9 (clinched); a fighter is ~111 world px tall, so ~156 screen
  // px at the wide end and ~322 at the tight end (24% → 50% of the viewport).
  camZoomMin: 1.3,
  camZoomMax: 3.0,
  // Framing margin, world px, around the pair's bounding box. Padding is what
  // the solve tries to hold; it can be eroded when a clamp (camZoomMin, or the
  // arena-fit floor) overrides the solve.
  camFramePaddingX: 30,
  camFramePaddingY: 30,
  // Half-size of a fighter, for framing only — NOT a hitbox. 70 covers the rig
  // margins (67 above the origin, 44 below, 24 either side at rest) so the
  // frame is sized to their drawn extent rather than to their origin point,
  // which would put a head exactly on the frame edge.
  camFighterExtent: 70,
  // Zoom smoothing, 1/s. Deliberately asymmetric: widening fast (a fighter
  // leaving frame is a real failure) and tightening slowly (a frame that stays
  // loose for a beat costs nothing, and this is what stops every jab from
  // snapping the camera in). See the anti-oscillation note in camera.js.
  camZoomLerp:   6,     // widening — target below current
  camZoomInLerp: 2,     // tightening — target above current
  // Deadzone on the solved zoom, in zoom units: the held target only moves once
  // the solve drifts past this. Kills the constant small hunting that reads as
  // the camera breathing. Costs up to ~10 world px of the framing padding at
  // the wide end, which is why the padding above is larger than the erosion.
  camZoomDeadzone: 0.06,

  // ── Arena bounds (Stage 15) — CAMERA ONLY ──────────────────────────────────
  // The ring rect grown by these margins. The camera clamps to the ARENA, not
  // the ring, which is what lets the ring edge sit comfortably inside the frame
  // instead of exactly on it. Fighter movement still clamps to the ring — these
  // do not touch gameplay. This band is where the apron/ropes/posts/crowd live.
  // ASSUMPTION — 110 is ~1.6× the current apron deck + skirt (34 + 34).
  arenaMarginX: 110,
  arenaMarginY: 110,
  // 0 = anchor on the player alone (rigid left-third lock, opponent free to
  // drift off-frame), 1 = anchor on the midpoint between both fighters (always
  // symmetric, but the player drifts off-frame at big separations). Between the
  // two: the pair stays framed AND the player stays left-ish.
  camPairMix: 0.6,
  // How far left of center the player is pushed, as a FRACTION of the visible
  // width (so it means the same thing at any zoom). At the defaults the player
  // sits around 1/3 from the left edge whenever the camera isn't clamped.
  camBiasFrac: 0.10,
  // px of horizontal separation over which the bias ramps from full-left to
  // full-right. Crossing past the opponent has to flip the bias (otherwise THEY
  // get shoved off-screen); this ramp is what makes that a slide, not a snap.
  camBiasFalloff: 60,
  // Follow smoothing, in 1/s (higher = snappier, lower = floatier). Vertical is
  // slower on purpose — up/down drift is constant during footwork and a fast
  // vertical follow reads as the camera bobbing.
  camLerpX: 6,
  camLerpY: 4,

  // ── Stance ('orthodox' | 'southpaw') ────────────────────────────────────────
  // Which anatomical arm leads: orthodox = left leads/jabs, southpaw = right.
  // A property of the fighter, independent of which way they are facing — see
  // leadArm()/armSlot() in rig.js. These are only the DEFAULTS each fighter is
  // constructed with; the live value is the instance's own `stance` field, so
  // flip it there (e.g. via the __game dev hook) rather than here at runtime.
  playerStance: 'orthodox',
  dummyStance:  'orthodox',

  // ── Guard stance ────────────────────────────────────────────────────────────
  // The guard POSE itself (arm angles) lives in rig.js with the punch
  // trajectory table — it's pose shape, not a gameplay tunable. These two are
  // the movement bounce layered on top of it: how much the body rises/falls
  // while moving, and how fast. Both scale to zero when standing still.
  guardBobAmplitude: 3.5,   // px of vertical travel at full speed
  guardBobFrequency: 2.2,   // bounce cycles per second at full speed

  // ── Rear-side depth cue (Stage 14 part 3) ───────────────────────────────────
  // The rear-side limbs (rear arm, rear thigh, rear shin, rear glove, rear
  // trunks) are pushed back visually so they read as being behind the torso.
  // There are two mechanisms and BOTH sliders are live, so the two treatments
  // can be compared side by side without a code change:
  //
  //   rearLimbDarken — the current treatment. The rear side draws FULLY OPAQUE
  //     in a darkened tint of its own colour. Nothing shows through it, so it
  //     reads as a limb in shadow rather than as a rendering glitch.
  //   rearArmAlpha   — the OLD treatment, now defaulted off (1.0). Translucent
  //     rear limbs let the mat show through, which at this rig scale read as
  //     missing geometry rather than as depth. Kept so it can be dialled back
  //     in for comparison.
  //
  // Whichever is used, it applies to EVERY rear-side element — an arm on one
  // treatment next to a thigh on the other reads as a bug, not as depth.
  rearLimbDarken: 0.35,   // 0..1 — fraction the rear side's colours are darkened
  rearArmAlpha:   1.0,    // 0..1 — legacy translucency; 1.0 = off

  // Fighter movement
  moveSpeed: 200,

  // Facing deadband (px of horizontal separation). Below this the fighter keeps
  // its current facing instead of flipping — see stepFacing() in movement.js.
  // Deliberately tiny: it exists only to give the exactly-zero case an answer
  // (pinned against a rope both fighters clamp to the same x, so there is no
  // side to face), NOT to smooth anything. Measured across a scripted corner
  // chase, 0 / 0.5 / 1 all produced the same facing-flip rate — there is no
  // sub-pixel strobing to damp — while 2+ started holding a stale direction at
  // ~1.5-2 px separations that should have resolved live. Raise it only if
  // near-stacked facing ever reads as twitchy in play.
  facingDeadband: 0.5,

  // ── Body separation ─────────────────────────────────────────────────────────
  // Fighters are soft bodies, not solid walls: an overlapping pair is EASED
  // apart each frame rather than blocked outright, so walking into someone
  // shoves them (which is what infighting should feel like) instead of hitting
  // an invisible wall. Deliberately smaller than smotherDist (50) so the
  // too-close/smothered band is still reachable, and well under the dummy's
  // standoff (64) so its movement AI never fights the push.
  // Dist is the REST target, not a hard floor: because only a fraction of the
  // overlap is corrected per frame, someone leaning their whole walk speed into
  // an opponent compresses it a few px (measured: ~33-37 px at the values below
  // depending on approach angle, ~35 px even at strength 1). That give is the
  // point — it reads as shoving,
  // and the pair still never stacks. Strength also sets how fast a dead-stacked
  // pair separates: 0.15 ≈ 27 frames, 0.5 ≈ 7, 1.0 ≈ 1 (visibly a hard snap).
  fighterSeparationDist:     38,   // min center-to-center distance (px). 0 = off
  fighterSeparationStrength: 0.5,  // fraction of the overlap corrected per frame; 1 = rigid

  // Fighter physics — mass scales accel/friction so heavier = sluggier
  playerMass:   80,
  acceleration: 900,   // force units; effective accel = acceleration / mass
  friction:     1200,  // deceleration force; effective decel = friction / mass

  // ── Fighter visuals ─────────────────────────────────────────────────────────
  // NOTE (Stage 14 part 5): fighterBodyColor / dummyBodyColor no longer colour
  // anything. The torso, upper arms and shins moved to skinColor and the hips /
  // upper thighs moved to trunksColor, which between them covered everything
  // bodyColor used to fill. They are deliberately left in place (config key,
  // palette field and tuning-panel slider) rather than deleted, pending a call
  // on whether some element should be handed back to them.
  fighterBodyColor:   '#2d5fa8',
  fighterSkinColor:   '#e8a86a',
  fighterTrunksColor: '#2d5fa8',   // the player's identity colour since Stage 14
  fighterGloveColor:  '#4d8ce0',
  fighterRadius:      22,          // boundary collision radius (px)

  // How far down the thigh the trunks reach, in px. The thigh segment is 26 px
  // long, so this is clamped to 0..26 — 0 is bare legs, 26 is trunks to the knee.
  // ASSUMPTION — the trunk line is the thing this stage exists to settle; the
  // default is a first guess, not derived from anything.
  trunksHeight: 14,

  // ── Contact shadows (Stage 14 part 2) ───────────────────────────────────────
  // A soft ellipse on the canvas under each fighter. Drawn by RingScene into its
  // own layer, NOT inside the fighter containers — those rotate and squash for
  // slip and knockdown, and a shadow that tilts off the ground during a slip is
  // exactly wrong. It tracks world (x, y) only: not the hit-reaction offsets,
  // not the slip lean, not the bob. A fighter rocked back by a cross has moved
  // their upper body, not their feet.
  // ASSUMPTION — every number here is a first-pass look guess.
  shadowEnabled:     true,
  shadowColor:       '#000000',
  shadowAlpha:       0.30,
  shadowRadiusX:     26,     // px — half-width of the ellipse
  shadowRadiusY:     8,      // px — half-height
  shadowOffsetY:     40,     // px below the torso origin; the shins bottom out at +40 local
  // Knockdown is the one state that changes the shadow's SHAPE: the body is
  // lying on the canvas rather than standing on it, so the ellipse widens by
  // this factor and flattens by the same factor.
  shadowDownRadiusScale: 1.7,

  // Punch execution
  punchDuration:      0.15,   // BASE arm animation duration (seconds); divided by the per-punch speed below

  // Punch force — scales with player momentum per the physics philosophy
  punchForceBase:      250,   // base stagger impulse (px/s added to dummy stagger velocity)
  punchMomentumScale:  1.0,   // multiplier on (approachSpeed/moveSpeed * playerMass); 0 = flat force

  // ── Per-punch damage / speed (Stage 8) ──────────────────────────────────────
  // Both are MULTIPLIERS on the existing shared systems, not replacements:
  //   damage — scales the momentum-based force computed in _resolveAttack, so it
  //            scales stagger impulse and health damage together (damage is still
  //            derived from force via healthDamagePerForce). 1.0 = the old value.
  //   speed  — rate multiplier on config.punchDuration (duration = punchDuration
  //            / speed). Higher = faster. 1.0 = the old duration.
  // ASSUMPTION — first-pass feel numbers, not derived from anything; the intended
  // ordering (jab weakest/fastest → hook & uppercut heaviest/slowest) is the spec,
  // the exact spacing is for the sliders to settle.
  jabDamage:        0.70,
  jabSpeed:         1.50,
  crossDamage:      0.95,
  crossSpeed:       1.35,
  hookDamage:       1.45,
  hookSpeed:        1.05,
  uppercutDamage:   1.55,
  uppercutSpeed:    1.00,

  // ── Hit geometry (Stage 9) ──────────────────────────────────────────────────
  // Landing is no longer a distance band — a punch lands when the FIST (sampled
  // at the punch's peak-extension frame, see peakProgress in rig.js) overlaps one
  // of the defender's hurtboxes. Effective reach therefore falls out of the rig +
  // the per-punch trajectory instead of being declared, so a jab, a rear hook and
  // an uppercut all reach different distances for free.
  //
  // The offsets below are the rig's own head/torso centers (see drawRig) — move
  // them only if the rig geometry moves. The sizes start slightly larger than the
  // drawn shapes because the drawn "fist" is the wrist joint, not the glove.
  // ASSUMPTION — first-pass sizes, expected to be dialed in on the sliders.
  fistRadius:           10,   // px — the glove around the solved wrist position
  headHurtboxRadius:    15,   // px — drawn head is r=13
  headHurtboxOffsetY:  -50,   // px from torso center (rig head center)
  bodyHurtboxWidth:     32,   // px — drawn torso is 28 wide
  bodyHurtboxHeight:    44,   // px — drawn torso is 38 tall
  bodyHurtboxOffsetY:  -20,   // px from torso center (rig torso center)

  // Dev-only overlay: draws both fighters' hurtboxes and the live fist circle so
  // the sliders above can be tuned against something visible. Off by default.
  showHurtboxes: false,

  // ── Aim cone (Stage 13) ─────────────────────────────────────────────────────
  // The rig has no anatomical rotation — facing is a binary left/right mirror —
  // so a punch's fist travels along one fixed rig-local trajectory and sails
  // past a target that is merely a bit above or below. The cone bends the
  // THROWING ARM ONLY (a rigid rotation of the arm chain about its own
  // shoulder), by an angle sampled ONCE on the input frame and then locked for
  // the punch's duration. Body, torso, guard, footwork and the mirror are
  // untouched — only where the arm reaches changes.
  //
  // The bend is measured RELATIVE to the level case, not absolutely: it is the
  // angle between (shoulder → aim point) and (shoulder → that same aim point
  // with the opponent's vertical offset removed). So at zero vertical offset
  // every punch bends by exactly 0° and keeps the trajectory, reach and
  // character it has today — see the note on the aim points below for why an
  // absolute "point at the head/body" formulation could not do that.
  // Set to 15 after feel-testing at 30: the wider cone was doing too much of the
  // work, which is the failure mode that matters here — ring position has to
  // stay a tactical layer, and a punch that finds a target you never lined up
  // erases the reason to circle for angles at all. 15 still erases the
  // incidental misalignment that normal footwork produces.
  maxAimAngle: 15,   // degrees off the punch's own natural trajectory, either way

  // How sharply the bend ramps in across the punch. The bend is scaled by the
  // punch's existing extension curve (0 through the whole wind-up, 0→1 into
  // peak, back to 0 on recovery) raised to this power, so the arm never cocks
  // at an angle before it throws — it leaves the guard straight and bends onto
  // the target as it extends. 1 = follow the extension curve exactly; higher =
  // the bend arrives later and more suddenly.
  // ASSUMPTION — feel value. 1.5 back-loads it slightly, which reads as the
  // punch tracking onto the target rather than being aimed from the shoulder.
  aimBendRamp: 1.5,

  // The point ON THE OPPONENT each punch tracks, as a y offset from their torso
  // center — the same reference points the hurtboxes use (head = -50, body =
  // -20), kept as separate values so aim can be tuned without moving the hit
  // geometry. Jab/cross/hook track the head; the uppercut tracks the body,
  // since it rises into the target by design.
  //
  // These are NOT an absolute aiming target: at zero vertical offset every
  // punch bends 0° regardless of what is set here (aiming the uppercut
  // absolutely at the body would tip it 30° downward at a level opponent,
  // which is a redesign of the punch, not an aim cone). What they change is how
  // much correction a given vertical offset asks for — tracking a high point on
  // a low opponent needs more bend than tracking a low one. At 30 px of offset
  // and 70 px of range that is ~32° for a head-tracking jab vs ~21° for a
  // body-tracking uppercut.
  jabAimPointY:      -50,
  crossAimPointY:    -50,
  hookAimPointY:     -50,
  uppercutAimPointY: -20,

  // Floor on the shoulder→target horizontal run used in the angle solve. Guards
  // the degenerate cases — a target directly above/below, or one inside the
  // separation slack and effectively on top of the shoulder — where the run
  // goes to zero or negative and the angle would otherwise blow up or flip
  // sign. Clamped rather than special-cased so the result stays continuous.
  aimMinRun: 8,   // px

  // Dev-only overlay: draws each fighter's cone bounds and, mid-punch, the
  // locked aim line actually being used. Sits next to Show Hurtboxes.
  showAimCone: false,

  // Smother — the one part of range gating that stays a proximity test, because
  // "too close to extend" is inherently about distance, not overlap (a straight
  // punch fired point-blank still passes THROUGH the head geometrically). Locked
  // spec: jab/cross smother, hook/uppercut still land inside this radius.
  // Measured center-to-center, same as before this stage.
  smotherDist: 50,

  // Block — percent of incoming force absorbed while actively blocking (0 = no reduction, 1 = fully negated)
  blockReduction: 0.75,

  // ── Vulnerability (Stage 16 part 1) ─────────────────────────────────────────
  // A continuous 0..1 "how exposed is this fighter right now" value carried by
  // both fighters (see vulnerability.js). It is NOT a parallel timeline: the
  // curve is sampled off the punch's OWN animation progress against the cockEnd
  // / peakAt timings already in the PUNCHES table in rig.js, so each punch type
  // gets its own exposure profile for free and re-timing a punch re-times its
  // vulnerability with it.
  //
  //   0                  at rest, and (near enough) through the early cock
  //   → cockLevel        by the end of the wind-up
  //   → vulnerabilityPeak at full extension — the committed moment
  //   → 0                across the recovery
  //
  // Blocking forces it to 0 outright, and so does being down (see the note in
  // vulnerability.js — that one is a judgement call, flagged in the summary).
  // ASSUMPTION — every number below is a first-pass feel guess.
  vulnerabilityPeak:      1.00,   // 0..1 ceiling, so max exposure can be tuned below 1
  vulnerabilityCockLevel: 0.15,   // fraction of peak reached by the END of the cock
  vulnerabilityRiseShape: 2.00,   // >1 back-loads the rise (flat early cock, steep into peak)
  vulnerabilityDecayShape: 1.20,  // >1 drops off quickly after peak; <1 keeps you exposed longer

  // Dev-only readout of both fighters' live vulnerability (and whiff-recovery
  // state). Sits next to Show Hurtboxes — the number is unreadable off the rig,
  // and none of the rest of this stage can be tuned without seeing it move.
  showVulnerability: false,

  // ── Whiff cost (Stage 16 part 2) ────────────────────────────────────────────
  // Multiplies the POST-PEAK portion of a punch's animation when it resolves as
  // a whiff or a smother — the cock and the extension have already happened by
  // the time the outcome is known. Everything follows from stretching that one
  // stretch of the timeline: the arm retracts visibly slower, the vulnerability
  // curve decays over the longer window, and the fighter can't throw again until
  // it ends.
  //
  // It does NOT lock the guard out: block stays available for the whole extended
  // recovery and still zeroes vulnerability (locked mechanic — see CLAUDE.md and
  // the note in Fighter.update). What it does keep is the throw lockout, so
  // guarding up out of a whiff is a real option rather than a free reset.
  // ASSUMPTION, and the single most important number in this stage to feel-test.
  // MEASURED at the shipped punch durations, this is what the multiplier buys:
  //
  //           normal recovery    extra at 2.2x    extra at 3.5x    extra at 5x
  //   jab          58 ms            70 ms           145 ms          232 ms
  //   cross        53 ms            64 ms           133 ms          213 ms
  //   hook         54 ms            65 ms           136 ms          217 ms
  //   uppercut     60 ms            72 ms           150 ms          240 ms
  //
  // The first guess here was 2.2, which works out at ~4 frames — too small to
  // change the spam behaviour this exists to fix. 3.5 costs ~9 frames, so a
  // missed punch is a beat the opponent can actually step into, and it keeps the
  // whole press-to-next-throw cycle for a jab at ~0.25 s. Raise toward 5 if
  // whiffing still feels free; drop it if the lockout reads as sluggish.
  //
  // Stage 17 (0c): this is now the GLOBAL SCALAR of a per-type gradient rather
  // than the multiplier itself — see punchWhiffRecoveryMult() below and the
  // per-type weights immediately after. Dragging this one slider still dials the
  // whole whiff cost up or down; 1 disables it everywhere at once.
  whiffRecoveryMultiplier: 3.5,

  // ── Per-punch whiff cost (Stage 17 part 0c) ─────────────────────────────────
  // A flat multiplier gave the four punches effectively identical penalties
  // (measured: 145 / 133 / 136 / 150 ms), because their base recoveries are all
  // within 7 ms of each other. The punch diamond had damage variety and no RISK
  // variety, so there was no mechanical reason to prefer a jab.
  //
  // WHY A TABLE AND NOT A DERIVATION. The intended approach was to scale off
  // each punch's PEAK vulnerability, the way the vulnerability curve itself
  // derives from the PUNCHES timings. Measured, that is a dead end: the curve is
  // normalised so every punch reaches exactly config.vulnerabilityPeak at its own
  // peakAt frame, so all four peak at 1.000 — see punchVulnerability()'s middle
  // branch, where k = 1 at u = peakAt regardless of type. Zero spread, so there
  // is nothing to derive a gradient from. Peak vulnerability says "how exposed
  // you are AT full extension"; whiff cost is "how long you stay there", which is
  // genuinely independent information and has to be authored.
  //
  // These are WEIGHTS on the global scalar's excess over 1, not multipliers in
  // their own right:  effective = 1 + (whiffRecoveryMultiplier - 1) × weight.
  // So the global still means what it always did (it is the ~1.0-weight punch's
  // multiplier) and a weight of 0 makes that punch's whiff free.
  // ASSUMPTION — the ORDERING is the spec (jab safest → uppercut scariest,
  // mirroring the damage ordering it pays for), the spacing is for the sliders.
  jabWhiffScale:      0.55,
  crossWhiffScale:    0.85,
  hookWhiffScale:     1.15,
  uppercutWhiffScale: 1.45,

  // ── Counter (Stage 16 part 3) ───────────────────────────────────────────────
  // A hit landed on a vulnerable target multiplies the SHARED force value by
  // 1 + (targetVulnerability × counterForceBonus), so damage, stagger impulse and
  // the Stage 10 hit reaction all scale together off one number rather than
  // three. Stacks multiplicatively with the momentum term and the per-punch
  // damage multiplier — see the measured ceiling in scripts/counter_test.mjs.
  // ASSUMPTION — feel guess. 0.9 makes a peak-vulnerability counter nearly
  // double-force.
  counterForceBonus: 0.90,

  // Feedback. No new VFX shapes here on purpose: hit-stop is the cheapest and
  // most reliable "that landed" signal, and it already exists.
  counterHitStopBonus:  0.05,   // seconds ADDED on top of the clamped hit-stop, × vulnerability
  counterShakeIntensity: 0.006, // fraction of the viewport, × vulnerability (zoom-normalised — see _shakeCamera)
  counterShakeDuration:  0.18,  // seconds

  // ── Perfect block (Stage 16 part 4) ─────────────────────────────────────────
  // A guard raised within perfectBlockWindow seconds of an impact resolving.
  // The reward is not a new parry system — it spikes the ATTACKER's
  // vulnerability, which opens a counter window through the part 1 + part 3
  // machinery that already exists.
  // ASSUMPTION — all four are guesses. perfectBlockWindow at 0.12 s is ~7 frames,
  // which is tight for a human but (see the summary) far too loose to stop the
  // dummy's zero-latency reactive block from perfect-blocking every single time.
  perfectBlockWindow:              0.12,   // seconds after the guard goes up
  perfectBlockPunishVulnerability: 0.85,   // 0..1 the attacker is pinned at
  perfectBlockPunishDuration:      0.45,   // seconds the spike is held
  perfectBlockHitStop:             0.05,   // seconds — deliberately under a counter's

  // ── Defensive / whiff VFX (Stage 16 part 5) ─────────────────────────────────
  // The block flash used to be a flat rect over the torso and head. It is now
  // localized to the GLOVES, where the block actually happens.
  blockFlashDuration:    0.14,   // seconds
  blockFlashAlpha:       0.40,   // peak alpha — deliberately low, this is defensive feedback
  blockFlashRadiusScale: 1.35,   // × fistRadius

  // The whiff effect used to be two concentric expanding rings, which read as an
  // impact radiating from a point — exactly wrong for a punch that hit nothing.
  // It is now a directional streak along the path the wrist actually travelled
  // (see wristPath() in rig.js), tapering and fading from the tail forward.
  whiffStreakDuration: 0.20,   // seconds
  whiffStreakSamples:  9,      // points sampled along the cock→peak wrist path
  whiffStreakWidth:    6,      // px — line width at the fist end, tapering to ~1 at the tail
  whiffStreakAlpha:    0.55,   // peak alpha at the fist end

  // ── Hit reaction (Stage 10) ─────────────────────────────────────────────────
  // The localized rig response to a landed punch — see reaction.js. Shared
  // spring first, then the per-punch SHAPE that decides where the impact goes.
  //
  // Magnitude is NOT a per-type constant: every value below multiplies the same
  // force _resolveAttack already computed (base × momentum × per-punch damage),
  // so a hard advancing cross and a weak retreating one differ on the same
  // shape. The per-type numbers are direction and proportion only.
  reactionStiffness:  400,    // spring stiffness (1/s²) pulling head/torso/tilt back to rest
  reactionDamping:     16,    // damping coefficient — lower = more wobble/oscillation
  reactionForceScale: 2.6,    // px/s of rig velocity per unit of impact force
  reactionTwistScale: 0.012,  // radians of tilt velocity per unit of (force × twist)
  reactionMaxOffset:   40,    // px — hard clamp so an extreme force can't fling the head off the body
  reactionMaxTilt:    0.6,    // radians — same clamp for the lean

  // Per-punch reaction shape. All in the DEFENDER's rig-local space (+x = toward
  // the attacker, -y = up), so the container mirror renders it correctly from
  // either side of the ring.
  //   back  — head snap straight back, away from the attacker
  //   lift  — upward component (positive = chin rises)
  //   twist — rotational whip of the upper body (positive = leans away)
  //   torso — fraction of back/lift that bleeds into the torso (0 = pure head)
  //   snap  — stiffness multiplier: higher = quicker, shorter-lived reaction
  // ASSUMPTION — first-pass feel numbers. The ORDERING is the spec (jab = small,
  // fast, head-only; cross = same axis but heavier with body behind it; hook =
  // rotational; uppercut = lifts), the exact spacing is for the sliders.
  jabReactBack:        0.70,
  jabReactLift:        0.15,
  jabReactTwist:       0.06,
  jabReactTorso:       0.05,   // almost entirely a head effect, per spec
  jabReactSnap:        1.80,   // short duration — springs back nearly twice as fast

  crossReactBack:      1.00,   // same axis as the jab, more of everything
  crossReactLift:      0.20,
  crossReactTwist:     0.20,
  crossReactTorso:     0.45,
  crossReactSnap:      1.15,

  hookReactBack:       0.55,   // less straight-back — the hook's signature is the twist
  hookReactLift:       0.10,
  hookReactTwist:      1.00,
  hookReactTorso:      0.40,
  hookReactSnap:       1.00,

  uppercutReactBack:   0.35,   // barely goes back...
  uppercutReactLift:   0.58,   // ...it goes UP
  uppercutReactTwist:  0.35,   // a lean back, not a whip around — the lift is the story here
  uppercutReactTorso:  0.75,   // much higher than the others: the head only overlaps the torso by
                               // ~2 px, so a big head-relative lift detaches it. The uppercut therefore
                               // raises the whole upper body and the head only slightly more.
  uppercutReactSnap:   0.90,

  // ── Hit-stop (Stage 10) ─────────────────────────────────────────────────────
  // A few frames of near-frozen timescale on a landed hit. Duration scales with
  // the same force value as everything else above, so a jab barely hitches and a
  // clean uppercut visibly stops. Applied globally in RingScene.update by
  // scaling dt — nothing else needs to know about it.
  hitStopEnabled:    true,
  hitStopBase:       0.015,     // seconds — floor, applied to even the lightest hit
  hitStopPerForce:   0.00012,   // extra seconds per unit of impact force
  hitStopMax:        0.10,      // seconds — ceiling, so a huge hit can't read as a hang
  hitStopScale:      0.05,      // timescale during the stop (0 = hard freeze, 1 = no effect)

  // Dummy colors. Since Stage 14 the two fighters are told apart by their TRUNKS
  // and GLOVES only: dummySkinColor is deliberately set to the same value as
  // fighterSkinColor so the trunks carry the whole identity read and it can be
  // judged on its own. Both sliders are kept — reintroducing a skin difference
  // is one drag away if trunks-plus-gloves turns out not to be enough.
  dummyBodyColor:   '#b83020',   // unused since Stage 14 — see fighterBodyColor
  dummySkinColor:   '#e8a86a',
  dummyTrunksColor: '#b83020',
  dummyGloveColor:  '#e04a34',

  // Dummy spring-damper stagger physics
  dummyReturnSpeed: 50,   // spring stiffness (px/s² per px of displacement)
  dummyDamping:     12,   // damping coefficient (higher = less oscillation)

  // Dummy attack cadence — the randomized base interval. Since Stage 7 the
  // expiring timer only *arms* an attack; the throw additionally requires the
  // player to be inside the landing band (see Dummy.update).
  dummyAttackDelayMin: 1.5,   // seconds — shortest gap between dummy punches
  dummyAttackDelayMax: 3.5,   // seconds — longest gap between dummy punches

  // ── Dummy movement AI (Stage 7) ─────────────────────────────────────────────
  // Reuses the shared locomotion step (movement.js) — same accel/friction/mass
  // and the same ring clamp as the player, only the top speed differs.
  // ASSUMPTION — flag for confirmation: set below the player's moveSpeed (200)
  // so the player can always create distance and the approach reads as
  // beatable rather than as the dummy matching them perfectly.
  dummyMoveSpeed: 170,
  // Distance the dummy tries to hold. The whole hysteresis band has to fit
  // between smotherDist and dummyEngageDist, not just its center: approaching
  // from far out, the dummy stops the moment it enters the band, so its actual
  // resting distance is standoff + band, NOT standoff. At the old 75 ± 18 that
  // put it at ~88 px — past the reach of its own jab — where it would sit
  // forever and never throw. 64 ± 12 rests at ~76: inside its jab's reach, and
  // still clear of the smother radius at the near edge.
  dummyStandoffDist: 64,
  // How far out the dummy is willing to commit to a punch, and the range inside
  // which it bothers reacting to the player's punches with its guard. Replaces
  // the old rangeMax, which was a hit-resolution constant the AI borrowed and
  // which no longer exists now that landing is geometric.
  //
  // MEASURED, not guessed: the dummy only throws a lead jab, and with the
  // hurtbox defaults above that jab lands out to ~85 px center-to-center and
  // whiffs past it (see scripts/reach_test.mjs, which sweeps the real resolver).
  // Set a little under that measured edge so the punch still connects if the
  // player drifts back a few px during the 0.8 s windup.
  dummyEngageDist: 78,
  // Hysteresis deadband around dummyStandoffDist: inside it the dummy stops
  // steering entirely. This is the anti-jitter knob — too small and it hunts
  // back and forth around the target distance. Narrowed from 18 so the whole
  // band clears dummyEngageDist (see above); the proportional taper in
  // Dummy.update does most of the settling work, so this stays jitter-free.
  dummyStandoffBand: 12,

  // ── Dummy reactive block (Stage 7) ──────────────────────────────────────────
  // ASSUMPTION — both values are feel-based guesses, flag for confirmation.
  dummyBlockReactionChance: 0.35,   // 0..1 — probability it reacts to a given player punch
  dummyBlockReactionWindow: 0.45,   // seconds the guard stays up once raised

  // ── Dummy opening aggression (Stage 7) ──────────────────────────────────────
  // Multiplies how fast the attack timer drains while the player is exposed.
  // The two openings (gassed / unguarded-in-range) STACK multiplicatively, so
  // both at once ≈ multiplier². ASSUMPTION — flag for confirmation.
  dummyOpeningAggressionMultiplier: 1.8,

  // Dummy windup — deliberately separate from the player's punchDuration so the
  // player's own punches can stay snappy while the dummy's telegraph stays readable.
  // Impact resolves at half this duration (peak extension), giving that much time to react.
  dummyWindupDuration: 0.8,   // seconds

  // Slip/duck — flick-vs-hold detection on the SAME movement joystick (Stage 5).
  // A push is tracked once its magnitude crosses slipInputThreshold. If it drops
  // back below threshold before slipFlickMaxDurationMs elapses, that's a FLICK
  // (triggers a slip). If it's still held past that duration, it's a confirmed
  // HOLD (ordinary footwork — no slip fires, even on eventual release).
  slipInputThreshold:        0.6,    // 0..1 — min joystick/key magnitude that counts as "pushed"
  slipFlickMaxDurationMs:    180,    // ms — release before this = flick; held past this = footwork
  slipInvincibilityDuration: 0.25,   // seconds — length of the active slip window (head offset + lean)
  slipHeadOffsetX:           90,     // px — head-hitbox shift (see Fighter.getHitPos), toward the flick direction
  slipHeadOffsetY:           90,     // px — same, vertical axis

  // Health (Stage 6) — symmetric for both player and dummy.
  healthMax: 100,
  // Damage reuses the exact force value already computed for the stagger
  // impulse in _resolveAttack (post block-reduction) rather than a parallel
  // damage number — this is a derived/tuned ratio, not measured from
  // anything else in config, so treat the default as an assumption to tune:
  // at defaults (punchForceBase=250) an unblocked solid punch deals roughly
  // healthDamagePerForce * ~300-400 force ≈ 20-32 health, so ~4-5 clean
  // hits to knock down. Flag this back if the pacing feels off.
  healthDamagePerForce: 0.01,

  // Stamina (Stage 6) — symmetric for both player and dummy.
  staminaMax: 100,
  staminaDrainPerPunch:            4,    // flat cost per punch thrown (lands or not)
  staminaDrainPerSecondBlocking:   2,    // continuous drain while block is held
  staminaRegenPerSecond:          20,    // regen while neither punching nor blocking

  // ── Chip damage on being hit (Stage 17 part 0d) ─────────────────────────────
  // Before this, stamina only ever drained from THROWING and from HOLDING the
  // guard — being hit cost nothing, which made turtling free and left the
  // perfect block with nothing to negate.
  //
  // Derived from the same post-block-reduction `force` value receiveImpulse /
  // takeDamage / receiveHit already share, exactly the way healthDamagePerForce
  // is. So there is no flat per-hit constant: a weak retreating jab and a hard
  // advancing counter differ for free, and the counter bonus and per-punch
  // damage multiplier both flow through without a second lookup.
  // MEASURED at the shipped defaults, a clean unblocked hit carries 125 units of
  // force (retreating jab) to 511 (advancing uppercut), rising to ~970 for an
  // advancing uppercut landed on a fully-exposed target at peak vulnerability.
  // So 0.012 costs 1.5 stamina on the lightest touch, ~6 on a solid one and ~12
  // on the worst counter in the build — against staminaDrainPerPunch of 4, i.e.
  // eating a good shot costs roughly what throwing one or two punches does.
  // ASSUMPTION — the ratio to the throw cost is the thing to feel-test.
  staminaDrainPerHitForce: 0.012,
  // Applied on top of blockReduction having ALREADY cut the force by 75%.
  // Absorbing shots on the guard is tiring in a way reduced force doesn't
  // capture, so this slider decides whether blocked hits cost proportionally
  // more than their reduced force implies. 1.0 = they cost exactly in
  // proportion. ASSUMPTION — left at the neutral default deliberately, so the
  // feature can be judged on the force derivation alone first.
  staminaDrainBlockedMult: 1.0,
  // Seconds of regen suppression after taking a hit. FLAGGED — not asked for.
  // At staminaRegenPerSecond 20, any chip drain is fully repaid in well under a
  // second, so without a pause the chip is close to a no-op in live play: the
  // number moves and then immediately un-moves. Set to 0 to disable it and see
  // the difference. ASSUMPTION — 0.6 s is roughly the gap between punches in an
  // exchange, so it suppresses regen for the duration of a flurry but not past
  // the end of one.
  staminaRegenDelayAfterHit: 0.6,

  // Low-stamina telegraph (Stage 6) — soft penalty, punches still fire.
  lowStaminaThreshold:        25,    // stamina below this = telegraphed
  lowStaminaWindupMultiplier: 2.5,   // multiplies punch/windup duration when gassed

  // Knockdown (Stage 6).
  knockdownRecoveryDuration:    2.5,   // seconds spent in the "down" state
  // ASSUMPTION — flag for confirmation: restored to this fraction of
  // healthMax on getting up (not full health). Picked as a reasonable
  // starting point (30-40% range) so a fighter doesn't immediately drop
  // again from residual chip damage, but this is a feel call, not derived.
  knockdownHealthRestorePct:    0.35,

  // ── Combat audio (Stage 12) ─────────────────────────────────────────────────
  // Impact/whiff SFX only — footwork, breathing and crowd are deliberately not
  // in this stage. Sounds are synthesised at runtime (see audio.js for why), so
  // the "asset manifest" below is a set of synth recipes rather than file paths;
  // swapping to sampled files later would replace audio.js's playRecipe(), not
  // any of the call sites in main.js.
  audioEnabled:       true,
  audioMasterVolume:  0.55,   // 0..1 — the single master knob asked for in the panel
  audioPitchJitter:   0.05,   // ±5% per play, so repeated punches aren't a loop
  audioVolumeJitter:  0.10,   // ±10% per play, same reason

  // Which impact sound each punch type gets when it lands UNBLOCKED. Blocked
  // hits ignore this entirely and always use 'impactBlocked' (see _resolveAttack)
  // — a blocked hook should read as absorbed, not as a heavy hit.
  audioPunchClass: {
    jab:      'impactSharp',
    cross:    'impactSharp',
    hook:     'impactHeavy',
    uppercut: 'impactHeavy',
  },

  // Synth recipes. Each sound is a stack of layers, all fired on the same
  // timestamp; each layer is source → optional filter → AD envelope.
  //   type   'noise' (white-noise buffer) | 'tone' (oscillator)
  //   wave   oscillator shape, tone layers only
  //   freq / freqEnd     oscillator pitch sweep, in Hz
  //   filter {type, freq, freqEnd, q}   biquad, freqEnd sweeps the cutoff
  //   attack / decay     envelope, in seconds — every sound stays under 300 ms
  //   gain               layer mix level, before master volume
  audioSounds: {
    // The three impact sounds are deliberately given three different parts of
    // the SPECTRUM, not three volumes of the same hit — that's what makes them
    // tellable apart mid-fight rather than only side by side. Sharp owns the
    // top, heavy owns the bottom, blocked owns the middle. audio_test.mjs
    // asserts exactly that, so a re-tune that collapses two of them fails.
    //
    // Recipe `gain` is a trim that keeps each sound peaking under ~0.85 with the
    // master slider at 1.0, so the panel's full range stays clean of clipping.

    // Jab / cross — sharp and high. The 3 kHz bandpass layer is the "crack".
    impactSharp: {
      gain: 0.62,
      layers: [
        { type: 'noise', gain: 0.85, attack: 0.001, decay: 0.060, filter: { type: 'highpass', freq: 1600, q: 0.7 } },
        { type: 'noise', gain: 0.60, attack: 0.001, decay: 0.035, filter: { type: 'bandpass', freq: 3200, q: 1.5 } },
        { type: 'tone',  gain: 0.35, attack: 0.001, decay: 0.070, wave: 'triangle', freq: 320, freqEnd: 140 },
      ],
    },

    // Hook / uppercut — heavy and low. The deep sine thud carries it; the noise
    // layers are the meat of the smack rather than a crack. Rings roughly 3x
    // longer than the sharp variant, which is most of the "weight" impression.
    impactHeavy: {
      gain: 0.60,
      layers: [
        { type: 'tone',  gain: 1.00, attack: 0.002, decay: 0.240, wave: 'sine', freq: 150, freqEnd: 45 },
        { type: 'noise', gain: 0.55, attack: 0.001, decay: 0.140, filter: { type: 'lowpass',  freq: 500,  q: 0.8 } },
        { type: 'noise', gain: 0.25, attack: 0.001, decay: 0.030, filter: { type: 'bandpass', freq: 1500, q: 1.0 } },
      ],
    },

    // Blocked (and smothered) — absorbed. Sits in the mids: no sub thud (that
    // would read as a heavy hit connecting) and no HF crack (that would read as
    // a clean one). The ~4x slower attack removes the transient snap, which is
    // the other half of why it reads as stopped rather than landed.
    // No tone layer at all, on purpose: any sustained low sine here pulls it
    // back toward the heavy thud. It's three narrow-ish noise bands stacked
    // around 1 kHz — a leathery glove-on-glove slap with no bottom end.
    impactBlocked: {
      gain: 1.50,
      layers: [
        { type: 'noise', gain: 0.90, attack: 0.005, decay: 0.090, filter: { type: 'bandpass', freq: 820,  q: 1.3 } },
        { type: 'noise', gain: 0.20, attack: 0.006, decay: 0.045, filter: { type: 'bandpass', freq: 1150, q: 1.5 } },
        { type: 'noise', gain: 0.45, attack: 0.006, decay: 0.070, filter: { type: 'bandpass', freq: 520,  q: 1.4 } },
      ],
    },

    // Counter (Stage 16) — a STING layered on top of the punch's own impact
    // sound, not a replacement for it. Replacing would have cost the punch-type
    // read (a countered jab should still crack like a jab) and would have
    // collapsed the three-way spectral split the impacts are built on, which
    // audio_test.mjs asserts. So this owns a band none of them do: a fast
    // upward tone snap over a tight metallic ring, short enough to fuse with the
    // impact it sits on rather than sounding like a second event.
    counter: {
      gain: 0.55,
      layers: [
        { type: 'tone',  gain: 0.70, attack: 0.001, decay: 0.110, wave: 'square',   freq: 180, freqEnd: 640 },
        { type: 'tone',  gain: 0.45, attack: 0.001, decay: 0.190, wave: 'triangle', freq: 900, freqEnd: 1500 },
        { type: 'noise', gain: 0.30, attack: 0.001, decay: 0.050, filter: { type: 'bandpass', freq: 2400, freqEnd: 5200, q: 2.2 } },
      ],
    },

    // Whiff — air moving past, no contact. Both layers are cutoff sweeps rather
    // than fixed filters: up then down is what makes it read as passing BY you.
    // Trimmed to sit clearly under the impacts — a miss shouldn't punch through
    // the mix — but not so far down it stops registering as feedback.
    whiff: {
      gain: 2.60,
      layers: [
        { type: 'noise', gain: 0.55, attack: 0.030, decay: 0.160, filter: { type: 'bandpass', freq: 300,  freqEnd: 2400, q: 1.4 } },
        { type: 'noise', gain: 0.28, attack: 0.020, decay: 0.120, filter: { type: 'bandpass', freq: 1800, freqEnd: 500,  q: 1.2 } },
      ],
    },
  },
};

/**
 * CSS hex string → Phaser integer colour. Lives here because config is where
 * colours are stored as strings; every draw site converts at its own boundary.
 */
export function cssHex(str) {
  return parseInt(String(str).replace('#', ''), 16);
}

/**
 * The colour set one fighter's rig is drawn with — see drawRig() in rig.js.
 * Built fresh each frame (same reason the ring is redrawn every frame) so a
 * tuning-panel colour change appears instantly.
 *
 * `body` is currently read by nothing (see the note on fighterBodyColor above);
 * it stays in the shape so handing an element back to it is a one-line change.
 *
 * @returns {{body:number, skin:number, trunks:number, glove:number}}
 */
export function playerPalette() {
  return {
    body:   cssHex(config.fighterBodyColor),
    skin:   cssHex(config.fighterSkinColor),
    trunks: cssHex(config.fighterTrunksColor),
    glove:  cssHex(config.fighterGloveColor),
  };
}

/** The dummy's equivalent — same shape, so the rig never asks who it's drawing. */
export function dummyPalette() {
  return {
    body:   cssHex(config.dummyBodyColor),
    skin:   cssHex(config.dummySkinColor),
    trunks: cssHex(config.dummyTrunksColor),
    glove:  cssHex(config.dummyGloveColor),
  };
}

// Per-punch multiplier lookups. Read through these rather than indexing config
// directly so punch logic never names a punch-type constant inline, and so the
// tuning-panel sliders (which bind to the flat keys above) take effect live.
export function punchDamageMult(type) {
  const v = config[`${type}Damage`];
  return typeof v === 'number' ? v : 1;
}
export function punchSpeedMult(type) {
  const v = config[`${type}Speed`];
  return typeof v === 'number' && v > 0 ? v : 1;
}

/**
 * The y offset (from the opponent's torso center) this punch type tracks — see
 * the aim-point block above. Same read-through-a-lookup convention as the
 * multipliers, so aim code never names a punch type inline.
 */
export function punchAimPointY(type) {
  const v = config[`${type}AimPointY`];
  return typeof v === 'number' ? v : config.headHurtboxOffsetY;
}

/**
 * Which impact sound an UNBLOCKED landed punch of this type plays. Same pattern
 * as the multiplier lookups above — punch logic never names a sound inline.
 */
export function punchAudioClass(type) {
  return config.audioPunchClass[type] || 'impactSharp';
}

/**
 * Per-punch hit-reaction shape (Stage 10) — see reaction.js and the block of
 * `*React*` keys above. Same read-through-a-lookup convention as the two
 * multipliers, so reaction code never names a punch-type constant inline and
 * the tuning-panel sliders take effect live.
 */
function num(key, fallback) {
  const v = config[key];
  return typeof v === 'number' ? v : fallback;
}
/**
 * The recovery-stretch multiplier a whiffed (or smothered) punch of this type
 * pays — Stage 17 part 0c. Same read-through-a-lookup convention as the damage
 * and speed multipliers, so _resolveAttack never names a punch type inline.
 *
 * Composed as 1 + (global − 1) × weight rather than as a bare per-type value so
 * that the single global slider still scales the whole gradient (and still
 * disables it outright at 1), while the weights only ever decide the SHAPE.
 * Clamped at 1 so a negative weight can't shorten a recovery — extendRecovery()
 * would ignore it anyway, but that would be a silent no-op rather than a floor.
 */
export function punchWhiffRecoveryMult(type) {
  const weight = Math.max(0, num(`${type}WhiffScale`, 1));
  const excess = Math.max(0, config.whiffRecoveryMultiplier - 1);
  return 1 + excess * weight;
}

export function punchReaction(type) {
  return {
    back:  num(`${type}ReactBack`,  1),
    lift:  num(`${type}ReactLift`,  0),
    twist: num(`${type}ReactTwist`, 0),
    torso: num(`${type}ReactTorso`, 0.3),
    snap:  num(`${type}ReactSnap`,  1),
  };
}
