/**
 * footing_test.mjs — overhaul A1, sim/footing.ts + movement.ts, in Node:
 *   - FLAT-FOOTED: standing still fills the clock, then the feet go flat; a slower
 *     first step; takes more; footwork clears it; gassed = flat whatever he does
 *   - THE BURST: a double-tap hops burstDist in that direction (forward / back /
 *     sideways), lands, cools down, costs little; a single flick does not; a jab
 *     thrown off a forward burst carries its momentum
 *   - THE PIVOT: block + lateral flick turns the hips about the planted lead foot,
 *     toward the flicked side; an opponent in range is slow to turn
 *   - ROPES: `ropes` only with the ropes BEHIND; cornered; takes more; a stumble
 *     rebounds; slipping a punch on the ropes carries the feet along them; a pivot
 *     off the ropes turns further
 *   - THE ANGLE: a fighter turns slower mid-punch; `angle` reads the offset
 *   - every toggle off = the old behaviour
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, flick, doubleTap, SIM_DT } = k;
const DEG = Math.PI / 180;
const FAR = 2.0;

// ── 1. Flat-footed ──────────────────────────────────────────────────────────
console.log('\n=== 1. Flat-footed ===');
{
  const early = fresh(cfg, FAR, T(cfg.flatAfter) - 5).fighters[0];
  check('standing still under flatAfter: still on the balls of the feet', early.flat === 0 && early.stillT > 0, `flat ${early.flat}, still ${early.stillT.toFixed(2)} s`);
  const mid = fresh(cfg, FAR, T(cfg.flatAfter + cfg.flatRamp / 2)).fighters[0];
  check('…half-way through flatRamp: half flat', near(mid.flat, 0.5, 0.05), `${mid.flat.toFixed(2)}`);
  const flatS = fresh(cfg, FAR, T(cfg.flatAfter + cfg.flatRamp) + 3);
  check('…and fully flat-footed after flatAfter + flatRamp', flatS.fighters[0].flat === 1);

  const stepSpeed = s => { const r = run(s, 6, () => [inp({ move: { x: 0, y: 1 } }), NONE]); return Math.hypot(r.s.fighters[0].vel.x, r.s.fighters[0].vel.z); };
  const vFlat = stepSpeed(flatS), vFresh = stepSpeed(fresh(cfg, FAR, 10));
  check(`the first step is slower flat-footed (${vFlat.toFixed(2)} vs ${vFresh.toFixed(2)} m/s after 6 ticks)`, vFlat < vFresh * 0.75 && vFlat > 0);
  const walked = run(flatS, T(0.7), () => [inp({ move: { x: 0, y: 1 } }), NONE]).s.fighters[0];
  check('0.7 s of footwork clears 2 s of standing (flatClear)', walked.flat === 0 && walked.stillT === 0, `flat ${walked.flat}, still ${walked.stillT.toFixed(2)}`);

  const jab = s => first(run(s, 20, i => [inp({ jab: i === 0 }), NONE]).evs, 'punchLand');
  const onFlat = jab(fresh(cfg, 0.79, T(cfg.flatAfter + cfg.flatRamp) + 3)), onFresh = jab(fresh(cfg, 0.79, 20));
  check(`a flat-footed target takes flatImpulseBonus more (${(mag(onFlat) / mag(onFresh)).toFixed(3)}×)`, near(mag(onFlat) / mag(onFresh), 1 + cfg.flatImpulseBonus, 1e-6));

  const gassed = fresh(cfg, FAR, 5); gassed.fighters[0].stamina = 0;
  const g = run(gassed, 30, () => [inp({ move: { x: 1, y: 0 } }), NONE], { ...cfg, staminaRegen: 0 }).s.fighters[0];
  check('a gassed fighter is flat-footed even while moving (flat ≥ fatigue × flatFatigue)', near(g.flat, cfg.flatFatigue, 1e-9) && g.fatigue === 1, `flat ${g.flat}`);

  const off = { ...cfg, flatFootedOn: false };
  const offS = fresh(off, 0.79, T(cfg.flatAfter + cfg.flatRamp) + 3);
  const offJab = first(run(offS, 20, i => [inp({ jab: i === 0 }), NONE], off).evs, 'punchLand');
  check('flatFootedOn off: never flat, no bonus', offS.fighters[1].flat === 0 && near(mag(offJab), mag(onFresh), 1e-6));
}

// ── 2. The burst ────────────────────────────────────────────────────────────
console.log('\n=== 2. The burst ===');
{
  const go = (x, y, c = cfg, tap = doubleTap(x, y)) => { const s0 = fresh(c, FAR, 10); const r = run(s0, 40, i => [inp({ move: tap(i) }), NONE], c); return { r, d: { x: r.s.fighters[0].pos.x - s0.fighters[0].pos.x, z: r.s.fighters[0].pos.z - s0.fighters[0].pos.z }, s0 }; };
  const fwd = go(0, 1);
  const b = first(fwd.r.evs, 'burst');
  // (The second push starts on tick 3 and is confirmed burstConfirm later — the window in which a punch press would claim the stick instead.)
  check('a forward double-tap is a burst toward the opponent', b && b.side === 0 && b.x === 0 && b.y === 1 && b.tick === 4, JSON.stringify(b));
  // The two 2-tick pushes also walk a few cm; the hop itself is burstDist.
  check(`…that travels about burstDist (${fwd.d.x.toFixed(3)} m)`, fwd.d.x > cfg.burstDist * 0.95 && fwd.d.x < cfg.burstDist + 0.15 && Math.abs(fwd.d.z) < 0.01);
  check('…with nothing else: a forward flick is not a slip', of(fwd.r.evs, 'slip').length === 0);
  const noRegen = { ...cfg, staminaRegen: 0 };
  check('…and costs burstStaminaCost', near(fwd.s0.fighters[0].stamina - run(fwd.s0, 5, i => [inp({ move: doubleTap(0, 1)(i) }), NONE], noRegen).s.fighters[0].stamina, cfg.burstStaminaCost, 1e-9));

  const back = go(0, -1);
  check('a back double-tap: the first flick is the pull, the second push the hop back', first(back.r.evs, 'slip')?.kind === 'pull' && first(back.r.evs, 'burst')?.y === -1);
  check(`…back about burstDist × burstBackScale (${back.d.x.toFixed(3)} m)`, back.d.x < -cfg.burstDist * cfg.burstBackScale * 0.95 && back.d.x > -(cfg.burstDist * cfg.burstBackScale + 0.15));
  const side = go(1, 0);
  check('a sideways double-tap: slip, then the hop that way', first(side.r.evs, 'slip')?.kind === 'slip' && first(side.r.evs, 'burst')?.x === 1 && side.d.z > cfg.burstDist * cfg.burstLateralScale * 0.9, `dz ${side.d.z.toFixed(3)}`);

  check('a single flick is not a burst', of(go(0, 1, cfg, flick(0, 1)).r.evs, 'burst').length === 0);
  const late = T(cfg.burstTapWindow) + 4;
  check('a second push after burstTapWindow is not a burst', of(go(0, 1, cfg, i => (i < 2 || (i >= late && i < late + 2) ? { x: 0, y: 1 } : { x: 0, y: 0 })).r.evs, 'burst').length === 0);
  check('a HELD push never bursts', of(go(0, 1, cfg, () => ({ x: 0, y: 1 })).r.evs, 'burst').length === 0);

  // The landing, then the cooldown.
  const trace = [];
  run(fresh(cfg, FAR, 10), 40, i => [inp({ move: doubleTap(0, 1)(i) }), NONE], cfg, s => trace.push(s.fighters[0].burstT));
  const busy = trace.filter(t => t > 0).length;
  check(`burstT runs for burstTime + burstRecover (${busy} ticks)`, Math.abs(busy - T(cfg.burstTime + cfg.burstRecover)) <= 1);
  const twice = run(fresh(cfg, FAR, 10), 40, i => [inp({ move: i < 8 ? doubleTap(0, 1)(i) : doubleTap(0, 1, 8)(i) }), NONE]);
  check('a second double-tap inside burstCooldown does nothing', of(twice.evs, 'burst').length === 1);

  // Momentum: a jab pressed as the hop starts lands harder than a standing one from the same contact distance.
  const hopJab = first(run(fresh(cfg, 1.25, 10), 30, i => [inp({ move: doubleTap(0, 1)(i), jab: i === 5 }), NONE]).evs, 'punchLand');
  const claimed = run(fresh(cfg, 1.25, 10), 30, i => [inp({ move: doubleTap(0, 1)(i), jab: i === 3 }), NONE]).evs;
  check('a punch pressed with the second push claims the stick: a step jab, no burst', of(claimed, 'burst').length === 0 && first(claimed, 'punchStart')?.variant === 'stepJab');
  const standJab = first(run(fresh(cfg, 0.8, 10), 30, i => [inp({ jab: i === 0 }), NONE]).evs, 'punchLand');
  check(`a jab off a forward burst carries the hop (${hopJab?.power.toFixed(2)} vs ${standJab?.power.toFixed(2)})`, hopJab && standJab && hopJab.power > standJab.power * 1.1, hopJab ? '' : 'no land');

  const off = { ...cfg, burstOn: false };
  check('burstOn off: a double-tap is just two flicks', of(go(0, 1, off).r.evs, 'burst').length === 0);
}

// ── 3. The pivot ────────────────────────────────────────────────────────────
console.log('\n=== 3. The pivot ===');
{
  const D = 0.7;
  const piv = (x, c = cfg, block = true) => { const s0 = fresh(c, D, 10); return { s0, r: run(s0, 30, i => [inp({ block, move: flick(x, 0)(i) }), NONE], c) }; };
  const right = piv(1);
  const ev = first(right.r.evs, 'pivot');
  check('block + a lateral flick is a pivot (on the release tick)', ev && ev.side === 0 && ev.tick === 2 && of(right.r.evs, 'slip').length === 0, JSON.stringify(ev));
  const f0 = right.s0.fighters[0], f1 = right.r.s.fighters[0];
  const moved = Math.hypot(f1.pos.x - f0.pos.x, f1.pos.z - f0.pos.z);
  const radius = Math.hypot(cfg.rigStanceFwd + cfg.pivotReach, cfg.rigStanceLat);
  const chord = 2 * radius * Math.sin(cfg.pivotAngleDeg * DEG / 2);
  // (Body separation nudges a few cm on top when the swing brings the hips near the opponent.)
  check(`the hips swing pivotAngleDeg round the planted lead foot (moved ${moved.toFixed(3)} m, chord ${chord.toFixed(3)} m)`, Math.abs(moved - chord) < 0.08);
  check('…toward the flicked side (+z is the orthodox fighter\'s right when facing +x)', f1.pos.z - f0.pos.z > 0.15, `dz ${(f1.pos.z - f0.pos.z).toFixed(3)}`);
  const left = piv(-1);
  check('…and the other way for the other flick', left.r.s.fighters[0].pos.z - left.s0.fighters[0].pos.z < -0.15);
  let pivTicks = 0;
  run(fresh(cfg, D, 10), 30, i => [inp({ block: true, move: flick(1, 0)(i) }), NONE], cfg, s => { if (s.fighters[0].pivot.dir !== 0) pivTicks++; });
  check(`it takes pivotTime (${pivTicks} ticks)`, Math.abs(pivTicks - T(cfg.pivotTime)) <= 1);
  check('the opponent, in range, is "turned" for pivotTurnLag', near(run(fresh(cfg, D, 10), 3, i => [inp({ block: true, move: flick(1, 0)(i) }), NONE]).s.fighters[1].turned, cfg.pivotTurnLag, SIM_DT * 1.5));
  // Off his line: the opponent's `angle` (how far off HIS facing I stand) opens up, more than with instant feet.
  const peakAngle = c => { let pk = 0; run(fresh(c, D, 10), 30, i => [inp({ block: true, move: flick(1, 0)(i) }), NONE], c, s => { pk = Math.max(pk, s.fighters[1].angle); }); return pk / DEG; };
  const lag = peakAngle(cfg), noLag = peakAngle({ ...cfg, pivotTurnScale: 1 });
  check(`the pivot takes an angle: the opponent is ${lag.toFixed(0)}° off-line at the peak (${noLag.toFixed(0)}° if his feet did not have to reset)`, lag > cfg.angleExposeDeg && lag > noLag + 5);
  check('…which is exposure to the pivoter', (() => { let pk = 0; run(fresh(cfg, D, 10), 30, i => [inp({ block: true, move: flick(1, 0)(i) }), NONE], cfg, s => { pk = Math.max(pk, sim.angleExposure(s.fighters[1], cfg)); }); return pk; })() > 0.2);
  check('out of pivotRange the opponent is not turned', run(fresh(cfg, 1.6, 10), 3, i => [inp({ block: true, move: flick(1, 0)(i) }), NONE]).s.fighters[1].turned === 0);
  check('without block the same flick is a slip, not a pivot', of(piv(1, cfg, false).r.evs, 'pivot').length === 0 && of(piv(1, cfg, false).r.evs, 'slip').length === 1);
  const off = piv(1, { ...cfg, pivotOn: false });
  check('pivotOn off: block + flick does nothing (v1: the block rules out the slip)', of(off.r.evs, 'pivot').length === 0 && of(off.r.evs, 'slip').length === 0);
}

// ── 4. Ropes and corners ────────────────────────────────────────────────────
console.log('\n=== 4. Ropes and corners ===');
{
  const b = k.bound(cfg);
  // The dummy (side 1) with its back to the +x ropes, the player in front of it.
  const onRopes = (gap, c = cfg, settle = 20) => fresh(c, 0.79, settle, b - gap - 0.79 / 2);
  const s = onRopes(0.1);
  const d = s.fighters[1], a = s.fighters[0];
  check(`back to the ropes, 0.1 m off them: ropes = 1 − 0.1 / ropeZone (${d.ropes.toFixed(2)})`, near(d.ropes, 1 - 0.1 / cfg.ropeZone, 0.02) && !d.cornered);
  check('the fighter FACING the ropes is not on them', a.ropes === 0);
  check('ring centre: 0', fresh(cfg, 0.79, 20).fighters[1].ropes === 0);
  const corner = (() => { let c = fresh(cfg, 0.79, 0); c.fighters[1].pos = { x: b - 0.1, z: b - 0.1 }; c.fighters[0].pos = { x: b - 0.1 - 0.56, z: b - 0.1 - 0.56 }; return run(c, 20).s.fighters[1]; })();
  check('two walls close and behind: cornered', corner.cornered && corner.ropes > 0.5, `ropes ${corner.ropes.toFixed(2)}`);

  const jabAt = st => first(run(st, 20, i => [inp({ jab: i === 0 }), NONE]).evs, 'punchLand');
  const rope = jabAt(onRopes(0.1)), centre = jabAt(fresh(cfg, 0.79, 20));
  check(`on the ropes he takes ropeImpulseBonus × ropes more (${(mag(rope) / mag(centre)).toFixed(3)}×)`, near(mag(rope) / mag(centre), 1 + cfg.ropeImpulseBonus * d.ropes, 0.01));

  // The rebound: a cross drives him into the ropes; the stumble comes back toward the ring.
  let minV = 0;
  run(onRopes(0.05), 40, i => [inp({ cross: i === 0 }), NONE], cfg, st => { minV = Math.min(minV, st.fighters[1].stagger.x); });
  check(`a stumble into the ropes rebounds (stagger back toward the ring: ${minV.toFixed(2)} m/s)`, minV < -0.3);
  const noReb = { ...cfg, ropesOn: false };
  let minOff = 0;
  run(onRopes(0.05, noReb), 40, i => [inp({ cross: i === 0 }), NONE], noReb, st => { minOff = Math.min(minOff, st.fighters[1].stagger.x); });
  check('ropesOn off: the ropes absorb it, and `ropes` stays 0', minOff === 0 && onRopes(0.1, noReb).fighters[1].ropes === 0);

  // The escape: the dummy slips the jab with the ropes behind it → carried along them.
  const L = first(run(onRopes(0.1), 20, i => [inp({ jab: i === 0 }), NONE]).evs, 'punchLand').tick;
  const slipIt = c => { const s0 = onRopes(0.1, c); return { s0, r: run(s0, 45, i => [inp({ jab: i === 0 }), inp({ move: flick(-1, 0, L - 7)(i) })], c) }; };
  const esc = slipIt(cfg);
  const dodged = of(esc.r.evs, 'slip').some(e => e.dodged);
  const along = Math.abs(esc.r.s.fighters[1].pos.z - esc.s0.fighters[1].pos.z);
  check('slipping a punch on the ropes is an ESCAPE', dodged && first(esc.r.evs, 'escape')?.how === 'slip' && first(esc.r.evs, 'escape')?.side === 1, `dodged ${dodged}`);
  check(`…that carries the feet ~ropeEscapeHop along them (${along.toFixed(2)} m)`, along > cfg.ropeEscapeHop * 0.8);
  const noEsc = slipIt({ ...cfg, ropeEscapeHop: 0 });
  check('ropeEscapeHop 0: the slip still dodges, the feet stay', of(noEsc.r.evs, 'slip').some(e => e.dodged) && of(noEsc.r.evs, 'escape').length === 0);

  // The pivot off the ropes turns further.
  const pivOff = st => { const r = run(st, 30, i => [NONE, inp({ block: true, move: flick(1, 0)(i) })]); return { evs: r.evs, moved: Math.hypot(r.s.fighters[1].pos.x - st.fighters[1].pos.x, r.s.fighters[1].pos.z - st.fighters[1].pos.z) }; };
  const pr = pivOff(onRopes(0.1)), pc = pivOff(fresh(cfg, 0.79, 20));
  check(`a pivot off the ropes is an escape and swings further (${pr.moved.toFixed(2)} vs ${pc.moved.toFixed(2)} m)`, first(pr.evs, 'escape')?.how === 'pivot' && of(pc.evs, 'escape').length === 0 && pr.moved > pc.moved * 1.1);
}

// ── 5. The angle: turning mid-punch ─────────────────────────────────────────
console.log('\n=== 5. Turning ===');
{
  // The dummy is moved a metre to the side on tick 2; how fast does the player's yaw follow?
  const turn = (punch, c = cfg) => {
    const rates = [];
    let prev = null;
    run(fresh(c, 0.79, 10), 12, i => [inp({ hook: punch && i === 0 }), NONE], c, (st, i) => {
      if (i === 1) st.fighters[1].pos = { x: st.fighters[1].pos.x, z: 1 };
      if (prev !== null && i >= 3) rates.push(Math.abs(st.fighters[0].yaw - prev) / SIM_DT);
      prev = st.fighters[0].yaw;
    });
    return Math.max(...rates);
  };
  const idle = turn(false), punching = turn(true);
  check(`idle he turns at turnRate (${idle.toFixed(1)} rad/s)`, near(idle, cfg.turnRate, 0.01));
  check(`mid-punch at turnRate × turnPunchScale (${punching.toFixed(1)} rad/s)`, near(punching, cfg.turnRate * cfg.turnPunchScale, 0.01));
  check('anglesOn off: punches track at full rate', near(turn(true, { ...cfg, anglesOn: false }), cfg.turnRate, 0.01));
  const s = fresh(cfg, 0.79, 10);
  check('square on: angle 0', s.fighters[0].angle < 1e-6 && sim.angleExposure(s.fighters[0], cfg) === 0);
}

done();
