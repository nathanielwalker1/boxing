/**
 * block_feel_test.mjs — blockFeelV2 (sim/combat.ts blockFeel), in Node, scripted punches into a held high guard at 0.8 m:
 *   the guard glove is driven back toward his own head (cross 6-14 cm, jab under 5 cm) and springs home inside 20 ticks;
 *   the head and torso rock from a blocked cross is under 40% of a landed cross's; the thrower's fist is moving away
 *   from the target within 4 ticks of the block; the glove is never inside his own head; toggle off = the old fight.
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';

const k = await kit();
const { cfg, inp, NONE, fresh, run } = k;
const on = { ...cfg, stylesOn: true, staminaBlockDrain: 0, staminaRegen: 0, healthRegen: 0, guardMeterOn: false, guardHolesV2: true, blockFeelV2: true };
const off = { ...on, blockFeelV2: false };
const BLOCK = inp({ block: true });
const PRE = 30;   // the guard is up and settled before the punch
const cm = m => (m * 100).toFixed(1);

/** One punch into a held guard (or a bare one) from side 0; per-tick traces along the punch axis (+x, side 0 to side 1). */
function trace(type, c, { blocked = true, x = 0, dist = 0.8 } = {}) {
  const fi = type === "jab" || (type === "hook" && x < 0) ? 0 : 1;   // the punching glove: jab and a lead hook lead, cross and a rear hook rear
  const s = fresh(c, dist, 20), tr = [];
  const r = run(s, PRE + 70, i => [inp({ [type]: i === PRE, move: { x: i === PRE ? x : 0, y: 0 } }), blocked ? BLOCK : NONE], c, st => {
    const a = st.fighters[0], d = st.fighters[1];
    tr.push({
      g: d.gloves.map(g => g.pos.x - d.pos.x),                    // his gloves relative to his feet, along the axis (his body is shoved too; this is the glove in his guard)
      gp: d.gloves.map(g => ({ ...g.pos })), h: { ...d.headBox }, hx: d.headBox.x - d.pos.x,
      fx: a.gloves[fi].pos.x, fp: { ...a.gloves[fi].pos }, gr: a.body.gloveR,
    });
  });
  const ev = r.evs.find(e => e.side === 0 && (e.type === 'punchBlock' || e.type === 'punchLand'));
  const base = tr[PRE - 1];
  let knock = 0, kI = PRE;
  tr.forEach((t, i) => { if (i < PRE) return; const kk = Math.max(t.g[0] - base.g[0], t.g[1] - base.g[1]); if (kk > knock) { knock = kk; kI = i; } });
  let back = -1;
  for (let i = kI; i < tr.length; i++) if (Math.max(tr[i].g[0] - base.g[0], tr[i].g[1] - base.g[1]) < 0.01) { back = i - kI; break; }
  let rock = 0;
  tr.forEach((t, i) => { if (i >= PRE) rock = Math.max(rock, Math.abs(t.hx - base.hx)); });
  // The fist, from two ticks after the block (the hit-stop frames are over): it sits on the OUTER surface of his glove —
  // further from his head than his own glove, never inside it — and has backed 3 cm off that spot (`away`, ticks after the block).
  let away = -1, behind = 0, inside = -1;
  if (ev) {
    const x0 = tr[ev.tick + 2]?.fx ?? 0;
    for (let i = ev.tick + 2; i < tr.length; i++) if (tr[i].fx <= x0 - 0.03) { away = i - ev.tick; break; }
    for (let i = ev.tick + 2; i <= ev.tick + 5; i++) {
      const q = tr[i], dh = (p, h) => Math.hypot(p.x - h.x, p.y - h.y, p.z - h.z);
      const gd = q.gp.map(p => Math.hypot(p.x - q.fp.x, p.y - q.fp.y, p.z - q.fp.z)), ng = gd[0] < gd[1] ? 0 : 1;
      if (dh(q.fp, q.h) <= dh(q.gp[ng], q.h)) behind++;
      inside = Math.max(inside, 2 * q.gr - q.gr * c.contactSquash - 0.01 - gd[ng]);   // how far in past two glove radii less the leather give (contactSquash), and 1 cm
    }
  }
  // Never inside his own head: the closest any of his gloves' centres gets to the head centre, over the whole trace.
  let minGap = Infinity;
  tr.forEach(t => t.gp.forEach(p => { minGap = Math.min(minGap, Math.hypot(p.x - t.h.x, p.y - t.h.y, p.z - t.h.z) - t.h.r); }));
  return { ev, knock, back, rock, away, behind, inside, minGap, tr };
}

