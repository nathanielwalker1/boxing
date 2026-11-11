/**
 * level_test.mjs — overhaul A2, in Node: the level, the contextual punch behind
 * each button (sim/variants.ts), how much each plants the feet, tells, the
 * feint, the push-off and the clinch (sim/clinch.ts).
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, flick, dist, SIM_DT } = k;
const MID = 0.79, IN = 0.6;
/** Side 0 presses `type` on tick `at` with `extra(i)` merged into its input every tick. */
const press = (type, at = 0, extra = () => ({})) => i => [inp({ [type]: i === at, ...extra(i) }), NONE];
const startOf = evs => evs.find(e => e.type === 'punchStart' && e.side === 0);
const outcome = evs => evs.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));
const LEVEL_LEAD = 10;   // ticks of held level before a press, so the body is down (levelTime 0.12 s)
const low = i => ({ level: true });

// ── 1. The level ────────────────────────────────────────────────────────────
console.log('\n=== 1. The level ===');
{
  const s0 = fresh(cfg, 2.0, 10);
  const down = run(s0, 20, () => [inp({ level: true }), NONE]).s;
  const a0 = s0.fighters[0], a1 = down.fighters[0];
  check('holding level takes the body all the way down in levelTime', a1.level === 1);
  check(`the head box drops levelDrop (${(a0.headBox.y - a1.headBox.y).toFixed(3)} m)`, near(a0.headBox.y - a1.headBox.y, cfg.levelDrop, 1e-6));
  check('…and the body capsule with it, both ends', near(a0.bodyBox.a.y - a1.bodyBox.a.y, cfg.levelDrop, 1e-6) && near(a0.bodyBox.b.y - a1.bodyBox.b.y, cfg.levelDrop, 1e-6));
  check(`…and the hands (lead glove ${(a0.gloves[0].pos.y - a1.gloves[0].pos.y).toFixed(3)} m lower, within the idle bob)`, Math.abs(a0.gloves[0].pos.y - a1.gloves[0].pos.y - cfg.levelDrop) < 0.03);
  check('stanceDrop reports it', near(sim.stanceDrop(a1, cfg), cfg.levelDrop, 1e-9));
  const up = run(down, 20).s.fighters[0];
  check('letting go brings it back up', up.level === 0 && near(up.headBox.y, a0.headBox.y, 1e-6));
  const speed = lv => { const r = run(fresh(cfg, 2.0, 10), 80, () => [inp({ level: lv, move: { x: 0, y: 1 } }), NONE]); return Math.hypot(r.s.fighters[0].vel.x, r.s.fighters[0].vel.z); };
  check(`crouched he walks at levelMoveScale (${(speed(true) / speed(false)).toFixed(2)})`, near(speed(true) / speed(false), cfg.levelMoveScale, 0.02));
  const off = { ...cfg, levelOn: false };
  const offS = run(fresh(off, 2.0, 10), 20, () => [inp({ level: true }), NONE], off).s.fighters[0];
  check('levelOn off: the input does nothing', offS.level === 0 && near(offS.headBox.y, a0.headBox.y, 1e-6));

  // A head-lane straight on a ducked head clips the top of it: glancing. (Two fighters of the SAME height: the lane is
  // the thrower's own inside punchAimDeadband, so against a taller man the same duck leaves more head on the line.)
  const twins = [k.specs[0], k.specs[0]];
  const ducked = () => run(fresh(cfg, MID, 10, 0, 1, twins), 20, () => [NONE, inp({ level: true })]).s;
  const jabDuck = outcome(run(ducked(), 20, i => [inp({ jab: i === 0 }), inp({ level: true })]).evs);
  const jabStand = outcome(run(fresh(cfg, MID, 30, 0, 1, twins), 20, press('jab')).evs);
  check(`a jab on a ducked head still lands but is GLANCING (${jabDuck?.grade}, power ${jabDuck?.power.toFixed(2)} vs ${jabStand?.power.toFixed(2)} standing)`, jabDuck?.type === 'punchLand' && jabDuck.part === 'head' && jabDuck.grade === 'glancing' && jabDuck.power < jabStand.power * 0.7);
}

