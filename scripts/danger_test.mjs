/**
 * danger_test.mjs — overhaul A5 / A6, the hurt states beyond ROCKED (sim/stun.ts,
 * resources.ts), in Node:
 *   - WINDED: the body threshold (investment lowers it), what the winded state does
 *   - THE LIVER: the fuse, the delayed buckle, the knockdown
 *   - COUNTER FLASH: a counter needs less to floor a man
 *   - SURVIVING: moving clears the head faster (the clinch is in level_test)
 *   - THE GET-UP: down → stir → knee → (slump → knee) → rise, the KO that tries and fails
 * (stun_test.mjs still pins ROCKED itself.)
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
// (Polish phase, item 3, deliberate: hurtRatesOn / hurtVarietyOn off — this file pins the danger numbers as designed (the liver drop, the
// counter flash, the get-up struggle); the polish phase scales the rates and adds kinds of hurt and of knockdown, pinned in hurt_test.
// Set on the kit's own config object so every helper default sees it.)
k.cfg.hurtRatesOn = false; k.cfg.hurtVarietyOn = false;
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, flick, SIM_DT } = k;
const MID = 0.79;
const soft = { ...cfg, healthDamagePerImpulse: 0.00002, healthRegen: 0 };   // the bar never empties by itself here
const LV = 10;
/** Side 0 throws a body punch (level held for LV ticks, then the press). x = stick for the hand. */
const bodyShot = (type, c, d = MID, x = 0, prep, n = 70) => { let s = fresh(c, d, 20); if (prep) prep(s); return run(s, LV + n, i => [inp({ [type]: i === LV, level: i <= LV, move: { x: i === LV ? x : 0, y: 0 } }), NONE], c); };
const landOf = evs => evs.find(e => e.type === 'punchLand' && e.side === 0);

// ── 1. The body threshold ───────────────────────────────────────────────────
console.log('\n=== 1. The body threshold ===');
{
  const d = fresh(soft, MID, 20).fighters[1];
  check(`fresh: bodyHurtBase (${sim.bodyThreshold(d, soft).toFixed(0)} N·s)`, near(sim.bodyThreshold(d, soft), soft.bodyHurtBase, 1e-6));
  check('a worn body carries bodyHurtWornFloor of it', near(sim.bodyThreshold({ ...d, damage: { head: 0, body: soft.bodyWearFull, liver: 0 } }, soft), soft.bodyHurtBase * soft.bodyHurtWornFloor, 1e-6));
  check('no wind left lowers it to the stamina floor', near(sim.bodyThreshold({ ...d, stamina: 0 }, soft), soft.bodyHurtBase * soft.stunStaminaFloor, 1e-6));
}

