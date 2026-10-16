/**
 * health_test.mjs — health, stamina, the gassed telegraph and the knockdown
 * (port of legacy health_test, in Node against the sim).
 *   - throwing costs stamina; holding the guard drains it; idling regains it
 *   - a landed hit costs health and stamina off the same post-block impulse,
 *     pauses regen, and a blocked hit costs less; clamps at 0
 *   - one worst-case hit cannot gas a fresh fighter (no spiral)
 *   - gassed: the cock phase stretches lowStaminaCockMult×, nothing else does
 *   - knockdown: count phase freezes both, the downed fighter cannot be hit,
 *     get-up restores part of the bar, TKO at knockdownsForTko
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, v3len } = core;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79, FAR = 1.5;
const ticks = s => Math.round(s / SIM_DT);

function fresh(c = cfg, dist = MID) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
function run(s, n, inputs = () => [NONE, NONE], c = cfg, onTick) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), c); s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (onTick?.(s, i, r.events) === true) break;
  }
  return { s, evs };
}
const first = (evs, type) => evs.find(e => e.type === type);

// ── 1. Stamina economy ──────────────────────────────────────────────────────
console.log('\n=== 1. Stamina economy ===');
{
  const { s } = run(fresh(cfg, FAR), 1, () => [inp({ jab: true }), NONE]);
  check('throwing costs staminaPunchCost on the start tick', near(s.fighters[0].stamina, 1 - cfg.staminaPunchCost, 1e-9), `${s.fighters[0].stamina}`);
  const { s: mid } = run(s, 6);   // still in the jab (~14 ticks)
  const { s: s2 } = run(mid, 40);
  check('…and regen does not run while the punch is in flight, only after', mid.fighters[0].punch.type !== null && near(mid.fighters[0].stamina, s.fighters[0].stamina, 1e-12) && s2.fighters[0].stamina > s.fighters[0].stamina, `${mid.fighters[0].stamina.toFixed(3)} in flight, ${s2.fighters[0].stamina.toFixed(3)} after`);
}
{
  const { s } = run(fresh(cfg, FAR), 60, () => [inp({ block: true }), NONE]);
  check('holding the block drains staminaBlockDrain per second', near(s.fighters[0].stamina, 1 - cfg.staminaBlockDrain, 1e-9), `${s.fighters[0].stamina.toFixed(4)} after 1 s`);
  const { s: s2 } = run(s, 30);
  check('releasing it regains staminaRegen per second', near(s2.fighters[0].stamina, Math.min(1, s.fighters[0].stamina + cfg.staminaRegen * 0.5), 1e-9), `${s2.fighters[0].stamina.toFixed(4)}`);
  const long = run(fresh(cfg, FAR), ticks(1 / cfg.staminaBlockDrain + 1), () => [inp({ block: true }), NONE]).s;
  check('the guard cannot be held forever: the bar empties and clamps at 0', long.fighters[0].stamina === 0);
}

// ── 1b. Health regenerates, up to a cap (2026-09-16) ────────────────────────
console.log('\n=== 1b. Health regen and the cap ===');
{
  const { s: hit, evs } = run(fresh(), 40, i => [inp({ jab: i === 0 }), NONE]);
  const land = first(evs, 'punchLand');
  const dmg = 1 - hit.fighters[1].health;
  check('a landed jab lowers the cap by healthCapLoss of its damage', land && near(sim.healthCap(hit.fighters[1]), 1 - dmg * cfg.healthCapLoss, 1e-9), `cap ${sim.healthCap(hit.fighters[1]).toFixed(4)} after ${dmg.toFixed(4)} damage`);
  const { s: paused } = run(hit, ticks(cfg.healthRegenDelay) - 45);   // the jab landed ~tick 7 of the 40: still inside the delay
  check('no regen inside healthRegenDelay after the hit', near(paused.fighters[1].health, hit.fighters[1].health, 1e-9), `${paused.fighters[1].health.toFixed(4)}`);
  const { s: expired } = run(paused, 50);
  const { s: later } = run(expired, ticks(1));
  check('…then it comes back at healthRegen per second', near(later.fighters[1].health, Math.min(sim.healthCap(later.fighters[1]), expired.fighters[1].health + cfg.healthRegen), 0.002), `${expired.fighters[1].health.toFixed(4)} → ${later.fighters[1].health.toFixed(4)} in 1 s`);
  const { s: full } = run(later, ticks(60));
  check('…but never past the cap', near(full.fighters[1].health, sim.healthCap(full.fighters[1]), 1e-9) && full.fighters[1].health < 1, `${full.fighters[1].health.toFixed(4)} vs cap ${sim.healthCap(full.fighters[1]).toFixed(4)}`);
  const none = { ...cfg, healthRegen: 0 };
  const { s: flat } = run(fresh(none), ticks(5), i => [inp({ jab: i === 0 }), NONE], none);
  check('healthRegen 0 = the old bar (nothing comes back)', flat.fighters[1].health < 1 && near(flat.fighters[1].health, 1 - dmg, 1e-6), `${flat.fighters[1].health.toFixed(4)}`);
  const allBack = { ...cfg, healthCapLoss: 0 };
  const { s: ab } = run(fresh(allBack), ticks(5), i => [inp({ jab: i === 0 }), NONE], allBack);
  check('healthCapLoss 0 leaves the cap at 1', near(sim.healthCap(ab.fighters[1]), 1, 1e-9));
}

// ── 2. Getting hit: health + chip off the same impulse ──────────────────────
console.log('\n=== 2. Getting hit ===');
{
  const clean = run(fresh(), 40, i => [inp({ jab: i === 0 }), NONE]);
  const land = first(clean.evs, 'punchLand');
  const mag = v3len(land.impulse);
  const d = clean.s.fighters[1];
  check('a landed jab costs the target health = impulse × healthDamagePerImpulse', land && near(d.health, 1 - mag * cfg.healthDamagePerImpulse, 1e-9), `impulse ${mag.toFixed(1)} N·s → health ${d.health.toFixed(4)}`);
  // Regen is paused after the hit, so the chip reads exactly until the delay lapses (the punch lands ~8 ticks in; 40 ticks total < 0.6 s + 8).
  check('…and stamina = impulse × staminaHitCost (a chip, not a flat number)', near(d.stamina, 1 - mag * cfg.staminaHitCost, 1e-9), `stamina ${d.stamina.toFixed(4)}`);

  const b0 = fresh();
  const blocked = run(b0, 40, i => [inp({ jab: i === 0 }), inp({ block: true })]);
  const hb = first(blocked.evs, 'hurt'), db = blocked.s.fighters[1];
  check('a blocked hit costs less health — blockReduction already cut the impulse', hb && 1 - db.health < 1 - d.health && near(1 - db.health, v3len(hb.impulse) * cfg.healthDamagePerImpulse, 1e-9), `${(1 - db.health).toFixed(4)} vs ${(1 - d.health).toFixed(4)}`);
  const guardDrain = cfg.staminaBlockDrain * (blocked.s.time - b0.time);   // game time: hit-stop slows the clock
  check('…and less stamina (chip × staminaBlockedHitMult, plus the guard\'s own drain)', near(1 - db.stamina, v3len(hb.impulse) * cfg.staminaHitCost * cfg.staminaBlockedHitMult + guardDrain, 1e-6), `${(1 - db.stamina).toFixed(4)}`);

  // Regen pause: sample every tick after the land.
  let landTick = null, rose = false, peak = 0;
  const { s: after } = run(fresh(), ticks(1.5), i => [inp({ jab: i === 0 }), NONE], cfg, (st, i, ev) => {
    if (landTick === null && ev.some(e => e.type === 'punchLand')) { landTick = i; peak = st.fighters[1].stamina; return; }
    if (landTick !== null && i <= landTick + ticks(cfg.staminaRegenDelay) - 1 && st.fighters[1].stamina > peak + 1e-12) rose = true;
  });
  check('regen is paused for staminaRegenDelay after a hit, then resumes', !rose && after.fighters[1].stamina > peak + 0.03, `held at ${peak.toFixed(4)}, then ${after.fighters[1].stamina.toFixed(4)} at 1.5 s`);

  const zero = fresh(); zero.fighters[1].stamina = 0;
  const { s: z } = run(zero, 40, i => [inp({ jab: i === 0 }), NONE]);
  check('getting hit at 0 stamina clamps rather than going negative', z.fighters[1].stamina === 0);

  // No spiral: the heaviest hit in the build vs the headroom above the gassed line.
  const worst = (cfg.punchImpulseBase + ROSTER[0].massKg * cfg.moveSpeed * cfg.punchMomentumScale) * (1 + cfg.punchLeanScale) * cfg.uppercutImpulseMult;
  const chip = worst * cfg.staminaHitCost, gap = 1 - cfg.lowStamina;
  check('one worst-case hit cannot push a fresh fighter into the gassed telegraph', chip < gap / 4, `chip ${chip.toFixed(3)} vs ${gap} of headroom (${(gap / chip).toFixed(1)} such hits needed)`);
}

// ── 3. Gassed: the wind-up telegraphs ───────────────────────────────────────
console.log('\n=== 3. Gassed telegraph ===');
{
  const peakTick = s0 => { const { evs } = run(s0, 90, i => [inp({ jab: i === 0 }), NONE]); return { peak: first(evs, 'punchWhiff')?.tick, evs }; };
  const normal = peakTick(fresh(cfg, FAR));
  const gs = fresh(cfg, FAR); gs.fighters[0].stamina = cfg.lowStamina - 0.05;
  const gassed = peakTick(gs);
  const extraCock = (cfg.lowStaminaCockMult - 1) * cfg.jabCock / SIM_DT;
  check('a gassed jab reaches its peak later by (mult − 1) × cock', Math.abs((gassed.peak - normal.peak) - extraCock) <= 1, `peak tick ${normal.peak} → ${gassed.peak} (expected +${extraCock.toFixed(1)})`);
  // Extend + recover are untouched: the time from peak to punch end is the same.
  const endTick = s0 => { let end = null; run(s0, 120, i => [inp({ jab: i === 0 }), NONE], cfg, (st, i) => { if (end === null && i > 2 && st.fighters[0].punch.type === null) { end = i; return true; } }); return end; };
  const gs2 = fresh(cfg, FAR); gs2.fighters[0].stamina = cfg.lowStamina - 0.05;
  const en = endTick(fresh(cfg, FAR)), eg = endTick(gs2);
  check('…but the strike and recovery are not slowed', Math.abs((eg - gassed.peak) - (en - normal.peak)) <= 1, `peak→end ${en - normal.peak} vs ${eg - gassed.peak} ticks`);
  const fresh1 = fresh(cfg, FAR); fresh1.fighters[0].stamina = cfg.lowStamina + 0.01;
  check('just above the line is not gassed', peakTick(fresh1).peak === normal.peak);
}

// ── 4. Knockdown ────────────────────────────────────────────────────────────
console.log('\n=== 4. Knockdown ===');
{
  const heavy = { ...cfg, healthDamagePerImpulse: 1 };   // one landed jab floors the dummy
  const clockBefore = fresh(heavy).round.clock;
  const { s, evs } = run(fresh(heavy), 12, i => [inp({ jab: i === 0 }), NONE], heavy);
  const kd = first(evs, 'knockdown');
  const d = s.fighters[1];
  check('a hit that empties the bar → knockdown event, fighter down, guard "down"', kd?.side === 1 && kd.count === 1 && d.down && d.guard === 'down' && d.health === 0 && d.knockdowns === 1);
  check('the round enters the count', s.round.phase === 'count');

  // During the count: inputs are ignored, the downed fighter cannot be hit, the clock holds.
  const during = run(s, 30, i => [inp({ jab: i === 0, move: { x: 0, y: 1 } }), inp({ block: true })], heavy);
  check('during the count nobody punches, moves or blocks', !during.evs.some(e => e.type === 'punchStart') && during.s.fighters[0].punch.type === null && !during.s.fighters[1].block && near(during.s.fighters[0].pos.x, s.fighters[0].pos.x, 1e-9));
  // 2026-10-15 (Nate): the clock keeps running through the count.
  check('…and the clock keeps running', during.s.round.clock < s.round.clock && during.s.round.clock < clockBefore, `${s.round.clock} → ${during.s.round.clock}`);

  // The get-up count is rolled from the chin (fight_test covers the roll); here just wait out the longest possible count.
  const up = run(during.s, ticks(10 * heavy.countTickSeconds) + 2, () => [NONE, NONE], heavy);
  const gu = first(up.evs, 'getUp');
  const f1 = up.s.fighters[1];
  check('they beat the count: getUp, standing, health restored to knockdownHealthRestore', gu?.side === 1 && !f1.down && f1.guard === 'rest' && near(f1.health, heavy.knockdownHealthRestore, 1e-9) && f1.knockdowns === 1, `health ${f1.health}`);
  check('…and the fight resumes', up.s.round.phase === 'fighting');
  const again = run(up.s, 40, i => [inp({ jab: i === 0 }), NONE], heavy);
  check('the fighter can be hit again once up', again.evs.some(e => e.type === 'punchLand'));

  // TKO.
  const t = fresh(heavy); t.fighters[1].knockdowns = heavy.knockdownsForTko - 1;
  const tko = run(t, 12, i => [inp({ jab: i === 0 }), NONE], heavy);
  const te = first(tko.evs, 'tko');
  check('knockdownsForTko knockdowns in the round → tko for the other side, round over', te?.winner === 0 && tko.s.round.phase === 'over' && first(tko.evs, 'knockdown')?.count === heavy.knockdownsForTko);

  // Both sides: the AI side's punch floors the player the same way.
  const mirror = run(fresh(heavy), 12, i => [NONE, inp({ jab: i === 0 })], heavy);
  check('symmetric: side 1 can floor side 0', first(mirror.evs, 'knockdown')?.side === 0 && mirror.s.fighters[0].down);
}

done();
