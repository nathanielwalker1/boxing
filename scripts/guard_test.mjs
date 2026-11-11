/**
 * guard_test.mjs — overhaul A4, what blocking costs (sim/combat.ts), in Node:
 *   - BLOCK STUN: a shot on the guard holds the blocker out of punching, feet slowed
 *   - GUARD WEAR: the meter drains under fire, recovers when left alone, absorbs
 *     less when worn, and BREAKS when empty (hands down, no block, exposed)
 *   - CHIP: only heavy shots take health through a block
 *   - THE GUARD HAS A SHAPE: straights and a square hook meet it; an uppercut
 *     splits it; a body shot gets under it; a hook from an angle comes round it
 *   - a PERFECT block pays nothing and leaves the puncher's arm hanging
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, SIM_DT } = k;
const MID = 0.79;
const quiet = { ...cfg, staminaBlockDrain: 0, staminaRegen: 0, healthRegen: 0 };
const BLOCK = inp({ block: true });
const res = evs => evs.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchBlock' || e.type === 'perfectBlock' || e.type === 'punchWhiff'));
/** Side 0 throws `type` (stick x for the hand) at a dummy holding `dummy` input. */
const at = (type, d, dummy = BLOCK, c = quiet, x = 0, n = 45) => run(fresh(c, d, 20), n, i => [inp({ [type]: i === 0, move: { x: i === 0 ? x : 0, y: 0 } }), dummy], c);
const rawOf = (type, d, x = 0, c = quiet) => mag(res(at(type, d, NONE, { ...c, gradesOn: false }, x).evs));

// ── 1. Block stun ───────────────────────────────────────────────────────────
console.log('\n=== 1. Block stun ===');
{
  const r = at('cross', MID);
  const b = res(r.evs);
  const rawPower = rawOf('cross', MID) / cfg.punchImpulseBase;
  check(`a blocked cross: block stun = blockStunBase × its unblocked power (${b?.stun.toFixed(3)} s)`, b?.type === 'punchBlock' && near(b.stun, Math.min(cfg.blockStunMax, cfg.blockStunBase * rawPower), 1e-6));
  // The blocker lets go and presses jab every other tick from the block: nothing starts until the stun is over.
  const press = run(fresh(quiet, MID, 20), 60, i => [inp({ cross: i === 0 }), inp({ block: i < b.tick + 1, jab: i > b.tick && i % 2 === 0 })], quiet);
  const start = press.evs.find(e => e.type === 'punchStart' && e.side === 1);
  check(`…no punch starts inside it (first ${((start.tick - b.tick) * SIM_DT).toFixed(2)} s after the block)`, start && (start.tick - b.tick) * SIM_DT >= b.stun - SIM_DT);
  const off = { ...quiet, blockStunOn: false };
  const pressOff = run(fresh(off, MID, 20), 60, i => [inp({ cross: i === 0 }), inp({ block: i < b.tick + 1, jab: i > b.tick && i % 2 === 0 })], off);
  check('blockStunOn off: the blocker can fire straight back', res(at('cross', MID, BLOCK, off).evs).stun === 0 && pressOff.evs.find(e => e.type === 'punchStart' && e.side === 1).tick < start.tick);
  const hook = res(at('hook', 0.72, BLOCK, quiet, 1).evs), jab = res(at('jab', MID).evs);
  check(`a hook holds him longer than a jab (${hook?.stun.toFixed(2)} vs ${jab?.stun.toFixed(2)} s)`, hook?.type === 'punchBlock' && hook.stun > jab.stun * 1.5);
}

