#!/usr/bin/env node
/**
 * anim_measure.mjs — the combat sim's baseline numbers for the animation rebuild. Plain Node against the sim
 * (through scripts/load.mjs + bots/kit.mjs), no browser, deterministic (fixed seeds). A permanent tool:
 * re-run it after the rebuild and diff against docs/anim/BASELINE_NUMBERS.md.
 *
 *   node scripts/anim_measure.mjs            # every section, A to F
 *   node scripts/anim_measure.mjs A C        # only some sections
 *   node scripts/anim_measure.mjs D 20       # section D with N seeded fights per difficulty (default 20)
 *   node scripts/anim_measure.mjs write      # all sections, and the output is written into docs/anim/BASELINE_NUMBERS.md
 *                                            # between the GENERATED markers (the prose around them is hand-written)
 *
 *   A  press-to-first-motion per punch, buffering, phase lengths
 *   B  frozen / slowed time: hit-stop in the sim, and the host's slow motion modelled from main.ts
 *   C  stamina: cost of every action, regeneration, a realistic budget to the floor
 *   D  the AI by difficulty: block rate, reaction, counters, throw rate, win rates, what gets through a guard
 *   E  counters: definition, multipliers, a counter against the same punch as a normal hit
 *   F  hit-reaction magnitudes: head, neck, torso, feet, return time
 *
 * Ratings and styles are OFF for A, C, E, F (the reference fighters, as the phase-1 tests pin them) and ON for
 * B and D (the game as shipped). Tick = 1/60 s = 16.667 ms.
 */
import { kit } from './bots/kit.mjs';
import { load } from './load.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';
import * as humanPace from './bots/human_pace.mjs';

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const OUT = [];
const realLog = console.log.bind(console);
console.log = (...a) => { OUT.push(a.join(' ')); realLog(...a); };
const argv = process.argv.slice(2);
const SECTIONS = argv.filter(a => /^[A-F]$/.test(a));
const NUM = Number(argv.find(a => /^\d+$/.test(a)) ?? 20);
const want = s => SECTIONS.length === 0 || SECTIONS.includes(s);
const MS = 1000 / 60;
const f1 = x => (Number.isFinite(x) ? x.toFixed(1) : String(x));
const f2 = x => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const f3 = x => (Number.isFinite(x) ? x.toFixed(3) : String(x));
const pct = x => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'n/a');
const row = (...c) => '| ' + c.join(' | ') + ' |';
const head = (...c) => { console.log(row(...c)); console.log(row(...c.map(() => '---'))); };
const title = t => console.log('\n## ' + t + '\n');
const median = xs => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
const quant = (xs, q) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

const [UI] = await load('/src/ui/slowmo.ts');   // the host's slow-motion rule, shared with main.ts
const k = await kit();                       // reference fighters: ratings and styles off
const kr = await kit({ rated: true });       // the game as shipped
const { sim, inp, NONE, fresh, SIM_DT } = k;
const cfg = k.cfg;

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// A. PRESS TO FIRST MOTION
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The pose channels the rig draws from, relative to the hips (so walking does not count as motion). */
function pose(f) {
  const rel = p => [p.x - f.pos.x, p.y, p.z - f.pos.z];
  return { gl: f.gloves.map(g => rel(g.pos)), el: f.arms.map(a => rel(a.elbow)), tw: f.torsoTwist, lf: f.lean.fwd, ll: f.lean.lat, cr: f.crouch };
}
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Which pose channels differ from the idle baseline's, and by how much. */
function poseDiff(p, q) {
  return {
    glove: Math.max(d3(p.gl[0], q.gl[0]), d3(p.gl[1], q.gl[1])) > 0.002,
    elbow: Math.max(d3(p.el[0], q.el[0]), d3(p.el[1], q.el[1])) > 0.002,
    twist: Math.abs(p.tw - q.tw) > 1e-4, lean: Math.abs(p.lf - q.lf) > 1e-4 || Math.abs(p.ll - q.ll) > 1e-4, crouch: Math.abs(p.cr - q.cr) > 1e-4,
  };
}
const CASES = [
  { name: 'jab', p: 'jab', stick: 0 }, { name: 'cross', p: 'cross', stick: 0 },
  { name: 'lead hook', p: 'hook', stick: -1 }, { name: 'rear hook', p: 'hook', stick: 1 },
  { name: 'lead uppercut', p: 'uppercut', stick: -1 }, { name: 'rear uppercut', p: 'uppercut', stick: 1 },
];
const dFor = p => (p === 'hook' ? 0.72 : p === 'uppercut' ? 0.66 : 0.78);
/** A settled fight, with the level held for 12 ticks first if `level` (the body-shot modifier needs the stance to drop). */
function prep(c, dist, level) {
  let s = fresh(c, dist);
  if (level) for (let i = 0; i < 12; i++) s = sim.step(s, [inp({ level: true }), NONE], c).state;
  return s;
}
/** Press `p` on tick 0 from guard; report the first tick (0 = the step that read the press) each channel moves. */
export function pressToMotion(c, caseDef, level, dist = 0.78, other = () => NONE) {
  const mk = () => prep(c, dist, level);
  let s = mk(), b = mk();
  const first = { state: null, progress: null, glove: null, glove1: null, glove5: null, elbow: null, twist: null, lean: null, crouch: null };
  let variant = '-', startTick = null, resolveTick = null, landOrWhiff = '-', endTick = null, extendTick = null, recoverTick = null;
  for (let i = 0; i < 70; i++) {
    const lv = level ? { level: true } : {};
    const r = sim.step(s, [inp({ ...lv, [caseDef.p]: i === 0, move: { x: i === 0 ? caseDef.stick : 0, y: 0 } }), other(i)], c); s = r.state;
    b = sim.step(b, [inp(lv), other(i)], c).state;
    const f = s.fighters[0], pp = pose(f), pb = pose(b.fighters[0]), d = poseDiff(pp, pb);
    const gd = Math.max(d3(pp.gl[0], pb.gl[0]), d3(pp.gl[1], pb.gl[1]));
    if (first.glove1 === null && gd > 0.01) first.glove1 = i;
    if (first.glove5 === null && gd > 0.05) first.glove5 = i;
    if (first.state === null && f.punch.type !== null) first.state = i;
    if (first.progress === null && f.punch.progress > 0) first.progress = i;
    for (const key of ['glove', 'elbow', 'twist', 'lean', 'crouch']) if (first[key] === null && d[key]) first[key] = i;
    if (extendTick === null && f.punch.phase === 'extend') extendTick = i;
    if (recoverTick === null && f.punch.phase === 'recover') recoverTick = i;
    if (endTick === null && startTick !== null && f.punch.type === null) endTick = i;
    for (const e of r.events) {
      if (e.side !== 0) continue;
      if (e.type === 'punchStart') { startTick = i; variant = e.variant; }
      if (resolveTick === null && /punchLand|punchBlock|punchWhiff|perfectBlock/.test(e.type)) { resolveTick = i; landOrWhiff = e.type.replace('punch', ''); }
    }
  }
  const moves = ['glove', 'elbow', 'twist', 'lean', 'crouch'].map(key => first[key]).filter(x => x !== null);
  return { variant, first, motion: moves.length ? Math.min(...moves) : null, startTick, extendTick, recoverTick, resolveTick, endTick, landOrWhiff };
}

/** From a settled guard, a first punch at tick 0 and a second press at tick `at`: the tick the second punch starts (null = dropped within 80 ticks). */
export function secondPress(c, first, second, at, { dist = 0.78, far = false, stick2 = 0 } = {}) {
  let s = fresh(c, far ? 1.6 : dist), fired = null;
  for (let i = 0; i < at + 80; i++) {
    const r = sim.step(s, [inp({ [first.p]: i === 0 || (first.p === second.p && i === at), [second.p]: i === at || (first.p === second.p && i === 0), move: { x: i === 0 ? first.stick : i === at ? stick2 : 0, y: 0 } }), NONE], c); s = r.state;
    if (i > 0) for (const e of r.events) if (e.type === 'punchStart' && e.side === 0 && fired === null) fired = i;
  }
  return fired === null ? null : fired - at;
}
/** Press during a hit-stop: `a` throws; once it lands (hit-stop up) a second press lands `k` ticks after the land tick. Returns the freeze at the land and the fire delay. */
export function pressInHitStop(c, a, b, kAfter, dist = 0.78) {
  // First find the land tick and the freeze it grants.
  let s = fresh(c, dist), landTick = null, freeze = 0;
  for (let i = 0; i < 60 && landTick === null; i++) { const r = sim.step(s, [inp({ [a.p]: i === 0, move: { x: i === 0 ? a.stick : 0, y: 0 } }), NONE], c); s = r.state; if (r.events.some(e => e.type === 'punchLand' && e.side === 0)) { landTick = i; freeze = s.hitStop; } }
  if (landTick === null) return null;
  s = fresh(c, dist);
  const pressAt = landTick + kAfter; let hsAtPress = 0, fired = null, hsAtFire = 0, dropped = false;
  for (let i = 0; i < pressAt + 80; i++) {
    if (i === pressAt) hsAtPress = s.hitStop;
    const r = sim.step(s, [inp({ [a.p]: i === 0 || (a.p === b.p && i === pressAt), [b.p]: i === pressAt || (a.p === b.p && i === 0), move: { x: i === 0 ? a.stick : i === pressAt ? b.stick : 0, y: 0 } }), NONE], c); s = r.state;
    if (i >= pressAt) for (const e of r.events) if (e.type === 'punchStart' && e.side === 0 && fired === null && i >= pressAt) { fired = i - pressAt; hsAtFire = s.hitStop; }
  }
  dropped = fired === null;
  return { landTick, freeze, hsAtPress, fired, hsAtFire, dropped };
}