// ── 2. Which variant a press throws ─────────────────────────────────────────
console.log('\n=== 2. The variant table ===');
{
  const thrown = (type, d, extra, at = 0) => startOf(run(fresh(cfg, d, 10), at + 3, press(type, at, extra)).evs)?.variant;
  const fwd = () => ({ move: { x: 0, y: 1 } }), back = () => ({ move: { x: 0, y: -1 } });
  const cases = [
    ['jab', MID, undefined, 0, 'jab'], ['jab', MID, fwd, 0, 'stepJab'], ['jab', MID, back, 0, 'retreatJab'], ['jab', MID, low, LEVEL_LEAD, 'bodyJab'],
    ['cross', MID, undefined, 0, 'cross'], ['cross', MID, fwd, 0, 'cross'], ['cross', MID, low, LEVEL_LEAD, 'bodyCross'],
    ['cross', MID, i => ({ level: true, move: { x: 0, y: i === LEVEL_LEAD ? 1 : 0 } }), LEVEL_LEAD, 'overhand'],
    ['hook', MID, undefined, 0, 'hook'], ['hook', IN, undefined, 0, 'shovelHook'], ['hook', MID, back, 0, 'checkHook'], ['hook', MID, low, LEVEL_LEAD, 'bodyHook'],
    ['hook', MID, i => ({ level: i < LEVEL_LEAD }), LEVEL_LEAD + 6, 'risingHook'],
    ['uppercut', MID, undefined, 0, 'uppercut'], ['uppercut', IN, undefined, 0, 'insideUppercut'], ['uppercut', IN, low, LEVEL_LEAD, 'risingUppercut'],
    ['uppercut', IN, i => ({ level: i < LEVEL_LEAD }), LEVEL_LEAD + 6, 'risingUppercut'],
  ];
  for (const [type, d, extra, at, want] of cases) {
    const got = thrown(type, d, extra ?? (() => ({})), at);
    check(`${type} @ ${d} m${extra === fwd ? ' + stick forward' : extra === back ? ' + stick back' : extra === low ? ' + level' : extra ? ' + level context' : ''} → ${want}`, got === want, `${got}`);
  }
  check('priority: level beats stick-back and range (hook + level + back at inside range is a body hook)', thrown('hook', IN, i => ({ level: true, move: { x: 0, y: i === LEVEL_LEAD ? -1 : 0 } }), LEVEL_LEAD) === 'bodyHook');
  const off = { ...cfg, variantsOn: false };
  check('variantsOn off: always the base punch', startOf(run(fresh(off, IN, 10), 3, press('hook'), off).evs)?.variant === 'hook');
  check('every variant has a definition on its base punch', sim.VARIANT_NAMES.length === 15 && sim.VARIANT_NAMES.every(v => ['jab', 'cross', 'hook', 'uppercut'].includes(sim.VARIANTS[v].base)));
}

// ── 3. Body shots are at body height ────────────────────────────────────────
console.log('\n=== 3. Body shots ===');
{
  const body = (type, x = 0, d = MID) => outcome(run(fresh(cfg, d, 10), LEVEL_LEAD + 30, press(type, LEVEL_LEAD, i => ({ level: i <= LEVEL_LEAD, move: { x: i === LEVEL_LEAD ? x : 0, y: 0 } }))).evs);
  const bj = body('jab'), bc = body('cross'), bhLead = body('hook', -1, 0.72), bhRear = body('hook', 1, 0.72);
  check(`a body jab lands on the BODY of a standing man (${bj?.type} ${bj?.part})`, bj?.type === 'punchLand' && bj.part === 'body' && bj.variant === 'bodyJab');
  check(`a body cross too (${bc?.type} ${bc?.part})`, bc?.type === 'punchLand' && bc.part === 'body' && bc.variant === 'bodyCross');
  check(`a body hook too (${bhLead?.type} ${bhLead?.part})`, bhLead?.type === 'punchLand' && bhLead.part === 'body' && bhLead.variant === 'bodyHook');
  check('the LEAD body hook lands on the liver side (the target\'s right); the rear one does not', bhLead?.liver === true && bhRear?.type === 'punchLand' && bhRear.liver === false, `lead ${bhLead?.liver}, rear ${bhRear?.type} ${bhRear?.liver}`);
  // The level is let go on the tick after the press: a body shot holds it down itself until it has landed.
  let lv = 1;
  run(fresh(cfg, MID, 10), LEVEL_LEAD + 12, press('cross', LEVEL_LEAD, i => ({ level: i <= LEVEL_LEAD })), cfg, (s, i) => { if (i > LEVEL_LEAD && s.fighters[0].punch.type !== null && !s.fighters[0].punch.resolved) lv = Math.min(lv, s.fighters[0].level); });
  check('a body shot holds its level through the flight even if the input is let go', lv === 1, `${lv}`);
  const headJab = outcome(run(fresh(cfg, MID, 30), 20, press('jab')).evs);
  check(`a body jab is a touch lighter than a jab upstairs (bodyJabPower: ${(bj.power / headJab.power).toFixed(2)})`, near(bj.power / headJab.power, cfg.bodyJabPower, 0.03));
}