// ── 2. Guard wear and the break ─────────────────────────────────────────────
console.log('\n=== 2. Guard wear ===');
{
  const r = at('cross', MID);
  const b = res(r.evs);
  check(`a blocked cross takes guardWearPerImpulse × its unblocked impulse off the meter (${(1 - b.guard).toFixed(3)})`, near(1 - b.guard, cfg.guardWearPerImpulse * rawOf('cross', MID), 1e-6));
  const later = run(r.s, T(cfg.guardRegenDelay + 1), () => [NONE, BLOCK], quiet).s.fighters[1].guardHp;
  check(`left alone it recovers after guardRegenDelay at guardRegen (${b.guard.toFixed(2)} → ${later.toFixed(2)})`, later > b.guard + cfg.guardRegen * 0.5 && later <= 1);
  const stillWorn = run(r.s, T(cfg.guardRegenDelay) - 50, () => [NONE, BLOCK], quiet).s.fighters[1].guardHp;
  check('…not before', near(stillWorn, b.guard, 1e-9));
  // A worn guard absorbs less: the same cross on a guard at 0.2 chips more than on a fresh one.
  const worn = fresh(quiet, MID, 20); worn.fighters[1].guardHp = 0.3; worn.fighters[1].guardRest = 0;
  const bw = res(run(worn, 45, i => [inp({ cross: i === 0 }), BLOCK], quiet).evs);
  check(`a worn guard lets more through (chip ${bw.chip.toFixed(4)} vs ${b.chip.toFixed(4)} fresh)`, bw.type === 'punchBlock' && bw.chip > b.chip * 1.5);

  // The break: hooks on the guard until it goes.
  const evs = [];
  let s = fresh(quiet, 0.72, 20), brokeAt = null, n = 0;
  const trace = [];
  for (let i = 0; i < 400 && brokeAt === null; i++) {
    const canPress = sim.canStartPunch(s.fighters[0], quiet) && s.fighters[0].punch.type === null;
    const r2 = sim.step(s, [inp({ hook: canPress && i % 3 === 0, move: { x: 1, y: 0 } }), BLOCK], quiet); s = r2.state;
    s.fighters[1].pos = { x: s.fighters[0].pos.x + 0.72, z: s.fighters[0].pos.z }; s.fighters[1].stagger = { x: 0, z: 0 };
    for (const e of r2.events) { evs.push({ ...e, tick: i }); if (e.type === 'punchBlock') n++; if (e.type === 'guardBreak') brokeAt = i; }
  }
  const gb = first(evs, 'guardBreak');
  check(`the guard BREAKS after ${n} hooks on it`, gb && gb.side === 1 && gb.by === 0 && n >= 2 && n <= 5, `broke at tick ${brokeAt}`);
  const d = s.fighters[1];
  check('broken: the block is down though it is held, for guardBreakSeconds', !d.block && near(d.guardBroken, cfg.guardBreakSeconds, 1e-9) && d.guardHp === 0);
  const after = run(s, 25, () => [NONE, BLOCK], quiet).s.fighters[1];   // (past the breaking hook's hit-stop)
  check(`…exposed (vuln ${after.vuln.toFixed(2)}) with the hands knocked down (lead glove ${after.gloves[0].pos.y.toFixed(2)} m)`, !after.block && after.vuln >= cfg.guardBreakVuln - 1e-9 && after.gloves[0].pos.y < fresh(quiet, 0.72, 20).fighters[1].gloves[0].pos.y - 0.08);
  const back = run(s, T(cfg.guardBreakSeconds) + 20, () => [NONE, BLOCK], quiet).s.fighters[1];
  check('…then the guard comes back at guardBreakRestore', back.block && back.guardBroken === 0 && back.guardHp >= cfg.guardBreakRestore - 1e-9);
  const offW = { ...quiet, guardWearOn: false };
  check('guardWearOn off: the meter never moves', res(at('cross', MID, BLOCK, offW).evs).guard === 1);
}

// ── 3. Chip ─────────────────────────────────────────────────────────────────
console.log('\n=== 3. Chip ===');
{
  const jab = at('jab', MID), cross = at('cross', MID);
  check('a blocked jab takes no health (chip 0)', res(jab.evs).chip === 0 && jab.s.fighters[1].health === 1);
  check(`…but it costs wind and guard`, jab.s.fighters[1].stamina < 1 && jab.s.fighters[1].guardHp < 1);
  check(`a blocked cross chips (${res(cross.evs).chip.toFixed(4)}), and that is the health it took`, res(cross.evs).chip > 0 && near(1 - cross.s.fighters[1].health, res(cross.evs).chip, 1e-9));
  const off = at('jab', MID, BLOCK, { ...quiet, chipOn: false });
  check('chipOn off: every blocked punch chips', res(off.evs).chip > 0 && off.s.fighters[1].health < 1);
}

