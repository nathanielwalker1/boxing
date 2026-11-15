/**
 * block_payoff_test.mjs — blockPayoffV2 (sim/combat.ts), in Node, controlled set-ups, reference fighters:
 *   1. a blocked punch weighs by the punch: hit-stop and push grow jab < cross < hook, and stay under the same punch landed clean;
 *   2. who goes next: the jab is safe on a guard, the cross about even, the hook and uppercut are punishable;
 *   3. a combination on the guard opens it for a moment (the next punch gets through); single pokes never do; it comes back;
 *   4. off = today's numbers (2 ticks for everything, the guard never opens on three punches).
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';

const k = await kit({ rated: false });
const { cfg, sim, inp, NONE, fresh } = k;
const on = { ...cfg, staminaRegen: 0, healthRegen: 0, aiDifficulty: 1, blockPayoffV2: true };
const off = { ...on, blockPayoffV2: false };
const BLOCK = inp({ block: true });
const DIST = { jab: 0.78, cross: 0.78, hook: 0.72, uppercut: 0.66 };

/** One punch from side 0 into a blocker holding (or not): stop ticks, push (cm), ticks until each side may punch again. */
function exp(c, type, held) {
  let s = fresh(c, DIST[type]);
  for (let i = 0; i < 25; i++) s = sim.step(s, [NONE, held ? BLOCK : NONE], c).state;
  const p0 = { x: s.fighters[1].pos.x, z: s.fighters[1].pos.z };
  const ax = s.fighters[0].pos.x, az = s.fighters[0].pos.z, L = Math.hypot(p0.x - ax, p0.z - az);
  let T = null, ev = null, stop = 0, a0 = null, a1 = null, heldNow = held;
  for (let i = 0; i < 90; i++) {
    const r = sim.step(s, [inp({ [type]: i === 0, move: { x: type === 'hook' || type === 'uppercut' ? 1 : 0, y: 0 } }), heldNow ? BLOCK : NONE], c); s = r.state;
    for (const e of r.events) if (T === null && e.side === 0 && (e.type === 'punchBlock' || e.type === 'punchLand')) { T = i; ev = e; heldNow = false; }
    if (T !== null) {
      stop = Math.max(stop, Math.round(s.hitStop / k.SIM_DT));
      if (a0 === null && s.fighters[0].punch.type === null && sim.canStartPunch(s.fighters[0], c)) a0 = i - T;
      if (a1 === null && s.fighters[1].punch.type === null && sim.canStartPunch(s.fighters[1], c)) a1 = i - T;
    }
  }
  const push = ((s.fighters[1].pos.x - p0.x) * (p0.x - ax) + (s.fighters[1].pos.z - p0.z) * (p0.z - az)) / L;
  return { kind: ev?.type, stop, push: push * 100, adv: a0 - a1, a0, a1, stun: ev?.stun };
}

console.log('\n=== 1. Weight on the guard ===');
const T = ['jab', 'cross', 'hook', 'uppercut'];
const bl = {}, cl = {};
for (const t of T) { bl[t] = exp(on, t, true); cl[t] = exp(on, t, false); }
console.log('  blocked: ' + T.map(t => `${t} ${bl[t].kind} stop ${bl[t].stop}t push ${bl[t].push.toFixed(1)}cm adv ${bl[t].adv} (thrower ${bl[t].a0}t, blocker ${bl[t].a1}t, stun ${bl[t].stun?.toFixed(3)}s)`).join(' | '));
console.log('  clean:   ' + T.map(t => `${t} ${cl[t].kind} stop ${cl[t].stop}t push ${cl[t].push.toFixed(1)}cm`).join(' | '));
check('every one of the four is a block on the held guard', T.every(t => bl[t].kind === 'punchBlock'));
check('hit-stop grows with the punch: jab <= cross <= hook, and jab < hook', bl.jab.stop <= bl.cross.stop && bl.cross.stop <= bl.hook.stop && bl.jab.stop < bl.hook.stop);
check(`blocked jab is about 2 ticks, cross 3, hook/uppercut 4 to 5 (${T.map(t => bl[t].stop).join('/')})`, bl.jab.stop === 2 && bl.cross.stop === 3 && bl.hook.stop >= 4 && bl.uppercut.stop >= 4);
check('push grows jab < cross < hook < uppercut', bl.jab.push < bl.cross.push && bl.cross.push < bl.hook.push && bl.hook.push <= bl.uppercut.push + 1e-6);
check(`blocked jab push 8 to 12 cm (${bl.jab.push.toFixed(1)}), cross 13 to 19 cm (${bl.cross.push.toFixed(1)})`, bl.jab.push > 8 && bl.jab.push < 12 && bl.cross.push > 13 && bl.cross.push < 19);
// (The uppercut is left out: this set-up's clean uppercut lands glancing, 1 tick and 18 cm, below even today's blocked one.)
check('a blocked punch stops shorter and pushes less than the same punch landed clean (jab, cross, hook)', ['jab', 'cross', 'hook'].every(t => bl[t].stop < cl[t].stop && bl[t].push < cl[t].push));
const o = exp(off, 'hook', true), oj = exp(off, 'jab', true);
check(`off: every blocked punch is 2 ticks as before (jab ${oj.stop}, hook ${o.stop})`, oj.stop === 2 && o.stop === 2);

