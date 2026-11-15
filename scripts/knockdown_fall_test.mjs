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
const TICKS = 700;
const DEG = Math.PI / 180;
const LIMB = 0.5;   // an arm's radius as a share of the torso capsule radius (body.ts bodyR): the limb is thinner than the trunk

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
  let downAt = -1, limitsOk = true, floorMin = 1, kind = 0, riseAt = -1, upAt = -1, prevQ = null;
  for (let i = 0; i < TICKS; i++) {
    const a = inp(i === 2 ? { [cs.punch]: true, move: { x: cs.x, y: 0 } } : {});
    const r = sim.step(s, [a, inp()], c); s = r.state;
    for (const e of r.events) if (e.type === 'knockdown' || e.type === 'getUp' || e.type === 'getUpPhase' || e.type === 'count' || e.type === 'ko' || e.type === 'tko') evs.push(`${i}:${e.type}:${e.side ?? ''}:${e.phase ?? ''}:${e.count ?? ''}`);
    const d = s.fighters[1];
    for (const e of r.events) { if (e.type === 'getUpPhase' && e.phase === 'rise' && riseAt < 0) riseAt = i; if (e.type === 'getUp') upAt = i; }
    if (d.down && downAt < 0) { downAt = i; kind = st.fallInfo(d).kind; }
    if (downAt >= 0 && d.skel && (upAt < 0 || i <= upAt + 25)) {
      const f = fk(def, d.skel);
      for (let j = 0; j < JOINT_COUNT; j++) { floorMin = Math.min(floorMin, f.p[j].y); if (j > 0 && !withinLimits(poseQ(d.skel, j), lim[j] ?? null, def.side[j])) limitsOk = false; }
      const q = []; for (let j = 0; j < JOINT_COUNT; j++) q.push(poseQ(d.skel, j));
      let turn = 0;
      if (prevQ) for (let j = 0; j < JOINT_COUNT; j++) { const a = prevQ[j], b = q[j]; turn = Math.max(turn, 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)))); }
      prevQ = q;
      rows.push({ i, py: f.p[0].y, p: f.p.map(q => ({ ...q })), turn, down: d.down });
    }
  }
  return { evs, rows, downAt, limitsOk, floorMin, kind, riseAt, upAt, body: d0.body };
}

