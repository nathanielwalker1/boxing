#!/usr/bin/env node
/**
 * feel_probe.mjs — "laggy, robotic" and "the punch stun is too much", measured (polish phase, item 2).
 *
 *   node scripts/feel_probe.mjs motion     # press → first visible motion, per punch × situation
 *   node scripts/feel_probe.mjs lockout    # after taking each punch: ms until a punch of mine can START, and what held it
 *   node scripts/feel_probe.mjs busy       # a busy exchange between two bots: frozen time per second, single-tick pose jumps
 *   node scripts/feel_probe.mjs all key=value …   # config overrides (numbers / true / false)
 *
 * "Visible motion" = the punching glove more than 1 cm from where it was at the press, or the torso twist more
 * than 1° from it. Ticks are 1/60 s of REAL time (a frozen hit-stop tick counts: the player waits through it).
 */
import { kit } from './bots/kit.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';

const args = process.argv.slice(2);
const mode = args[0] ?? 'all';
const k = await kit({ rated: args.includes('rated') });
const cfg = { ...k.cfg };
for (const a of args) { const m = a.match(/^(\w+)=(.+)$/); if (m) cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]); }
const PUNCHES = ['jab', 'cross', 'hook', 'uppercut'];
const ms = t => Math.round(t * 1000 / 60);
const DEG = 180 / Math.PI;

/** Ticks from `press` until side 0's punch has started and until its glove / twist visibly moves. */
function motionAfter(s, punch, pre, script) {
  // `pre` ticks of `script(i)` inputs, then the press on tick `pre`.
  let pressAt = -1, startAt = -1, moveAt = -1, ref = null;
  for (let i = 0; i < pre + 60; i++) {
    const ins = script(i, s);
    if (i === pre) { ins[0] = { ...ins[0], [punch]: true }; pressAt = i; }
    const before = s;
    const r = k.sim.step(s, ins, cfg); s = r.state;
    if (i === pre) ref = { g: before.fighters[0].gloves.map(g => ({ ...g.pos })), twist: before.fighters[0].torsoTwist, pos: { ...before.fighters[0].pos } };
    if (i >= pre) {
      if (startAt < 0 && r.events.some(e => e.type === 'punchStart' && e.side === 0 && e.punch === punch)) startAt = i;
      if (startAt >= 0 && moveAt < 0) {
        const f = s.fighters[0], h = f.punch.hand === 'lead' ? 0 : 1;
        // Relative to the fighter's own position, so walking does not count as the punch moving.
        const dx = (f.gloves[h].pos.x - f.pos.x) - (ref.g[h].x - ref.pos.x), dy = f.gloves[h].pos.y - ref.g[h].y, dz = (f.gloves[h].pos.z - f.pos.z) - (ref.g[h].z - ref.pos.z);
        if (Math.hypot(dx, dy, dz) > 0.01 || Math.abs(f.torsoTwist - ref.twist) * DEG > 1) moveAt = i;
      }
    }
    if (moveAt >= 0) break;
  }
  return { start: startAt < 0 ? null : startAt - pressAt, move: moveAt < 0 ? null : moveAt - pressAt };
}

