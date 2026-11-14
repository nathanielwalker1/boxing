/**
 * grade_test.mjs — overhaul A3, sim/grade.ts + combat.ts, in Node:
 *   - a set punch at a sensible distance is CLEAN and worth exactly what it was
 *   - GLANCING: the end of the arm, a smothered straight (never stacked on the
 *     smother's own loss), a target rolling away
 *   - FLUSH: into the target's own punch, a target walking onto it, a rocked target
 *   - each grade's hit-stop tier, and the grade on the event
 *   - combinations build: the 2nd and 3rd clean lands hit harder; a miss, a
 *     block or a pause resets
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, SIM_DT } = k;
cfg.hitStopV2 = false;   // anim 2.4: this file asserts the old seconds-based freezes / 5% clock, so it pins hitStopV2 off (hitstop_test.mjs covers V2)
const MID = 0.79;
const plain = { ...cfg, gradesOn: false };
const landOf = evs => evs.find(e => e.type === 'punchLand' && e.side === 0);
/** Side 0 presses `type` on tick 0 at `d` m; returns { land, hitStop on the land tick }. */
function hit(type, d, c = cfg, dummy = () => NONE, prep) {
  let s = fresh(c, d, 20);
  if (prep) s = prep(s) ?? s;
  let hs = null;
  const r = run(s, 30, i => [inp({ [type]: i === 0 }), dummy(i)], c, (st, i, ev) => { if (hs === null && ev.some(e => e.type === 'punchLand' && e.side === 0)) hs = st.hitStop; });
  return { land: landOf(r.evs), hs, evs: r.evs };
}

// ── 1. Clean ────────────────────────────────────────────────────────────────
console.log('\n=== 1. Clean ===');
for (const [type, d] of [['jab', MID], ['cross', MID], ['hook', 0.72]]) {
  const a = hit(type, d), b = hit(type, d, plain);
  check(`a set ${type} at ${d} m is CLEAN and worth exactly what it was (${a.land?.power.toFixed(3)})`, a.land?.grade === 'clean' && near(a.land.power, b.land.power, 1e-9));
  // (Polish phase, deliberate: a clean JAB's freeze is hitStopJabScale of that — the most frequent land in a fight, and the lightest.)
  check(`…hit-stop = hitStopBase × power, capped${type === 'jab' ? ' × hitStopJabScale' : ''} (${a.hs.toFixed(3)} s)`, near(a.hs, Math.min(cfg.hitStopMax, cfg.hitStopBase * a.land.power) * (type === 'jab' && cfg.hitStopBudgetOn ? cfg.hitStopJabScale : 1), 1e-9));
}

// ── 2. Glancing ─────────────────────────────────────────────────────────────
console.log('\n=== 2. Glancing ===');
{
  const end = hit('jab', 1.0), endPlain = hit('jab', 1.0, plain);
  check(`a jab on the very end of the arm (1.0 m) is GLANCING: ${(end.land.power / endPlain.land.power).toFixed(2)}× = gradeGlancingPower`, end.land?.grade === 'glancing' && near(end.land.power / endPlain.land.power, cfg.gradeGlancingPower, 1e-6));
  check(`…with the glancing hit-stop (${end.hs.toFixed(3)} s)`, near(end.hs, cfg.hitStopGlancing, 1e-9));
  const sm = hit('jab', 0.55), smPlain = hit('jab', 0.55, plain);
  check(`a smothered jab (0.55 m) is glancing, and its power is the smother's own loss, not both (${sm.land.power.toFixed(3)} = ${smPlain.land.power.toFixed(3)})`, sm.land?.grade === 'glancing' && near(sm.land.power, smPlain.land.power, 1e-9));
  // Rolling away: the dummy walks back at full speed as the cross arrives.
  const back = () => inp({ move: { x: 0, y: -1 } });
  const walking = c => s => run(s, 8, () => [NONE, back()], c).s;   // already up to speed when the cross is pressed
  const rollPlain = hit('cross', 0.55, plain, back, walking(plain)), roll = hit('cross', 0.55, cfg, back, walking(cfg));
  const g = sim.gradeProbe.last;
  check(`a cross on a man going away with it is glancing (${roll.land?.grade}; timing ${g.timing.toFixed(2)}, range ${g.range.toFixed(2)}): rolled with`, roll.land?.grade === 'glancing' && g.timing < cfg.gradeGlanceBelow && roll.land.power <= rollPlain.land.power + 1e-9);
  check('the grade probe reports the parts (range, square, timing, exposure, closing)', g && ['range', 'square', 'timing', 'exposure', 'closing', 'quality', 'bonus'].every(p => typeof g[p] === 'number'));
}

