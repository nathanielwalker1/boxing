/**
 * joint_jump_probe.mjs — how far each joint turns in ONE sim tick at every motion change (slice A1: measurement only).
 * Node, no browser:   node scripts/joint_jump_probe.mjs
 *
 * The pose measured is f.skel (src/sim/skel.ts fitSimTorso + fitSimArm: the final per-tick joint-space pose the hit
 * shapes are rewritten from). Per joint: turn_t = the angle between this tick's and last tick's LOCAL rotation (deg);
 * dv_t = |turn_t - turn_(t-1)| (deg/tick^2) — "start or stop in one tick".
 * Default config (skelOn, punchKeysOn, hitChainV2 all on: punchKeysOn is forced on here in case the default is off).
 * Scenario: ROSTER red vs blue at 0.84 m (1.2 m for the walks), 30 idle ticks, then the scenario; side 0 is measured
 * (hit scenarios: side 1 throws, side 0 stands). Rel tick 0 = the state change (the press / flick release / impulse).
 * "peak" column = the fastest turn of ANY joint on a tick where the measured man is mid-punch (normal fast), per row.
 */
import { load } from './load.mjs';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, JOINT_NAMES, JOINT_COUNT } = core;
let cfg = { ...createConfig(), punchKeysOn: true };
const ARGV_ON_ONLY = process.argv.includes('--on-only');
const DEG = 180 / Math.PI;
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const HOOKX = { lead: -1, rear: 1 };
const PUNCH = (p, h) => inp({ [p]: true, ...(p === 'hook' || p === 'uppercut' ? { move: { x: HOOKX[h], y: 0 } } : {}) });

/** Run `fn(t, state) -> [in0, in1]` for T ticks after 30 idle ones; returns per-tick joint turns of `side` and markers. */
function run(fn, T, { dist = 0.84, side = 0 } = {}) {
  let s = sim.createState([ROSTER[0], ROSTER[1]], cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], cfg).state;
  let prevQ = s.fighters[side].skel.q.slice();
  const turn = [], mid = [], ptype = [], ev = [];
  for (let t = 0; t < T; t++) {
    const r = sim.step(s, fn(t, s), cfg); s = r.state;
    const f = s.fighters[side], q = f.skel.q, row = [];
    for (let j = 0; j < JOINT_COUNT; j++) {
      const d = Math.abs(q[4 * j] * prevQ[4 * j] + q[4 * j + 1] * prevQ[4 * j + 1] + q[4 * j + 2] * prevQ[4 * j + 2] + q[4 * j + 3] * prevQ[4 * j + 3]);
      row.push(2 * Math.acos(Math.min(1, d)) * DEG);
    }
    prevQ = q.slice(); turn.push(row); ptype.push(f.punch.type); ev.push(r.events);
  }
  return { turn, ptype, ev };
}
const none = () => [inp(), inp()];
const firstIdx = (a, p, from = 0) => { for (let i = from; i < a.length; i++) if (p(a[i], i)) return i; return -1; };

// ── window analysis ──
const ALL = [];   // every (scenario, joint, tick, deg) from non-impulse windows
const ROWS = [];
let peakAll = { v: 0, j: '' };
function analyse(label, R, t0, a, b, { impulse = false, note = '' } = {}) {
  // a..b: ticks relative to t0 (inclusive), turn index = t0 + rel
  let wt = { v: -1 }, wd = { v: -1 }, peak = { v: 0, j: '' };
  for (let rel = a; rel <= b; rel++) {
    const t = t0 + rel; if (t < 1 || t >= R.turn.length) continue;
    for (let j = 0; j < JOINT_COUNT; j++) {
      const v = R.turn[t][j], dv = Math.abs(v - R.turn[t - 1][j]);
      if (v > wt.v) wt = { v, j: JOINT_NAMES[j], rel };
      if (dv > wd.v) wd = { v: dv, j: JOINT_NAMES[j], rel };
      if (!impulse && v > 0.05) ALL.push({ label, joint: JOINT_NAMES[j], rel, deg: v });
    }
  }
  // normal-fast reference: fastest turn on any tick where the man is mid-punch (whole run)
  // (combos are skipped: their peak IS the jump; single punches give the reference)
  if (!/^3 |^5 slip \w+>|drop>/.test(label)) for (let t = 1; t < R.turn.length; t++) if (R.ptype[t]) for (let j = 0; j < JOINT_COUNT; j++) if (R.turn[t][j] > peak.v) peak = { v: R.turn[t][j], j: JOINT_NAMES[j] };
  if (peak.v > peakAll.v) peakAll = peak;
  ROWS.push({ label: label + (note ? ` ${note}` : ''), wt, wd, peak });
}