function motion() {
  console.log('\nPress → the punch starts → first visible motion (ticks; ms). `--` = the press never became a punch inside a second.\n');
  const sit = {
    'from rest': { pre: 0, script: () => [k.inp(), k.NONE] },
    'walking forward': { pre: 20, script: () => [k.inp({ move: { x: 0, y: 1 } }), k.NONE], dist: 1.6 },
    'mid-combination (4 ticks into a jab that lands)': { pre: 4, script: i => [k.inp({ jab: i === 0 }), k.NONE] },
    'mid-combination (4 ticks into a cross that lands)': { pre: 4, script: i => [k.inp({ cross: i === 0 }), k.NONE] },
    'the tick a landed jab freezes (hit-stop)': { pre: 7, script: i => [k.inp({ jab: i === 0 }), k.NONE] },
    'block held, released on the press tick': { pre: 20, script: i => [k.inp({ block: i < 20 }), k.NONE] },
    'the tick after his jab lands on me': { pre: 8, script: i => [k.inp(), k.inp({ jab: i === 0 })] },
    'the tick after his cross lands on me': { pre: 13, script: i => [k.inp(), k.inp({ cross: i === 0 })] },
    'the tick after his hook lands on me': { pre: 16, script: i => [k.inp(), k.inp({ hook: i === 0 })], dist: 0.7 },
    'the tick after I block his cross (still holding → release)': { pre: 13, script: i => [k.inp({ block: i < 13 }), k.inp({ cross: i === 0 })] },
  };
  console.log('situation'.padEnd(58) + PUNCHES.map(p => p.padEnd(22)).join(''));
  for (const [name, c] of Object.entries(sit)) {
    const cells = PUNCHES.map(p => {
      const r = motionAfter(k.fresh(cfg, c.dist ?? 0.8), p, c.pre, c.script);
      return (r.start === null ? '--' : `start +${r.start} move +${r.move ?? '?'} (${r.move === null ? '?' : ms(r.move)} ms)`).padEnd(22);
    });
    console.log(name.padEnd(58) + cells.join(''));
  }
}

/** After `hit(i)` (side 1's script) lands on side 0: ticks until side 0 could start a punch, and what held it. */
function lockoutCase(name, { dist = 0.78, mine = () => k.inp(), his, prep = null, c = cfg }) {
  let s = k.fresh(c, dist);
  if (prep) prep(s);
  let landAt = -1, ev = null, free = -1, mineWas = '', inFlight = false; const why = new Set();
  for (let i = 0; i < 240; i++) {
    const r = k.sim.step(s, [mine(i, s, landAt), his(i, s)], c); s = r.state;
    for (const e of r.events) if (e.side === 0 && landAt >= 0 || e.type === 'punchStuffed') {
      if (e.type === 'punchStuffed' && e.side === 0) mineWas = 'STUFFED';
      else if (e.type === 'punchLand' && e.side === 0) mineWas = `still LANDED (${k.mag(e).toFixed(0)} N·s, nerf ${(e.nerf ?? 0).toFixed(2)})`;
      else if (e.type === 'punchWhiff' && e.side === 0) mineWas = 'came out, fell short';
    }
    if (landAt < 0) {
      ev = r.events.find(e => (e.type === 'punchLand' || e.type === 'punchBlock') && e.side === 1);
      if (ev) landAt = i;
      continue;
    }
    const f = s.fighters[0];
    if (f.punch.type !== null && mineWas === '' && !f.punch.resolved) inFlight = true;
    if (k.sim.canStartPunch(f, c) && !f.down) { free = i; break; }
    if (f.down) why.add('down');
    else if (f.hurt > 0 && f.punch.type === null && !(f.blockStun > 0)) why.add(f.hurtKind === 'body' ? 'winded lock' : 'rocked lock');
    else if (f.blockStun > 0) why.add('block stun');
    else if (f.punch.type !== null) why.add('own punch in flight');
    else why.add('other');
  }
  if (mineWas) why.add(`my punch ${mineWas}`);
  const what = ev ? `${ev.type === 'punchLand' ? ev.grade : 'blocked'} ${ev.punch} ${ev.type === 'punchLand' ? k.mag(ev).toFixed(0) + ' N·s' : ''}` : 'never landed';
  const wait = landAt < 0 ? '--' : free < 0 ? '> 4 s' : `${free - landAt} t = ${ms(free - landAt)} ms`;
  console.log(`${name.padEnd(46)} ${what.padEnd(26)} ${wait.padEnd(16)} ${[...why].join(', ') || '—'}`);
  return landAt < 0 || free < 0 ? null : free - landAt;
}