// ── 4. The overhand and the rising punches ──────────────────────────────────
console.log('\n=== 4. Overhand, rising hook, rising uppercut ===');
{
  const twins = [k.specs[0], k.specs[0]];   // same height, so "ducked" means the same to both punches (see §1)
  const overhand = dummy => run(fresh(cfg, 0.9, 10, 0, 1, twins), LEVEL_LEAD + 40, i => [inp({ cross: i === LEVEL_LEAD, level: i <= LEVEL_LEAD, move: { x: 0, y: i === LEVEL_LEAD ? 1 : 0 } }), dummy]).evs;
  const cross = dummy => run(fresh(cfg, 0.9, 10, 0, 1, twins), LEVEL_LEAD + 40, i => [inp({ cross: i === LEVEL_LEAD, move: { x: 0, y: i === LEVEL_LEAD ? 1 : 0 } }), dummy]).evs;
  const ohStand = outcome(overhand(NONE)), xStand = outcome(cross(NONE));
  check(`the overhand finds a standing head (${ohStand?.type} ${ohStand?.part} ${ohStand?.grade})`, ohStand?.type === 'punchLand' && ohStand.part === 'head' && ohStand.variant === 'overhand' && ohStand.grade !== 'glancing');
  check(`…harder than a stepping cross (${(ohStand.power / xStand.power).toFixed(2)}× ≈ overhandPower)`, near(ohStand.power / xStand.power, cfg.overhandPower, 0.12));
  check('…and slower: its tell is longer', startOf(overhand(NONE)).tell > startOf(cross(NONE)).tell + 0.02, `${startOf(overhand(NONE)).tell.toFixed(3)} vs ${startOf(cross(NONE)).tell.toFixed(3)} s`);
  const duck = inp({ level: true });
  const ohDuck = outcome(overhand(duck)), xDuck = outcome(cross(duck));
  check(`on a DUCKED head the overhand lands square (${ohDuck?.grade}) where the cross goes over or only clips it (${xDuck?.type} ${xDuck?.grade ?? ''})`, ohDuck?.type === 'punchLand' && ohDuck.part === 'head' && ohDuck.grade !== 'glancing' && (xDuck?.type === 'punchWhiff' || xDuck?.grade === 'glancing'));
  // It is aimed at where the head is AT THE PRESS: duck after it starts and it goes over.
  const lateDuck = outcome(run(fresh(cfg, 0.9, 10, 0, 1, twins), LEVEL_LEAD + 40, i => [inp({ cross: i === LEVEL_LEAD, level: i <= LEVEL_LEAD, move: { x: 0, y: i === LEVEL_LEAD ? 1 : 0 } }), inp({ level: i > LEVEL_LEAD + 2 })]).evs);
  check(`…but ducking AFTER it starts still gets under it (${lateDuck?.type} ${lateDuck?.grade ?? ''})`, lateDuck?.type === 'punchWhiff' || lateDuck?.grade === 'glancing');

  const rising = run(fresh(cfg, 0.75, 10), LEVEL_LEAD + 40, press('hook', LEVEL_LEAD + 5, i => ({ level: i < LEVEL_LEAD, move: { x: i === LEVEL_LEAD + 5 ? -1 : 0, y: 0 } }))).evs;
  const plain = run(fresh(cfg, 0.75, 10), 40, press('hook', 0, i => ({ move: { x: i === 0 ? -1 : 0, y: 0 } }))).evs;
  const rh = outcome(rising), ph = outcome(plain);
  check(`a hook thrown coming up out of the crouch is the rising hook, on the head (${rh?.variant} ${rh?.part})`, rh?.type === 'punchLand' && rh.variant === 'risingHook' && rh.part === 'head');
  check(`…harder (${(rh.power / ph.power).toFixed(2)}× ≈ risingHookPower) and quicker off the mark`, near(rh.power / ph.power, cfg.risingHookPower, 0.06) && startOf(rising).tell < startOf(plain).tell);
  const ru = outcome(run(fresh(cfg, 0.55, 10), LEVEL_LEAD + 40, press('uppercut', LEVEL_LEAD, i => ({ level: i <= LEVEL_LEAD, move: { x: i === LEVEL_LEAD ? 1 : 0, y: 0 } }))).evs);
  check(`an uppercut from the crouch drives up to the head (${ru?.variant} ${ru?.type} ${ru?.part})`, ru?.type === 'punchLand' && ru.variant === 'risingUppercut' && ru.part === 'head');
}

