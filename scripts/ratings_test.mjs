/**
 * ratings_test.mjs — overhaul phase 2: each of the five ratings does something a
 * player notices, for either side (sim/ratings.ts). Every case is the same
 * fighter (the reference body, high guard) rated 90 against rated 40 on ONE
 * rating, everything else neutral, with the measured number in the check name.
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit({ rated: true });
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, flick, doubleTap, SIM_DT } = k;
const MID = 0.79;
const N = cfg.ratingNeutral;
const base = { ...k.specs[0], power: N, speed: N, chin: N, stamina: N, defense: N };   // pressure style → the high guard
const spec = o => ({ ...base, ...o });
/** A fight between two of `base` with side 0 (or side 1) overridden. */
const pair = (o0 = {}, o1 = {}) => [spec(o0), spec(o1)];
const start = (sp, d = MID, c = cfg, settle = 20) => fresh(c, d, settle, 0, 1, sp);
const landOf = (evs, side = 0) => evs.find(e => e.type === 'punchLand' && e.side === side);
const x = r => Math.max(-1, Math.min(1, (r - N) / cfg.ratingRange));

// ── Power ───────────────────────────────────────────────────────────────────
console.log('\n=== Power ===');
{
  const cross = o => mag(landOf(run(start(pair(o)), 30, i => [inp({ cross: i === 0 }), NONE]).evs));
  const hi = cross({ power: 90 }), lo = cross({ power: 40 }), mid = cross({});
  check(`the same cross: power 90 lands ${hi.toFixed(0)} N·s, power 40 ${lo.toFixed(0)} (neutral ${mid.toFixed(0)})`, near(hi / mid, 1 + cfg.ratingPowerImpulse * x(90), 1e-6) && near(lo / mid, 1 + cfg.ratingPowerImpulse * x(40), 1e-6) && hi > lo * 1.35);
  const off = { ...cfg, ratingsOn: false };
  const unrated = mag(landOf(run(start(pair({ power: 90 }), MID, off), 30, i => [inp({ cross: i === 0 }), NONE], off).evs));
  check('neutral is exactly the un-rated sim; ratingsOn off = everybody neutral', near(mid, unrated, 1e-9));
  // It is the AI's fighter's too: side 1 rated, side 0 takes it.
  const taken = o => mag(landOf(run(start(pair({}, o)), 30, i => [NONE, inp({ cross: i === 0 })]).evs, 1));
  check('side 1 is rated the same way', near(taken({ power: 90 }) / taken({ power: 40 }), hi / lo, 1e-6));
  // Felt: a power-90 hook rocks a fresh neutral man; a power-40 one does not.
  const hook = o => run(start(pair(o), 0.72), 40, i => [inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } }), NONE]).evs;
  check('power 90: a standing hook rocks a fresh neutral chin; power 40: it does not', hook({ power: 90 }).some(e => e.type === 'rocked') && !hook({ power: 40 }).some(e => e.type === 'rocked'));
}

// ── Speed ───────────────────────────────────────────────────────────────────
console.log('\n=== Speed ===');
{
  const cross = o => { let end = null; const r = run(start(pair(o), 2.0), 80, i => [inp({ cross: i === 0 }), NONE], cfg, (s, i) => { if (end === null && i > 2 && s.fighters[0].punch.type === null) end = i; }); return { tell: first(r.evs, 'punchStart').tell, total: end * SIM_DT }; };
  const hi = cross({ speed: 90 }), lo = cross({ speed: 40 });
  check(`press to contact of a cross: speed 90 ${(hi.tell * 1000).toFixed(0)} ms, speed 40 ${(lo.tell * 1000).toFixed(0)} ms`, hi.tell < lo.tell - 0.04 && near(hi.tell, Math.max(cfg.tellMinHeavy, cfg.crossCock / (1 + cfg.ratingSpeedHands * x(90)) + cfg.crossExtend), 1e-9));
  check(`…and the whole punch (a miss, start to home): ${(hi.total * 1000).toFixed(0)} ms vs ${(lo.total * 1000).toFixed(0)} ms`, hi.total < lo.total - 0.1);
  check('even at speed 100 a lone heavy punch keeps its tell (tellMinHeavy)', cross({ speed: 100 }).tell >= cfg.tellMinHeavy - 1e-9);
  const top = o => { const r = run(start(pair(o), 2.0), 90, () => [inp({ move: { x: 1, y: 0 } }), NONE]); return Math.hypot(r.s.fighters[0].vel.x, r.s.fighters[0].vel.z); };
  check(`circling speed: ${top({ speed: 90 }).toFixed(2)} m/s vs ${top({ speed: 40 }).toFixed(2)} m/s`, near(top({ speed: 90 }) / top({ speed: 40 }), (1 + cfg.ratingSpeedFeet * x(90)) / (1 + cfg.ratingSpeedFeet * x(40)), 0.01));
  const hop = o => { const s0 = start(pair(o), 2.0); const r = run(s0, 40, i => [inp({ move: doubleTap(0, -1)(i) }), NONE]); return s0.fighters[0].pos.x - r.s.fighters[0].pos.x; };
  check(`a burst back: ${hop({ speed: 90 }).toFixed(2)} m vs ${hop({ speed: 40 }).toFixed(2)} m`, hop({ speed: 90 }) > hop({ speed: 40 }) + 0.06);
}

