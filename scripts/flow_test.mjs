/**
 * flow_test.mjs — the polish phase's flow rules (sim/flow.ts, 2026-11-11, item 2):
 *   - a clean combination keeps him in front of you long enough to finish it
 *     (the hold + the follow step), and its last power punch is the finisher
 *   - a lone punch is exactly what it was
 *   - hit-stop is paid from a budget
 *   - being hit nerfs a punch instead of locking it out; ordinary locks have a ceiling
 *   - a rewound chained punch does not snap the body
 *   - a land carries a hit zone and a seeded variation; the grades are further apart
 * The measurements behind the numbers: docs/POLISH_SIM.md; the probes: combo_probe.mjs, feel_probe.mjs.
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';
import { COMBOS, runCombo } from './combo_probe.mjs';

const k = await kit();
const { cfg, inp, NONE, T, fresh, run, of, mag } = k;
cfg.hitStopV2 = false;   // anim 2.4: this file asserts the old seconds-based freezes / 5% clock, so it pins hitStopV2 off (hitstop_test.mjs covers V2)
const BEFORE = { ...cfg, comboHoldOn: false, comboStepOn: false, comboFinisherOn: false, hitStopBudgetOn: false, comboHitStopScale: 1, hitNerfOn: false, carryFadeOn: false, gradeSpreadOn: false, reactionVary: 0 };
const DISTS = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90];

// ── 1. The combination finishes ─────────────────────────────────────────────
console.log('\n=== 1. Combinations ===');
for (const [name, combo] of Object.entries(COMBOS)) {
  const now = DISTS.map(d => runCombo(k, cfg, combo, d)), was = DISTS.map(d => runCombo(k, BEFORE, combo, d));
  const landed = r => r.rows.filter(x => x.outcome === 'L').length;
  check(`${name}, open ring, 0.60–0.90 m: all three land at every distance (${now.map(landed).join('')})`, now.every(r => landed(r) === 3));
  check(`…before the polish phase the 3 whiffed at every one of them (${was.map(landed).join('')}): he had been knocked out of reach`, was.every(r => r.rows[2].outcome === 'W' && r.rows[2].gap > 1.0));
  check(`…no press was dropped or made to wait more than 3 ticks (${now.map(r => Math.max(...r.rows.map(x => x.start - x.press))).join(' ')})`, now.every(r => r.rows.every(x => x.start >= 0 && x.start - x.press <= 3)));
  // (At the far end of the range the hook can arrive at the end of the arm — a glancing land is neither part of the combination nor its finisher.)
  check(`…the third is the FINISHER wherever it lands clean (${now.filter(r => r.rows[2].finisher).length} of ${now.length} distances), and only the third`, now.every(r => r.rows[2].finisher === (r.rows[2].grade !== 'g') && !r.rows[0].finisher && !r.rows[1].finisher) && now.filter(r => r.rows[2].finisher && r.rows[2].combo === 3).length >= 5);
  check(`…the attacker follows: he is never more than 0.55 m from where he started (${Math.max(...now.map(r => r.followed)).toFixed(2)} m)`, now.every(r => r.followed <= 0.55));
  for (const gap of [12]) {
    const slow = DISTS.slice(1).map(d => runCombo(k, cfg, combo, d, { gap }));
    check(`…and at a slower cadence (presses ${gap} ticks apart) it still lands (${slow.map(landed).join('')})`, slow.every(r => landed(r) === 3));
  }
}
{
  const hold = runCombo(k, { ...cfg, comboStepOn: false }, COMBOS['1-2-3'], 0.75), step = runCombo(k, { ...cfg, comboHoldOn: false }, COMBOS['1-2-3'], 0.75);
  check('neither the hold nor the follow step is enough alone at 0.75 m (the 3 whiffs with either off)', hold.rows[2].outcome === 'W' && step.rows[2].outcome === 'W', `${hold.rows[2].outcome} ${step.rows[2].outcome}`);
  const ropes = [0.65, 0.75, 0.85].map(d => runCombo(k, cfg, COMBOS['1-2-3'], d, { ropes: true }));
  check('on the ropes it lands too', ropes.every(r => r.rows.every(x => x.outcome === 'L')));
  // The finisher is the biggest moment.
  const on = runCombo(k, cfg, COMBOS['1-2-3'], 0.75), off = runCombo(k, { ...cfg, comboFinisherOn: false }, COMBOS['1-2-3'], 0.75);
  check(`the finisher hits harder than the same third punch without it (${on.rows[2].impulse.toFixed(0)} vs ${off.rows[2].impulse.toFixed(0)} N·s)`, on.rows[2].impulse > off.rows[2].impulse * 1.1);
  check(`…and takes the longest freeze of the combination (the big one is saved for last: longest stop ${(on.maxStop * 1000).toFixed(0)} ms ≥ comboFinisherHitStop)`, on.maxStop >= cfg.comboFinisherHitStop - 1e-9);
  check('…and the count starts again after it (attacker combo 0)', on.s.fighters[0].combo === 0);
  check(`he is knocked further at the end of the combination than its first two punches alone would have sent him (${on.knocked.toFixed(2)} m)`, on.knocked > 0.75);
}

// ── 2. A lone punch is what it was ──────────────────────────────────────────
console.log('\n=== 2. Lone punches ===');
for (const p of ['jab', 'cross', 'hook']) {
  const one = c => { const r = run(fresh(c, 0.76), 90, i => [inp({ [p]: i === 0 }), NONE], c); return { pos: r.s.fighters[1].pos, a: r.s.fighters[0].pos, land: of(r.evs, 'punchLand')[0] }; };
  const now = one({ ...cfg, reactionVary: 0, gradeSpreadOn: false, hitStopBudgetOn: false }), was = one(BEFORE);
  check(`a lone ${p}: same impulse, the target ends where he did, the puncher does not move (hold / follow / finisher change nothing)`,
    Math.abs(mag(now.land) - mag(was.land)) < 1e-9 && Math.abs(now.pos.x - was.pos.x) < 1e-9 && Math.abs(now.a.x - was.a.x) < 1e-9 && !now.land.finisher, `${now.pos.x} vs ${was.pos.x}`);
}

// ── 3. The hit-stop budget ──────────────────────────────────────────────────
console.log('\n=== 3. Hit-stop budget ===');
{
  // A man on the ropes taking a cross every 14 ticks for 4 s (nothing rocks: stunBase 0; no health: he does not go down).
  const frozen = c => {
    const cc = { ...c, stunBase: 0, healthDamagePerImpulse: 0, staminaPunchCost: 0, comboFinisherOn: false };
    let s = fresh(cc, 0.7, 30, k.bound(cc) - 0.36), n = 0, worst = 0; const f = [];
    for (let i = 0; i < 240; i++) { s = k.sim.step(s, [inp({ cross: i % 14 === 0 }), NONE], cc).state; f.push(s.hitStop > 0 ? 1 : 0); n += f[i]; }
    for (let i = 0; i + 60 <= f.length; i++) worst = Math.max(worst, f.slice(i, i + 60).reduce((a, b) => a + b, 0));
    return { n, worst };
  };
  const now = frozen(cfg), was = frozen({ ...cfg, hitStopBudgetOn: false, comboHitStopScale: 1 });
  check(`a cross every 14 ticks for 4 s: ${now.n} ticks frozen (${(now.n / 2.4).toFixed(0)}%) against ${was.n} (${(was.n / 2.4).toFixed(0)}%) with every freeze in full`, now.n <= was.n * 0.75 && now.n > 0);
  check(`…the worst second: ${now.worst} ticks frozen against ${was.worst}`, now.worst < was.worst && now.worst <= T(cfg.hitStopBudget + cfg.hitStopBudget / cfg.hitStopBudgetWindow) + 5);
  // The first hit after a quiet moment reads in full.
  const first = c => { let hs = 0; const r = run(fresh(c, 0.72), 30, i => [inp({ hook: i === 0 }), NONE], c, s => { hs = Math.max(hs, s.hitStop); }); return { hs, land: of(r.evs, 'punchLand')[0] }; };
  const a = first(cfg);
  check(`a first clean hook gets its whole freeze (${(a.hs * 1000).toFixed(0)} ms = hitStopBase × power)`, Math.abs(a.hs - Math.min(cfg.hitStopMax, cfg.hitStopBase * a.land.power)) < 1e-9);
  // Inputs are never eaten by a freeze: a press on a frozen tick starts on that tick.
  const r = run(fresh(cfg, 0.76), 40, i => [inp({ jab: i === 0, cross: i === 8 }), NONE]);
  const st = of(r.evs, 'punchStart').filter(e => e.side === 0);
  check(`a cross pressed during the jab's freeze starts that tick (@${st[1]?.tick})`, st.length === 2 && st[1].tick === 8);
}

// ── 4. Being hit nerfs; ordinary locks have a ceiling ───────────────────────
console.log('\n=== 4. The nerf and the lock ceiling ===');
{
  /** Real ticks from side 1's punch arriving on side 0 until side 0 could start a punch. */
  const lockAfter = (c, his, mine, dist = 0.74) => {
    let s = fresh(c, dist), at = -1;
    for (let i = 0; i < 200; i++) {
      const r = k.sim.step(s, [mine(i, at), his(i)], c); s = r.state;
      if (at < 0) { if (r.events.some(e => (e.type === 'punchLand' || e.type === 'punchBlock') && e.side === 1)) at = i; continue; }
      if (k.sim.canStartPunch(s.fighters[0], c)) return i - at;
    }
    return 999;
  };
  const ceil = T(cfg.hitLockMax) + 1;
  for (const p of ['jab', 'cross', 'hook', 'uppercut']) {
    const now = lockAfter(cfg, i => inp({ [p]: i === 0 }), (i, at) => inp({ block: at < 0 })), was = lockAfter(BEFORE, i => inp({ [p]: i === 0 }), (i, at) => inp({ block: at < 0 }));
    check(`blocking his ${p}: a punch can start ${now} ticks later (≤ hitLockMax ${ceil}; it was ${was})`, now <= ceil && was >= now);
  }
  const walkNow = lockAfter(cfg, i => inp({ jab: i === 8 }), () => inp({ move: { x: 0, y: 1 } }), 1.25), walkWas = lockAfter(BEFORE, i => inp({ jab: i === 8 }), () => inp({ move: { x: 0, y: 1 } }), 1.25);
  check(`walking onto his jab (the jab stop): ${walkNow} ticks (≤ ${ceil}; it was ${walkWas})`, walkNow <= ceil && walkWas > ceil);
  for (const p of ['jab', 'cross', 'hook']) check(`a clean ${p} on a man with his hands at rest never locks him (1 tick)`, lockAfter(cfg, i => inp({ [p]: i === 0 }), () => inp()) <= 1);
  // The nerf itself: slower and weaker, by how hard and how recently he was hit.
  const start = (c, hitBy, pressAt) => {
    const r = run(fresh(c, 0.76), pressAt + 2, i => [inp({ [hitBy ?? 'none']: i === 0 }), inp({ cross: i === pressAt })], c);
    return { ev: of(r.evs, 'punchStart').find(e => e.side === 1), p: r.s.fighters[1].punch, hit: of(r.evs, 'punchLand').find(e => e.side === 0) };
  };
  const cold = start(cfg, null, 9), afterJab = start(cfg, 'jab', 9), afterCross = start(cfg, 'cross', 14), later = start(cfg, 'jab', 20);
  check(`a cross thrown 2 ticks after a clean jab landed on him: nerf ${afterJab.ev.nerf.toFixed(2)}, in state and on punchStart`, afterJab.ev.nerf > 0.4 && afterJab.ev.nerf <= cfg.hitSevClean && Math.abs(afterJab.p.nerf - afterJab.ev.nerf) < 1e-9);
  check(`…slower (tell ${(afterJab.ev.tell * 1000).toFixed(0)} ms vs ${(cold.ev.tell * 1000).toFixed(0)} ms) and weaker (powerMult ${afterJab.p.powerMult.toFixed(2)} vs ${cold.p.powerMult.toFixed(2)})`,
    afterJab.ev.tell > cold.ev.tell * 1.15 && Math.abs(afterJab.p.powerMult / cold.p.powerMult - (1 - cfg.hitNerfPower * afterJab.ev.nerf)) < 1e-9);
  check(`…the nerf fades as the hit window closes (${later.ev.nerf.toFixed(2)} at 13 ticks < ${afterJab.ev.nerf.toFixed(2)} at 2)`, later.ev.nerf < afterJab.ev.nerf && later.ev.nerf > 0);
  check(`…and is the same for a jab and a cross of the same grade (${afterCross.hit?.grade}: ${afterCross.ev.nerf.toFixed(2)})`, afterCross.hit?.grade !== 'clean' || Math.abs(afterCross.ev.nerf - afterJab.ev.nerf) < 0.08);
  // Shorter: the nerfed punch's fist stops short of where the cold one's does.
  const reach = (c, hitBy) => { let far = 0; run(fresh(c, 1.15), 40, i => [inp({ [hitBy ?? 'none']: i === 0 }), inp({ cross: i === 9 })], c, s => { const f = s.fighters[1]; far = Math.max(far, Math.abs(f.gloves[1].pos.x - f.pos.x)); }); return far; };
  const rCold = reach({ ...cfg, hitNerfReach: 0 }, null), rNerf = reach({ ...cfg, rangeMax: 2 }, null);
  void rCold; void rNerf;
  const sForced = fresh(cfg, 1.3); sForced.fighters[1].hitT = cfg.hitWindow; sForced.fighters[1].hitSev = 1;
  let farN = 0, farC = 0;
  run(sForced, 30, i => [NONE, inp({ cross: i === 0 })], cfg, s => { const f = s.fighters[1]; farN = Math.max(farN, Math.abs(f.gloves[1].pos.x - f.pos.x)); });
  run(fresh(cfg, 1.3), 30, i => [NONE, inp({ cross: i === 0 })], cfg, s => { const f = s.fighters[1]; farC = Math.max(farC, Math.abs(f.gloves[1].pos.x - f.pos.x)); });
  check(`…and shorter: a fully nerfed cross reaches ${(farN * 100).toFixed(0)} cm against ${(farC * 100).toFixed(0)} cm`, farN < farC - 0.04);
  const off = start({ ...cfg, hitNerfOn: false }, 'jab', 9);
  check('hitNerfOn off: no nerf, the old tell', off.ev.nerf === 0 && Math.abs(off.ev.tell - cold.ev.tell) < 1e-9);
}