// ── 2. Winded ───────────────────────────────────────────────────────────────
console.log('\n=== 2. Winded ===');
{
  const r0 = bodyShot('cross', soft);
  check(`a standing body cross (${mag(landOf(r0.evs)).toFixed(0)} N·s) does not wind a fresh man`, landOf(r0.evs)?.part === 'body' && of(r0.evs, 'bodyHurt').length === 0);
  // The same cross after the investment: his body is worn, the threshold is down.
  const worn = bodyShot('cross', soft, MID, 0, s => { s.fighters[1].damage.body = soft.bodyWearFull; }, 20);
  const bh = first(worn.evs, 'bodyHurt');
  check(`…the same cross on a worn body does (threshold ${(soft.bodyHurtBase * soft.bodyHurtWornFloor).toFixed(0)}): winded for bodyHurtSeconds`, bh && bh.side === 1 && bh.by === 0 && bh.liver === false && near(bh.seconds, soft.bodyHurtSeconds, 1e-9));
  const big = { ...soft, crossImpulseMult: 2.4 };
  const r = bodyShot('cross', big, MID, 0, null, 34);   // (long enough to be past the land's hit-stop and folded)
  check('a big enough body shot winds a fresh one', first(r.evs, 'bodyHurt') !== undefined && of(r.evs, 'rocked').length === 0);
  const d = r.s.fighters[1], f0 = fresh(big, MID, 20).fighters[1];
  check(`winded: hurtKind body, the body buckles (buckle ${d.buckle.toFixed(2)}, head ${(f0.headBox.y - d.headBox.y).toFixed(2)} m lower)`, d.hurtKind === 'body' && d.hurt > 0 && d.buckle === 1 && f0.headBox.y - d.headBox.y > big.buckleDrop * 0.8);
  check(`…the hands come down (guardDroop ${d.guardDroop.toFixed(2)} m; lead glove ${(f0.gloves[0].pos.y - d.gloves[0].pos.y).toFixed(2)} m lower)`, d.guardDroop >= big.bodyHurtGuardDrop - 1e-9 && f0.gloves[0].pos.y - d.gloves[0].pos.y > 0.2);
  check(`…exposure is held at bodyHurtVuln (${d.vuln.toFixed(2)})`, near(d.vuln, big.bodyHurtVuln, 1e-9));
  const place = s => { s.fighters[1].stagger = { x: 0, z: 0 }; return s; };
  const walk = st => { const w = run(place(st), 25, () => [NONE, inp({ move: { x: 1, y: 0 } })], big); return Math.hypot(w.s.fighters[1].vel.x, w.s.fighters[1].vel.z); };
  const vW = walk(r.s), vF = walk(fresh(big, MID, 20));
  check(`…the feet are slow (${(vW / vF).toFixed(2)} of normal)`, vW < vF * (big.bodyHurtMoveScale + 0.12));
  const lock = run(r.s, 90, i => [NONE, inp({ jab: i % 2 === 0 })], big);
  const st = lock.evs.find(e => e.type === 'punchStart' && e.side === 1);
  // (Polish phase, deliberate: with hitNerfOn the lock is hurtPunchLockScale as long, and the punch that follows is nerfed.)
  const lockS = big.bodyHurtPunchLock * (big.hitNerfOn ? big.hurtPunchLockScale : 1);
  check(`…and no punch starts for the winded punch lock (${lockS.toFixed(2)} s), and the first one is nerfed`, st && st.tick * SIM_DT >= lockS - (big.bodyHurtSeconds - r.s.fighters[1].hurt) - 2 * SIM_DT && st.nerf >= big.hitNerfHurt - 1e-9, `start @${st?.tick}, nerf ${st?.nerf}`);
  const clear = run(r.s, T(big.bodyHurtSeconds) + 30, () => [NONE, NONE], big).s.fighters[1];
  check('it clears: hurtKind none, upright again', clear.hurt === 0 && clear.hurtKind === 'none' && clear.buckle === 0 && clear.guardDroop < 0.01);
  // The cheap finish is the head's: a modest head shot on a winded man is not a knockdown.
  const weak = { ...big, crossImpulseMult: 0.9 };
  const fin = run(place({ ...r.s, fighters: [r.s.fighters[0], { ...r.s.fighters[1], pos: { x: r.s.fighters[0].pos.x + MID, z: r.s.fighters[0].pos.z } }] }), 40, i => [inp({ cross: i === 0 }), NONE], weak);
  check('a head shot on a WINDED man does not get the rocked man\'s cheap finish', fin.evs.some(e => e.type === 'punchLand' && e.part === 'head') && of(fin.evs, 'knockdown').length === 0);
  check('bodyHurtOn off: the body is never winded', of(bodyShot('cross', { ...big, bodyHurtOn: false }, MID, 0, null, 20).evs, 'bodyHurt').length === 0);
}

