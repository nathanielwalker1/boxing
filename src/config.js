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

  // Punch parameters
  punchForceBase: 150,
  rangeMin: 80,
  rangeMax: 220,
  smotherDist: 50,
};