// ── 5. What each punch does to the feet ─────────────────────────────────────
console.log('\n=== 5. Planting the feet ===');
{
  // Walk sideways (circling) for 0.5 s, press, read the speed half-way through the wind-up.
  const circle = (type, c = cfg) => { let v = null, ms = null; run(fresh(c, 1.5, 10), 60, i => [inp({ [type]: i === 30, move: { x: 1, y: 0 } }), NONE], c, (s, i) => { const p = s.fighters[0].punch; if (p.type !== null && !p.resolved) { v = Math.hypot(s.fighters[0].vel.x, s.fighters[0].vel.z); ms = p.moveScale; } }); return { v, ms }; };
  const top = cfg.moveSpeed * cfg.moveLateralScale;
  const j = circle('jab'), x = circle('cross'), h = circle('hook'), u = circle('uppercut');
  check(`the jab does not root: circling at ${(j.v / top).toFixed(2)} of full speed as it lands`, j.ms === cfg.jabMove && j.v > top * 0.85);
  check(`a cross plants the feet (${(x.v / top).toFixed(2)}), a hook (${(h.v / top).toFixed(2)}) and an uppercut (${(u.v / top).toFixed(2)}) more`, x.ms === cfg.crossMove && x.v < top * 0.7 && h.v < top * 0.7 && u.v <= h.v + 0.05);
  const off = circle('cross', { ...cfg, punchRootOn: false });
  check('punchRootOn off: a cross is walked through at full speed', off.v > top * 0.97);
  for (const v of sim.VARIANT_NAMES) if (!(cfg[`${v}Move`] >= 0 && cfg[`${v}Move`] <= 1)) check(`config has a ${v}Move`, false);
  check('every variant has its own …Move key', sim.VARIANT_NAMES.every(v => sim.VARIANTS[v].move(cfg) === cfg[`${v}Move`]));

  // Stick and move: jab going backward — the retreat jab hops back as it goes out and still scores.
  const s0 = fresh(cfg, 0.85, 10);
  const rj = run(s0, 30, i => [inp({ jab: i === 0, move: { x: 0, y: -1 } }), NONE]);
  const land = outcome(rj.evs);
  check(`a retreat jab lands (${land?.type}) while the feet go back ${(s0.fighters[0].pos.x - rj.s.fighters[0].pos.x).toFixed(2)} m in half a second`, land?.type === 'punchLand' && land.variant === 'retreatJab' && s0.fighters[0].pos.x - rj.s.fighters[0].pos.x > 0.5);
  const stand = outcome(run(fresh(cfg, 0.85, 10), 30, press('jab')).evs);
  check('…lighter than a set jab', land.power < stand.power);
}