// ── 3. The liver ────────────────────────────────────────────────────────────
console.log('\n=== 3. The liver ===');
{
  const D = 0.72;
  // Phase 2 (liverMinImpulse 430, was 330): a routine standing body hook (~390 N·s) lands on the liver side but does
  // not light the fuse; one with something behind it does. This section's hook hits 20% harder than a standing one.
  const routine = bodyShot('hook', soft, D, -1);
  check(`a standing lead body hook (${mag(landOf(routine.evs)).toFixed(0)} N·s) is on the liver side but under liverMinImpulse: no fuse`, landOf(routine.evs)?.liver === true && of(routine.evs, 'liverShot').length === 0);
  const base0 = soft;
  // eslint-disable-next-line no-shadow
  const soft2 = { ...base0, hookImpulseMult: base0.hookImpulseMult * 1.2 };
  const lead = bodyShot('hook', soft2, D, -1), rear = bodyShot('hook', soft2, D, 1);
  const land = landOf(lead.evs), ls = first(lead.evs, 'liverShot');
  check(`a clean lead body hook with something behind it (${mag(land).toFixed(0)} N·s) is a liver shot: the fuse is lit`, land?.liver === true && ls && ls.side === 1 && ls.tick === land.tick && near(ls.delay, soft.liverDelay, 1e-9));
  check('the rear body hook is not', landOf(rear.evs)?.part === 'body' && of(rear.evs, 'liverShot').length === 0);
  const bh = first(lead.evs, 'bodyHurt');
  check(`nothing shows until the buckle, liverDelay later (${((bh?.tick - ls.tick) * SIM_DT).toFixed(2)} s, plus the land's hit-stop)`, bh && bh.liver === true && (bh.tick - ls.tick) * SIM_DT >= soft.liverDelay - SIM_DT && (bh.tick - ls.tick) * SIM_DT < soft.liverDelay + 0.2);
  let hurtBefore = 0;
  run(fresh(soft2, D, 20), LV + 70, i => [inp({ hook: i === LV, level: i <= LV, move: { x: i === LV ? -1 : 0, y: 0 } }), NONE], soft2, (s, i) => { if (i > ls.tick && i < bh.tick - 1) hurtBefore = Math.max(hurtBefore, s.fighters[1].hurt); });
  check('…he is not hurt in between', hurtBefore === 0);
  check(`the buckle: winded for liverSeconds (${bh.seconds.toFixed(1)} s) and liverStaminaLoss of wind gone`, near(bh.seconds, soft.liverSeconds, 1e-9) && lead.s.fighters[1].stamina < 1 - soft.liverStaminaLoss + 0.2);
  check('the liver has its own line in the damage ledger', lead.s.fighters[1].damage.liver > 0 && rear.s.fighters[1].damage.liver === 0);
  // (Phase 2: a body shot costs less wind — staminaBodyHitMult 2 → 1.2 — so the body threshold at the buckle is higher
  // than it was and the shot that drops him has to be bigger: ×4, was ×3.)
  const huge = { ...soft, hookImpulseMult: 4 };
  const drop = bodyShot('hook', huge, D, -1);
  const kd = first(drop.evs, 'knockdown');
  check(`a big liver shot puts him down when the buckle comes (cause ${kd?.cause})`, kd && kd.cause === 'body' && kd.side === 1 && kd.tick > first(drop.evs, 'liverShot').tick + 10);
  check('liverOn off: a body hook is a body hook', of(bodyShot('hook', { ...soft, liverOn: false }, D, -1).evs, 'liverShot').length === 0);
}