function lockout(c = cfg) {
  console.log('\nAfter being hit: how long until a punch of mine can START (real ticks from the land; hit-stop included), and what held it\n');
  console.log('case'.padEnd(46) + ' ' + 'what landed'.padEnd(26) + ' ' + 'locked for'.padEnd(16) + ' held by');
  const out = {};
  for (const p of PUNCHES) out[`rest/${p}`] = lockoutCase(`standing, hands at rest — his ${p}`, { his: i => k.inp({ [p]: i === 0 }), dist: p === 'hook' || p === 'uppercut' ? 0.7 : 0.78, c });
  out.glance = lockoutCase('his jab at the end of the arm (glancing)', { his: i => k.inp({ jab: i === 0 }), dist: 1.0, c });
  for (const p of PUNCHES) out[`block/${p}`] = lockoutCase(`blocking (released on the land) — his ${p}`, { his: i => k.inp({ [p]: i === 0 }), mine: (i, s, landAt) => k.inp({ block: landAt < 0 }), dist: p === 'hook' || p === 'uppercut' ? 0.7 : 0.78, c });
  out.walk = lockoutCase('walking onto his jab (the jab stop)', { his: i => k.inp({ jab: i === 8 }), mine: () => k.inp({ move: { x: 0, y: 1 } }), dist: 1.25, c });
  out.stuffJab = lockoutCase('his jab in the wind-up of my hook', { his: i => k.inp({ jab: i === 0 }), mine: i => k.inp({ hook: i === 0 }), c });
  out.stuffCross = lockoutCase('his cross in the wind-up of my uppercut', { his: i => k.inp({ cross: i === 0 }), mine: i => k.inp({ uppercut: i === 3 }), c });
  out.lateJab = lockoutCase('his jab late in my cross (arrives, bled)', { his: i => k.inp({ jab: i === 3 }), mine: i => k.inp({ cross: i === 0 }), c });
  out.rocked = lockoutCase('his hook rocks me (health 0.35)', { his: i => k.inp({ hook: i === 0 }), dist: 0.7, prep: s => { s.fighters[0].health = 0.35; }, c });
  out.winded = lockoutCase('his body hook winds me (worn body)', { his: i => k.inp({ hook: i === 3, level: i <= 3, move: { x: i === 3 ? 1 : 0, y: 0 } }), dist: 0.7, prep: s => { s.fighters[0].damage.body = 1.0; s.fighters[0].stamina = 0.5; }, c });
  return out;
}

