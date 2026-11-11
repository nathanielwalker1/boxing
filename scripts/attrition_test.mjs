/**
 * attrition_test.mjs — overhaul A6 / A7, the body as an investment and fatigue
 * (sim/resources.ts, footing.ts), in Node:
 *   - head and body damage are separate ledgers; a body shot takes less health
 *     now and much more wind
 *   - body damage lowers the stamina ceiling, slows the feet and brings the
 *     resting guard down, for the rest of the fight (it survives the stool)
 *   - fatigue: punches slow, hands drop, the bounce goes — as numbers on the state
 *   - the work-rate wear of missed punches comes partly back on the stool
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag } = k;
const MID = 0.79, LV = 10;
const quiet = { ...cfg, staminaRegen: 0, healthRegen: 0, bodyHurtOn: false };
const landOf = evs => evs.find(e => e.type === 'punchLand' && e.side === 0);
const head = c => run(fresh(c, MID, 20), 40, i => [inp({ cross: i === 0 }), NONE], c);
const body = c => run(fresh(c, MID, 20), LV + 40, i => [inp({ cross: i === LV, level: i <= LV }), NONE], c);

// ── 1. Two ledgers ──────────────────────────────────────────────────────────
console.log('\n=== 1. The ledgers ===');
{
  const h = head(quiet), b = body(quiet);
  const hl = landOf(h.evs), bl = landOf(b.evs);
  const hd = h.s.fighters[1], bd = b.s.fighters[1];
  check('a head shot goes on the head ledger, a body shot on the body ledger', hd.damage.head > 0 && hd.damage.body === 0 && bd.damage.body > 0 && bd.damage.head === 0);
  check('the ledger is the impulse × healthDamagePerImpulse for both (comparable)', near(hd.damage.head, mag(hl) * cfg.healthDamagePerImpulse, 1e-9) && near(bd.damage.body, mag(bl) * cfg.healthDamagePerImpulse, 1e-9));
  check(`a body shot takes bodyHealthScale of the health (${((1 - bd.health) / bd.damage.body).toFixed(2)})`, near((1 - bd.health) / bd.damage.body, cfg.bodyHealthScale, 1e-6) && near(1 - hd.health, hd.damage.head, 1e-9));
  const windH = (1 - hd.stamina) / mag(hl), windB = (1 - bd.stamina) / mag(bl);
  check(`…and staminaBodyHitMult times the wind (${(windB / windH).toFixed(2)}×)`, near(windB / windH, cfg.staminaBodyHitMult, 0.01));
  const off = body({ ...quiet, bodyDamageOn: false }).s.fighters[1];
  check('bodyDamageOn off: a body shot costs what a head shot does (the ledger is still kept)', near(1 - off.health, off.damage.body, 1e-9) && off.damage.body > 0);
}

// ── 2. What the investment buys ─────────────────────────────────────────────
console.log('\n=== 2. The investment ===');
{
  const worn = (frac, c = cfg) => { const s = fresh(c, 2.0, 5); s.fighters[1].damage.body = c.bodyWearFull * frac; return run(s, 40, () => [NONE, NONE], c).s; };
  const full = worn(1).fighters[1], half = worn(0.5).fighters[1], none = worn(0).fighters[1];
  check(`body wear lowers the stamina ceiling: ${none.staminaCap.toFixed(2)} → ${half.staminaCap.toFixed(2)} → ${full.staminaCap.toFixed(2)}`, none.staminaCap === 1 && near(half.staminaCap, 1 - cfg.bodyStaminaCapLoss / 2, 1e-9) && near(full.staminaCap, 1 - cfg.bodyStaminaCapLoss, 1e-9));
  const tired = worn(1); tired.fighters[1].stamina = 0.2;
  const rest = run(tired, T(4), () => [NONE, NONE]).s.fighters[1];
  check(`…and stamina only regenerates up to it (${rest.stamina.toFixed(2)})`, near(rest.stamina, full.staminaCap, 1e-9));
  const speed = st => { const r = run(st, 90, () => [NONE, inp({ move: { x: 0, y: 1 } })]); return Math.hypot(r.s.fighters[1].vel.x, r.s.fighters[1].vel.z); };
  check(`…the feet slow by bodyMoveLoss (${(speed(worn(1)) / speed(worn(0))).toFixed(2)} of fresh)`, near(speed(worn(1)) / speed(worn(0)), 1 - cfg.bodyMoveLoss, 0.02));
  check(`…and the resting guard comes down bodyGuardDroop (${full.guardDroop.toFixed(2)} m; lead glove ${(none.gloves[0].pos.y - full.gloves[0].pos.y).toFixed(2)} m lower)`, near(full.guardDroop, cfg.bodyGuardDroop, 1e-9) && none.gloves[0].pos.y - full.gloves[0].pos.y > cfg.bodyGuardDroop * 0.7);
  check('bodyWear reports it 0..1', near(sim.bodyWear(half, cfg), 0.5, 1e-9));
  // It survives the stool.
  const c2 = { ...cfg, roundSeconds: 10, betweenRoundSeconds: 3 };
  const s0 = fresh(c2, 2.0, 5); s0.fighters[1].damage.body = 0.3; s0.fighters[1].wear = 0.1;
  const next = run(s0, T(10 + 3) + 30, () => [NONE, NONE], c2).s;
  check('body damage is still there next round; the work-rate wear came back by wearRestore', next.round.index === 1 && next.fighters[1].damage.body === 0.3 && near(next.fighters[1].wear, 0.1 * (1 - cfg.wearRestore), 1e-9));
}

// ── 3. Fatigue ──────────────────────────────────────────────────────────────
console.log('\n=== 3. Fatigue ===');
{
  const at = (stamina, c = { ...cfg, staminaRegen: 0 }) => { const s = fresh(c, 2.0, 5); s.fighters[0].stamina = stamina; return run(s, 30, () => [NONE, NONE], c).s.fighters[0]; };
  const fine = at(0.8), half = at(cfg.fatigueFrom / 2), empty = at(0);
  check('above fatigueFrom: no fatigue', fine.fatigue === 0 && fine.punchSlow === 1 && fine.guardDroop === 0);
  check(`half-way down: fatigue 0.5, punches ${half.punchSlow.toFixed(3)}× slower, hands ${(half.guardDroop * 100).toFixed(1)} cm lower`, near(half.fatigue, 0.5, 1e-9) && near(half.punchSlow, 1 + (cfg.tiredPunchSlow - 1) / 2, 1e-9) && near(half.guardDroop, cfg.tiredGuardDroop / 2, 1e-9));
  check('empty: fatigue 1, tiredPunchSlow, tiredGuardDroop, and flat-footed (the bounce the rig draws is 1 − flat)', empty.fatigue === 1 && near(empty.punchSlow, cfg.tiredPunchSlow, 1e-9) && near(empty.guardDroop, cfg.tiredGuardDroop, 1e-9) && near(empty.flat, cfg.flatFatigue, 1e-9));
  check(`the hands really are lower (lead glove ${(fine.gloves[0].pos.y - empty.gloves[0].pos.y).toFixed(3)} m)`, fine.gloves[0].pos.y - empty.gloves[0].pos.y > cfg.tiredGuardDroop * 0.6);
  // A tired punch really takes longer.
  const dur = stamina => { const c = { ...cfg, staminaRegen: 0, lowStamina: 0 }; const s = fresh(c, 2.0, 5); s.fighters[0].stamina = stamina; let end = null; run(s, 80, i => [inp({ jab: i === 3 }), NONE], c, (st, i) => { if (end === null && i > 5 && st.fighters[0].punch.type === null) end = i; }); return end - 3; };
  check(`a gassed jab takes longer start to finish (${dur(0.04 + cfg.staminaPunchCost)} ticks vs ${dur(1)} fresh)`, dur(0.04 + cfg.staminaPunchCost) > dur(1) * 1.15);
  const off = at(0, { ...cfg, staminaRegen: 0, fatigueOn: false });
  check('fatigueOn off: none of it', off.fatigue === 0 && off.punchSlow === 1 && off.guardDroop === 0 && off.flat === 0);
  const noWhiff = { ...cfg, whiffCostOn: false, staminaRegen: 0 };
  const miss = run(fresh(noWhiff, 2.0, 5), 20, i => [inp({ jab: i === 0 }), NONE], noWhiff).s.fighters[0];
  check('whiffCostOn off: a miss costs the punch and nothing else', near(miss.stamina, 1 - cfg.staminaPunchCost, 1e-9) && miss.wear === 0);
  const many = run(fresh(cfg, 2.0, 5), 600, i => [inp({ jab: i % 30 === 0 }), NONE]).s.fighters[0];
  check(`twenty missed jabs wear the ceiling to ${many.staminaCap.toFixed(2)} — the round has an arc`, near(many.staminaCap, 1 - 20 * cfg.whiffCapLoss, 1e-6));
  // A jab never puts a man down by itself; a tired man's punches are arm punches.
  const nearly = c => { const s = fresh(c, MID, 20); s.fighters[1].health = 0.04; return run(s, 20, i => [inp({ jab: i === 0 }), NONE], c); };
  const j = nearly(quiet), j0 = nearly({ ...quiet, jabHealthFloor: 0 });
  check('a jab cannot take the bar under jabHealthFloor (or below where it already is): no knockdown', landOf(j.evs) && of(j.evs, 'knockdown').length === 0 && near(j.s.fighters[1].health, 0.04, 1e-9));
  check('…jabHealthFloor 0: it can', of(j0.evs, 'knockdown').length === 1);
  const cross = st => { const c = { ...cfg, staminaRegen: 0, lowStamina: 0 }; const s = fresh(c, MID, 20); s.fighters[0].stamina = st; return landOf(run(s, 40, i => [inp({ cross: i === 3 }), NONE], c).evs); };
  const tiredX = cross(cfg.staminaPunchCost), freshX = cross(1);
  check(`a gassed cross is an arm punch: ${tiredX?.grade}, ${(tiredX.power / freshX.power).toFixed(2)} of a fresh one`, tiredX.power < freshX.power * 0.55);
  const floor = fresh(cfg, 2.0, 5); floor.fighters[0].wear = 2;
  check('the ceiling never falls below staminaCapFloor', run(floor, 3).s.fighters[0].staminaCap === cfg.staminaCapFloor);
}

done();