// ── Stamina ─────────────────────────────────────────────────────────────────
console.log('\n=== Stamina ===');
{
  const noRegen = { ...cfg, staminaRegen: 0 };
  const after = o => run(start(pair(o), 2.0, noRegen), 300, i => [inp({ jab: i % 30 === 0 }), NONE], noRegen).s.fighters[0].stamina;
  const hi = after({ stamina: 90 }), lo = after({ stamina: 40 });
  check(`ten missed jabs: stamina 90 has ${(hi * 100).toFixed(0)}% left, stamina 40 has ${(lo * 100).toFixed(0)}%`, hi > lo + 0.12);   // (polish phase, item 6, deliberate: a missed jab costs half what it did, so the gap between the two is 18 points, not 30+)
  const regen = o => { const s = start(pair(o), 2.0); s.fighters[0].stamina = 0.2; return run(s, 60, () => [NONE, NONE]).s.fighters[0].stamina - 0.2; };
  check(`a second of rest gives back ${(regen({ stamina: 90 }) * 100).toFixed(0)}% vs ${(regen({ stamina: 40 }) * 100).toFixed(0)}%`, near(regen({ stamina: 90 }) / regen({ stamina: 40 }), (1 + cfg.ratingStaminaRegen * x(90)) / (1 + cfg.ratingStaminaRegen * x(40)), 0.02));
  const tired = o => { const s = start(pair(o), 2.0, noRegen); s.fighters[0].stamina = 0.5; return run(s, 5, () => [NONE, NONE], noRegen).s.fighters[0]; };
  const th = tired({ stamina: 90 }), tl = tired({ stamina: 40 });
  check(`at half a bar: stamina 90 is not tired yet (fatigue ${th.fatigue.toFixed(2)}, hands ${(th.guardDroop * 100).toFixed(1)} cm down), stamina 40 is (${tl.fatigue.toFixed(2)}, ${(tl.guardDroop * 100).toFixed(1)} cm)`, th.fatigue < tl.fatigue - 0.15 && tl.punchSlow > th.punchSlow);
  const guard = o => 1 - run(start(pair(o), 2.0, noRegen), 120, () => [inp({ block: true }), NONE], noRegen).s.fighters[0].stamina;
  check(`two seconds of holding the guard costs ${(guard({ stamina: 90 }) * 100).toFixed(0)}% vs ${(guard({ stamina: 40 }) * 100).toFixed(0)}%`, guard({ stamina: 90 }) < guard({ stamina: 40 }) * 0.75);
}

// ── Defense ─────────────────────────────────────────────────────────────────
console.log('\n=== Defense ===');
{
  const quiet = { ...cfg, staminaBlockDrain: 0, staminaRegen: 0, healthRegen: 0 };
  const blocked = o => { const r = run(start(pair({}, o), MID, quiet), 40, i => [inp({ cross: i === 0 }), inp({ block: true })], quiet); return { ev: first(r.evs, 'punchBlock'), d: r.s.fighters[1] }; };
  const hi = blocked({ defense: 90 }), lo = blocked({ defense: 40 });
  check(`a cross on the guard: defense 90 keeps ${(hi.ev.guard * 100).toFixed(0)}% of the meter, defense 40 keeps ${(lo.ev.guard * 100).toFixed(0)}%`, hi.ev.guard > lo.ev.guard + 0.08);
  check(`…is held ${(hi.ev.stun * 1000).toFixed(0)} ms vs ${(lo.ev.stun * 1000).toFixed(0)} ms`, hi.ev.stun < lo.ev.stun * 0.75);
  check(`…and chipped ${(hi.ev.chip * 100).toFixed(1)}% vs ${(lo.ev.chip * 100).toFixed(1)}% of the bar`, hi.ev.chip < lo.ev.chip * 0.8);
  const window = o => { let n = 0; run(start(pair(o), 2.0), 60, i => [inp({ move: flick(1, 0)(i) }), NONE], cfg, s => { if (s.fighters[0].slip.active) n++; }); return n; };
  check(`the slip keeps the head off the line ${window({ defense: 90 })} ticks vs ${window({ defense: 40 })} ticks`, window({ defense: 90 }) >= window({ defense: 40 }) + 4);
}

// ── Chin ────────────────────────────────────────────────────────────────────
console.log('\n=== Chin ===');
{
  const f = o => start(pair(o), 2.0).fighters[0];
  const hi = f({ chin: 90 }), lo = f({ chin: 40 });
  check(`the rock threshold: chin 90 ${sim.stunThreshold(hi, cfg).toFixed(0)} N·s, chin 40 ${sim.stunThreshold(lo, cfg).toFixed(0)} N·s (as before)`, sim.stunThreshold(hi, cfg) > sim.stunThreshold(lo, cfg) * 1.25);
  check(`the body threshold: chin 90 ${sim.bodyThreshold(hi, cfg).toFixed(0)} N·s, chin 40 ${sim.bodyThreshold(lo, cfg).toFixed(0)} N·s`, near(sim.bodyThreshold(hi, cfg) / sim.bodyThreshold(lo, cfg), (1 + cfg.ratingChinBody * x(90)) / (1 + cfg.ratingChinBody * x(40)), 1e-6));
  // Felt: the cross that rocks a chin-40 man at 60% health does not rock a chin-90 one.
  const rock = o => { const s = start(pair({}, o)); s.fighters[1].health = 0.3; return run(s, 30, i => [inp({ cross: i === 0 }), NONE]).evs.some(e => e.type === 'rocked'); };
  check('a standing cross on a man at 30% health rocks chin 40 and not chin 90', rock({ chin: 40 }) && !rock({ chin: 90 }));
}

done();
