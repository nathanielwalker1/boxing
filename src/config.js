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

  // Range gating
  rangeMin:    80,    // reserved — currently the landing zone is smotherDist..rangeMax
  rangeMax:   100,
  smotherDist: 50,   // < this distance = smother (except hook/uppercut which still land)

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
  // Distance the dummy tries to hold. Should sit between smotherDist and
  // rangeMax — the default is the midpoint of the current landing band, i.e.
  // close enough to threaten but outside the smother zone where its jab dies.
  // ASSUMPTION — flag for confirmation: feel-based, not derived.
  dummyStandoffDist: 75,
  // Hysteresis deadband around dummyStandoffDist: inside it the dummy stops
  // steering entirely. This is the anti-jitter knob — too small and it hunts
  // back and forth around the target distance.
  dummyStandoffBand: 18,

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