function busy(seconds = 60) {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  console.log(`\nBusy exchanges: the inside-fighter bot against the swarmer AI, up to ${seconds} s each (to the first knockdown), seeds ${SEEDS.join(' ')}\n`);
  const spec = id => k.core.ROSTER.find(f => f.id === id);
  const specs = [spec('red'), spec('boiler')];
  const c = { ...cfg, ratingsOn: true, stylesOn: true, roundSeconds: seconds, roundCount: 1 };
  const frozenAt = [], lands = []; let ticks = 0, stops = 0, longest = 0, run = 0;
  const hist = [], evAt = [];
  for (const seed of SEEDS) {
  let s = k.sim.createState(specs, c, seed);
  let ai = k.ai.createAi(1, seed, c, k.ai.styleFor(specs[1], c));
  const bot = insideFighter.create(k, seed, c);
  let own = 0;
  // hist: per tick, per fighter: lead glove, rear glove, head (relative to feet), twist, lean
  const what = f => `${f.punch.type ?? '-'}/${f.punch.variant}/${f.punch.phase}/${f.punch.progress.toFixed(2)}${f.punch.feint ? '/feint' : ''}${f.down ? ' down' : ''}${f.clinch.active ? ' clinch' : ''}${f.slip.active ? ' slip:' + f.slip.kind : ''}${f.pivot.dir ? ' pivot' : ''}${f.burstT > 0 ? ' burst' : ''}${f.hurt > 0 ? ' hurt' : ''}`;
  const snap = f => ({ w: what(f), g0: { x: f.gloves[0].pos.x - f.pos.x, y: f.gloves[0].pos.y, z: f.gloves[0].pos.z - f.pos.z }, g1: { x: f.gloves[1].pos.x - f.pos.x, y: f.gloves[1].pos.y, z: f.gloves[1].pos.z - f.pos.z }, h: { x: f.headBox.x - f.pos.x, y: f.headBox.y, z: f.headBox.z - f.pos.z }, tw: f.torsoTwist, ln: f.lean.fwd });
  while (s.round.phase === 'fighting' && own++ < seconds * 60 + 600) {
    const d = k.ai.aiStep(ai, s, c); ai = d.ai;
    const r = k.sim.step(s, [bot.step(s), d.input], c); s = r.state;
    const fr = s.hitStop > 0;
    frozenAt.push(fr ? 1 : 0);
    if (fr) { run++; longest = Math.max(longest, run); } else { if (run > 0) stops++; run = 0; }
    hist.push(s.fighters.map(snap));
    evAt.push(r.events.filter(e => /punchLand|punchBlock|punchStuffed|knockdown|rocked|slip|getUp|perfectBlock/.test(e.type)).map(e => e.type).join('+'));
    for (const e of r.events) if (e.type === 'punchLand') lands.push(ticks);
    ticks++;
  }
  // A gap between fights, so no window or jump is measured across one.
  for (let i = 0; i < 120; i++) { frozenAt.push(0); hist.push(hist[hist.length - 1]); evAt.push('gap'); }
  if (run > 0) { stops++; run = 0; }
  }
  const total = frozenAt.reduce((a, b) => a + b, 0);
  let worst = 0, worst2 = 0;
  for (let i = 0; i + 60 <= frozenAt.length; i++) { let n = 0; for (let j = 0; j < 60; j++) n += frozenAt[i + j]; worst = Math.max(worst, n); }
  for (let i = 0; i + 120 <= frozenAt.length; i++) { let n = 0; for (let j = 0; j < 120; j++) n += frozenAt[i + j]; worst2 = Math.max(worst2, n); }
  console.log(`hit-stop: ${total} of ${ticks} ticks frozen (${(100 * total / ticks).toFixed(1)}%) in ${stops} stops · ${lands.length} lands · longest single stop ${longest} t (${ms(longest)} ms) · worst 1 s window ${worst} t (${Math.round(100 * worst / 60)}%) · worst 2 s window ${worst2} t (${Math.round(100 * worst2 / 120)}%)`);
  // Single-tick jumps: a per-tick change larger than `abs` AND more than 3× both neighbours' changes.
  const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const chans = { 'lead glove (cm)': [(a, b) => d3(a.g0, b.g0) * 100, 10], 'rear glove (cm)': [(a, b) => d3(a.g1, b.g1) * 100, 10], 'head (cm)': [(a, b) => d3(a.h, b.h) * 100, 5], 'twist (deg)': [(a, b) => Math.abs(a.tw - b.tw) * DEG, 12], 'lean': [(a, b) => Math.abs(a.ln - b.ln), 0.25] };
  for (const [name, [fn, abs]] of Object.entries(chans)) {
    let n = 0, max = 0; const ctx = {};
    for (const side of [0, 1]) for (let i = 2; i < hist.length - 1; i++) {
      const d = fn(hist[i][side], hist[i - 1][side]), p = fn(hist[i - 1][side], hist[i - 2][side]), q = fn(hist[i + 1][side], hist[i][side]);
      if (d > abs && d > 3 * Math.max(p, q, 1e-9)) {
        n++; max = Math.max(max, d); const key = evAt[i] || evAt[i - 1] || 'no event'; ctx[key] = (ctx[key] ?? 0) + 1;
        if ((args.includes('jumps') || args.includes('jumps=' + name.split(' ')[0])) && key === 'no event') console.log(`    ${name} t${i} side ${side} Δ${d.toFixed(1)}: ${hist[i - 1][side].w}  →  ${hist[i][side].w}`);
      }
    }
    console.log(`${name.padEnd(18)} ${String(n).padStart(3)} single-tick jumps over ${abs} (max ${max.toFixed(1)})  ${Object.entries(ctx).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([key, v]) => `${key} ×${v}`).join(' · ')}`);
  }
}

