/** movement_test.mjs — bounds, top speed, friction, body separation, facing (port of legacy boundary/separation/facing assertions). */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, RING_HALF, v2dist, v2len, v2sub, v2angle, angleDelta } = core;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const B = RING_HALF - cfg.ringInset;

function fresh(dist) {
  const s = sim.createState(specs, cfg, 1);
  if (dist !== undefined) { s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 }; }
  return s;
}
function run(s, n, inputs, onTick) {
  for (let i = 0; i < n; i++) { s = sim.step(s, inputs(i), cfg).state; if (onTick) onTick(s, i); }
  return s;
}
const inBounds = f => Math.abs(f.pos.x) <= B + 1e-9 && Math.abs(f.pos.z) <= B + 1e-9;

// ── 1. Holding each direction never leaves the inset bounds (boundary_test) ──
for (const [name, move] of [['forward', { x: 0, y: 1 }], ['back', { x: 0, y: -1 }], ['right', { x: 1, y: 0 }], ['left', { x: -1, y: 0 }]]) {
  let ok = true, worst = 0;
  const end = run(fresh(), 600, () => [inp({ move }), NONE], s => {
    for (const f of s.fighters) { if (!inBounds(f)) ok = false; worst = Math.max(worst, Math.abs(f.pos.x), Math.abs(f.pos.z)); }
  });
  check(`holding ${name} for 10 s stays inside the inset bounds (both fighters)`, ok, `worst |coord| ${worst.toFixed(3)} vs bound ${B.toFixed(3)}`);
  if (name === 'back') check('walking back reaches the rope', near(Math.abs(end.fighters[0].pos.x), B, 1e-6), `${end.fighters[0].pos.x.toFixed(3)}`);
}
{
  const s = run(fresh(), 120, () => [inp({ move: { x: 0, y: -1 } }), NONE]);
  check('pinned against the rope, velocity on that axis is zeroed', s.fighters[0].vel.x === 0);
}

// ── 2. Velocity reaches moveSpeed, never exceeds it, friction stops it ──────
{
  let maxSpd = 0;
  let s = run(fresh(), 40, () => [inp({ move: { x: 1, y: 0 } }), NONE], st => { maxSpd = Math.max(maxSpd, v2len(st.fighters[0].vel)); });
  const spd = v2len(s.fighters[0].vel);
  check('strafing for 40 ticks reaches ~moveSpeed', spd >= cfg.moveSpeed * 0.99, `${spd.toFixed(3)} vs ${cfg.moveSpeed}`);
  check('speed never exceeds moveSpeed', maxSpd <= cfg.moveSpeed + 1e-9, `${maxSpd.toFixed(4)}`);
  check('strafe right moves along the fighter\'s right (+z when facing +x)', s.fighters[0].pos.z > 0.5, `${s.fighters[0].pos.z.toFixed(3)}`);
  s = run(s, 60, () => [NONE, NONE]);
  check('friction brings the fighter to a dead stop within 1 s', s.fighters[0].vel.x === 0 && s.fighters[0].vel.z === 0, `${JSON.stringify(s.fighters[0].vel)}`);
  const heavier = { ...cfg, moveMassRef: cfg.moveMassRef / 2 };
  let sh = fresh(), sl = fresh();
  for (let i = 0; i < 10; i++) { sh = sim.step(sh, [inp({ move: { x: 1, y: 0 } }), NONE], heavier).state; sl = sim.step(sl, [inp({ move: { x: 1, y: 0 } }), NONE], cfg).state; }
  check('a lower mass reference (heavier fighter) accelerates slower', v2len(sh.fighters[0].vel) < v2len(sl.fighters[0].vel));
}