// ── 4. Counter flash ────────────────────────────────────────────────────────
console.log('\n=== 4. Counter flash ===');
{
  // The dummy (side 1) slips the player's jab and counters with the cross (counter_test §5's exchange).
  const exchange = c => {
    const L = first(run(fresh(c, MID, 30), 20, i => [inp({ jab: i === 0 }), NONE], c).evs, 'punchLand').tick;
    return run(fresh(c, MID, 30), 70, i => [inp({ jab: i === 0 }), inp({ cross: i === L + 3, move: flick(-1, 0)(i) })], c);
  };
  // skelOn false (anim Phase 1.1): on the rigid skeleton this counter brushes the attacker's rear guard glove and grades clean, not flush, so it does not rock (LOG_SKELETON.md, behavioural shifts).
  const c0 = { ...cfg, skelOn: false };
  const base = exchange(c0);
  check('a slip-counter cross ROCKS a fresh man but does not floor him', base.evs.some(e => e.type === 'counter') && base.evs.some(e => e.type === 'rocked' && e.side === 0) && of(base.evs, 'knockdown').length === 0);
  // (Phase 3: stunFlashFrac 1.85 → 3.2 and a hit costs less wind, so the scale that makes this cross a flash is 0.4, was 0.7.)
  const eager = { ...c0, counterFlashScale: 0.4 };
  const fl = exchange(eager), flOff = exchange({ ...eager, counterFlashOn: false });
  check('with the counter flash threshold lower (counterFlashScale 0.4) the same counter floors him: cause flash', first(fl.evs, 'knockdown')?.cause === 'flash' && first(fl.evs, 'knockdown').side === 0);
  check('…and with counterFlashOn off it is back to a rock', of(flOff.evs, 'knockdown').length === 0 && flOff.evs.some(e => e.type === 'rocked'));
}

// ── 4b. The loaded counter (phase 3) ────────────────────────────────────────
// The biggest single shot in the game: blue jabs at 0.79 m, red slips to the lead side and throws the lead hook —
// a counter, flush, off the loaded hand. The game as shipped (ratings and guard shapes on).
console.log('\n=== 4b. The loaded counter ===');
{
  const r = await kit({ rated: true });
  r.cfg.hurtRatesOn = false; r.cfg.hurtVarietyOn = false;   // (as at the top of the file)
  // skelPoleTwist 1 (anim Phase 1.1b): with the hook's elbow out where a shoulder can put it (0.5, the default) this slip-counter lead hook whiffs; LOG_SKELETON.md, behavioural shifts.
  r.cfg.skelPoleTwist = 1;
  const c = r.cfg;
  const len = v => Math.hypot(v.x, v.y, v.z);
  const GAP = 3;
  const counter = (prep = () => {}) => {
    const s = r.fresh(c, MID, 20); prep(s.fighters[0], s.fighters[1]);
    let hurtAtLand = 0;
    const out = r.run(s, 80, i => [r.inp({ move: { x: (i >= 2 && i < 4) || i === 4 + GAP ? -1 : 0, y: 0 }, hook: i === 4 + GAP }), r.inp({ jab: i === 0 })], c,
      (st, i, ev) => { if (ev.some(e => e.type === 'punchLand' && e.side === 0)) hurtAtLand = st.fighters[1].hurt; });
    const land = out.evs.find(e => e.type === 'punchLand' && e.side === 0), kd = out.evs.find(e => e.type === 'knockdown' && e.side === 1);
    return { ...out, land, kd, rocked: out.evs.find(e => e.type === 'rocked' && e.side === 1), hurtAtLand, mag: land ? len(land.impulse) : 0 };
  };
  const fr = counter();
  check(`it is a flush, loaded counter (${fr.land?.grade}, counter ${fr.land?.counter}, ${fr.mag.toFixed(0)} N·s)`, fr.land?.grade === 'flush' && fr.land.counter === true && fr.mag > 900);
  check(`a FRESH, average-chin man is badly rocked by one, not floored (hurt ${fr.hurtAtLand.toFixed(1)} s, ${(fr.mag / fr.rocked?.threshold).toFixed(2)} × his threshold; health left ${fr.s.fighters[1].health.toFixed(2)})`, !fr.kd && fr.rocked && fr.hurtAtLand >= 2.4);
  // A second one — any rocking shot at stunFinishFrac × T while he is rocked — finishes it.
  const again = (() => { const s = fr.s; s.fighters[0].pos = { x: -0.36, z: 0 }; s.fighters[1].pos = { x: 0.36, z: 0 }; return r.run(s, 40, i => [r.inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } }), r.NONE], c); })();
  check(`…and the next clean hook while he is rocked puts him down (cause ${again.evs.find(e => e.type === 'knockdown')?.cause})`, again.evs.find(e => e.type === 'knockdown' && e.side === 1)?.cause === 'finish');
  for (const hp of [0.8, 0.6]) { const w = counter((a, d) => { d.health = hp; }); check(`worn to ${hp * 100}% health the same counter floors him on the land tick (cause ${w.kd?.cause}${w.rocked ? `; only rocked, ${(w.mag / w.rocked.threshold).toFixed(2)} ×` : ''})`, w.kd?.cause === 'flash' && w.kd.tick === w.land.tick); }
  const iron = counter((a, d) => { d.ratings = { ...d.ratings, chin: 90 }; }), glass = counter((a, d) => { d.ratings = { ...d.ratings, chin: 40 }; });
  check(`ratings move it: a chin-90 man is further from the floor (${(iron.mag / iron.rocked?.threshold).toFixed(2)} × his threshold vs ${(fr.mag / fr.rocked?.threshold).toFixed(2)}; the flash is at ${(c.stunFlashFrac * c.counterFlashScale).toFixed(2)}) and a chin-40 man goes down fresh (${glass.kd?.cause})`, !iron.kd && iron.rocked && iron.rocked.threshold > fr.rocked.threshold && glass.kd?.cause === 'flash');
  const heavy = counter(a => { a.ratings = { ...a.ratings, power: 90 }; }), light = counter(a => { a.ratings = { ...a.ratings, power: 40 }; });
  check(`…a power-90 man's floors a fresh one (${heavy.mag.toFixed(0)} N·s, ${heavy.kd?.cause}); a power-40 man's rocks him (${light.mag.toFixed(0)} N·s)`, heavy.kd?.cause === 'flash' && !light.kd && !!light.rocked);
}