// ── 5. A rewound chained punch does not snap the body ───────────────────────
console.log('\n=== 5. The pose unwind ===');
{
  const snap = c => {
    // A cross that lands, a hook chained off it, feinted two ticks into its wind-up.
    let s = fresh(c, 0.76), hookAt = -1, max = 0, prev = null;
    for (let i = 0; i < 70; i++) {
      const r = k.sim.step(s, [inp({ cross: i === 0, hook: i === 6, block: hookAt >= 0 && i >= hookAt + 2 && i < hookAt + 5 }), NONE], c); s = r.state;
      if (hookAt < 0 && r.events.some(e => e.type === 'punchStart' && e.punch === 'hook')) hookAt = i;
      const tw = s.fighters[0].torsoTwist;
      if (prev !== null && hookAt >= 0) max = Math.max(max, Math.abs(tw - prev));
      prev = tw;
    }
    return { max, feint: hookAt >= 0, end: s.fighters[0].torsoTwist };
  };
  const now = snap(cfg), was = snap({ ...cfg, carryFadeOn: false });
  check(`a feinted chained hook: the torso moves at most ${(now.max * 57.3).toFixed(0)}° in a tick (it snapped ${(was.max * 57.3).toFixed(0)}° with carryFadeOn off)`, now.feint && now.max < 0.45 && was.max > now.max * 1.8, `${now.max} vs ${was.max}`);
  check('…and is home (twist 0) a moment later', now.end === 0);
}

