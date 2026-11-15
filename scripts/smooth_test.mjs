/**
 * smooth_test.mjs — joint inertialization (src/sim/inertia.ts, docs/anim/LOG_SMOOTH.md).
 *  1. The probe's scenarios with inertiaOn: outside impulse ticks no joint's turn changes by more than 15 deg/tick^2
 *     and none turns more than 40 deg in one tick.
 *  2. Punch timing barely moves: the tick a punch lands (the glove's contact), inertia on vs off, single punches within 1
 *     tick, the second punch of jab-cross and cross-hook within 2.
 *  3. inertiaOn = false is the pre-change sim: a seeded scripted fight gives the same skeleton, bit for bit, as the sim
 *     before the layer existed (fingerprint pinned below; re-pin only when the pose is changed on purpose).
 */
import { load } from './load.mjs';
import { check, done } from './check.js';
import { suite } from './joint_jump_probe.mjs';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput } = core;
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const HOOKX = { lead: -1, rear: 1 };
const PUNCH = (p, h) => inp({ [p]: true, ...(p === 'hook' || p === 'uppercut' ? { move: { x: HOOKX[h], y: 0 } } : {}) });

// ── 1. the probe's targets ──
{
  const R = suite(true);
  let worstDv = 0, worstTurn = 0, wd = '', wt = '';
  for (const r of R.rows) {
    if (/impulse tick/.test(r.label)) continue;
    if (r.wd.v > worstDv) { worstDv = r.wd.v; wd = r.label; }
    if (r.wt.v > worstTurn) { worstTurn = r.wt.v; wt = r.label; }
  }
  check(`worst one-tick change in turn <= 15 deg/tick^2 (${worstDv.toFixed(1)}: ${wd})`, worstDv <= 15);
  check(`worst single-tick turn <= 40 deg (${worstTurn.toFixed(1)}: ${wt})`, worstTurn <= 40);
  // The cut that was 126 degrees in one tick, by name.
  const cut = R.rows.filter(r => /cross>lead hook/.test(r.label));
  check('cross > lead hook: no joint turns more than 40 deg in a tick', cut.every(r => r.wt.v <= 40));
}

// ── 2. punch timing ──
/** Ticks (index) on which side 0's punch resolves, for a run: presses = [[tick, punch, hand], ...]. */
function lands(on, presses, T = 120) {
  const cfg = { ...createConfig(), punchKeysOn: true, inertiaOn: on };
  let s = sim.createState([ROSTER[0], ROSTER[1]], cfg, 1);
  s.fighters[0].pos = { x: -0.42, z: 0 }; s.fighters[1].pos = { x: 0.42, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], cfg).state;
  const out = [];
  for (let t = 0; t < T; t++) {
    const pr = presses.find(p => p[0] === t);
    const r = sim.step(s, [pr ? PUNCH(pr[1], pr[2]) : inp(), inp()], cfg); s = r.state;
    // The punch's resolution tick: the glove's contact (a land, a block, a whiff at full reach).
    if (r.events.some(e => (e.type === 'punchLand' || e.type === 'punchBlock' || e.type === 'punchWhiff' || e.type === 'punchSmother' || e.type === 'punchStuffed') && e.side === 0)) out.push(t);
  }
  return out;
}
const SINGLES = [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'], ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']];
for (const [p, h] of SINGLES) {
  const a = lands(false, [[2, p, h]]), b = lands(true, [[2, p, h]]);
  check(`${p} ${h}: lands at tick ${a[0]} off, ${b[0]} on (within 1)`, a.length > 0 && b.length > 0 && Math.abs(a[0] - b[0]) <= 1);
}
for (const [name, pr] of [['jab>cross', [[2, 'jab', 'lead'], [11, 'cross', 'rear']]], ['cross>lead hook', [[2, 'cross', 'rear'], [17, 'hook', 'lead']]]]) {
  const a = lands(false, pr), b = lands(true, pr);
  check(`${name}: second punch lands at tick ${a[1]} off, ${b[1]} on (within 2)`, a.length > 1 && b.length > 1 && Math.abs(a[1] - b[1]) <= 2);
}

// ── 3. inertiaOn = false is the pre-change sim ──
{
  const cfg = { ...createConfig(), inertiaOn: false };
  let s = sim.createState([ROSTER[0], ROSTER[1]], cfg, 7);
  const script = i => {
    const a = inp(), b = inp();
    if (i < 40) a.move = { x: 0, y: 1 };
    if (i === 100) a.jab = true;
    if (i >= 130 && i < 160) a.cross = true;
    if (i >= 200 && i < 260) a.block = true;
    if (i >= 260 && i < 400) a.move = { x: 1, y: 0.2 };
    if (i === 300) a.jab = true;
    if (i === 330) { a.hook = true; a.move = { x: -1, y: 0 }; }
    if (i >= 420 && i < 480) a.move = { x: 0, y: -1 };
    if (i === 500) a.cross = true;
    if (i >= 90 && i < 110) b.block = true;
    if (i === 320) b.jab = true;
    if (i >= 340 && i < 360) b.move = { x: -1, y: 0 };
    return [a, b];
  };
  let h = 2166136261;
  const mix = str => { for (let k = 0; k < str.length; k++) { h ^= str.charCodeAt(k); h = Math.imul(h, 16777619) >>> 0; } };
  let hasInertia = false;
  for (let i = 0; i < 600; i++) {
    s = sim.step(s, script(i), cfg).state;
    for (const f of s.fighters) { mix(JSON.stringify(f.skel.q)); mix(JSON.stringify(f.gloves.map(g => g.pos))); mix(JSON.stringify(f.headBox)); if (f.inertia) hasInertia = true; }
  }
  const PINNED = '3889377711';
  check(`off: no inertia state is ever created`, !hasInertia);
  check(`off: skeleton, gloves and head fingerprint is the pre-change one (${h})`, String(h) === PINNED);
}
done();