// ── 6. Tells ────────────────────────────────────────────────────────────────
console.log('\n=== 6. Tells ===');
{
  const tell = (type, d = MID, c = cfg, extra) => startOf(run(fresh(c, d, 10), 3, press(type, 0, extra), c).evs).tell;
  check(`jab ${tell('jab').toFixed(3)} s, cross ${tell('cross').toFixed(3)}, hook ${tell('hook').toFixed(3)}, uppercut ${tell('uppercut').toFixed(3)} = wind-up + extension`,
    near(tell('jab'), cfg.jabCock + cfg.jabExtend, 1e-9) && near(tell('cross'), cfg.crossCock + cfg.crossExtend, 1e-9) && near(tell('hook'), cfg.hookCock + cfg.hookExtend, 1e-9) && near(tell('uppercut'), cfg.uppercutCock + cfg.uppercutExtend, 1e-9));
  check('the compact inside punches are quicker', near(tell('hook', IN), cfg.hookCock * cfg.shovelHookTime + cfg.hookExtend, 1e-9) && near(tell('uppercut', IN), cfg.uppercutCock * cfg.insideUppercutTime + cfg.uppercutExtend, 1e-9));
  // The tell is on the state too, and it is when the hit test really runs.
  let resolvedAt = null;
  const r = run(fresh(cfg, MID, 10), 30, press('hook'), cfg, (s, i) => { if (resolvedAt === null && s.fighters[0].punch.resolved) resolvedAt = i; });
  check(`the hit test runs at the tell (${((resolvedAt + 1) * SIM_DT).toFixed(3)} s vs ${startOf(r.evs).tell.toFixed(3)} s)`, Math.abs((resolvedAt + 1) * SIM_DT - startOf(r.evs).tell) <= SIM_DT + 1e-9);
  // A loaded counter would be 0.1475 s; tellMinHeavy holds it at 0.17. (Slip to the rear side loads the cross.)
  const loadedX = c => startOf(run(fresh(c, 2.0, 10), 12, i => [inp({ cross: i === 8, move: flick(1, 0)(i) }), NONE], c).evs);
  const lx = loadedX(cfg), lxOff = loadedX({ ...cfg, tellsOn: false });
  check(`a loaded counter cross never beats tellMinHeavy (${lx.tell.toFixed(3)} s; ${lxOff.tell.toFixed(4)} s with tellsOn off)`, near(lx.tell, cfg.tellMinHeavy, 1e-9) && near(lxOff.tell, cfg.crossCock * cfg.slipLoadedCock + cfg.crossExtend, 1e-9));
  const chain = run(fresh(cfg, MID, 10), 30, i => [inp({ jab: i === 0, cross: i === 2 }), NONE]).evs.filter(e => e.type === 'punchStart');
  check(`the 2 of a 1-2 is exempt (${chain[1]?.tell.toFixed(3)} s): the combination is its own tell`, chain.length === 2 && near(chain[1].tell, cfg.crossCock * cfg.comboCockScale + cfg.crossExtend, 1e-9));
  const tired = fresh(cfg, MID, 10); tired.fighters[0].stamina = 0.3;
  const tt = startOf(run(tired, 6, press('cross', 3), { ...cfg, staminaRegen: 0 }).evs).tell;   // (pressed a few ticks in: punchSlow is derived each tick)
  check(`a tired cross is slower to arrive (${tt.toFixed(3)} s)`, tt > tell('cross') * 1.05);
}