// ── 3. Flush ────────────────────────────────────────────────────────────────
console.log('\n=== 3. Flush ===');
{
  // Into his own punch: the dummy's hook is in its extension when the cross lands.
  // (Phase 3: his LEAD hook. With the lane tracking his height fully, a cross into his REAR hook now arrives at the
  // height of the lead glove still at his chin, pins it on his face and is a land THROUGH the guard — clean, not flush.
  // Before, the fist came in 5.5 cm low, under that glove. Into the lead hook the lead hand is away and the chin is open.)
  const trade = i => inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } });
  const a = hit('cross', MID, cfg, trade, s => run(s, 3, i => [NONE, trade(i)]).s);
  const b = hit('cross', MID, plain, trade, s => run(s, 3, i => [NONE, trade(i)], plain).s);  check(`a cross into the other man's hook is FLUSH (${a.land?.grade}; ${(a.land.power / b.land.power).toFixed(2)}× = gradeFlushPower on top of the exposure bonus)`, a.land?.grade === 'flush' && near(a.land.power / b.land.power, cfg.gradeFlushPower, 1e-6));
  // (That cross also ROCKS him, which has its own, longer, hit-stop; the larger wins.)
  const rockedBy = a.evs.some(e => e.type === 'rocked');
  check(`…with the flush hit-stop (${a.hs.toFixed(3)} s${rockedBy ? ', raised to stunHitStop by the rock' : ''})`, near(a.hs, Math.max(cfg.hitStopFlush, rockedBy ? cfg.stunHitStop : 0), 1e-9));
  // Walking onto it: the dummy comes forward; the jab is thrown as he arrives.
  const walkIn = c => {
    let pressed = false;
    const r = run(fresh(c, 1.7, 10), 80, (i, s) => { const go = !pressed && k.dist(s) < 1.12; if (go) pressed = true; return [inp({ jab: go }), inp({ move: { x: 0, y: 1 } })]; }, c);
    return landOf(r.evs);
  };
  // (jabImpulseCap 0: the ratio is the grade's, measured without the cap that phase 3 / 4 put on every jab.)
  const w = walkIn({ ...cfg, jabImpulseCap: 0 }), wp = walkIn({ ...plain, jabImpulseCap: 0 });
  check(`a jab on a man walking onto it is FLUSH (${w?.grade})`, w?.grade === 'flush' && near(w.power / wp.power, cfg.gradeFlushPower, 1e-6));
  // Rocked: exposure is held, so every square shot is flush.
  const rocked = hit('jab', MID, cfg, () => NONE, s => { const d = s.fighters[1]; d.hurt = 1.5; d.hurtMax = 1.5; d.hurtKind = 'head'; return run(s, 2).s; });
  check(`a jab on a rocked man is flush (${rocked.land?.grade})`, rocked.land?.grade === 'flush');
  const off = hit('cross', MID, plain, trade, s => run(s, 3, i => [NONE, trade(i)], plain).s);
  check('gradesOn off: everything is clean', off.land?.grade === 'clean' && hit('jab', 1.0, plain).land?.grade === 'clean');
  check('the event carries the variant and the grade', a.land.variant === 'cross' && typeof a.land.combo === 'number' && a.land.through === false && a.land.wrongWay === false);
}

