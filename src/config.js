// All tunable gameplay constants live here.
// Import this object and read from it at runtime — never hardcode values in game logic.
export const config = {
  // Ring dimensions (pixels)
  ringWidth: 700,
  ringHeight: 480,

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
  punchDuration:      0.15,   // arm animation duration (seconds)

  // Punch force — scales with player momentum per the physics philosophy
  punchForceBase:      250,   // base stagger impulse (px/s added to dummy stagger velocity)
  punchMomentumScale:  1.0,   // multiplier on (approachSpeed/moveSpeed * playerMass); 0 = flat force

  // Range gating
  rangeMin:    80,    // reserved — currently the landing zone is smotherDist..rangeMax
  rangeMax:   220,
  smotherDist: 50,   // < this distance = smother (except hook/uppercut which still land)

  // Block — percent of incoming force absorbed while actively blocking (0 = no reduction, 1 = fully negated)
  blockReduction: 0.75,

  // Dummy colors (distinct from player so you can tell them apart at a glance)
  dummyBodyColor: '#b83020',
  dummySkinColor: '#d4906a',

  // Dummy spring-damper stagger physics
  dummyReturnSpeed: 50,   // spring stiffness (px/s² per px of displacement)
  dummyDamping:     12,   // damping coefficient (higher = less oscillation)
};