// ── 4. The guard has a shape ────────────────────────────────────────────────
console.log('\n=== 4. Shape ===');
{
  check('a jab, a cross and a square-on hook meet the guard: blocked', res(at('jab', MID).evs).type === 'punchBlock' && res(at('cross', MID).evs).type === 'punchBlock' && res(at('hook', 0.72, BLOCK, quiet, 1).evs).type === 'punchBlock');
  // Phase 2 (guardUppercutCover / guardBodyCover 0.6, were 0.45): a FRESH guard half-stops an uppercut and a body
  // shot — a block, at a heavy chip — and a WORN one is split / got under. At 0.45 they always came through, and a
  // held guard did nothing at inside range.
  const upRaw = rawOf('uppercut', 0.58, 1);
  const crossChip = res(at('cross', MID).evs).chip / rawOf('cross', MID), upF = res(at('uppercut', 0.58, BLOCK, quiet, 1).evs);
  check(`an uppercut on a FRESH guard is blocked, but the guard only half meets it (chip ${(upF?.chip / upRaw * 1e4).toFixed(1)} vs a cross's ${(crossChip * 1e4).toFixed(1)} per 10 kN·s)`, upF?.type === 'punchBlock' && upF.chip / upRaw > crossChip * 1.8);
  const worn = (type, d, x, level) => { const s = fresh(quiet, d, 20); s.fighters[1].guardHp = 0.3; s.fighters[1].guardRest = 0; return run(s, 50, i => [inp({ [type]: i === 10, level: level && i <= 10, move: { x: i === 10 ? x : 0, y: 0 } }), BLOCK], quiet); };
  const up = res(worn('uppercut', 0.58, 1, false).evs);
  const left = 1 - cfg.blockReduction * cfg.guardUppercutCover * (cfg.guardWornCover + (1 - cfg.guardWornCover) * 0.3);
  check(`an uppercut SPLITS a worn guard: a land, flagged through (${up?.type} through=${up?.through})`, up?.type === 'punchLand' && up.through === true && up.grade !== 'flush');
  check(`…at what the guard left of it (${(mag(up) / upRaw).toFixed(2)} ≈ ${left.toFixed(2)})`, near(mag(up) / upRaw, left, 0.04));
  const bodyFresh = res(run(fresh(quiet, MID, 20), 50, i => [inp({ jab: i === 10, level: i <= 10 }), BLOCK], quiet).evs);
  const bodyOn = worn('jab', MID, 0, true);
  const bj = res(bodyOn.evs);
  check(`a body jab is blocked by a fresh guard (${bodyFresh?.type}) and gets UNDER a worn one (${bj?.type} ${bj?.part} through=${bj?.through})`, bodyFresh?.type === 'punchBlock' && bodyFresh.part === 'body' && bj?.type === 'punchLand' && bj.part === 'body' && bj.through === true);
  check('…and both still wear the guard and hold the blocker', bodyOn.s.fighters[1].guardHp < 0.3 && run(fresh(quiet, MID, 20), 18, i => [inp({ jab: i === 10, level: i <= 10 }), BLOCK], quiet).s.fighters[1].blockStun > 0);

  // A hook from an angle comes round. The attacker stands 45° off the blocker's facing; the blocker's feet are slow (as after a pivot).
  const angled = deg => {
    const s = fresh(quiet, 0.72, 20);
    const d = s.fighters[1], a = s.fighters[0], th = Math.PI + deg * Math.PI / 180;   // the blocker faces −x (yaw π)
    a.pos = { x: d.pos.x + Math.cos(th) * 0.72, z: d.pos.z + Math.sin(th) * 0.72 };
    a.yaw = Math.atan2(d.pos.z - a.pos.z, d.pos.x - a.pos.x);
    d.turned = 2;
    const turnless = { ...quiet, pivotTurnScale: 0 };
    return res(run(s, 45, i => [inp({ hook: i === 0, move: { x: i === 0 ? (deg > 0 ? -1 : 1) : 0, y: 0 } }), BLOCK], turnless).evs);
  };
  const sq = angled(0), ang = angled(45);
  check(`a hook thrown from 45° off his line comes ROUND the guard (${ang?.type} through=${ang?.through}); square on it is ${sq?.type}`, sq?.type === 'punchBlock' && ang?.type === 'punchLand' && ang.through === true);
  const off = { ...quiet, guardShapeOn: false };
  check('guardShapeOn off: a held block stops an uppercut and a body shot like anything else', res(at('uppercut', 0.58, BLOCK, off, 1).evs).type === 'punchBlock' && res(run(fresh(off, MID, 20), 50, i => [inp({ jab: i === 10, level: i <= 10 }), BLOCK], off).evs).type === 'punchBlock');
}

// ── 5. The perfect block ────────────────────────────────────────────────────
console.log('\n=== 5. Perfect block ===');
{
  const L = res(at('cross', MID, NONE).evs).tick;
  const dur = dummy => { let end = null; const r = run(fresh(quiet, MID, 20), 80, i => [inp({ cross: i === 0 }), dummy(i)], quiet, (s, i) => { if (end === null && i > 2 && s.fighters[0].punch.type === null) end = i; }); return { end, r }; };
  const perfect = dur(i => inp({ block: i >= L - 1 })), plain = dur(() => BLOCK);
  check('a guard raised just before the impact is a perfect block', perfect.r.evs.some(e => e.type === 'perfectBlock') && plain.r.evs.some(e => e.type === 'punchBlock'));
  const d = perfect.r.s.fighters[1];
  check('it pays nothing: no stun, no guard wear, no health', d.guardHp === 1 && d.health === 1 && run(fresh(quiet, MID, 20), L + 1, i => [inp({ cross: i === 0 }), inp({ block: i >= L - 1 })], quiet).s.fighters[1].blockStun === 0);
  const stretch = (cfg.crossRecover * (cfg.perfectBlockRecoverMult - 1)) / SIM_DT;
  check(`the deflected arm hangs: the punch takes ${perfect.end - plain.end} ticks longer to come home (≈ ${stretch.toFixed(1)}, less the hold it skips)`, perfect.end - plain.end >= 2 && perfect.end - plain.end <= stretch + 4);
}

done();