// ── 4. Combinations build ───────────────────────────────────────────────────
console.log('\n=== 4. Combinations ===');
{
  // Jab, cross, hook pressed as fast as the buffer takes them, on a man with his back on the ropes: in open ring the
  // first two knock him out of the hook's reach (measured: the 3 of a 1-2-3 whiffs on a free target at 0.74 m — a
  // third punch has to be stepped in behind, or thrown on the ropes). No rebound and no rocking, so the on / off runs
  // differ only by the build.
  // (Polish phase: the hold, the follow step and the finisher are off here — this section pins the BUILD ratios alone; flow_test pins those three.)
  const base = { ...cfg, ropeRebound: 0, stunBase: 0, comboHoldOn: false, comboStepOn: false, comboFinisherOn: false, hitStopBudgetOn: false, comboHitStopScale: 1, reactionVary: 0, hitNerfOn: false, gradeSpreadOn: false };   // (…and the old hit-stop: the budget makes the freeze, and so the timing of the next punch, depend on the power being compared)
  const combo = (c, seq = ['jab', 'cross', 'hook']) => {
    const s0 = fresh(c, 0.74, 20, k.bound(c) - 0.02 - 0.37);
    const r = run(s0, 70, i => [inp({ [seq[0]]: i === 0, [seq[1]]: i === 2, [seq[2]]: i === 16 }), NONE], c);
    return { lands: r.evs.filter(e => e.type === 'punchLand' && e.side === 0), s: r.s };
  };
  const on = combo(base), off = combo({ ...base, comboBuildOn: false });
  check(`a 1-2-3 lands as punches 1, 2, 3 of a combination (${on.lands.map(l => l.combo).join(', ')})`, on.lands.length === 3 && on.lands.map(l => l.combo).join() === '1,2,3', on.lands.map(l => `${l.variant}:${l.grade}`).join(' '));
  check(`the 2nd hits ${(on.lands[1].power / off.lands[1].power).toFixed(2)}× and the 3rd ${(on.lands[2].power / off.lands[2].power).toFixed(2)}× what they would alone (comboBuildStep)`,
    near(on.lands[1].power / off.lands[1].power, 1 + cfg.comboBuildStep, 0.02) && near(on.lands[2].power / off.lands[2].power, 1 + 2 * cfg.comboBuildStep, 0.03));
  check(`the third punch of the combination hits harder than the same punch thrown first (${on.lands[2]?.power.toFixed(2)} vs ${off.lands[2]?.power.toFixed(2)})`, on.lands[2].power > off.lands[2].power * 1.15);   // (measured 1.201× with full height tracking; the bound was a strict 1.2)
  check('the first punch of a combination is untouched', near(on.lands[0].power, off.lands[0].power, 1e-9));
  const cap = { ...base, comboBuildStep: 0.3 };
  const capped = combo(cap), capOff = combo({ ...cap, comboBuildOn: false });
  check('the bonus is capped at comboBuildMax', near(capped.lands[2].power / capOff.lands[2].power, 1 + cfg.comboBuildMax, 0.03), `${capped.lands.map(l => `${l.variant}:${l.grade}:${l.power.toFixed(2)}`).join(' ')} vs off ${capOff.lands.map(l => `${l.variant}:${l.grade}:${l.power.toFixed(2)}`).join(' ')}`);

  // Resets.
  // (From 0.66 m: the first jab knocks him back ~0.15 m and the second must still be in clean range — a glancing land neither counts nor resets.)
  const lapse = run(fresh(cfg, 0.66, 20), T(cfg.comboWindow) + 40, i => [inp({ jab: i === 0 || i === T(cfg.comboWindow) + 20 }), NONE]);
  const ll = lapse.evs.filter(e => e.type === 'punchLand');
  check('a pause longer than comboWindow starts a new combination', ll.length === 2 && ll[1].grade !== 'glancing' && ll[1].combo === 1, ll.map(l => `${l.grade}:${l.combo}`).join(' '));
  const blocked = run(fresh(cfg, MID, 20), 60, i => [inp({ jab: i === 0, cross: i === 2 }), inp({ block: i >= 9 })]);
  check('a blocked punch ends it', blocked.evs.some(e => e.type === 'punchBlock') && blocked.s.fighters[0].combo === 0);
  const miss = run(fresh(cfg, MID, 20), 40, i => [inp({ jab: i === 0, cross: i === 2 }), NONE], cfg, (st, i) => { if (i === 8) st.fighters[1].pos = { x: st.fighters[1].pos.x + 1, z: 0 }; });
  check('a miss ends it', miss.evs.some(e => e.type === 'punchWhiff') && miss.s.fighters[0].combo === 0);
  const live = run(fresh(cfg, MID, 20), 9, i => [inp({ jab: i === 0 }), NONE]).s.fighters[0];
  check('the count and its clock are on the state', live.combo === 1 && live.comboT > 0 && live.comboT <= cfg.comboWindow);
}

done();
