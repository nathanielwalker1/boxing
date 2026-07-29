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

  // Fighter physics
  playerMass: 80,

  // Punch parameters
  punchForceBase: 150,
  rangeMin: 80,
  rangeMax: 220,
  smotherDist: 50,
};