console.log('\n=== 2. Who goes next ===');
console.log(`  adv (thrower later than blocker, ticks): ${T.map(t => `${t} ${bl[t].adv}`).join(' | ')}   off: jab ${oj.adv} hook ${o.adv}`);
check(`jab is safe on a guard: thrower ready no later than the blocker (adv ${bl.jab.adv} <= 0, and within 3)`, bl.jab.adv <= 0 && bl.jab.adv >= -3);
check(`cross about even (adv ${bl.cross.adv}, within 2)`, Math.abs(bl.cross.adv) <= 2);
check(`hook and uppercut are punishable: blocker ahead by 4 ticks or more (${bl.hook.adv}, ${bl.uppercut.adv})`, bl.hook.adv >= 4 && bl.uppercut.adv >= 4);

console.log('\n=== 3. A combination opens the guard ===');
/** Side 0 throws `seq` as soon as it may (a pause of `gap` ticks between), blocker holds. Returns events by punch plus the open tick. */
function combo(c, seq, gap = 0) {
  let s = fresh(c, 0.74); let n = 0, wait = 0; const outs = [], breaks = []; let tick = 0;
  for (let i = 0; i < 25; i++) s = sim.step(s, [NONE, BLOCK], c).state;
  for (let i = 0; i < 400 && n <= seq.length; i++) {
    const f = s.fighters[0]; let a = NONE;
    if (n < seq.length && f.punch.type === null && sim.canStartPunch(f, c)) { if (wait > 0) wait--; else { const t = seq[n]; a = inp({ [t]: true, move: { x: t === 'hook' ? 1 : 0, y: 0 } }); n++; wait = gap; } }
    // keep them in range, as a real fight does
    s.fighters[1].pos = { x: s.fighters[0].pos.x + 0.74, z: s.fighters[0].pos.z }; s.fighters[1].stagger = { x: 0, z: 0 };
    const r = sim.step(s, [a, BLOCK], c); s = r.state; tick++;
    for (const e of r.events) {
      if (e.side === 0 && (e.type === 'punchBlock' || e.type === 'punchLand')) outs.push(e.type === 'punchBlock' ? `${e.punch}:block` : `${e.punch}:${e.grade}${e.through ? '(through)' : ''}`);
      if (e.type === 'guardBreak' && e.side === 1) breaks.push({ at: outs.length, seconds: e.seconds });
    }
  }
  return { outs, breaks };
}
const c3 = combo(on, ['jab', 'cross', 'hook', 'cross']);
console.log('  jab, cross, hook, cross: ' + c3.outs.join(', ') + ` | openings ${c3.breaks.length} after punch #${c3.breaks[0]?.at}, ${c3.breaks[0]?.seconds}s`);
check('three or four blocked punches in a row open the guard', c3.breaks.length >= 1 && c3.breaks[0].at >= 2 && c3.breaks[0].at <= 4);
check(`it opens for about half a second (${c3.breaks[0]?.seconds})`, Math.abs((c3.breaks[0]?.seconds ?? 9) - on.blockPayoffOpenSeconds) < 1e-9);
const idx = c3.breaks[0]?.at ?? 99;
check('the next punch after the opening gets through (a land)', c3.outs[idx] !== undefined && /:(clean|flush|glancing)/.test(c3.outs[idx]));
const pokes = combo(on, ['jab', 'jab', 'jab'], 45);
console.log('  three jabs a second apart: ' + pokes.outs.join(', ') + ` | openings ${pokes.breaks.length}`);
check('single pokes (jabs spaced out) never open the guard', pokes.breaks.length === 0 && pokes.outs.every(x => x.endsWith('block')));
const one2 = combo(on, ['jab', 'cross'], 30);
check('a 1-2 on a fresh guard does not open it', one2.breaks.length === 0);
const offc = combo(off, ['jab', 'cross', 'hook']);
check(`off: jab, cross, hook does not open the guard (${offc.outs.join(', ')})`, offc.breaks.length === 0);

done();