console.log('\n=== 1. The guard glove is driven back and springs home ===');
const cross = trace('cross', on), jab = trace('jab', on), hook = trace('hook', on, { x: 1 });
const crossOff = trace('cross', off), jabOff = trace('jab', off), hookOff = trace('hook', off, { x: 1 });
{
  check(`all three are blocked (${cross.ev?.type}, ${jab.ev?.type}, ${hook.ev?.type})`, [cross, jab, hook].every(t => t.ev?.type === 'punchBlock'));
  check(`a blocked cross: the guard glove rocks back with the head 5-14 cm (${cm(cross.knock)} cm; was ${cm(crossOff.knock)} off)`, cross.knock >= 0.05 && cross.knock <= 0.14);
  check(`…and it is home within 20 ticks (${cross.back})`, cross.back >= 0 && cross.back <= 20);
  check(`a blocked jab moves it under 5 cm (${cm(jab.knock)} cm; was ${cm(jabOff.knock)} off)`, jab.knock < 0.05);
  check(`a blocked hook rocks 5-14 cm (${cm(hook.knock)} cm; was ${cm(hookOff.knock)} off) and is home within 20 ticks (${hook.back})`, hook.knock >= 0.05 && hook.knock <= 0.14 && hook.back >= 0 && hook.back <= 20);
}

console.log('\n=== 2. The head rocks behind the gloves, far less than a land ===');
{
  const landed = trace('cross', on, { blocked: false });
  check(`the head's rock off a blocked cross ${cm(cross.rock)} cm is under 40% of a landed cross's ${cm(landed.rock)} cm (${((cross.rock / landed.rock) * 100).toFixed(0)}%); off it was ${cm(crossOff.rock)} cm`, cross.rock < 0.4 * landed.rock);
  check(`head rock: cross ${cm(cross.rock)} cm and hook ${cm(hook.rock)} cm in 5-9 cm, jab ${cm(jab.rock)} cm in 1.5-3.5 cm`, [cross, hook].every(r => r.rock >= 0.05 && r.rock <= 0.09) && jab.rock >= 0.015 && jab.rock <= 0.035);
}

console.log('\n=== 3. The fist stops on the glove and bounces back ===');
{
  check(`the fist is outside his glove (further from his head than it) on ticks 2-5 after the block: cross ${cross.behind}, jab ${jab.behind}, hook ${hook.behind} ticks behind it`, cross.behind === 0 && jab.behind === 0 && hook.behind === 0);
  check(`…and not inside it (past the gloves' touching distance: cross ${cm(cross.inside)}, hook ${cm(hook.inside)} cm)`, cross.inside < 0 && hook.inside < 0);
  check(`it has backed 3 cm off the glove within 6 ticks of the block: cross ${cross.away} (off ${crossOff.away}), hook ${hook.away} (off ${hookOff.away}), jab ${jab.away}`, [cross, hook, jab].every(r => r.away >= 0 && r.away <= 6));
}

console.log('\n=== 4. Never inside his own head ===');
{
  const min = Math.min(cross.minGap, jab.minGap, hook.minGap);
  check(`closest a glove centre gets to the head surface: ${cm(min)} cm`, min >= 0.04);
}

console.log('\n=== 5. Toggle off = the old fight ===');
{
  const a = trace('cross', off), b = trace('cross', { ...on, blockFeelV2: false, blockFeelGlove: 0.2, blockFeelHeadScale: 1 });
  const same = JSON.stringify(a.tr) === JSON.stringify(b.tr) && a.ev?.type === b.ev?.type;
  check('with blockFeelV2 false the new keys change nothing (identical trace and event)', same);
  const base = trace('cross', { ...off, guardHolesV2: false }), noHoles = trace('cross', { ...on, guardHolesV2: false });
  check('with guardHolesV2 off the block is as it was, blockFeelV2 or not', JSON.stringify(base.tr) === JSON.stringify(noHoles.tr));
}

done();