// ── 5. Surviving ────────────────────────────────────────────────────────────
console.log('\n=== 5. Surviving ===');
{
  const hurt = c => { const s = fresh(c, 2.0, 10); const f = s.fighters[0]; f.hurt = 2; f.hurtMax = 2; f.hurtKind = 'head'; return s; };
  const left = (c, move) => run(hurt(c), 60, () => [inp({ move }), NONE], c).s.fighters[0].hurt;
  const still = left(cfg, { x: 0, y: 0 }), moving = left(cfg, { x: 1, y: 0 });
  check(`a hurt man who keeps his feet moving clears his head faster (${moving.toFixed(2)} s left vs ${still.toFixed(2)} s standing)`, near(still, 1, 0.02) && moving < still - 0.3);
  check('hurtSurvivalOn off: the clock runs the same either way', near(left({ ...cfg, hurtSurvivalOn: false }, { x: 1, y: 0 }), still, 0.02));
}

// ── 6. The get-up ───────────────────────────────────────────────────────────
console.log('\n=== 6. The get-up ===');
{
  const floor = c => run(fresh(c, MID, 20), T(10 * c.countTickSeconds) + 60, i => [inp({ cross: i === 0 }), NONE], c);
  // (stunFlashFrac 1.85: this section is about the get-up, and floors its man with one big cross — the flash bar it was written on; phase 3 raised it to 3.2.)
  const huge = { ...soft, crossImpulseMult: 3.5, getUpSlumpChance: 0, stunFlashFrac: 1.85 };
  const r = floor(huge);
  const kd = first(r.evs, 'knockdown'), up = first(r.evs, 'getUp');
  const ph = of(r.evs, 'getUpPhase');
  check(`he goes down, struggles, and is up (${((up?.tick - kd?.tick) * SIM_DT).toFixed(1)} s)`, kd && up && up.tick > kd.tick);
  check(`the struggle: ${ph.map(p => p.phase).join(' → ')}`, ph.map(p => p.phase).join() === 'stir,knee,rise' && ph.every(p => p.side === 1));
  const span = (up.tick - kd.tick) * SIM_DT;
  // (Wall ticks: the knockdown's own hit-stop stretches the first ~0.15 s, hence the tolerance.)
  check('stir at getUpStirFrac, a knee at getUpKneeFrac, the rise over the last getUpRiseSeconds', near((ph[0].tick - kd.tick) * SIM_DT, span * huge.getUpStirFrac, 0.2) && near((ph[1].tick - kd.tick) * SIM_DT, span * huge.getUpKneeFrac, 0.2) && near((up.tick - ph[2].tick) * SIM_DT, huge.getUpRiseSeconds, 0.05));
  let midPhase = null;
  run(fresh(huge, MID, 20), ph[1].tick + 3, i => [inp({ cross: i === 0 }), NONE], huge, s => { midPhase = s.fighters[1].getUp; });
  check('the phase is on the state while he is down, and cleared when he is up', midPhase.phase === 'knee' && midPhase.tries === 1 && r.s.fighters[1].getUp.phase === 'none');
  // Phase 3: the count is a breather. He goes down with an empty tank and gets up with knockdownStaminaRestore of it.
  const windAtGetUp = c => { const s0 = fresh(c, MID, 20); s0.fighters[1].stamina = 0.02; let w = null; run(s0, T(10 * c.countTickSeconds) + 60, i => [inp({ cross: i === 0 }), NONE], c, (s, i, ev) => { if (w === null && ev.some(e => e.type === 'getUp')) w = s.fighters[1].stamina; }); return w; };
  const wOn = windAtGetUp(huge), wOff = windAtGetUp({ ...huge, knockdownStaminaRestore: 0 });
  check(`floored with an empty tank he gets up with wind (${wOn?.toFixed(2)}; ${wOff?.toFixed(2)} with knockdownStaminaRestore 0)`, wOn !== null && wOff !== null && wOn >= Math.min(huge.knockdownStaminaRestore, 0.45) - 1e-9 && wOff < 0.1);
  // The first try fails.
  // (A short slump so it fits this ~2.5 s get-up; at the default 0.4 s it plays only on the longer counts.)
  const slumpy = { ...huge, getUpSlumpChance: 3, getUpSlumpSeconds: 0.15 };
  const s2 = floor(slumpy);
  const ph2 = of(s2.evs, 'getUpPhase');
  check(`a first try that fails: ${ph2.map(p => `${p.phase}${p.tries ? p.tries : ''}`).join(' → ')}`, ph2.map(p => p.phase).join() === 'stir,knee,slump,knee,rise' && ph2[3].tries === 2);
  check('…and he is up at the same moment the roll said (the struggle is laid inside it)', first(s2.evs, 'getUp').tick === up.tick);
  // He does not beat the count: he tries, slumps, and stays there.
  const out = { ...huge, getUpCountBest: 12, getUpCountWorst: 12 };
  const ko = floor(out);
  const ph3 = of(ko.evs, 'getUpPhase');
  check(`a man who will not beat the count still tries: ${ph3.map(p => p.phase).join(' → ')}, then the ten`, ph3.map(p => p.phase).join() === 'stir,knee,slump' && ko.evs.some(e => e.type === 'ko' && e.winner === 0) && ko.s.fighters[1].getUp.phase === 'slump');
  const off = floor({ ...huge, getUpOn: false });
  check('getUpOn off: no phases, the same get-up tick', of(off.evs, 'getUpPhase').length === 0 && first(off.evs, 'getUp').tick === up.tick);
  // The pure timeline.
  const seq = []; for (let t = 0; t < 3; t += 0.05) { const p = sim.getUpPhaseAt(t, 3, true, cfg).phase; if (seq[seq.length - 1] !== p) seq.push(p); }
  check(`getUpPhaseAt is the same timeline as a pure function (${seq.join(' → ')})`, seq.join() === 'down,stir,knee,slump,knee,rise');
}

done();
