// All tunable gameplay constants live here.
// Import this object and read from it at runtime — never hardcode values in game logic.
export const config = {
  // Ring dimensions (pixels)
  ringWidth: 500,
  ringHeight: 500,

  // Ring visuals
  ringFloorColor: '#c8a060',
  ringRopeColor:  '#cc2222',
  ringPostColor:  '#ffffff',
  ringRopeCount:  3,
  ringBorderThickness: 8,

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

  // Depth cue: the rear-side limbs (rear arm at rest, rear thigh) are drawn
  // dimmed so they read as being behind the torso. At this rig scale a low value
  // can read as "missing" rather than "receded", so it's tunable — 1.0 removes
  // the cue entirely and draws the rear side solid.
  rearArmAlpha: 0.55,

  // Fighter movement
  moveSpeed: 200,

  // Fighter physics — mass scales accel/friction so heavier = sluggier
  playerMass:   80,
  acceleration: 900,   // force units; effective accel = acceleration / mass
  friction:     1200,  // deceleration force; effective decel = friction / mass

  // Fighter visuals
  fighterBodyColor: '#2d5fa8',
  fighterSkinColor: '#e8a86a',
  fighterRadius:    22,         // boundary collision radius (px)

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

  // Smother — the one part of range gating that stays a proximity test, because
  // "too close to extend" is inherently about distance, not overlap (a straight
  // punch fired point-blank still passes THROUGH the head geometrically). Locked
  // spec: jab/cross smother, hook/uppercut still land inside this radius.
  // Measured center-to-center, same as before this stage.
  smotherDist: 50,

  // Block — percent of incoming force absorbed while actively blocking (0 = no reduction, 1 = fully negated)
  blockReduction: 0.75,

  // Dummy colors (distinct from player so you can tell them apart at a glance)
  dummyBodyColor: '#b83020',
  dummySkinColor: '#d4906a',

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
};

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