/** What the SIM produces per grade: impulse, freeze, how far the head and torso are displaced on the frozen frame, how far the feet are knocked. */
function grades(c = cfg) {
  console.log('\nPer grade — what one land produces (target standing, hands at rest unless it says walking in)\n');
  console.log('case'.padEnd(34) + 'grade'.padEnd(10) + 'N·s'.padEnd(7) + 'freeze ms'.padEnd(11) + 'head cm'.padEnd(9) + 'torso cm'.padEnd(10) + 'knocked cm'.padEnd(12) + 'zone'.padEnd(10) + 'health −');
  const one = (name, dist, punch, { walk = false, combo = null } = {}) => {
    let s = k.fresh(c, dist), ev = null, at = -1, disp = null, stop = 0, p0 = null, h0 = 0;
    const presses = combo ?? [punch];
    for (let i = 0; i < 160; i++) {
      const t0 = walk ? 2 : 0;
      const idx = i >= t0 && (i - t0) % 8 === 0 ? (i - t0) / 8 : -1;
      const pr = idx >= 0 && idx < presses.length ? presses[idx] : null;
      if (p0 === null) { p0 = { ...s.fighters[1].pos }; h0 = s.fighters[1].health; }
      // `walk` here = the flush set-up: the target is ROCKED (open), set directly so nothing else differs.
      if (walk && i === 0) { s.fighters[1].hurt = 2; s.fighters[1].hurtMax = 3; s.fighters[1].hurtKind = 'head'; }
      const r = k.sim.step(s, [k.inp({ [pr ?? 'none']: true, move: { x: pr === 'hook' ? -1 : 0, y: 0 } }), k.NONE], c); s = r.state;
      const land = r.events.filter(e => e.type === 'punchLand' && e.side === 0).pop();
      if (land && (!combo || land.punch === presses[presses.length - 1])) {
        ev = land; at = i; const re = s.fighters[1].reaction;
        disp = { head: Math.hypot(re.head.x, re.head.y, re.head.z) * 100, torso: Math.hypot(re.torso.x, re.torso.y, re.torso.z) * 100 };
        stop = s.hitStop; h0 = h0 - s.fighters[1].health;
        if (walk) break;
      }
    }
    if (!ev) { console.log(name.padEnd(34) + 'no land'); return null; }
    const knocked = walk ? NaN : Math.hypot(s.fighters[1].pos.x - p0.x, s.fighters[1].pos.z - p0.z) * 100;
    console.log(name.padEnd(34) + `${ev.grade}${ev.finisher ? '!' : ''}`.padEnd(10) + k.mag(ev).toFixed(0).padEnd(7) + String(Math.round(stop * 1000)).padEnd(11) + disp.head.toFixed(1).padEnd(9) + disp.torso.toFixed(1).padEnd(10) + (Number.isNaN(knocked) ? '—' : knocked.toFixed(0)).padEnd(12) + String(ev.zone ?? '—').padEnd(10) + h0.toFixed(3));
    return { grade: ev.grade, mag: k.mag(ev), stop, ...disp, knocked, finisher: !!ev.finisher };
  };
  return {
    jabG: one('jab at 1.00 m', 1.0, 'jab'), jabC: one('jab at 0.80 m', 0.8, 'jab'), jabF: one('jab at 0.80 m on a rocked man', 0.8, 'jab', { walk: true }),
    crossG: one('cross at 1.03 m', 1.03, 'cross'), crossC: one('cross at 0.80 m', 0.8, 'cross'), crossF: one('cross at 0.80 m on a rocked man', 0.8, 'cross', { walk: true }),
    hookC: one('hook at 0.72 m', 0.72, 'hook'), upC: one('uppercut at 0.66 m', 0.66, 'uppercut'),
    fin: one('the hook of a 1-2-3 from 0.75 m', 0.75, 'hook', { combo: ['jab', 'cross', 'hook'] }),
  };
}

if (mode === 'grades' || mode === 'all') grades();
if (mode === 'motion' || mode === 'all') motion();
if (mode === 'lockout' || mode === 'all') lockout();
if (mode === 'busy' || mode === 'all') busy();
export { lockout, busy, motion, grades };
