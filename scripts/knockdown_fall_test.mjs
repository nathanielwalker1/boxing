/**
 * knockdown_fall_test.mjs — knockdownV2 (docs/anim/LOG_KNOCKDOWN.md): the authored falls on the sim skeleton. Sim only.
 *   - the fall chosen matches the punch (cross: straight 1, lead hook: 2, rear uppercut: folded 3)
 *   - pelvis height never rises (within 1 cm) once the legs go; it ends near the canvas (or, folded, at knee height)
 *   - no joint under the canvas, every joint inside its limits on every tick
 *   - at rest (every joint under 1 mm a tick) within 60 ticks of the knockdown
 *   - the knockdown / count / getUp events and their ticks are identical with the toggle on and off
 */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [core, sim, st] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/sim/state.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, JOINT_COUNT, skelDef, skelLimits, fk, poseQ, withinLimits } = core;
const base = { ...createConfig(), ratingsOn: false, stylesOn: false, jabHealthFloor: 0, healthDamagePerImpulse: 0.006 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const TICKS = 420;

const CASES = [
  { name: 'cross', punch: 'cross', x: 0, dist: 0.79, kind: 1 },
  { name: 'lead hook', punch: 'hook', x: -1, dist: 0.79, kind: 2 },
  { name: 'rear uppercut', punch: 'uppercut', x: 1, dist: 0.65, kind: 3 },
];

function run(c, cs) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -cs.dist / 2, z: 0 }; s.fighters[1].pos = { x: cs.dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], c).state;
  const d0 = s.fighters[1], def = skelDef(d0.body, d0.stance, c), lim = skelLimits(c);
  const evs = [], rows = [];
  let downAt = -1, limitsOk = true, floorMin = 1, kind = 0;
  for (let i = 0; i < TICKS; i++) {
    const a = inp(i === 2 ? { [cs.punch]: true, move: { x: cs.x, y: 0 } } : {});
    const r = sim.step(s, [a, inp()], c); s = r.state;
    for (const e of r.events) if (e.type === 'knockdown' || e.type === 'getUp' || e.type === 'getUpPhase' || e.type === 'count' || e.type === 'ko' || e.type === 'tko') evs.push(`${i}:${e.type}:${e.side ?? ''}:${e.phase ?? ''}:${e.count ?? ''}`);
    const d = s.fighters[1];
    if (d.down && downAt < 0) { downAt = i; kind = st.fallInfo(d).kind; }
    if (d.down && d.skel && downAt >= 0) {
      const f = fk(def, d.skel);
      for (let j = 0; j < JOINT_COUNT; j++) { floorMin = Math.min(floorMin, f.p[j].y); if (j > 0 && !withinLimits(poseQ(d.skel, j), lim[j] ?? null, def.side[j])) limitsOk = false; }
      rows.push({ i, py: f.p[0].y, p: f.p.map(q => ({ ...q })) });
    }
  }
  return { evs, rows, downAt, limitsOk, floorMin, kind };
}

for (const cs of CASES) {
  const on = run({ ...base, knockdownV2: true }, cs), off = run({ ...base, knockdownV2: false }, cs);
  check(`${cs.name}: he goes down`, on.downAt >= 0, `downAt ${on.downAt}`);
  check(`${cs.name}: fall chosen is ${cs.kind}`, on.kind === cs.kind, `kind ${on.kind}`);
  const D0 = base.kdDelay;
  const rows = on.rows, start = rows.findIndex(r => r.i >= on.downAt + D0);
  let worst = 0;
  for (let k = Math.max(1, start); k < rows.length; k++) worst = Math.max(worst, rows[k].py - rows[k - 1].py);
  check(`${cs.name}: pelvis never rises after the buckle (worst ${(worst * 100).toFixed(2)} cm)`, worst <= 0.01);
  const end = rows[Math.min(rows.length - 1, 59)];
  check(`${cs.name}: pelvis lands low (${(end.py * 100).toFixed(0)} cm)`, end.py < (cs.kind === 3 ? 0.55 : 0.2));
  check(`${cs.name}: no joint under the canvas (min ${(on.floorMin * 100).toFixed(1)} cm)`, on.floorMin >= -0.005);
  check(`${cs.name}: every joint inside its limits every tick`, on.limitsOk);
  const a = rows[59], b = rows[60];
  let sp = 0;
  for (let j = 0; j < JOINT_COUNT; j++) sp = Math.max(sp, Math.hypot(b.p[j].x - a.p[j].x, b.p[j].y - a.p[j].y, b.p[j].z - a.p[j].z));
  check(`${cs.name}: at rest 60 ticks after the knockdown (${(sp * 1000).toFixed(2)} mm/tick)`, sp < 0.001);
  check(`${cs.name}: count and get-up events identical on and off`, JSON.stringify(on.evs) === JSON.stringify(off.evs), `${on.evs.length} vs ${off.evs.length}`);
}
done();