function sectionA() {
  title('A. Press-to-first-motion (ratings and styles off; tick 0 = the tick the press is read)');
  console.log('Hook: pressToMotion(cfg, case, level) in scripts/anim_measure.mjs (steps sim.step, diffs the rig channels against an idle twin).');
  console.log('Channels: glove/elbow = hand and elbow position relative to the hips, > 2 mm from the idle twin; twist/lean/crouch > 1e-4. "0" = already moved on the tick that read the press (it is drawn on the next frame).\n');
  head('punch', 'level', 'variant', 'state', 'glove >2mm', 'glove >1cm', 'glove >5cm', 'elbow', 'twist', 'lean', 'crouch', 'FIRST MOTION (ticks / ms)', 'extend phase at', 'resolve (hit test) at', 'ends at');
  for (const lvl of [false, true]) for (const cs of CASES) {
    const m = pressToMotion(cfg, cs, lvl, dFor(cs.p) - (cs.p === 'uppercut' ? 0.06 : 0));
    const fm = m.first, t = x => (x === null ? 'never' : x);
    console.log(row(cs.name, lvl ? 'body' : 'head', m.variant, t(fm.state), t(fm.glove), t(fm.glove1), t(fm.glove5), t(fm.elbow), t(fm.twist), t(fm.lean), t(fm.crouch), m.motion === null ? 'never' : `${m.motion} / ${f1(m.motion * MS)}`, t(m.extendTick), `${t(m.resolveTick)} (${f1((m.resolveTick ?? 0) * MS)} ms, ${m.landOrWhiff})`, t(m.endTick)));
  }

  console.log('\n### A.2 Phase lengths as they exist (config keys; ticks measured from the press, from the hit run and the miss run)\n');
  head('punch', 'cock s (key)', 'extend s (key)', 'recover s (key)', 'hold frac (key)', 'tell s = press to hit test', 'phase ticks measured, landed (cock/extend/recover)', 'phase ticks measured, missed (cock/extend/recover)', 'chain opens (ticks after press), landed', 'chain opens, missed');
  for (const cs of CASES.filter(x => ['jab', 'cross', 'lead hook', 'rear uppercut'].includes(x.name))) {
    const key = cs.p, K = key + '';
    const hold = key === 'jab' ? 'jabHoldFrac' : 'punchHoldFrac';
    const run = (dist) => {
      let s = fresh(cfg, dist), cock = 0, ext = 0, rec = 0, chain = null, tell = null;
      for (let i = 0; i < 80; i++) {
        const r = sim.step(s, [inp({ [cs.p]: i === 0, move: { x: i === 0 ? cs.stick : 0, y: 0 } }), NONE], cfg); s = r.state;
        const f = s.fighters[0];
        for (const e of r.events) if (e.type === 'punchStart' && e.side === 0) tell = e.tell;
        if (f.punch.type !== null) { if (f.punch.phase === 'cock') cock++; else if (f.punch.phase === 'extend') ext++; else rec++; if (chain === null && i > 0 && sim.canStartPunch(f, cfg)) chain = i; }
      }
      return { cock, ext, rec, chain, tell };
    };
    const hit = run(dFor(cs.p)), miss = run(1.6);
    console.log(row(cs.name, `${f3(cfg[K + 'Cock'])} (${K}Cock)`, `${f3(cfg[K + 'Extend'])} (${K}Extend)`, `${f3(cfg[K + 'Recover'])} (${K}Recover)`, `${cfg[hold]} (${hold})`, `${f3(hit.tell)} (${f1(hit.tell / SIM_DT)} ticks; hooks/uppercuts floored by tellMinHeavy ${cfg.tellMinHeavy})`, `${hit.cock}/${hit.ext}/${hit.rec}`, `${miss.cock}/${miss.ext}/${miss.rec}`, hit.chain, miss.chain));
  }
  console.log(`\nGlobal: punchTimeScale ${cfg.punchTimeScale}, punchChainAt ${cfg.punchChainAt} (chain after a MISS, fraction of the stretched recover), punchChainOnHit ${cfg.punchChainOnHit} (after a land/block), comboCockScale ${cfg.comboCockScale} (wind-up of a chained punch), whiffRecoveryMult ${cfg.whiffRecoveryMult} (x per-type jabWhiffScale ${cfg.jabWhiffScale} etc.), punchBuffer ${cfg.punchBuffer} s, punchBufferDepth ${cfg.punchBufferDepth}, feintCommit ${cfg.feintCommit} (block in the first ${cfg.feintCommit} of the wind-up cancels it), tellMinHeavy ${cfg.tellMinHeavy}.`);

  console.log('\n### A.3 A press during the previous punch (buffer): ticks from the press to the next punchStart. "x" = dropped (no start within 80 ticks)\n');
  const pairs = [[CASES[0], CASES[1]], [CASES[1], CASES[2]], [CASES[2], CASES[1]], [CASES[0], CASES[0]]];
  for (const far of [false, true]) {
    console.log(`First punch ${far ? 'MISSES (stretched recovery)' : 'LANDS'}:\n`);
    head('first -> second', 'press tick: delay until the second punch starts', 'buffer keeps a press for (s)');
    for (const [a, b] of pairs) {
      const out = [];
      for (let at = a.p === b.p ? 2 : 1; at <= 40; at += far ? 3 : 2) { const d = secondPress(cfg, a, b, at, { far, stick2: b.stick }); out.push(`${at}:${d === null ? 'x' : '+' + d}`); }
      console.log(row(`${a.name} -> ${b.name}`, out.join(' '), cfg.punchBuffer));
    }
    console.log('');
  }

  console.log('### A.4 A press during hit-stop (cross lands, freeze granted; second press k ticks after the land tick)\n');
  head('first -> second', 'k', 'freeze at land (s)', 'freeze left at press (s)', 'ticks press -> second punchStart', 'freeze left at start (s)');
  for (const [a, b] of [[CASES[1], CASES[0]], [CASES[2], CASES[1]]]) {
    for (const kk of [0, 1, 2, 4, 6]) {
      const r = pressInHitStop(cfg, a, b, kk);
      if (!r) { console.log(row(`${a.name} -> ${b.name}`, kk, 'no land', '', '', '')); continue; }
      console.log(row(`${a.name} -> ${b.name}`, kk, f3(r.freeze), f3(r.hsAtPress), r.dropped ? 'x dropped' : r.fired, r.dropped ? '' : f3(r.hsAtFire)));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// E. COUNTERS
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const dist2 = s => Math.hypot(s.fighters[0].pos.x - s.fighters[1].pos.x, s.fighters[0].pos.z - s.fighters[1].pos.z);
/**
 * Side 0 jabs at tick 0; side 1 flicks the stick (x = -1) for 2 ticks from `slipAt` (a SLIP) and throws `punch` at tick `counterAt`.
 * Returns what the first side-1 punchLand did (and the slip / counter events).
 */
export function slipCounterTrial(c, slipAt, counterAt, punch = 'cross', dist = 0.78) {
  let s = fresh(c, dist), land = null, slipDodged = null, counterEv = null, hsAt = null, hpBefore = null, healthAfter = null, vuln = null, press = null, rocked = null, kd = null, winLeft = null, distAtPress = null;
  for (let i = 0; i < 90; i++) {
    if (i === counterAt) { hpBefore = s.fighters[0].health; distAtPress = dist2(s); }
    const hb = s.fighters[0].health;
    const r = sim.step(s, [inp({ jab: i === 0 }), inp({ [punch]: i === counterAt, move: { x: i >= slipAt && i < slipAt + 2 ? -1 : 0, y: 0 } })], c); s = r.state;
    for (const e of r.events) {
      if (e.type === 'slip' && e.side === 1 && e.dodged && slipDodged === null) slipDodged = i;
      if (e.type === 'punchLand' && e.side === 1 && land === null) { land = { ...e, tick: i }; hsAt = s.hitStop; healthAfter = s.fighters[0].health; hpBefore = hb; vuln = null; }
      if (e.type === 'counter' && e.side === 1) counterEv = i;
      if (e.type === 'rocked' && e.side === 0 && rocked === null) rocked = e;
      if (e.type === 'knockdown' && e.side === 0 && kd === null) kd = e;
    }
    if (land && land.tick === i) { winLeft = s.fighters[0].counterWindow; vuln = s.fighters[0].vuln; }
    if (land && i > land.tick + 40) break;
  }
  return { land, slipDodged, counterEv, hsAt, dmg: land ? hpBefore - healthAfter : null, vuln, rocked, kd, winLeft, distAtPress };
}
/** The same punch from the same range at a man who has done nothing (no slip window): a normal hit. */
export function plainTrial(c, punch, dist) {
  let s = fresh(c, dist), land = null, hsAt = null, hpBefore = null, healthAfter = null, rocked = null, kd = null, vuln = null;
  for (let i = 0; i < 60; i++) {
    const hb = s.fighters[0].health;
    const r = sim.step(s, [NONE, inp({ [punch]: i === 0 })], c); s = r.state;
    for (const e of r.events) {
      if (e.type === 'punchLand' && e.side === 1 && land === null) { land = { ...e, tick: i }; hsAt = s.hitStop; hpBefore = hb; healthAfter = s.fighters[0].health; vuln = s.fighters[0].vuln; }
      if (e.type === 'rocked' && e.side === 0 && rocked === null) rocked = e;
      if (e.type === 'knockdown' && e.side === 0 && kd === null) kd = e;
    }
    if (land && i > land.tick + 40) break;
  }
  return { land, hsAt, dmg: land ? hpBefore - healthAfter : null, vuln, rocked, kd };
}
const imp = e => (e ? Math.hypot(e.impulse.x, e.impulse.z) : NaN);

function sectionE() {
  title('E. Counters');
  console.log('Definition: a counter is a punchLand whose target has `counterWindow > 0` AND `punishSource === PUNISH_SLIP` AND `vuln > 0` (src/sim/combat.ts:593). The window is opened only by a successful SLIP of a punch that missed because of the slip (combat.ts:500, applyPunish(attacker, slipPunishVuln, slipPunishDuration, PUNISH_SLIP)). A perfect block opens an exposure window too (combat.ts:738) but a landing in it is NOT a counter (exposedImpulseBonus applies instead).');
  console.log(`Multipliers on a counter: impulse x (1 + vuln x counterImpulseBonus) = 1 + ${cfg.slipPunishVuln} x ${cfg.counterImpulseBonus} (combat.ts:598); a non-counter exposure uses exposedImpulseBonus ${cfg.exposedImpulseBonus}; hit-stop + vuln x counterHitStopBonus ${cfg.counterHitStopBonus} s, tier 2 = always granted in full (combat.ts:749-752); the stun flash threshold x counterFlashScale ${cfg.counterFlashScale} when counterFlashOn ${cfg.counterFlashOn} (stun.ts:103). Window: slipPunishDuration ${cfg.slipPunishDuration} s, slipPunishVuln ${cfg.slipPunishVuln}. The slipped punch also gives hit-stop slipDodgeHitStop ${cfg.slipDodgeHitStop} s (combat.ts:491) and the attacker lunges slipOverreach ${cfg.slipOverreach} m. Host side (not in the sim): main.ts:442 slow motion readCounterSlowMo ${cfg.readCounterSlowMo}x for readCounterSlowMoSeconds ${cfg.readCounterSlowMoSeconds} wall s; ui/read.ts:73 readWindowSlowMo ${cfg.readWindowSlowMo}x for the whole open window when the PLAYER slipped.\n`);
  // Find a slip + counter timing that produces a counter.
  let best = null;
  for (let slipAt = 0; slipAt <= 12 && !best; slipAt++) for (let counterAt = 6; counterAt <= 30 && !best; counterAt++) {
    const t = slipCounterTrial(cfg, slipAt, counterAt, 'cross');
    if (t.land && t.land.counter && t.slipDodged !== null) best = { slipAt, counterAt, t };
  }
  if (!best) { console.log('not measured: no slip + counter timing found in the search grid'); return; }
  const { slipAt, counterAt, t } = best;
  console.log(`Trial found by search: side 0 jabs at tick 0; side 1 flicks at tick ${slipAt} (slip dodged at tick ${t.slipDodged}), crosses at tick ${counterAt}; distance at the counter's press ${f3(t.distAtPress)} m.\n`);
  head('case', 'grade', 'impulse N·s', 'x normal', 'health lost', 'x normal', 'hit-stop at land (s)', 'rocked?', 'knockdown?', 'target vuln at land');
  const plain = plainTrial(cfg, 'cross', t.distAtPress);
  const show = (name, r, ref) => console.log(row(name, r.land.grade, f1(imp(r.land)), f2(imp(r.land) / imp(ref.land)), f3(r.dmg), f2(r.dmg / ref.dmg), f3(r.hsAt), r.rocked ? `yes (${f2(r.rocked.seconds)} s, impulse ${f1(r.rocked.impulse)} vs threshold ${f1(r.rocked.threshold)})` : 'no', r.kd ? r.kd.cause : 'no', f2(r.vuln)));
  show('normal cross (target idle)', plain, plain);
  show('COUNTER cross (after a slip)', t, plain);
  // Ratios by explicit config.
  console.log(`\nPredicted impulse ratio (1 + vuln x counterImpulseBonus) x flush ${cfg.gradeFlushPower} if flush vs measured ${f2(imp(t.land) / imp(plain.land))}. Counter-window left at the land: ${f3(t.winLeft)} s.`);
  // The same, different punches and grades: a jab and a hook as the counter.
  console.log('\nOther counters (same slip, different counter punch):\n');
  head('counter punch', 'landed as', 'grade', 'impulse', 'x normal', 'health lost', 'hit-stop (s)', 'rocked?');
  for (const p of ['jab', 'hook']) {
    let found = null;
    for (let counterAt = 6; counterAt <= 30 && !found; counterAt++) { const r = slipCounterTrial(cfg, slipAt, counterAt, p, 0.78); if (r.land && r.land.counter) found = r; }
    const pl = plainTrial(cfg, p, found ? found.distAtPress : 0.78);
    if (!found || !pl.land) { console.log(row(p, 'no counter in grid', '', '', '', '', '', '')); continue; }
    console.log(row(p, 'counter', found.land.grade, f1(imp(found.land)), f2(imp(found.land) / imp(pl.land)), f3(found.dmg), f3(found.hsAt), found.rocked ? 'yes' : 'no'));
    console.log(row(p, 'normal', pl.land.grade, f1(imp(pl.land)), '1.00', f3(pl.dmg), f3(pl.hsAt), pl.rocked ? 'yes' : 'no'));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// F. HIT REACTION MAGNITUDES
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Defender (side 1) pose channels, as differences from an idle twin. */
function reactTrial(c, p, stick, level, dist) {
  const mk = () => prep(c, dist, level);
  const sA = mk(), sB = mk();
  let a = sA, b = sB, land = null;
  const rows = [];
  const lv = level ? { level: true } : {};
  for (let i = 0; i < 150; i++) {
    const r = sim.step(a, [inp({ ...lv, [p]: i === 0, move: { x: i === 0 ? stick : 0, y: 0 } }), NONE], c); a = r.state;
    b = sim.step(b, [inp(lv), NONE], c).state;
    if (!land) for (const e of r.events) if (e.type === 'punchLand' && e.side === 0) land = { ...e, tick: i, grade: e.grade, part: e.part, zone: e.zone, impulse: Math.hypot(e.impulse.x, e.impulse.z) };
    const d = a.fighters[1], q = b.fighters[1];
    const dh = Math.hypot(d.headBox.x - q.headBox.x, d.headBox.y - q.headBox.y, d.headBox.z - q.headBox.z);
    // The neck: the head-to-shoulder (bodyBox.b) vector, angle between the hit run's and the idle run's.
    const v1 = [d.headBox.x - d.bodyBox.b.x, d.headBox.y - d.bodyBox.b.y, d.headBox.z - d.bodyBox.b.z], v2 = [q.headBox.x - q.bodyBox.b.x, q.headBox.y - q.bodyBox.b.y, q.headBox.z - q.bodyBox.b.z];
    const dot = v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2], n = Math.hypot(...v1) * Math.hypot(...v2);
    const neck = Math.acos(Math.max(-1, Math.min(1, dot / Math.max(1e-9, n)))) * 180 / Math.PI;
    // The trunk: the hips-to-shoulders (bodyBox a→b) axis against the idle run's.
    const t1 = [d.bodyBox.b.x - d.bodyBox.a.x, d.bodyBox.b.y - d.bodyBox.a.y, d.bodyBox.b.z - d.bodyBox.a.z], t2 = [q.bodyBox.b.x - q.bodyBox.a.x, q.bodyBox.b.y - q.bodyBox.a.y, q.bodyBox.b.z - q.bodyBox.a.z];
    const trunk = Math.acos(Math.max(-1, Math.min(1, (t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2]) / Math.max(1e-9, Math.hypot(...t1) * Math.hypot(...t2))))) * 180 / Math.PI;
    const feet = Math.hypot(d.pos.x - q.pos.x, d.pos.z - q.pos.z);
    // Head against the feet: the head's move relative to the hips' floor position, i.e. the body bending, not the whole man being shoved.
    const dhr = Math.hypot((d.headBox.x - d.pos.x) - (q.headBox.x - q.pos.x), d.headBox.y - q.headBox.y, (d.headBox.z - d.pos.z) - (q.headBox.z - q.pos.z));
    rows.push({ i, t: a.time, dh, dhr, neck, trunk, tilt: Math.abs(d.reaction.tilt.x) * 180 / Math.PI, torso: Math.hypot(d.reaction.torso.x, d.reaction.torso.y, d.reaction.torso.z), spin: Math.abs(d.reaction.spin.x) * 180 / Math.PI, sink: d.reaction.sink.x, feet, hop: Math.hypot(d.hop.x, d.hop.z), stag: Math.hypot(d.stagger.x, d.stagger.z), headR: d.body.headR, hs: a.hitStop, hurt: d.hurt, down: d.down });
  }
  return { land, rows };
}
const peak = (rows, key) => rows.reduce((m, r) => (r[key] > m.v ? { v: r[key], i: r.i, t: r.t } : m), { v: -1, i: 0, t: 0 });
/** Last tick (index) the channel is still above 10% of its peak. */
const settleTick = (rows, key, pk) => { let last = pk.i; for (const r of rows) if (r.i >= pk.i && r[key] > 0.1 * pk.v) last = r.i; return last; };

function sectionF() {
  title('F. Hit-reaction magnitudes (fresh, planted defender; ratings and styles off; clean landed punch)');
  console.log('Hook: reactTrial(cfg, punch, stick, level, dist) in scripts/anim_measure.mjs. Head = headBox centre against an idle twin run (same ticks, no punch). Neck = angle between the head-to-shoulder (bodyBox.b) vectors of the two runs. Trunk = angle between the hips-to-shoulders (bodyBox a->b) axes. Tilt/torso/spin/sink = the reaction springs (state.fighters[1].reaction). Feet = floor position (pos) shift against the idle twin; the sim has no discrete foot-step state, the rig derives steps from pos/stagger. "Back within 10%" = last tick the head is still more than 10% of its peak away, counted from the punch press (and in sim seconds from the land, which includes the hit-stop slowdown).\n');
  head('punch', 'part / zone', 'grade', 'impulse N·s', 'head peak vs idle twin, whole man incl. shove (m)', 'x head radius', 'HEAD vs FEET peak, the bend (m)', 'x head radius', 'peak at (ticks after land)', 'neck peak (deg)', 'trunk bend peak (deg)', 'tilt spring peak (deg)', 'torso spring peak (m)', 'yaw spin peak (deg)', 'sink peak (m)', 'feet shift peak / end (m)', 'head-vs-feet back within 10% (ticks after land / sim s)', 'neck back within 10% (ticks after land)', 'freeze at land (s)', 'rocked/hurt');
  const T = [['jab', 'jab', 0, false, 0.78], ['cross', 'cross', 0, false, 0.78], ['lead hook', 'hook', -1, false, 0.72], ['rear hook', 'hook', 1, false, 0.72], ['uppercut (rear)', 'uppercut', 1, false, 0.66], ['body cross', 'cross', 0, true, 0.78], ['body hook (lead)', 'hook', -1, true, 0.72], ['body jab', 'jab', 0, true, 0.78]];
  for (const [name, p, stick, level, dist] of T) {
    const { land, rows } = reactTrial(cfg, p, stick, level, dist);
    if (!land) { console.log(row(name, 'no land')); continue; }
    const ph = peak(rows, 'dh'), phr = peak(rows, 'dhr'), pn = peak(rows, 'neck'), pt = peak(rows, 'trunk'), ptl = peak(rows, 'tilt'), pto = peak(rows, 'torso'), psp = peak(rows, 'spin'), psk = peak(rows, 'sink'), pf = peak(rows, 'feet');
    const endH = settleTick(rows, 'dhr', phr), endN = settleTick(rows, 'neck', pn);
    const hr = rows[0].headR, freeze = Math.max(...rows.filter(r => r.i >= land.tick && r.i <= land.tick + 1).map(r => r.hs));
    const endFeet = rows[rows.length - 1].feet;
    const hurt = rows.some(r => r.down) ? 'DOWN' : rows.some(r => r.hurt > 0) ? 'hurt ' + f2(Math.max(...rows.map(r => r.hurt))) + ' s' : 'no';
    console.log(row(name, `${land.part} / ${land.zone}`, land.grade, f1(land.impulse), f3(ph.v), f2(ph.v / hr), f3(phr.v), f2(phr.v / hr), phr.i - land.tick, f1(pn.v), f1(pt.v), f1(ptl.v), f3(pto.v), f1(psp.v), f3(psk.v), `${f3(pf.v)} / ${f3(endFeet)}`, `${endH - land.tick} / ${f2(rows[endH].t - rows[land.tick].t)}`, endN - land.tick, f3(freeze), hurt));
  }
  console.log(`\nReference: head radius ${f3(prepHeadR())} m. Reaction magnitudes are set by config keys *React* (jabReactBack/Lift/Twist/Torso/Snap/Spin, crossReact*, hookReact*, uppercutReact*), reactionSpring* / reactionHipFollow, gradeReact*, gradeNeck*; see src/sim/reaction.ts applyReaction.`);
}
function prepHeadR() { return fresh(cfg, 0.78).fighters[1].body.headR; }

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// C. STAMINA
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hold the pair at `dist` apart on the x axis (a scripted exchange, not a ring). */
function pin(s, dist) {
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  s.fighters[0].vel = { x: 0, z: 0 }; s.fighters[1].vel = { x: 0, z: 0 };
}
/**
 * The budget: side 0 throws 4-punch combinations (a press every `gapTicks`, then `restTicks` of rest) while side 1 lands a clean
 * cross on him every `hitEvery` ticks. Health damage and stuns are off so only the stamina is measured; the pair is pinned at range.
 * `miss` = share of side 0's combinations thrown at a range that misses.
 */
export function staminaBudget({ gapTicks = 36, restTicks = 60, hitEvery = 120, miss = 0, seconds = 90, guardRest = false, c = cfg } = {}) {
  const cc = { ...c, healthDamagePerImpulse: 0, stunBase: 0, bodyHurtOn: false, liverOn: false, guardWearOn: false, roundSeconds: 600 };
  let s = fresh(cc, 0.78);
  const seq = ['jab', 'cross', 'hook', 'cross'];
  const out = { floorAt: null, gassedAt: null, tiredAt: null, thrown: 0, taken: 0, blocked: 0, tank: [], min: 1, maxSlow: 1 };
  let nextCombo = 30, idx = -1, comboN = 0, mine = null, farNow = false;
  for (let i = 0; i < seconds * 60; i++) {
    if (i === nextCombo) { idx = 0; mine = i; comboN++; }
    let press = null;
    if (i === mine && idx === 0) farNow = miss > 0 && Math.floor(comboN * miss) !== Math.floor((comboN - 1) * miss);   // a missed combination is thrown from out of reach, the whole of it
    if (idx < 0 && i > mine + 4 * gapTicks + 20) farNow = false;
    if (idx >= 0 && i === mine + idx * gapTicks) { press = seq[idx]; idx++; if (idx === seq.length) { nextCombo = i + restTicks + 25; idx = -1; } }
    const blocking = guardRest && idx < 0 && i < nextCombo - 30 && i > nextCombo - restTicks;
    const hit = i % hitEvery === 60;
    pin(s, farNow ? 1.6 : (s.fighters[0].punch.type === 'hook' || press === 'hook' ? 0.72 : 0.78));
    const r = sim.step(s, [inp({ [press ?? 'none']: press !== null, block: blocking, move: { x: press === 'hook' ? -1 : 0, y: 0 } }), inp({ cross: hit })], cc); s = r.state;
    for (const e of r.events) { if (e.type === 'punchStart' && e.side === 0) out.thrown++; if (e.type === 'punchLand' && e.side === 1) out.taken++; if (e.type === 'punchBlock' && e.side === 1) out.blocked++; }
    const f = s.fighters[0];
    out.min = Math.min(out.min, f.stamina);
    if (out.tiredAt === null && f.fatigue > 0) out.tiredAt = i / 60;
    if (out.gassedAt === null && f.stamina < cc.lowStamina) out.gassedAt = i / 60;
    if (out.floorAt === null && f.stamina <= 0.005) out.floorAt = i / 60;
    out.maxSlow = Math.max(out.maxSlow, f.punchSlow);
    if (i % 300 === 0) out.tank.push(f1(f.stamina * 100));
  }
  out.end = s.fighters[0].stamina; out.cap = s.fighters[0].staminaCap;
  return out;
}
/** What a cross costs in speed and power at a given stamina (regeneration off, ratings off). */
export function crossAtStamina(c, st) {
  const cc = { ...c, staminaRegen: 0 };
  let s = fresh(cc, 0.78); s.fighters[0].stamina = st;
  let tell = null, land = null, endT = null, startT = null;
  for (let i = 0; i < 90; i++) {
    const r = sim.step(s, [inp({ cross: i === 0 }), NONE], cc); s = r.state;
    for (const e of r.events) { if (e.type === 'punchStart' && e.side === 0) { tell = e.tell; startT = i; } if (e.type === 'punchLand' && e.side === 0 && !land) land = { ...e, tick: i }; }
    if (endT === null && startT !== null && s.fighters[0].punch.type === null) endT = i;
  }
  return { fatigue: null, tell, impulse: land ? Math.hypot(land.impulse.x, land.impulse.z) : NaN, landTick: land?.tick ?? NaN, endT };
}

async function sectionC() {
  title('C. Stamina (reference fighters, ratings and styles off; stamina_probe.mjs costs() is the measuring hook for 1-14)');
  const sp = await import('./stamina_probe.mjs');
  const costs = sp.costs(cfg, true);
  head('action', 'stamina cost, % of the tank', 'plus ceiling loss', 'config keys');
  const keyOf = lab => {
    if (/THROWN|thrown/.test(lab) && /LANDED/.test(lab)) return 'staminaPunchCost x staminaThrowScale ' + cfg.staminaThrowScale + ' x staminaJab/Hook/UppercutWeight (' + [cfg.staminaJabWeight, 1, cfg.staminaHookWeight, cfg.staminaUppercutWeight].join('/') + '), minus staminaLandRefund ' + cfg.staminaLandRefund;
    if (/MISSED/.test(lab)) return 'throw cost + staminaWhiffCost ' + cfg.staminaWhiffCost + ' x weight (staminaWhiffByWeight); whiffCapLoss ' + cfg.whiffCapLoss + ' on the ceiling; regen paused staminaWhiffDelay';
    if (/BLOCKED/.test(lab)) return 'throw cost (the attacker pays it whether or not it is blocked)';
    if (/BLOCKING his/.test(lab)) return 'impulse x staminaHitCost ' + cfg.staminaHitCost + ' x staminaBlockedHitMult ' + cfg.staminaBlockedHitMult + ' x staminaBlockedLight ' + cfg.staminaBlockedLight + ' (a jab) / staminaBlockedHeavy ' + cfg.staminaBlockedHeavy;
    if (/TAKING/.test(lab) || /taking/.test(lab)) return 'impulse x staminaHitCost ' + cfg.staminaHitCost + ' (body: x staminaBodyHitMult ' + cfg.staminaBodyHitMult + ')';
    if (/guard up/.test(lab)) return 'staminaBlockDrain ' + cfg.staminaBlockDrain + ' x staminaGuardHold ' + cfg.staminaGuardHold + ' per second (regen also runs at staminaGuardRegen ' + cfg.staminaGuardRegen + ' - the probe has regen off)';
    if (/walking/.test(lab)) return 'none (no stamina cost for walking; moveTiredScale slows the feet when tired)';
    if (/slip/.test(lab)) return 'none in sim/slip.ts';
    if (/burst/.test(lab)) return 'burstStaminaCost ' + cfg.burstStaminaCost;
    if (/pivot/.test(lab)) return 'pivotStaminaCost ' + cfg.pivotStaminaCost + ' (+ guard hold)';
    if (/feint/.test(lab)) return 'staminaPunchCost x weight x (1 - feintRefund ' + cfg.feintRefund + ')';
    if (/overhand/.test(lab)) return 'throw cost + whiff';
    return '';
  };
  for (const [lab, v] of Object.entries(costs)) console.log(row(lab, f2(v.cost * 100) + '%', v.cap > 1e-9 ? '-' + f2(v.cap * 100) + '%' : '0', keyOf(lab)));
  console.log(`\nRegeneration: staminaRegen ${cfg.staminaRegen}/s (${pct(cfg.staminaRegen)} of the tank per second) whenever NOT blocking and no punch in flight (or a punch that touched something is in its recovery, x staminaPunchRegen ${cfg.staminaPunchRegen}); behind a held guard x staminaGuardRegen ${cfg.staminaGuardRegen}; paused staminaRegenDelay ${cfg.staminaRegenDelay} s after any hit (x staminaRegenDelayLight ${cfg.staminaRegenDelayLight} after a jab; x staminaBlockedDelay ${cfg.staminaBlockedDelay} on a heavy shot on the guard; 0 for a light shot on the guard); paused after a miss by staminaWhiffDelay ${cfg.staminaWhiffDelay} x weight. Ceiling: staminaCap = max(staminaCapFloor ${cfg.staminaCapFloor}, 1 - wear) where each miss adds whiffCapLoss; between rounds betweenRoundStaminaRestore ${cfg.betweenRoundStaminaRestore}. (sim/resources.ts stepStamina, combat.ts startPunch/missed, footing.ts)`);
  // Measured regen.
  { const cc = { ...cfg };
    const idle = (st, ticks, block) => { let s = fresh(cc, 3); s.fighters[0].stamina = st; for (let i = 0; i < ticks; i++) s = sim.step(s, [inp({ block }), NONE], cc).state; return s.fighters[0].stamina - st; };
    console.log(`\nMeasured (fresh, 3 m apart): standing idle from 20% for 1 s regains ${pct(idle(0.2, 60, false))}; behind a held guard from 20% for 1 s: ${pct(idle(0.2, 60, true))} (net of the guard's own cost).`); }

  console.log('\n### C.2 Speed and power against stamina (a cross, ratings off, regen off)\n');
  head('stamina', 'fatigue (0..1)', 'punchSlow (phase x)', 'gassed wind-up (x2.5 below lowStamina)', 'cross tell, press to hit test (s)', 'ticks to hit test', 'impulse N·s', 'power vs full tank', 'walk speed scale (moveTiredScale)');
  const base = crossAtStamina(cfg, 1);
  for (const st of [1, 0.6, 0.45, 0.3, 0.25, 0.2, 0.1, 0]) {
    const r = crossAtStamina(cfg, st);
    const from = cfg.fatigueFrom, fat = cfg.fatigueOn ? Math.max(0, Math.min(1, (from - st) / from)) : 0;
    const slow = 1 + (cfg.tiredPunchSlow - 1) * fat;
    console.log(row(pct(st), f2(fat), f2(slow), st < cfg.lowStamina ? 'yes, x' + cfg.lowStaminaCockMult : 'no', f3(r.tell), r.landTick, f1(r.impulse), pct(r.impulse / base.impulse), f2(cfg.moveTiredScale + (1 - cfg.moveTiredScale) * st)));
  }
  console.log(`\nAt the floor (stamina 0): nothing locks out - a punch still starts (stamina is clamped at 0, combat.ts startPunch). The punch phases run ${cfg.tiredPunchSlow}x longer, the impulse loses tiredPowerLoss ${cfg.tiredPowerLoss}, a gassed wind-up (below lowStamina ${cfg.lowStamina}) runs lowStaminaCockMult ${cfg.lowStaminaCockMult}x longer, the legs go (moveTiredScale ${cfg.moveTiredScale} of walking speed), the guard droops, and the AI smells it (aiAggressionMult). The tank cannot refill past the ceiling (staminaCapFloor ${cfg.staminaCapFloor}).`);

  console.log('\n### C.3 Budget: 4-punch combinations (jab, cross, hook, cross) a press every 0.6 s, 1 s rest after each, while taking a clean cross every 2 s. Health damage off; pinned at range.\n');
  head('scenario', 'punches thrown', 'clean shots taken', 'first tired (s)', 'first gassed <25% (s)', 'FLOOR (<=0.5%) at (s)', 'lowest tank', 'tank every 5 s (%)', 'ceiling at end');
  const sc = [
    ['all land, guard down in the rests', staminaBudget({})],
    ['all land, guard UP in the rests', staminaBudget({ guardRest: true })],
    ['a quarter missed (out of range), guard down', staminaBudget({ miss: 0.25 })],
    ['half missed, guard down', staminaBudget({ miss: 0.5 })],
    ['faster: 0.4 s between punches, 0.5 s rest, all land', staminaBudget({ gapTicks: 24, restTicks: 30 })],
    ['no shots taken (the same, alone)', staminaBudget({ hitEvery: 1e9 })],
    ['HARD PACE: 0.25 s between punches, 0.4 s rest, all land', staminaBudget({ gapTicks: 15, restTicks: 0 })],
    ['HARD PACE, all missed', staminaBudget({ gapTicks: 15, restTicks: 0, miss: 1 })],
    ['HARD PACE, all missed, no shots taken', staminaBudget({ gapTicks: 15, restTicks: 0, miss: 1, hitEvery: 1e9 })],
  ];
  for (const [n, r] of sc) console.log(row(n, r.thrown, r.taken, r.tiredAt === null ? 'never' : f1(r.tiredAt), r.gassedAt === null ? 'never' : f1(r.gassedAt), r.floorAt === null ? 'not in 90 s' : f1(r.floorAt), pct(r.min), r.tank.join(' '), pct(r.cap)));

  // C.4 (2026-11-14): the budget of one 60 s round at three paces, staminaV2 off (as it was) and on, from stamina_probe.pace().
  console.log('\n### C.4 Budget of a 60 s round (scripted paces, stamina_probe.pace): tank % at 15 / 30 / 45 / 60 s; staminaV2 off, then on\n');
  head('pace', 'staminaV2', 'tank at 15 / 30 / 45 / 60 s', 'gassed (<25%) at', 'thrown a minute');
  const paces = { 'sensible: 50 a minute, mixed, half landing': { ppm: 50, miss: 0.5, his: 24, holdGuard: true }, 'spamming: 110 a minute, power shots': { ppm: 110, miss: 0.4, his: 24, power: true, heavy: 0.4 }, 'defensive: guard up, 8 a minute': { ppm: 8, miss: 0.25, his: 40, guard: 1, heavy: 0.5, holdGuard: true } };
  for (const [n, o] of Object.entries(paces)) for (const on of [false, true]) {
    const r = sp.pace({ ...o, c: { ...cfg, staminaV2: on } }, true);
    console.log(row(n, on ? 'on' : 'off', [...r.snaps.slice(0, 3), r.rounds[0].end].map(x => Math.round(x * 100)).join(' / '), r.gassedAt === null ? 'never' : f1(r.gassedAt) + ' s', Math.round(r.ppm)));
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// B. FROZEN OR SLOWED TIME
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The host loop's time model, copied from src/main.ts loop() lines 405-450 (NOT main.ts itself; it is not measured in a browser):
 * 60 wall frames a second; the sim is fed `dt x slow` per frame and ticks while the accumulator holds a tick; the slow-motion
 * timers (counter, rocked, finisher, knockdown) are started from the events of a frame; the player's open slip window (ui/read.ts)
 * slows the scene; showSlowAfterStop makes the slow motion wait for the sim's hit-stop. `inputs(s, simTick)` gives both sides' input
 * per sim tick (the host reads the human's stick once per frame; scripted inputs here are per tick).
 */
export function hostRun({ s, c, inputs, wallSeconds = 95, fightingOnly = true, kx = kr, trace = null }) {
  const { sim: S, SIM_DT: DT } = kx;
  const dt = 1 / 60;
  let acc = 0, slowMo = { t: 0, scale: 1 }, simTick = 0;
  const cat = { normal: 0, freeze: 0, slow: 0 }, simT = { normal: 0, freeze: 0, slow: 0 };
  const segs = { freeze: [], slow: [] }; let runKind = null, runLen = 0;
  const trig = { counter: 0, rocked: 0, finisher: 0, knockdown: 0, readWindowFrames: 0 };
  let fightWall = 0, fightSim = 0, minSlow = 1, wallTotal = 0;
  const flush = () => { if (runKind && runLen) segs[runKind].push(runLen); runKind = null; runLen = 0; };
  for (let frame = 0; frame < wallSeconds * 60 && s.round.phase !== 'over'; frame++) {
    const frozen = c.showSlowAfterStop && s.hitStop > 0;
    const f1 = s.fighters[1];
    const open = c.readEnabled && !f1.down && f1.counterWindow > 0 && kx.sim.punishSource(f1) === kx.sim.PUNISH_SLIP;
    const readScale = UI.readWindowScale(c, c.readEnabled && open && !s.fighters[0].down ? c.readWindowSlowMo : 1);   // hitStopV2: no read-window slow motion (main.ts)
    if (open) trig.readWindowFrames++;
    const slow = Math.min(slowMo.t > 0 && !frozen ? slowMo.scale : 1, readScale);
    if (!frozen) slowMo.t = Math.max(0, slowMo.t - dt);
    acc += dt * slow;
    const kind = frozen ? 'freeze' : slow < 1 ? 'slow' : 'normal';
    const fightingBefore = s.round.phase === 'fighting', t0 = s.time;
    const events = [];
    while (acc >= DT) { const r = S.step(s, inputs(s, simTick++), c); s = r.state; events.push(...r.events); acc -= DT; }
    for (const e of events) {
      if (e.type === 'counter') trig.counter++;
      else if (e.type === 'rocked') trig.rocked++;
      else if (e.type === 'punchLand' && e.finisher === true && c.showFinisherOn) trig.finisher++;
      else if (e.type === 'knockdown') trig.knockdown++;
    }
    slowMo = UI.slowMoAfter(slowMo, events, c);   // the game's own rule (src/ui/slowmo.ts): under hitStopV2 only a knockdown slows
    wallTotal += dt;
    if (trace) trace.push({ frame, kind, slow, simDt: s.time - t0, ev: events.filter(e => ['slip', 'counter', 'punchLand', 'punchStart', 'punchWhiff', 'rocked', 'knockdown'].includes(e.type)).map(e => (e.type === 'slip' ? (e.dodged ? 'slipDodged' : 'slipFlick') : e.type + (e.side !== undefined ? e.side : ''))) });
    if (!fightingOnly || fightingBefore || s.round.phase === 'fighting') {
      cat[kind] += dt; simT[kind] += s.time - t0; fightWall += dt; fightSim += s.time - t0; minSlow = Math.min(minSlow, slow);
      if (kind === 'normal') flush(); else if (runKind === kind) runLen++; else { flush(); runKind = kind; runLen = 1; }
    }
  }
  flush();
  return { cat, simT, segs, trig, fightWall, fightSim, minSlow, state: s };
}

/** A scripted exchange: side 1 jabs every 90 ticks, side 0 slips it (flick at the press) and counters with a cross 6 ticks later; pinned at range. */
function slipCounterInputs(c, period = 90) {
  return (s, i) => {
    pin(s, 0.78);
    const m = i % period;
    return [inp({ cross: m === 6, move: { x: m < 2 ? -1 : 0, y: 0 } }), inp({ jab: m === 0 })];
  };
}

function sectionB() {
  title('B. Frozen or slowed time (shipped config: ratings and styles on)');
  const c = { ...kr.cfg };
  console.log('Mechanisms, found by grep for hitStop / freeze / slowMo / timeScale / hold in src/sim, src/main.ts, src/render, src/ui, src/ai. "In sim" = measured here by stepping the sim; "host" = src/main.ts and src/ui/read.ts, modelled here from reading them (hostRun() copies the loop arithmetic) and NOT measured in a browser.\n');
  head('#', 'mechanism', 'where', 'trigger', 'duration / rate (config keys)', 'is input read while it runs?');
  const rows = [
    ['1', 'Hit-stop on a land or block', 'sim: combat.ts:745-752, flow.ts addHitStop', 'every punchLand / punchBlock', `clean: hitStopBase ${c.hitStopBase} s x power, capped hitStopMax ${c.hitStopMax}; glancing hitStopGlancing ${c.hitStopGlancing}; flush hitStopFlush ${c.hitStopFlush}; a jab x hitStopJabScale ${c.hitStopJabScale}; a land inside a combination x comboHitStopScale ${c.comboHitStopScale}; finisher comboFinisherHitStop ${c.comboFinisherHitStop}; counter + vuln x counterHitStopBonus ${c.counterHitStopBonus}. Sim time runs at hitStopScale ${c.hitStopScale} (not zero) for the freeze, which counts down in REAL ticks`, 'YES. step() reads both inputs every tick. A press starts a punch at once (A.4: +0 ticks) but the punch clock then runs at 5%, so it is drawn nearly still until the freeze ends; the AI is stepped in real ticks too'],
    ['2', 'Hit-stop budget (cuts #1)', 'sim: flow.ts addHitStop / stepHitStopBudget', 'every request', `bucket hitStopBudget ${c.hitStopBudget} s refilling over hitStopBudgetWindow ${c.hitStopBudgetWindow} s; floor hitStopMin ${c.hitStopMin}; big moments (finisher, rock, knockdown) may overdraw by hitStopBigExtra ${c.hitStopBigExtra}; tier 2 (slip, counter) always in full`, 'n/a (it only shortens the freeze)'],
    ['3', 'Hit-stop on a slipped punch', 'sim: combat.ts:491', 'a punch missed because of a slip (the "read")', `slipDodgeHitStop ${c.slipDodgeHitStop} s, tier 2: always granted in full`, 'YES, as #1'],
    ['4', 'Hit-stop on a perfect block', 'sim: combat.ts:739', 'block raised within perfectBlockWindow of the impact', `perfectBlockHitStop ${c.perfectBlockHitStop} s`, 'YES, as #1'],
    ['5', 'Hit-stop on a rock / knockdown', 'sim: combat.ts:770', 'a clean head shot that clears the stun threshold', `stunHitStop ${c.stunHitStop} s (tier 1)`, 'YES, as #1'],
    ['6', 'Counter slow motion', 'host: main.ts:442', "any 'counter' event, either side", `readCounterSlowMo ${c.readCounterSlowMo}x for readCounterSlowMoSeconds ${c.readCounterSlowMoSeconds} wall s; waits for #1 to finish (showSlowAfterStop ${c.showSlowAfterStop}, main.ts:414)`, 'the host feeds the sim 0.3 of a frame, so ticks (and so the input being applied) come 3.3x less often; the human stick is sampled once per wall frame'],
    ['7', 'Rocked slow motion', 'host: main.ts:443', "any 'rocked' event", `readRockedSlowMo ${c.readRockedSlowMo}x for ${c.readRockedSlowMoSeconds} wall s`, 'as #6'],
    ['8', 'Finisher slow motion', 'host: main.ts:444', "punchLand with finisher (3rd+ clean land of a combination, a power punch)", `showFinisherSlowMo ${c.showFinisherSlowMo}x for ${c.showFinisherSlowMoSeconds} wall s (showFinisherOn ${c.showFinisherOn})`, 'as #6'],
    ['9', 'Knockdown slow motion', 'host: main.ts:446', "any 'knockdown' event", `knockdownSlowMo ${c.knockdownSlowMo}x for knockdownSlowMoSeconds ${c.knockdownSlowMoSeconds} wall s; replaces the others`, 'as #6 (the man down cannot act; the other cannot punch him during the count)'],
    ['10', 'Counter-window slow motion (the READ)', 'host: ui/read.ts:73 -> main.ts:415', "while a slip of the PLAYER (side 0) has the AI's counterWindow open", `readWindowSlowMo ${c.readWindowSlowMo}x for as long as the window is open (slipPunishDuration ${c.slipPunishDuration} s of SIM time, so ${f2(c.slipPunishDuration / c.readWindowSlowMo)} wall s), min() with the others`, 'as #6, and it is exactly when the player is meant to press the counter'],
    ['11', 'Knockdown replay', 'host: main.ts:451-457 startReplay', 'after a knockdown, once the count reaches flowReplayAtCount (flow only)', `flowReplaySeconds ${c.flowReplaySeconds} s before + flowReplayAfterSeconds ${c.flowReplayAfterSeconds} s after, at flowReplaySpeed; the sim is HELD (main.ts:393 held=true)`, 'NO: the sim does not step and held buttons are swallowed until released (main.ts:398-402)'],
    ['12', 'Menus, cards, pause, pose grid', 'host: main.ts:392-393', 'flow.holdsSim, posed fighters', 'while up', 'NO, same swallow rule'],
    ['13', 'Intro / between rounds / count phases', 'sim: index.ts:81', 'round.phase is not fighting', `introSeconds ${c.introSeconds}, betweenRoundSeconds ${c.betweenRoundSeconds}, the referee count`, 'NO: step() replaces both inputs with NULL_INPUT outside the fighting phase (no buffering)'],
  ];
  for (const r of rows) console.log(row(...r));
  console.log('\nNot a time freeze, but named "hold": flow.ts stepHold / applyKnock (THE HOLD) delays knockback during a combination; it never stops the clock.\n');

  console.log('Rows 1-10 are the mechanisms as they were (hitStopV2 false). With hitStopV2 (anim 2.4, default true) #2 (budget), #3 (slip freeze), #6, #7, #8 and #10 are off in live play, #1 and #4 become the hitStopTicks* table in 60 Hz ticks, and a press during #1 is buffered and fires after the stop at full speed; #5 keeps stunHitStop only for a knockdown, #9 and #11 stay.\n');
  for (const v2 of [false, true]) {
  const c = { ...kr.cfg, hitStopV2: v2 };
  console.log(`\n#### hitStopV2 = ${v2}${v2 ? ' (the new default)' : ' (the old behaviour, the baseline)'}\n`);
  console.log('### B.2 Measured: ms of each kind per 10 s, shipped config, medium AI (host model; fighting phases only)\n');
  console.log('"freeze" = frames where the sim has hitStop > 0 (picture near-still). "slow" = frames at less than real time from the host timers or the read window. Per 10 s of WALL time and per 10 s of SIM time. Seeds 1-3, one 3 x 30 s fight each (a KO ends it early; the scripted exchange runs 3 x 60 s); the bots drive side 0, the AI (monsoon, pressure, medium) side 1.\n');
  head('scenario', 'wall s measured', 'sim s advanced', 'FREEZE ms / 10 s wall', 'SLOW ms / 10 s wall', 'normal ms / 10 s wall', 'game speed (sim s per wall s)', 'FREEZE ms / 10 s of sim', 'SLOW ms / 10 s of sim', 'wall s to play 10 s of sim', 'freeze episodes /10 s wall (mean, max ms)', 'slow episodes /10 s wall (mean, max ms)', 'counters / rocks / finishers / knockdowns', 'read-window frames');
  const spec = id => kr.core.ROSTER.find(f => f.id === id);
  const botScen = [['inside-fighter vs AI', insideFighter], ['human-pace vs AI', humanPace], ['counter-puncher vs AI', counterPuncher], ['masher vs AI', masher]];
  const totals = [];
  const add = (name, runs) => {
    const A = { wall: 0, sim: 0, cat: { normal: 0, freeze: 0, slow: 0 }, simT: { normal: 0, freeze: 0, slow: 0 }, fz: [], sl: [], trig: { counter: 0, rocked: 0, finisher: 0, knockdown: 0, readWindowFrames: 0 } };
    for (const r of runs) { A.wall += r.fightWall; A.sim += r.fightSim; for (const key of ['normal', 'freeze', 'slow']) { A.cat[key] += r.cat[key]; A.simT[key] += r.simT[key]; } A.fz.push(...r.segs.freeze); A.sl.push(...r.segs.slow); for (const key of Object.keys(A.trig)) A.trig[key] += r.trig[key]; }
    const per = x => x / (A.wall / 10);
    console.log(row(name, f1(A.wall), f1(A.sim), f1(per(A.cat.freeze) * 1000), f1(per(A.cat.slow) * 1000), f1(per(A.cat.normal) * 1000), f2(A.sim / A.wall), f1(A.cat.freeze / (A.sim / 10) * 1000), f1(A.cat.slow / (A.sim / 10) * 1000), f1(A.wall / (A.sim / 10)), `${f1(per(A.fz.length))} (${f1(A.fz.length ? A.fz.reduce((a, b) => a + b, 0) / A.fz.length * MS : 0)}, ${f1(Math.max(0, ...A.fz) * MS)})`, `${f1(per(A.sl.length))} (${f1(A.sl.length ? A.sl.reduce((a, b) => a + b, 0) / A.sl.length * MS : 0)}, ${f1(Math.max(0, ...A.sl) * MS)})`, `${A.trig.counter}/${A.trig.rocked}/${A.trig.finisher}/${A.trig.knockdown}`, A.trig.readWindowFrames));
    totals.push([name, A]);
  };
  for (const [name, bot] of botScen) {
    const runs = [];
    for (let seed = 1; seed <= 3; seed++) {
      const specs = [spec(seed % 2 ? 'red' : 'blue'), spec('monsoon')];
      const s = kr.sim.createState(specs, c, seed);
      let ai = kr.ai.createAi(1, seed, c, kr.ai.styleFor(specs[1], c));
      const player = bot.create(kr, seed, c);
      runs.push(hostRun({ s, c, wallSeconds: 130, inputs: (st) => { const d = kr.ai.aiStep(ai, st, c); ai = d.ai; return [player.step(st), d.input]; } }));
    }
    add(name, runs);
  }
  {
    // The scripted counter exchange: no ring, the pair pinned; round clock 60 s so it never ends.
    const cc = { ...c, roundSeconds: 60, roundCount: 1, healthDamagePerImpulse: 0, stunBase: 0, stylesOn: false, ratingsOn: false };
    const runs = [];
    for (let seed = 1; seed <= 3; seed++) {
      const s = kr.sim.createState([spec('red'), spec('blue')], cc, seed);
      runs.push(hostRun({ s, c: cc, wallSeconds: 130, inputs: slipCounterInputs(cc) }));
    }
    add('SCRIPT: side 0 slips every jab and lands the counter cross every 1.5 s', runs);
  }
  {
    console.log('\n### B.3 One slip-and-counter on the wall clock (the scripted exchange above; frames of 16.7 ms; "sim ms" = how much fight time passed in that stretch)\n');
    const cc = { ...c, roundSeconds: 60, roundCount: 1, healthDamagePerImpulse: 0, stunBase: 0, stylesOn: false, ratingsOn: false };
    const s = kr.sim.createState([spec('red'), spec('blue')], cc, 1);
    const trace = [];
    hostRun({ s, c: cc, wallSeconds: 12, inputs: slipCounterInputs(cc), trace });
    const t = trace.findIndex((f, i) => i > 400 && f.ev.includes('punchStart1'));
    const seg = []; let curSeg = null;
    for (const f of trace.slice(t, t + 220)) {
      if (!curSeg || curSeg.kind !== f.kind || Math.abs(curSeg.slow - f.slow) > 1e-9) { curSeg = { kind: f.kind, slow: f.slow, frames: 0, sim: 0, ev: [] }; seg.push(curSeg); }
      curSeg.frames++; curSeg.sim += f.simDt; curSeg.ev.push(...f.ev);
    }
    head('stretch', 'kind', 'rate', 'wall ms', 'sim ms', 'events inside');
    let wall = 0, n = 0; const enough = 1.45 * 60;
    for (const g of seg) { if (wall > enough * MS * 1.8) break; n++; console.log(row(n, g.kind, g.kind === 'freeze' ? 'sim x' + c.hitStopScale + ' (hit-stop)' : f2(g.slow) + 'x', f1(g.frames * MS), f1(g.sim * 1000), [...new Set(g.ev)].join(' ') || '-')); wall += g.frames; }
    console.log('(The cycle begins at the AI\'s jab press; side 0 flicks the same tick. Stretches after the last row are normal speed until the next jab, 1.5 s of sim time per cycle.)');
    // The slip-and-counter on the wall clock: from the AI's jab press to the tick the counter's stop has ended.
    const cEnd = trace.findIndex((f, i) => i >= t && f.ev.includes('punchLand0'));
    let k = cEnd + 1; while (k < trace.length && trace[k].kind !== 'normal') k++;   // until real time again after the counter's freeze and slow motion
    const fightMs = trace.slice(t, k).reduce((a, f) => a + f.simDt, 0) * 1000;
    console.log(`\nSLIP-AND-COUNTER (hitStopV2 ${v2}): jab press until real time again after the counter = ${f1((k - t) * MS)} ms of wall clock for ${f1(fightMs)} ms of fight time (baseline: 2.0 s wall for 0.84 s of fight).`);
  }
  }
  console.log('\nHook: hostRun({ s, c, inputs }) in scripts/anim_measure.mjs. After the rebuild re-run to see the same table; if the host loop in main.ts changes, hostRun must be re-copied from it.');
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// D. THE AI BY DIFFICULTY
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const DIFFS = ['easy', 'medium', 'hard'];
const STYLE_BODY = { pressure: 'monsoon', outboxer: 'lighthouse', counter: 'alambre', swarmer: 'boiler', slugger: 'raffle' };
const GROUP = v => (/^body/.test(v) ? v.replace('bodyJab', 'body jab').replace('bodyCross', 'body cross').replace('bodyHook', 'body hook')
  : /jab/i.test(v) ? 'jab' : /cross|overhand/i.test(v) ? 'cross' : /hook/i.test(v) ? 'hook' : /uppercut/i.test(v) ? 'uppercut' : v);
const GROUPS = ['jab', 'cross', 'hook', 'uppercut', 'body jab', 'body cross', 'body hook'];

/**
 * The FIXED SCRIPTED ATTACKER (side 0) for D: a human-like plan. Guard up between combinations, walks to 0.7-0.86 m, and
 * every 1.5-2.7 s throws one of: 1-2, 1-2-3 (lead hook), 1-1-2, 1-2-body hook, body cross, 2-3 with a rear uppercut, a lone
 * lead hook, a rear hook. Presses are 8 ticks apart (a person's thumb). Reads nothing of the AI (no slips, no reads).
 */
async function mixBot(kx, seed, c) {
  const util = await import('./bots/util.mjs');
  const PLANS = [
    b => b.combo([['jab'], ['cross']], 8),
    b => b.combo([['jab'], ['cross'], ['hook', -1]], 8),
    b => b.combo([['jab'], ['jab'], ['cross']], 8),
    b => { b.combo([['jab'], ['cross']], 8); for (let i = 0; i < 3; i++) b.push({}); b.lowThen('hook', -1); },
    b => b.lowThen('cross'),
    b => b.combo([['cross'], ['uppercut', 1]], 8),
    b => b.combo([['hook', -1]], 8),
    b => b.combo([['jab'], ['hook', 1]], 8),
  ];
  return util.makeBot(kx, seed, (b, s) => {
    const d = util.dist(s);
    b.mem.wait = (b.mem.wait ?? 60) - 1;
    if (b.mem.wait <= 0 && d <= 0.9 && util.ready(kx, s, c)) {
      b.mem.wait = 90 + Math.floor(kx.core.rngRange(b.rng, 0, 72));
      b.mem.n = (b.mem.n ?? 0) + 1;
      PLANS[kx.core.rngInt(b.rng, 0, PLANS.length - 1)](b);
      for (let i = 0; i < 18; i++) b.push({});
      return {};
    }
    return { block: d < 1.5, move: { x: 0, y: d > 0.86 ? 1 : d < 0.7 ? -1 : 0 } };
  });
}

/** One fight of the attacker against the AI; returns the per-punch records and the totals. */
async function dFight(diff, style, seed) {
  const c = { ...kr.cfg, aiDifficulty: diff };
  const spec = id => kr.core.ROSTER.find(f => f.id === id);
  const specs = [spec(seed % 2 ? 'red' : 'blue'), spec(STYLE_BODY[style])];
  let s = kr.sim.createState(specs, c, seed);
  let ai = kr.ai.createAi(1, seed, c, kr.ai.styleFor(specs[1], c));
  const player = await mixBot(kr, seed, c);
  const punches = [], aiPunches = [];
  let cur = null, fightTicks = 0, blockPrev = false, kd = [0, 0], winner = null, how = 'none', timerPrev = 0;
  const maxTicks = Math.round(((c.roundCount * (c.roundSeconds + c.betweenRoundSeconds) + 40) / kr.SIM_DT)) * 2;
  for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
    const d = kr.ai.aiStep(ai, s, c); ai = d.ai;
    const r = kr.sim.step(s, [player.step(s), d.input], c); s = r.state;
    const f0 = s.fighters[0], f1 = s.fighters[1];
    if (s.round.phase === 'fighting') fightTicks++;
    for (const e of r.events) {
      if (e.type === 'punchStart' && e.side === 0) { if (cur && cur.endTick === null) cur.endTick = i; const prevP = cur; cur = { pos: prevP && i - prevP.start <= 30 ? prevP.pos + 1 : 1, start: i, type: e.punch, variant: e.variant, grp: GROUP(e.variant), tell: e.tell, upAtStart: blockPrev, react: null, outcome: null, resolveTick: null, endTick: null, guardUpAtResolve: false, answered: false, aiTried: false, through: false, feint: false }; punches.push(cur); }
      else if (e.type === 'punchStart' && e.side === 1) aiPunches.push({ tick: i });
      else if (cur && e.side === 0 && cur.outcome === null && /^(punchLand|punchBlock|perfectBlock|punchWhiff|punchStuffed|feint)$/.test(e.type) && (e.type === 'punchStuffed' || e.type === 'feint' || e.side === 0)) {
        cur.outcome = e.type === 'punchLand' ? 'land' : e.type === 'punchBlock' ? 'block' : e.type === 'perfectBlock' ? 'perfect' : e.type === 'punchWhiff' ? 'whiff' : e.type === 'punchStuffed' ? 'stuffed' : 'feint';
        cur.resolveTick = i; cur.guardUpAtResolve = f1.block; if (e.type === 'punchLand') cur.through = !!e.through;
      }
      else if (e.type === 'slip' && e.side === 1 && e.dodged && cur && cur.outcome === 'whiff') cur.outcome = 'slipped';
      else if (e.type === 'knockdown') kd[e.side]++;
      else if (e.type === 'ko' || e.type === 'tko') { winner = e.winner; how = e.type; }
      else if (e.type === 'decision') { winner = e.winner; how = 'decision'; }
    }
    // The AI's REACTIVE block: the tick its reaction timer fires (ai.blockTimer rises from 0), as opposed to a shell / cover / inside-hold guard.
    if (cur && cur.rx === undefined) cur.rx = null;
    if (cur && cur.rx === null && ai.blockTimer > 0 && timerPrev === 0 && cur.outcome === null && i >= cur.start) cur.rx = i - cur.start;
    if (cur && cur.outcome !== null && cur.timerAtResolve === undefined) cur.timerAtResolve = ai.blockTimer > 0;
    timerPrev = ai.blockTimer;
    // The AI's guard going up, from the start of the attacker's punch.
    if (cur && cur.react === null && !cur.upAtStart && cur.outcome === null && f1.block && i > cur.start) cur.react = i - cur.start;
    if (cur && cur.outcome === null && cur.react === null && f1.block && !cur.upAtStart) cur.react = i - cur.start;
    if (cur && cur.endTick === null && cur.resolveTick !== null && f0.punch.type === null) cur.endTick = i;
    // The AI's landed punches answer the attacker's latest resolved punch inside its recovery (resolve .. end + 18 ticks).
    for (const e of r.events) if (e.type === 'punchLand' && e.side === 1) {
      for (let j = punches.length - 1; j >= 0 && j >= punches.length - 3; j--) { const p = punches[j]; if (p.resolveTick !== null && i >= p.resolveTick && (p.endTick === null || i <= p.endTick + 18)) { p.answered = true; break; } }
    }
    blockPrev = f1.block;
  }
  // The AI's punch STARTS inside a punch's recovery (an attempt), by that punch's window.
  for (const p of punches) if (p.resolveTick !== null) p.aiTried = aiPunches.some(a => a.tick >= p.resolveTick && a.tick <= (p.endTick ?? p.resolveTick + 40) + 18);
  const live = punches.filter(p => p.outcome !== 'feint');
  return { punches: live, aiThrown: aiPunches.length, minutes: fightTicks / 3600, kd, winner, how };
}

async function sectionD() {
  title('D. The AI by difficulty (shipped config; the fixed scripted attacker; ' + NUM + ' seeded fights per difficulty, the AI as each of the five styles in turn)');
  console.log('Difficulty table (src/ai/style.ts:320-327 DIFFICULTY, applied by withDifficulty; selected by cfg.aiDifficulty 0/1/2): easy {reaction x1.5, defence x0.5, counter x0.4, tempo x1.8, combo x0.5, mistake 0.35, offence 0.35, hesitate 0.65}; medium {reaction x1.2, defence x0.8, counter x0.7, tempo x1.35, combo x0.85, mistake 0.18, offence 0.7, hesitate 0.3}; hard {reaction x0.85, defence x1.15, counter x1.15, tempo x0.8, combo x1.2, mistake 0, offence 1.2, hesitate 0}. Base aiReactionTime ' + cfg.aiReactionTime + ' s, aiBlockChance ' + cfg.aiBlockChance + ', aiInsideBlock ' + cfg.aiInsideBlock + ' (per-style values override: ai/style.ts STYLE_OVERRIDES).\n');
  console.log('Block decision in the AI (src/ai/index.ts:728-759): when the attacker starts a punch inside engageStraight, a timer of st.reaction starts; when it expires the AI rolls blockChance (insideBlock at close range, 1 against a rush) x (1 - mistake); on success the guard is held blockWindow ' + cfg.aiBlockWindow + ' s, or it slips/rolls instead. Block coverage in the SIM (src/sim/combat.ts:373-392 guardCover, 620-622): a held block covers the punch fully only if it arrives within guardArcFullDeg ' + cfg.guardArcFullDeg + ' of the blocker\'s facing, fading to nothing by guardArcNoneDeg ' + cfg.guardArcNoneDeg + ' (a hook arrives from the side); an uppercut x guardUppercutCover ' + cfg.guardUppercutCover + '; a body shot x guardBodyCover ' + cfg.guardBodyCover + '; a worn guard (guardHp) x up to guardWornCover ' + cfg.guardWornCover + '; with the guard shape on, a hand-pinned resting guard counts x guardPinnedCover ' + cfg.guardPinnedCover + '; cover below guardThroughAt ' + cfg.guardThroughAt + ' = "through": a LAND on the held guard (the event\'s `through` flag) at the strength the guard left (blockReduction ' + cfg.blockReduction + ' x cover absorbed). Per-shape numbers (arc, headCover, bodyCover, uppercutCover, raise) are in src/core/styles.ts GUARDS and apply when stylesOn.\n');

  const results = {};
  const t0 = Date.now();
  for (let di = 0; di < 3; di++) {
    const fights = [];
    for (let seed = 1; seed <= NUM; seed++) fights.push(await dFight(di, Object.keys(STYLE_BODY)[(seed - 1) % 5], seed));
    results[di] = fights;
  }

  const summary = [], notes = [];
  head('difficulty', 'attacker punches', 'reached the AI (land+block)', 'BLOCK RATE of those', 'perfect-block share', 'LAND share', 'whiff / slipped / stuffed (share of thrown)', 'guard already up at the punch start', 'REACTION p10 / median / p90 / mean (ticks) [ms]', 'guard up before the hit test (of blocks)', 'COUNTER land rate (any punch)', 'counter attempt rate', 'counter land after a block', 'counter land after a land', 'AI punches / min', 'attacker punches / min');
  for (let di = 0; di < 3; di++) {
    const ps = results[di].flatMap(f => f.punches), mins = results[di].reduce((a, f) => a + f.minutes, 0);
    const n = ps.length, by = o => ps.filter(p => p.outcome === o);
    const reached = ps.filter(p => ['land', 'block', 'perfect'].includes(p.outcome));
    const blocked = reached.filter(p => p.outcome !== 'land'), landed = by('land');
    const reacts = ps.filter(p => p.react !== null && !p.upAtStart && (p.outcome === 'block' || p.outcome === 'perfect')).map(p => p.react);
    const resolved = ps.filter(p => p.resolveTick !== null);
    const upBefore = blocked.filter(p => p.react !== null || p.upAtStart).length / Math.max(1, blocked.length);
    const ans = a => a.length ? a.filter(p => p.answered).length / a.length : NaN;
    const tried = resolved.filter(p => p.aiTried).length / Math.max(1, resolved.length);
    summary.push({ di, n });
    const rxs = blocked.filter(p => p.rx !== null).map(p => p.rx);
    const reactiveShare = blocked.filter(p => p.timerAtResolve).length / Math.max(1, blocked.length);
    notes.push(`- ${DIFFS[di]}: of ${blocked.length} blocked punches, ${pct(reactiveShare)} were the REACTIVE block (the AI's reaction timer fired: ai.blockTimer > 0 at the hit test), the rest a shell / cover / inside-hold guard that was up anyway. Reactive-timer fire, ticks after the attacker's punchStart, for blocked punches: ${rxs.length ? `p10 ${quant(rxs, 0.1)} / median ${median(rxs)} / p90 ${quant(rxs, 0.9)} (${f1(median(rxs) * MS)} ms median)` : 'no samples'}. Configured reaction x difficulty: ${f3(cfg.aiReactionTime * [1.5, 1.2, 0.85][di])} s = ${f1(cfg.aiReactionTime * [1.5, 1.2, 0.85][di] * 60)} ticks (before per-style scaling). Punches that landed although the reaction had already fired: ${landed.filter(p => p.rx !== null).length} of ${landed.length}.`);
    console.log(row(DIFFS[di], n, reached.length, pct(blocked.length / Math.max(1, reached.length)), pct(by('perfect').length / Math.max(1, reached.length)), pct(landed.length / Math.max(1, reached.length)), `${pct(by('whiff').length / n)} / ${pct(by('slipped').length / n)} / ${pct(by('stuffed').length / n)}`, pct(ps.filter(p => p.upAtStart).length / n), reacts.length ? `${quant(reacts, 0.1)} / ${median(reacts)} / ${quant(reacts, 0.9)} / ${f1(reacts.reduce((a, b) => a + b, 0) / reacts.length)} [${f1(median(reacts) * MS)} ms median]` : 'no samples', pct(upBefore), pct(ans(resolved)), pct(tried), pct(ans(blocked)), pct(ans(landed)), f1(results[di].reduce((a, f) => a + f.aiThrown, 0) / mins), f1(n / mins)));
  }
  console.log('\nReactive block, per difficulty:\n');
  for (const nt of notes) console.log(nt);
  console.log('\nDefinitions: attacker punch = a side-0 punchStart (feints dropped). Reached = it landed or was blocked (a whiff or a slipped punch never reached). Block rate = (punchBlock + perfectBlock) / reached. Reaction = ticks from the attacker\'s punchStart to the first tick the AI\'s `block` is true, for punches the AI blocked and whose guard was not already up at the start. "Guard already up" = block was true on the tick before the start. Counter land rate = share of the attacker\'s resolved punches after which an AI punchLand arrives between that punch\'s hit test and 18 ticks (0.3 s) after its recovery ends. Counter attempt = an AI punchStart in the same window.\n');

  console.log('### D.2 What gets through the guard, by punch type (the same attacker; of the punches that REACHED the AI: land / block / perfect)\n');
  head('difficulty', 'punch type', 'thrown', 'reached', 'land %', 'of which `through` a held guard (came round or through)', 'land with the AI\'s guard DOWN at the hit test', 'block %', 'perfect %', 'whiff/slip/stuff % of thrown');
  for (let di = 0; di < 3; di++) {
    const ps = results[di].flatMap(f => f.punches);
    for (const g of [...GROUPS, 'ALL']) {
      const a = g === 'ALL' ? ps : ps.filter(p => p.grp === g);
      if (!a.length) continue;
      const reached = a.filter(p => ['land', 'block', 'perfect'].includes(p.outcome)), land = reached.filter(p => p.outcome === 'land');
      const rl = x => x / Math.max(1, reached.length);
      console.log(row(DIFFS[di], g, a.length, reached.length, pct(rl(land.length)), pct(rl(land.filter(p => p.guardUpAtResolve).length)) + ` (${land.filter(p => p.through).length} flagged through)`, pct(rl(land.filter(p => !p.guardUpAtResolve).length)), pct(rl(reached.filter(p => p.outcome === 'block').length)), pct(rl(reached.filter(p => p.outcome === 'perfect').length)), pct(a.filter(p => ['whiff', 'slipped', 'stuffed'].includes(p.outcome)).length / a.length)));
    }
  }
  console.log('### D.2b By position in the attacker\'s combination (a punch starting within 30 ticks of the previous one is a follow-up)\n');
  head('difficulty', 'position', 'thrown', 'reached', 'land %', 'block + perfect %', 'guard already up at the start', 'whiff/slip/stuff % of thrown');
  for (let di = 0; di < 3; di++) {
    const ps = results[di].flatMap(f => f.punches);
    for (const [lab, test] of [['1st or lone', p => p.pos === 1], ['2nd', p => p.pos === 2], ['3rd or later', p => p.pos >= 3]]) {
      const a = ps.filter(test); if (!a.length) continue;
      const reached = a.filter(p => ['land', 'block', 'perfect'].includes(p.outcome));
      console.log(row(DIFFS[di], lab, a.length, reached.length, pct(reached.filter(p => p.outcome === 'land').length / Math.max(1, reached.length)), pct(reached.filter(p => p.outcome !== 'land').length / Math.max(1, reached.length)), pct(a.filter(p => p.upAtStart).length / a.length), pct(a.filter(p => ['whiff', 'slipped', 'stuffed'].includes(p.outcome)).length / a.length)));
    }
  }
  console.log('');
}

async function sectionD2() {
  title('D.3 Win / knockdown rates against the existing scripted bots (scripts/bot_table.mjs fight(): five bots x five styles, ' + Math.max(4, Math.round(NUM * 0.3)) + ' fights per cell, 3 x 30 s, ratings and styles on)');
  const bt = await import('./bot_table.mjs');
  const n = Math.max(4, Math.round(NUM * 0.3));
  head('difficulty', 'bot', 'bot wins', 'bot wins by stoppage', 'AI wins', 'AI wins by stoppage', 'draws', 'bot knockdowns suffered / fight', 'AI knockdowns suffered / fight', 'landed by bot / by AI per fight', 'boxing s per fight');
  for (let di = 0; di < 3; di++) {
    const c = { ...kr.cfg, aiDifficulty: di };
    const all = { w: 0, l: 0, d: 0, ko: 0, koBy: 0, kd: 0, kdBy: 0, lands: 0, taken: 0, secs: 0, n: 0 };
    for (const bot of bt.BOTS) {
      const t = { w: 0, l: 0, d: 0, ko: 0, koBy: 0, kd: 0, kdBy: 0, lands: 0, taken: 0, secs: 0, n: 0 };
      for (const style of bt.STYLES) { const cl = bt.cell(bot, style, n, c); for (const key of ['w', 'l', 'd', 'ko', 'koBy', 'kd', 'kdBy', 'lands', 'taken', 'secs']) t[key] += cl[key]; t.n += n; }
      console.log(row(DIFFS[di], bot.name + (bot.legit ? '' : ' (not a plan)'), pct(t.w / t.n), pct(t.ko / t.n), pct(t.l / t.n), pct(t.koBy / t.n), pct(t.d / t.n), f2(t.kdBy / t.n), f2(t.kd / t.n), `${f1(t.lands / t.n)} / ${f1(t.taken / t.n)}`, f1(t.secs / t.n)));
      if (bot.legit) for (const key of Object.keys(all)) all[key] += t[key];
    }
    console.log(row(DIFFS[di], '**legitimate plans (jab-and-move, inside-fighter, counter-puncher)**', pct(all.w / all.n), pct(all.ko / all.n), pct(all.l / all.n), pct(all.koBy / all.n), pct(all.d / all.n), f2(all.kdBy / all.n), f2(all.kd / all.n), `${f1(all.lands / all.n)} / ${f1(all.taken / all.n)}`, f1(all.secs / all.n)));
  }
}

// @@END_A
// @@MAIN
if (want('A')) sectionA();
if (want('B')) sectionB();
if (want('C')) await sectionC();
if (want('D')) { await sectionD(); await sectionD2(); }
if (want('E')) sectionE();
if (want('F')) sectionF();

if (argv.includes('write')) {
  const doc = join(dirname(dirname(fileURLToPath(import.meta.url))), 'docs', 'anim', 'BASELINE_NUMBERS.md');
  const BEGIN = '<!-- BEGIN GENERATED (node scripts/anim_measure.mjs write) -->', END = '<!-- END GENERATED -->';
  const body = BEGIN + '\n' + OUT.join('\n') + '\n' + END;
  let text = existsSync(doc) ? readFileSync(doc, 'utf8') : '';
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  text = a >= 0 && b > a ? text.slice(0, a) + body + text.slice(b + END.length) : text + '\n' + body + '\n';
  writeFileSync(doc, text);
  realLog(`\nwrote ${doc}`);
}