// ── 3. Body separation (separation_test) ────────────────────────────────────
{
  let minD = Infinity;
  const s = run(fresh(), 240, () => [inp({ move: { x: 0, y: 1 } }), NONE], st => { minD = Math.min(minD, v2dist(st.fighters[0].pos, st.fighters[1].pos)); });
  const d = v2dist(s.fighters[0].pos, s.fighters[1].pos);
  check('walking into the dummy never stacks (closer than 0.24 m)', minD > 0.24, `min ${minD.toFixed(3)}`);
  check('the push is soft: smother range stays reachable', d < cfg.smotherDist, `held at ${d.toFixed(3)} vs smother ${cfg.smotherDist}`);
  check('the dummy is shoved along, not walked through', s.fighters[1].pos.x > 1.2 + 0.2, `dummy x ${s.fighters[1].pos.x.toFixed(3)}`);
  check('both fighters still inside the ring', inBounds(s.fighters[0]) && inBounds(s.fighters[1]));
}
{
  let s = fresh(0);
  let frames = null;
  for (let i = 0; i < 180 && frames === null; i++) {
    s = sim.step(s, [NONE, NONE], cfg).state;
    if (v2dist(s.fighters[0].pos, s.fighters[1].pos) >= cfg.separationDist * 0.95) frames = i + 1;
  }
  check('a dead-stacked pair separates on its own within 60 ticks', frames !== null && frames <= 60, `${frames} ticks`);
  const p = fresh(0);
  const q = run(p, 60, () => [NONE, NONE]);
  check('separation with strength applies symmetrically', near(q.fighters[0].pos.x, -q.fighters[1].pos.x, 1e-9), `${q.fighters[0].pos.x.toFixed(3)} / ${q.fighters[1].pos.x.toFixed(3)}`);
}
{
  // Cornered: the dummy is pinned in the corner; the player walks in. The
  // refused share is handed over so the pair never overlaps.
  const s = fresh();
  s.fighters[1].pos = { x: B, z: B }; s.fighters[0].pos = { x: B - 0.6, z: B - 0.6 }; s.fighters[0].yaw = Math.PI / 4;
  let minD = Infinity;
  run(s, 240, () => [inp({ move: { x: 0, y: 1 } }), NONE], st => { minD = Math.min(minD, v2dist(st.fighters[0].pos, st.fighters[1].pos)); });
  check('crowding a cornered dummy does not stack', minD > 0.24, `min ${minD.toFixed(3)}`);
}
{
  // Same shape as legacy §5: dummy pinned in the corner, player walks in with
  // the push off. The corner clamp holds both, so they end up stacked. (On open
  // floor they pass through each other and then oscillate, because "forward"
  // is opponent-relative and flips on every overshoot.)
  const off = { ...cfg, separationDist: 0 };
  let s = fresh();
  s.fighters[1].pos = { x: B, z: B }; s.fighters[0].pos = { x: B - 0.6, z: B - 0.6 }; s.fighters[0].yaw = Math.PI / 4;
  for (let i = 0; i < 240; i++) s = sim.step(s, [inp({ move: { x: 0, y: 1 } }), NONE], off).state;
  check('separationDist = 0 disables the push', v2dist(s.fighters[0].pos, s.fighters[1].pos) < 0.05, `${v2dist(s.fighters[0].pos, s.fighters[1].pos).toFixed(3)}`);
}

// ── 4. Facing tracks the opponent, never snaps (facing_test) ────────────────
{
  let worst0 = 0, worst1 = 0, maxStep = 0, prevYaw = [0, Math.PI];
  const s = run(fresh(), 400, () => [inp({ move: { x: 1, y: 0 } }), NONE], (st, i) => {
    for (const side of [0, 1]) {
      const f = st.fighters[side], o = st.fighters[1 - side];
      const err = Math.abs(angleDelta(f.yaw, v2angle(v2sub(o.pos, f.pos))));
      if (i > 10) { if (side === 0) worst0 = Math.max(worst0, err); else worst1 = Math.max(worst1, err); }
      maxStep = Math.max(maxStep, Math.abs(angleDelta(prevYaw[side], f.yaw)));
      prevYaw[side] = f.yaw;
    }
  });
  check('circling: the player\'s yaw tracks the dummy within 0.15 rad', worst0 < 0.15, `worst ${worst0.toFixed(3)}`);
  check('circling: the dummy (NULL input) turns to keep facing the player', worst1 < 0.15, `worst ${worst1.toFixed(3)}`);
  check('yaw never turns faster than turnRate', maxStep <= cfg.turnRate * SIM_DT + 1e-9, `max step ${maxStep.toFixed(4)} vs ${(cfg.turnRate * SIM_DT).toFixed(4)}`);
  check('the player actually circled (moved off the start axis)', Math.abs(s.fighters[0].pos.z) > 0.5 || s.fighters[0].pos.x > 0);
}
{
  // Teleport the dummy behind the player: yaw turns through π over several
  // ticks rather than snapping.
  const s = fresh();
  s.fighters[1].pos = { x: -2.4, z: 0 };
  const a = sim.step(s, [NONE, NONE], cfg).state;
  const d1 = Math.abs(angleDelta(0, a.fighters[0].yaw));
  check('a 180° flip is a rate-limited turn, not a snap', d1 > 0 && d1 <= cfg.turnRate * SIM_DT + 1e-9, `first tick turned ${d1.toFixed(3)}`);
  const b = run(a, 60, () => [NONE, NONE]);
  check('…and completes within a second', Math.abs(angleDelta(b.fighters[0].yaw, Math.PI)) < 1e-6, `${b.fighters[0].yaw.toFixed(4)}`);
}
{
  // Facing anchors to locomotion: a staggered dummy shoved past the player's x
  // does not flip the player's facing on the wobble alone.
  const s = fresh(0.79);
  const st = run(s, 30, () => [NONE, NONE]);
  st.fighters[1].stagger = { x: 3, z: 0 };
  const after = run(st, 5, () => [NONE, NONE]);
  check('stagger moves the dummy but the player keeps facing it', Math.abs(angleDelta(after.fighters[0].yaw, 0)) < 0.05 && after.fighters[1].pos.x > st.fighters[1].pos.x);
}

done();