// ── 7. The feint ────────────────────────────────────────────────────────────
console.log('\n=== 7. The feint ===');
{
  const noRegen = { ...cfg, staminaRegen: 0, staminaBlockDrain: 0 };
  const feint = (blockAt, c = noRegen) => run(fresh(c, MID, 10), 40, i => [inp({ cross: i === 0, block: i >= blockAt && i < blockAt + 6 }), NONE], c);
  const f = feint(3);
  const ev = first(f.evs, 'feint');
  check('block during the wind-up, before feintCommit, is a FEINT', ev && ev.side === 0 && ev.punch === 'cross' && ev.tick === 3);
  check('…the punch never resolves', !f.evs.some(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock')));
  check('…the opponent saw a punch start (the AI reads punchStart / punch.type)', f.evs.some(e => e.type === 'punchStart' && e.side === 0));
  let home = null, guard = null;
  run(fresh(noRegen, MID, 10), 20, i => [inp({ cross: i === 0, block: i >= 3 }), NONE], noRegen, (s, i) => { if (home === null && i > 0 && s.fighters[0].punch.type === null) home = i; if (guard === null && s.fighters[0].block) guard = i; });
  check(`…the fist is home ${home - 3} ticks later and the guard is up the tick after (tick ${guard})`, home - 3 <= 3 && guard === home + 1);
  check('…and most of the stamina comes back (feintRefund)', near(1 - f.s.fighters[0].stamina, cfg.staminaPunchCost * (1 - cfg.feintRefund), 1e-9), `${(1 - f.s.fighters[0].stamina).toFixed(4)}`);
  const lateTick = Math.ceil(cfg.feintCommit * cfg.crossCock / SIM_DT) + 2;
  const late = feint(lateTick);
  check(`block after the commit point (tick ${lateTick}) does not cancel: the cross lands`, !first(late.evs, 'feint') && late.evs.some(e => e.type === 'punchLand' && e.side === 0));
  const off = feint(3, { ...noRegen, feintOn: false });
  check('feintOn off: no feint', !first(off.evs, 'feint') && off.evs.some(e => e.type === 'punchLand' && e.side === 0));
}

// ── 8. The push-off ─────────────────────────────────────────────────────────
console.log('\n=== 8. The push-off ===');
{
  const push = (d, c = cfg, dummy = () => NONE) => { const s0 = fresh(c, d, 10); return { s0, r: run(s0, 40, i => [inp({ block: true, move: flick(0, 1)(i) }), dummy(i)], c) }; };
  const p = push(0.7);
  const ev = first(p.r.evs, 'pushOff');
  check('block + a forward flick is a push-off that connects in range', ev && ev.side === 0 && ev.target === 1 && ev.hit === true && ev.tick === 2);
  const went = p.r.s.fighters[1].pos.x - p.s0.fighters[1].pos.x, recoil = p.s0.fighters[0].pos.x - p.r.s.fighters[0].pos.x;
  const expect = cfg.pushSpeed * (k.specs[0].massKg / k.specs[1].massKg) / cfg.staggerDecay;
  check(`the shoved fighter goes back ~pushSpeed × mass ratio / staggerDecay (${went.toFixed(2)} m vs ${expect.toFixed(2)})`, Math.abs(went - expect) < 0.06);
  // (The flick itself walked him a few cm forward first, so the net is small; the recoil is the stagger he is left with.)
  const recoilV = run(p.s0, 3, i => [inp({ block: true, move: flick(0, 1)(i) }), NONE]).s.fighters[0].stagger.x;
  check(`…and the pusher rocks back pushRecoil of it (stagger ${recoilV.toFixed(2)} m/s; net ${recoil.toFixed(2)} m)`, recoilV < -0.5 && recoil < went);
  check('…held out of punching for pushStun', near(run(p.s0, 3, i => [inp({ block: true, move: flick(0, 1)(i) }), NONE]).s.fighters[1].blockStun, cfg.pushStun, SIM_DT * 1.5));
  check('no damage', p.r.s.fighters[1].health === 1);
  check('out of reach it misses', first(push(1.3).r.evs, 'pushOff')?.hit === false);
  const smother = push(0.7, cfg, i => inp({ hook: i === 0 }));
  check('it smothers a wind-up that has not committed (the hook is stuffed)', smother.r.evs.some(e => e.type === 'punchStuffed' && e.side === 1 && e.by === 0) && !smother.r.evs.some(e => e.type === 'punchLand' && e.side === 1));
  const again = run(fresh(cfg, 0.7, 10), 30, i => [inp({ block: true, move: i < 2 || (i >= 8 && i < 10) ? { x: 0, y: 1 } : { x: 0, y: 0 } }), NONE]);
  check('pushCooldown: a second shove straight after does nothing', of(again.evs, 'pushOff').length === 1);
  check('pushOffOn off: nothing', of(push(0.7, { ...cfg, pushOffOn: false }).r.evs, 'pushOff').length === 0);
}

// ── 9. The clinch ───────────────────────────────────────────────────────────
console.log('\n=== 9. The clinch ===');
{
  const tie = inp({ block: true, level: true });
  const c0 = fresh(cfg, 0.65, 10);
  const r = run(c0, T(cfg.clinchSeconds) + 60, i => [i < 30 ? tie : NONE, inp({ jab: i === 40, move: { x: 0, y: i >= 35 && i < 60 ? -1 : 0 } })]);
  const ev = first(r.evs, 'clinch');
  check(`block + level held in range for clinchReach ties up (tick ${ev?.tick})`, ev && ev.side === 0 && ev.target === 1 && Math.abs(ev.tick - T(cfg.clinchReach)) <= 1);
  check('nobody punches or walks while tied up', !r.evs.some(e => e.type === 'punchStart') && (() => { const m = run(c0, 45, i => [i < 30 ? tie : NONE, inp({ move: { x: 0, y: i >= 20 ? -1 : 0 } })]).s; return m.fighters[1].clinch.active && Math.hypot(m.fighters[1].vel.x, m.fighters[1].vel.z) === 0; })());
  const brk = first(r.evs, 'clinchBreak');
  check(`the referee breaks it after clinchSeconds (${((brk?.tick - ev.tick) * SIM_DT).toFixed(2)} s)`, brk?.reason === 'referee' && Math.abs((brk.tick - ev.tick) * SIM_DT - cfg.clinchSeconds) <= 2 * SIM_DT);
  const apart = dist(run(c0, T(cfg.clinchSeconds) + 50, i => [i < 30 ? tie : NONE, NONE]).s);
  check(`…and sends them apart to about clinchBreakDist (${apart.toFixed(2)} m)`, Math.abs(apart - cfg.clinchBreakDist) < 0.1);
  const cd = run(c0, T(cfg.clinchSeconds) + 150, (i, s) => [tie, inp({ move: { x: 0, y: s.fighters[1].clinch.active ? 0 : 1 } })]);
  check('the fighter who tied up cannot do it again inside clinchCooldown', of(cd.evs, 'clinch').length === 1);
  // The other man can shove his way out.
  const out = run(c0, 80, i => [i < 30 ? tie : NONE, inp({ block: i >= 30 && i < 40, move: flick(0, 1, 30)(i) })]);
  check('the other man pushes off out of it', first(out.evs, 'clinchBreak')?.reason === 'pushOff' && first(out.evs, 'clinchBreak').tick < ev.tick + T(cfg.clinchSeconds) - 10);
  // A clean shot during the reach breaks the attempt.
  // (An uppercut splits the grabbing man's guard — it LANDS. A long reach so the uppercut arrives inside it.)
  const slowGrab = { ...cfg, clinchReach: 0.5 };
  // (Pressed once the grabbing man is down: an uppercut is aimed at where the chin is at the press.)
  const upper = run(fresh(slowGrab, 0.6, 10), 70, i => [tie, inp({ uppercut: i === 10, move: { x: i === 10 ? 1 : 0, y: 0 } })], slowGrab);
  const land = first(upper.evs, 'punchLand'), tied2 = first(upper.evs, 'clinch');
  check(`a shot that gets through during the reach resets the grab (landed tick ${land?.tick}; tied up at ${tied2?.tick}, not ${T(0.5)})`, land && land.side === 1 && land.through === true && (tied2 === undefined || tied2.tick >= land.tick + T(0.5) - 1));
  // A hurt fighter clears his head faster tied up.
  const hurt = () => { const s = fresh(cfg, 0.65, 10); const f = s.fighters[0]; f.hurt = 2; f.hurtMax = 2; f.hurtKind = 'head'; return s; };
  const tied = run(hurt(), 60, () => [tie, NONE]).s.fighters[0].hurt, loose = run(hurt(), 60, () => [inp({ block: true }), NONE]).s.fighters[0].hurt;
  check(`a hurt fighter clears his head faster in the clinch (${tied.toFixed(2)} s left vs ${loose.toFixed(2)} s covering up)`, tied < loose - 0.5);
  check('clinchOn off: nothing', of(run(fresh({ ...cfg, clinchOn: false }, 0.65, 10), 60, () => [tie, NONE], { ...cfg, clinchOn: false }).evs, 'clinch').length === 0);
  check('out of clinchRange: nothing', of(run(fresh(cfg, 1.0, 10), 60, () => [tie, NONE]).evs, 'clinch').length === 0);
}

done();