// ── 6. Zone, variation, the grade gap ───────────────────────────────────────
console.log('\n=== 6. What a land carries ===');
{
  const land = (p, dist, o = {}) => of(run(fresh(cfg, dist), 40, i => [inp({ [p]: i === (o.level ? 6 : 0), level: !!o.level && i <= 6, move: { x: i === (o.level ? 6 : 0) ? (o.x ?? 0) : 0, y: 0 } }), NONE]).evs, 'punchLand')[0];
  const jab = land('jab', 0.8), hook = land('hook', 0.72, { x: -1 }), upper = land('uppercut', 0.66), liver = land('hook', 0.7, { x: -1, level: true }), bodyCross = land('cross', 0.8, { level: true });
  check(`zones from the contact: jab ${jab?.zone}, lead hook ${hook?.zone}, uppercut ${upper?.zone}, lead body hook ${liver?.zone}, body cross ${bodyCross?.zone}`,
    ['chin', 'nose', 'forehead'].includes(jab?.zone) && ['jaw', 'temple'].includes(hook?.zone) && upper?.zone === 'chin' && liver?.zone === 'liver' && ['solar', 'belly', 'ribs'].includes(bodyCross?.zone));
  const two = c => of(run(fresh(c, 0.7, 30, k.bound(c) - 0.36), 60, i => [inp({ jab: i === 0 || i === 30 }), NONE], c).evs, 'punchLand');
  const a = two(cfg), b = two(cfg);
  check(`a seeded variation rides on every land, in −1..1 (${a.map(e => e.vary.toFixed(2)).join(', ')}): two jabs differ, two runs do not`, a.length === 2 && a.every(e => e.vary >= -1 && e.vary <= 1) && a[0].vary !== a[1].vary && a[0].vary === b[0].vary && a[1].vary === b[1].vary);
  // The reaction itself differs between two identical jabs (and not at all with reactionVary 0).
  // The REAL head (the posed head box the sim hits), relative to his feet: its peak travel in the 10 ticks after a land
  // from where it was the tick before (with hitChainV2 the legacy spring offsets are not kicked, so they read 0).
  const headTravel = () => {
    let prev = null, base = null, until = -1, peak = 0; const out = [];
    const rel = f => ({ x: f.headBox.x - f.pos.x, y: f.headBox.y, z: f.headBox.z - f.pos.z });
    return { out, track: (s, i, ev) => {
      const h = rel(s.fighters[1]);
      if (ev.some(e => e.type === 'punchLand')) { if (until >= 0) out.push(peak); base = prev ?? h; until = i + 10; peak = 0; }
      if (base && i <= until) peak = Math.max(peak, Math.hypot(h.x - base.x, h.y - base.y, h.z - base.z));
      if (i === until) { out.push(peak); until = -1; base = null; }
      prev = h;
    } };
  };
  const disp = c => { const t = headTravel(); run(fresh(c, 0.7, 30, k.bound(c) - 0.36), 60, i => [inp({ jab: i === 0 || i === 30 }), NONE], c, t.track); return t.out; };
  const dv = disp(cfg);
  check(`…and the head's snap differs with it (${dv.map(x => (x * 100).toFixed(1)).join(' vs ')} cm)`, dv.length === 2 && Math.abs(dv[0] - dv[1]) > 0.002);
  // The grade gap: displacement on the frozen frame.
  const head = (c, dist, p, rocked) => { const s0 = fresh(c, dist); if (rocked) { s0.fighters[1].hurt = 2; s0.fighters[1].hurtMax = 3; s0.fighters[1].hurtKind = 'head'; } let g = ''; const t = headTravel(); run(s0, 30, i => [inp({ [p]: i === 2 }), NONE], c, (s, i, ev) => { const e = ev.find(x => x.type === 'punchLand'); if (e) g = e.grade; t.track(s, i, ev); }); return { d: t.out[0] ?? 0, g }; };
  const flat = { ...cfg, reactionVary: 0 }, plain = { ...flat, gradeSpreadOn: false };
  const gl = head(flat, 1.0, 'jab'), gl0 = head(plain, 1.0, 'jab'), cl = head(flat, 0.8, 'cross'), cl0 = head(plain, 0.8, 'cross'), fl = head(flat, 0.8, 'cross', true), fl0 = head(plain, 0.8, 'cross', true);
  check(`a glancing jab moves the head less than it did (${(gl.d * 100).toFixed(1)} vs ${(gl0.d * 100).toFixed(1)} cm), a clean cross the same (${(cl.d * 100).toFixed(1)} cm), a flush cross more (${(fl.d * 100).toFixed(1)} vs ${(fl0.d * 100).toFixed(1)} cm — past the old neck clamp)`,
    gl.g === 'glancing' && gl.d < gl0.d * 0.85 && cl.g === 'clean' && Math.abs(cl.d - cl0.d) < 1e-9 && fl.g === 'flush' && fl.d > fl0.d * 1.2 && fl.d > cfg.reactionMaxNeck);
}

// ── 7. Determinism ──────────────────────────────────────────────────────────
{
  const a = runCombo(k, cfg, COMBOS['1-2-3'], 0.8).s, b = runCombo(k, cfg, COMBOS['1-2-3'], 0.8).s;
  check('two identical runs through a held, followed, finished combination end in the same state', JSON.stringify(a) === JSON.stringify(b));
  const nan = v => typeof v === 'number' ? Number.isNaN(v) : v && typeof v === 'object' ? Object.values(v).some(nan) : false;
  check('no NaN anywhere in it', !nan(a));
}

done();