/** All the scenarios with inertiaOn = `on`; returns the rows, the individual jumps and the fastest mid-punch turn. */
function suite(on) {
cfg = { ...createConfig(), punchKeysOn: true, inertiaOn: on };
ROWS.length = 0; ALL.length = 0; peakAll = { v: 0, j: '' };
// ── 1 + 2: single punches ──
const PUNCHES = [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'], ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']];
for (const [p, h] of PUNCHES) {
  const R = run(t => [t === 2 ? PUNCH(p, h) : inp(), inp()], 70);
  const end = firstIdx(R.ptype, (x, i) => i > 2 && x === null);
  analyse(`1 guard>${p} ${h}`, R, 2, 0, 3);
  if (end > 0) analyse(`2 ${p} ${h}>guard`, R, end, -8, 4, { note: `(end@${end - 2}, win -8..+4)` });
}

// ── 3: punch to punch, second pressed at the earliest tick the sim accepts it ──
function earliest(seq) {
  // seq: [[punch,hand], ...]; press k-th at tick t_k. Search each gap 1..60 for the smallest that starts that punch.
  const presses = [2];
  for (let k = 1; k < seq.length; k++) {
    let found = -1;
    for (let gap = 1; gap < 70 && found < 0; gap++) {
      const pr = [...presses, presses[k - 1] + gap];
      const R = run(t => { const i = pr.indexOf(t); return [i >= 0 ? PUNCH(...seq[i]) : inp(), inp()]; }, pr[k] + 8);
      // accepted if the new punch's type is active the tick after the press, and it is the intended type
      if (R.ptype[pr[k] + 1] === seq[k][0]) found = gap;   // the new punch is the active one the tick after the press
    }
    presses.push(presses[k - 1] + (found < 0 ? 40 : found));
  }
  return presses;
}
for (const [name, seq] of [['jab>cross', [['jab', 'lead'], ['cross', 'rear']]], ['jab>cross>lead hook', [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead']]], ['cross>lead hook', [['cross', 'rear'], ['hook', 'lead']]]]) {
  const pr = earliest(seq);
  const R = run(t => { const i = pr.indexOf(t); return [i >= 0 ? PUNCH(...seq[i]) : inp(), inp()]; }, pr[pr.length - 1] + 60);
  for (let k = 1; k < pr.length; k++) analyse(`3 ${name}`, R, pr[k], -1, 3, { note: `(2nd at +${pr[k] - pr[k - 1]}t)` });
}

// ── 4: hit to guard (side 1 throws, side 0 idle) ──
for (const [p, h] of [['cross', 'rear'], ['hook', 'lead']]) {
  const R = run(t => [inp(), t === 2 ? PUNCH(p, h) : inp()], 90);
  const imp = firstIdx(R.ev, es => es.some(e => e.type === 'punchLand' && e.target === 0));
  if (imp < 0) { ROWS.push({ label: `4 hit ${p}: NO LAND`, wt: { v: 0, j: '-', rel: 0 }, wd: { v: 0, j: '-', rel: 0 }, peak: { v: 0, j: '-' } }); continue; }
  analyse(`4 hit ${p} impulse tick`, R, imp, 0, 0, { impulse: true });
  analyse(`4 hit ${p} after impulse`, R, imp, 1, 20, { note: '(+1..+20)' });
}

// ── 5: slips (flick = 3 ticks of push, then release; the release tick is the state change) ──
const FLICKS = [['left', { x: -1, y: 0 }], ['right', { x: 1, y: 0 }], ['back', { x: 0, y: -1 }]];
for (const [n, mv] of FLICKS) {
  const flick = t => (t >= 2 && t < 5 ? [inp({ move: mv }), inp()] : [inp(), inp()]);
  const R = run(flick, 80);
  const sl = firstIdx(R.ev, es => es.some(e => e.type === 'slip' && e.side === 0));
  if (sl < 0) { ROWS.push({ label: `5 slip ${n}: NO SLIP`, wt: { v: 0, j: '-', rel: 0 }, wd: { v: 0, j: '-', rel: 0 }, peak: { v: 0, j: '-' } }); continue; }
  analyse(`5 slip ${n} onset`, R, sl, -1, 3);
  analyse(`5 slip ${n} return`, R, sl, 4, 40, { note: '(+4..+40)' });
  // earliest jab (and cross) pressed after the flick release that the sim accepts, while the slip is in progress
  for (const [p, h] of [['jab', 'lead'], ['cross', 'rear']]) {
    let pt = -1;
    for (let k = sl - 1; k < sl + 40 && pt < 0; k++) {
      const Rk = run(t => (t === k ? [PUNCH(p, h), inp()] : flick(t)), k + 4);
      if (Rk.ptype[k + 1] === p || Rk.ptype[k] === p) pt = k;
    }
    if (pt < 0) { ROWS.push({ label: `5 slip ${n}>${p}: never accepted`, wt: { v: 0, j: '-', rel: 0 }, wd: { v: 0, j: '-', rel: 0 }, peak: { v: 0, j: '-' } }); continue; }
    const Rp = run(t => (t === pt ? [PUNCH(p, h), inp()] : flick(t)), pt + 60);
    analyse(`5 slip ${n}>${p}`, Rp, pt, -1, 3, { note: `(press at slip${pt - sl >= 0 ? '+' : ''}${pt - sl})` });
  }
}

// ── 6: block ──
{
  const blk = t => (t >= 2 && t < 30 ? [inp({ block: true }), inp()] : [inp(), inp()]);
  const R = run(blk, 70);
  analyse('6 block raised', R, 2, 0, 3);
  analyse('6 block dropped', R, 30, 0, 3);
  const R2 = run(t => (t >= 2 && t < 30 ? [inp({ block: true }), inp()] : t === 30 ? [PUNCH('jab', 'lead'), inp()] : [inp(), inp()]), 90);
  analyse('6 block drop>jab same tick', R2, 30, -1, 3);
}

// ── 7: walking, then a jab mid-step; and the stick onset / release ──
for (const [n, mv] of [['forward', { x: 1, y: 0 }], ['back', { x: -1, y: 0 }], ['sideways', { x: 0, y: 1 }]]) {
  const walk = t => (t >= 2 && t < 40 ? inp({ move: mv }) : inp());
  const R = run(t => [t === 24 ? PUNCH('jab', 'lead') : walk(t), inp()], 90, { dist: 1.4 });
  analyse(`7 walk ${n} start`, R, 2, 0, 3);
  analyse(`7 walk ${n} jab mid-step`, R, 24, -1, 3);
  const R2 = run(t => [walk(t), inp()], 90, { dist: 1.4 });
  analyse(`7 walk ${n} stop`, R2, 40, 0, 3);
}

return { rows: ROWS.slice(), all: ALL.slice(), peak: { ...peakAll } };
}
export { suite };

// ── output: off column, on column ──
if (process.argv[1] && process.argv[1].endsWith('joint_jump_probe.mjs')) {
  const f1 = v => v.toFixed(1).padStart(6);
  const off = ARGV_ON_ONLY ? null : suite(false), on = suite(true);
  console.log('scenario'.padEnd(46) + (off ? 'turn off ' : '') + 'turn on  | ' + (off ? 'dv off  ' : '') + 'dv on   | worst joint on, rel');
  on.rows.forEach((r, i) => {
    const o = off ? off.rows[i] : null;
    console.log(`${r.label.padEnd(46)}${o ? f1(o.wt.v) + '    ' : ''}${f1(r.wt.v)}    | ${o ? f1(o.wd.v) + '  ' : ''}${f1(r.wd.v)}  | ${r.wt.j} ${r.wt.rel}`);
  });
  console.log(`\nfastest mid-punch turn: off ${off ? off.peak.v.toFixed(1) : '-'}  on ${on.peak.v.toFixed(1)} (${on.peak.j})`);
  for (const [name, R] of [['off', off], ['on', on]]) {
    if (!R) continue;
    console.log(`\n10 worst individual one-tick turns, inertia ${name} (impulse ticks excluded):`);
    const seen = new Set();
    R.all.sort((x, y) => y.deg - x.deg);
    let n = 0;
    for (const a of R.all) {
      const key = `${a.label}|${a.joint}|${a.rel}`;
      if (seen.has(key)) continue; seen.add(key);
      console.log(`  ${a.deg.toFixed(2).padStart(7)} deg  ${a.label.padEnd(40)} ${a.joint.padEnd(16)} rel ${a.rel}`);
      if (++n >= 10) break;
    }
  }
}