for (const cs of CASES) {
  const on = run({ ...base, knockdownV2: true }, cs), off = run({ ...base, knockdownV2: false }, cs);
  check(`${cs.name}: he goes down`, on.downAt >= 0, `downAt ${on.downAt}`);
  check(`${cs.name}: fall chosen is ${cs.kind}`, on.kind === cs.kind, `kind ${on.kind}`);
  const D0 = base.kdDelay;
  const rows = on.rows, start = rows.findIndex(r => r.i >= on.downAt + D0);
  let worst = 0;
  for (let k = Math.max(1, start); k < rows.length && rows[k].i < on.downAt + 60; k++) worst = Math.max(worst, rows[k].py - rows[k - 1].py);
  check(`${cs.name}: pelvis never rises after the buckle (worst ${(worst * 100).toFixed(2)} cm)`, worst <= 0.01);
  const end = rows[Math.min(rows.length - 1, 59)];
  check(`${cs.name}: pelvis lands low (${(end.py * 100).toFixed(0)} cm)`, end.py < (cs.kind === 3 ? 0.55 : 0.2));
  check(`${cs.name}: no joint under the canvas (min ${(on.floorMin * 100).toFixed(1)} cm)`, on.floorMin >= -0.005);
  // At rest no arm joint is under the canvas: hands at the glove radius, elbows and shoulders at the limb radius (bodyR * kdLimbShare).
  {
    const bd = on.body, rr = rows[59], A = [[7, 'shoulder', bd.bodyR * LIMB], [8, 'elbow', bd.bodyR * LIMB], [9, 'hand', bd.gloveR], [11, 'shoulder', bd.bodyR * LIMB], [12, 'elbow', bd.bodyR * LIMB], [13, 'hand', bd.gloveR]];
    let worstGap = 9, wn = '';
    for (const [j, n, r] of A) { const g = rr.p[j].y - r; if (g < worstGap) { worstGap = g; wn = `${n} ${j} at ${(rr.p[j].y * 100).toFixed(1)} cm, needs ${(r * 100).toFixed(1)}`; } }
    check(`${cs.name}: at rest no arm joint is under the canvas (lowest: ${wn})`, worstGap >= -0.003);
  }
  check(`${cs.name}: every joint inside its limits every tick`, on.limitsOk);
  const a = rows[59], b = rows[60];
  let sp = 0;
  for (let j = 0; j < JOINT_COUNT; j++) sp = Math.max(sp, Math.hypot(b.p[j].x - a.p[j].x, b.p[j].y - a.p[j].y, b.p[j].z - a.p[j].z));
  check(`${cs.name}: at rest 60 ticks after the knockdown (${(sp * 1000).toFixed(2)} mm/tick)`, sp < 0.001);
  check(`${cs.name}: count and get-up events identical on and off`, JSON.stringify(on.evs) === JSON.stringify(off.evs), `${on.evs.length} vs ${off.evs.length}`);
  // The get-up: no snap, and the pelvis only rises once he starts to stand.
  check(`${cs.name}: he gets up (up at tick ${on.upAt}, rise phase at ${on.riseAt})`, on.upAt > 0);
  const maxTurn = Math.max(...on.rows.map(r => r.turn ?? 0));
  const worstRow = on.rows.reduce((m, r) => ((r.turn ?? 0) > (m.turn ?? 0) ? r : m), on.rows[0]);
  check(`${cs.name}: no joint turns over 12 deg in a tick, knockdown to guard (worst ${(maxTurn / DEG).toFixed(1)} at tick ${worstRow.i})`, maxTurn <= 12 * DEG);
  const stand = on.rows.filter(r => r.i >= (on.riseAt > 0 ? on.riseAt : on.upAt) && r.i <= on.upAt);
  let wr = 0;
  for (let k = 1; k < stand.length; k++) wr = Math.max(wr, stand[k - 1].py - stand[k].py);
  check(`${cs.name}: pelvis rises monotonically through the stand (worst dip ${(wr * 100).toFixed(2)} cm)`, wr <= 0.01);
}
// A knockdown that ends the fight (the knockdown limit: a TKO) keeps him on the canvas for as long as he is down: head low for 120 ticks.
for (const cs of CASES) {
  const c = { ...base, knockdownV2: true, knockdownsForTko: 1 };
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -cs.dist / 2, z: 0 }; s.fighters[1].pos = { x: cs.dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], c).state;
  const d0 = s.fighters[1], def = skelDef(d0.body, d0.stance, c);
  let downAt = -1, tko = false, maxHead = 0, stillDown = true;
  for (let i = 0; i < 400; i++) {
    const r = sim.step(s, [inp(i === 2 ? { [cs.punch]: true, move: { x: cs.x, y: 0 } } : {}), inp()], c); s = r.state;
    if (r.events.some(e => e.type === 'tko')) tko = true;
    const d = s.fighters[1];
    if (d.down && downAt < 0) downAt = i;
    if (downAt >= 0 && i >= downAt + 60 && i < downAt + 180) { maxHead = Math.max(maxHead, fk(def, d.skel).p[5].y); if (!d.down) stillDown = false; }
  }
  check(`${cs.name}, fight-ending knockdown: TKO, and he stays down with his head low for 120 ticks (highest head ${(maxHead * 100).toFixed(0)} cm)`, tko && stillDown && maxHead < 0.9);
}
// A man who is counted out stays down in the lying pose (no get-up is ever posed).
{
  const c = { ...base, knockdownV2: true, getUpCountBest: 10, getUpCountWorst: 10, getUpJitter: 0 };
  const r = run(c, CASES[0]);
  const a = r.rows.find(x => x.i === r.downAt + 80), b = r.rows[r.rows.length - 1];
  const mv = a && b ? Math.max(...a.p.map((p, j) => Math.hypot(p.x - b.p[j].x, p.y - b.p[j].y, p.z - b.p[j].z))) : 1;
  check(`counted out: still in the lying pose at the end (moved ${(mv * 1000).toFixed(1)} mm)`, mv < 0.002 && r.upAt < 0);
}
done();
