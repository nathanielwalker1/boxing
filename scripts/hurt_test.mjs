/**
 * hurt_test.mjs — the polish phase's kinds of hurt (2026-11-11, item 3; sim/stun.ts, resources.ts):
 *   - rocked is legs gone / reaching / covering up; winded is folded / an elbow down / sinking to a knee — sometimes
 *     a beat late; each kind is in state, on an event, seeded, and mechanically (a little) different
 *   - knockdowns are flash (up early), heavy (up late or not), a knee taken by choice, or OUT (no count)
 *   - the rates: the bar, the compression of stacked impulses, the raised bar after a hurt
 *   - the off switches
 * The fight-level rates (how often each happens) are measured by scripts/hurt_table.mjs, not pinned here.
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';

const k = await kit();
const { sim, inp, NONE, T, run, of, SIM_DT } = k;
const cfg = k.cfg;
/** No compression, so a test can dial an impulse straight against the threshold. */
const RAW = { ...cfg, stunSoftKeep: 1 };
const fresh = (c, dist, seed = 1) => k.fresh(c, dist, 30, 0, seed);
const hookCfg = (c, mult) => ({ ...c, hookImpulseMult: mult });
const T0 = sim.stunThreshold(fresh(cfg, 0.72).fighters[1], cfg);
/** Side 0 throws one hook at side 1; `mult` sets its weight. */
const hook = (c, mult, seed = 1, prep = null, ticks = 60, his = () => NONE) => { const cc = hookCfg(c, mult); const s = fresh(cc, 0.72, seed); if (prep) prep(s); return { ...run(s, ticks, i => [inp({ hook: i === 0 }), his(i)], cc), cc }; };

// ── 1. Rocked: three kinds ──────────────────────────────────────────────────
console.log('\n=== 1. Rocked ===');
{
  const seen = {}, seenBig = {};
  for (let seed = 1; seed <= 40; seed++) {
    const r = hook(RAW, 1.7, seed), e = of(r.evs, 'hurtStyle')[0], rock = of(r.evs, 'rocked')[0];
    if (rock && e) { seen[e.style] = (seen[e.style] ?? 0) + 1; if (r.s.fighters[1].hurt > 0 && r.s.fighters[1].hurtStyle !== e.style) seen.mismatch = 1; }
    const b = hook(RAW, 2.6, seed), eb = of(b.evs, 'hurtStyle')[0];
    if (eb) seenBig[eb.style] = (seenBig[eb.style] ?? 0) + 1;
  }
  check(`a rock picks a kind, in state and on a hurtStyle event; over 40 seeds all three appear (${JSON.stringify(seen)})`, seen.legs > 0 && seen.reach > 0 && seen.cover > 0 && !seen.mismatch && seen.legs + seen.reach + seen.cover === 40);
  check(`a shot well over the bar takes the legs or leaves him reaching — he does not get to cover up (${JSON.stringify(seenBig)})`, !seenBig.cover && seenBig.legs > 0 && seenBig.reach > 0);
  const a = hook(RAW, 1.7, 5), b = hook(RAW, 1.7, 5);
  check('the kind is seeded: the same fight picks the same one', of(a.evs, 'hurtStyle')[0].style === of(b.evs, 'hurtStyle')[0].style);
  // The mechanical differences, with the kind set directly on a rocked man.
  const rocked = (style, c = cfg) => { const s = fresh(c, 1.6); const f = s.fighters[1]; f.hurt = 2; f.hurtMax = 3; f.hurtKind = 'head'; f.hurtStyle = style; return s; };
  const walk = style => { const r = run(rocked(style), 40, () => [NONE, inp({ move: { x: 1, y: 0 } })]); return Math.hypot(r.s.fighters[1].vel.x, r.s.fighters[1].vel.z); };
  const vuln = style => run(rocked(style), 5, () => [NONE, NONE]).s.fighters[1].vuln;
  const gloveY = style => run(rocked(style), 40, () => [NONE, NONE]).s.fighters[1].gloves[0].pos.y;
  check(`LEGS GONE: he walks at ${walk('legs').toFixed(2)} m/s against ${walk('reach').toFixed(2)} for the other kinds (hurtLegsMove on his top speed and his push-off)`, walk('legs') / walk('reach') <= cfg.hurtLegsMove + 0.02 && walk('legs') / walk('reach') > 0.3 && Math.abs(walk('reach') - walk('cover')) < 1e-9);
  check(`REACHING: exposure ${vuln('reach').toFixed(2)} against ${vuln('legs').toFixed(2)}, and the lead glove hangs ${((gloveY('legs') - gloveY('reach')) * 100).toFixed(1)} cm lower than a legs-gone man's`, vuln('reach') > vuln('legs') + 0.05 && gloveY('reach') < gloveY('legs') - 0.02);
  check(`COVERING UP: the hands stay on the head (lead glove ${((gloveY('cover') - gloveY('legs')) * 100).toFixed(1)} cm higher than a legs-gone man's)`, gloveY('cover') > gloveY('legs') + 0.02);
  const chip = style => { const s = fresh(cfg, 0.76); const f = s.fighters[1]; f.hurt = 2; f.hurtMax = 3; f.hurtKind = 'head'; f.hurtStyle = style; const r = run(s, 30, i => [inp({ cross: i === 0 }), inp({ block: true })]); return { blocked: of(r.evs, 'punchBlock').length, lost: 1 - r.s.fighters[1].health }; };
  const cc = chip('cover'), cl = chip('legs');
  check(`…and his held guard is a real guard: a blocked cross takes ${(cc.lost * 100).toFixed(2)}% against ${(cl.lost * 100).toFixed(2)}% from a legs-gone man's loose one`, cc.blocked === 1 && cl.blocked === 1 && cc.lost < cl.lost * 0.8);
  const lock = style => { const s = fresh(cfg, 1.6); const f = s.fighters[1]; f.hurt = 3; f.hurtMax = 3; f.hurtKind = 'head'; f.hurtStyle = style; let n = 0; let st = s; while (!sim.canStartPunch(st.fighters[1], cfg) && n < 200) { st = sim.step(st, [NONE, NONE], cfg).state; n++; } return n; };
  check(`…but he is the slowest to punch back (${lock('cover')} ticks locked against ${lock('legs')})`, lock('cover') >= lock('legs') * 1.7);
  const off = hook({ ...RAW, hurtVarietyOn: false }, 1.7, 3);
  check('hurtVarietyOn off: rocked, no kind, no hurtStyle event', of(off.evs, 'rocked').length === 1 && of(off.evs, 'hurtStyle').length === 0 && off.s.fighters[1].hurtStyle === 'none');
}

// ── 2. Winded: three kinds, sometimes late ──────────────────────────────────
console.log('\n=== 2. Winded ===');
{
  const body = (c, seed, lead = false) => { const cc = { ...c, bodyHurtBase: 200, liverOn: false }; const s = fresh(cc, 0.7, seed); return { ...run(s, 110, i => [inp({ hook: i === 6, level: i <= 6, move: { x: i === 6 ? (lead ? -1 : 1) : 0, y: 0 } }), NONE], cc), cc }; };
  const seen = {}; let late = 0, atOnce = 0, lateGap = [];
  for (let seed = 1; seed <= 40; seed++) {
    const r = body(cfg, seed), land = of(r.evs, 'punchLand')[0], e = of(r.evs, 'hurtStyle')[0], bh = of(r.evs, 'bodyHurt')[0];
    if (!land || !e || !bh) continue;
    seen[e.style] = (seen[e.style] ?? 0) + 1;
    if (e.late) { late++; lateGap.push((bh.tick - land.tick) * SIM_DT); } else atOnce++;
  }
  check(`a body hurt picks a kind; over 40 seeds fold, elbow and knee all appear (${JSON.stringify(seen)})`, seen.fold > 0 && seen.elbow > 0 && seen.knee > 0);
  check(`some land a beat LATE (${late} of ${late + atOnce}; he is hit, keeps his shape, then folds ${Math.min(...lateGap).toFixed(2)}–${Math.max(...lateGap).toFixed(2)} s later)`, late >= 5 && atOnce >= 10 && Math.min(...lateGap) >= cfg.bodyHurtLateMin - 0.1 && Math.max(...lateGap) <= cfg.bodyHurtLateMax + 0.35);
  const winded = style => { const s = fresh(cfg, 1.6); const f = s.fighters[1]; f.hurt = 1.4; f.hurtMax = 1.4; f.hurtKind = 'body'; f.hurtStyle = style; return s; };
  const after = style => run(winded(style), 30, () => [NONE, inp({ move: { x: 1, y: 0 } })]).s.fighters[1];
  const fo = after('fold'), el = after('elbow'), kn = after('knee');
  const sp = f => Math.hypot(f.vel.x, f.vel.z);
  check(`SINKING TOWARD A KNEE: the head is ${((fo.headBox.y - kn.headBox.y) * 100).toFixed(1)} cm lower than a folded man's and he moves at ${sp(kn).toFixed(2)} against ${sp(fo).toFixed(2)} m/s`, kn.headBox.y < fo.headBox.y - 0.04 && sp(kn) < sp(fo) * 0.7);
  check(`AN ELBOW DOWN: the hands hang ${((el.guardDroop - fo.guardDroop) * 100).toFixed(1)} cm further than a folded man's, and he keeps his feet better (${sp(el).toFixed(2)} m/s)`, el.guardDroop > fo.guardDroop + 0.04 && sp(el) > sp(fo) * 1.2);
}

// ── 3. Knockdowns: flash, heavy, a knee, out ────────────────────────────────
console.log('\n=== 3. Knockdowns ===');
{
  const upAt = r => { const kd = of(r.evs, 'knockdown')[0], up = of(r.evs, 'getUp')[0]; return kd && up ? (up.tick - kd.tick) * SIM_DT / cfg.countTickSeconds : null; };
  // A flash: one shot of 3 × the bar on a fresh man (under the OUT line).
  const flashes = [], heavies = [];
  for (let seed = 1; seed <= 12; seed++) {
    const f = hook({ ...RAW, stunOutFrac: 99 }, 4.6, seed, null, 700), kd = of(f.evs, 'knockdown')[0];
    if (kd) flashes.push({ kind: kd.kind, cause: kd.cause, up: upAt(f), ko: of(f.evs, 'ko').length });
    // Heavy: the same shot on a man with a quarter of his health.
    const h = hook({ ...RAW, stunOutFrac: 99 }, 4.6, seed, s => { s.fighters[1].health = 0.25; }, 700), kh = of(h.evs, 'knockdown')[0];
    if (kh) heavies.push({ kind: kh.kind, up: upAt(h), ko: of(h.evs, 'ko').length });
  }
  const fu = flashes.map(x => x.up).filter(x => x !== null), hu = heavies.map(x => x.up).filter(x => x !== null);
  check(`a one-shot knockdown of a fresh man is a FLASH knockdown (${flashes.filter(x => x.kind === 'flash').length} of ${flashes.length}); he is up at ${Math.min(...fu).toFixed(1)}–${Math.max(...fu).toFixed(1)} and never counted out`,
    flashes.length === 12 && flashes.every(x => x.kind === 'flash' && x.cause === 'flash' && x.ko === 0) && Math.min(...fu) >= cfg.knockdownFlashMin - 0.1 && Math.max(...fu) <= 5.5);
  check(`the same shot on a worn man is HEAVY (${heavies.filter(x => x.kind === 'heavy').length} of ${heavies.length}): up at ${hu.length ? Math.min(...hu).toFixed(1) : '—'}–${hu.length ? Math.max(...hu).toFixed(1) : '—'}, or not at all (${heavies.filter(x => x.ko).length} counted out)`,
    heavies.every(x => x.kind === 'heavy') && (hu.length === 0 || Math.min(...hu) > Math.max(...fu)) && hu.every(x => x <= 10));
  // OUT: over stunOutFrac × the bar.
  const out = hook(RAW, 8, 1, null, 200), kd = of(out.evs, 'knockdown')[0], ko = of(out.evs, 'ko')[0];
  check(`a shot of ${kd?.over?.toFixed(1)} × the bar (≥ stunOutFrac ${cfg.stunOutFrac}): OUT — knockdown kind out, fall ${kd?.fall}, and the referee waves it off on the same tick (ko, waved)`,
    kd?.kind === 'out' && (kd.fall === 'stiff' || kd.fall === 'crumple') && ko?.waved === true && ko.tick === kd.tick && ko.winner === 0);
  check('…no count: no countTick, no getUp, the fight is over, and he is in state as out', of(out.evs, 'countTick').length === 0 && of(out.evs, 'getUp').length === 0 && out.s.round.phase === 'over' && out.s.fighters[1].down && out.s.fighters[1].downKind === 'out' && out.s.fighters[1].fall === kd.fall);
  check(`…his fall has time to play (downT ${out.s.fighters[1].downT.toFixed(2)} s and running)`, out.s.fighters[1].downT > 1);
  const upper = (() => { const cc = { ...RAW, uppercutImpulseMult: 9 }; return run(fresh(cc, 0.66), 60, i => [inp({ uppercut: i === 0 }), NONE], cc); })();
  const kdu = of(upper.evs, 'knockdown')[0];
  check(`an uppercut that puts him out crumples him; a hook on an upright man drops him stiff (${kdu?.fall} / ${kd?.fall})`, kdu?.kind === 'out' && kdu.fall === 'crumple' && kd.fall === 'stiff');
  const noVar = hook({ ...RAW, hurtVarietyOn: false }, 8, 1, null, 200);
  check('hurtVarietyOn off: the same shot is a knockdown with a count, as before', of(noVar.evs, 'knockdown').length === 1 && of(noVar.evs, 'ko').every(e => !e.waved) && of(noVar.evs, 'countTick').length > 0);

  // Taking a knee.
  const knee = (c, { far = true, walkIn = false, hurt = true, ticks = 700 } = {}) => {
    const s = fresh(c, far ? 1.6 : 0.6); const f = s.fighters[0];
    if (hurt) { f.hurt = 2.5; f.hurtMax = 3; f.hurtKind = 'head'; f.hurtStyle = 'legs'; }
    return run(s, ticks, i => [inp({ block: i < 60, level: i < 60, move: { x: 0, y: walkIn ? 1 : 0 } }), NONE], c);
  };
  const kn = knee(cfg), kk = of(kn.evs, 'knockdown')[0];
  check(`a hurt man holding block + level with nobody near goes down by choice after takeKneeHold (${kk ? (kk.tick * SIM_DT).toFixed(2) : '—'} s): a knockdown, kind knee`, kk?.kind === 'knee' && kk.side === 0 && kk.count === 1 && Math.abs(kk.tick * SIM_DT - cfg.takeKneeHold) < 0.06);
  const up = upAt(kn);
  check(`…he uses the count (up at ${up?.toFixed(1)}, takeKneeCount ${cfg.takeKneeCount} ± a half), the hurt state is over, and he has his wind (${(kn.s.fighters[0].stamina * 100).toFixed(0)}%)`, up !== null && Math.abs(up - cfg.takeKneeCount) <= 0.75 && kn.s.fighters[0].hurt === 0 && kn.s.fighters[0].stamina >= cfg.takeKneeStamina - 0.05 && of(kn.evs, 'ko').length === 0);
  check('…it is on the cards like any knockdown (knockdowns 1)', kn.s.fighters[0].knockdowns === 1);
  check('not hurt: the same hold does nothing', of(knee(cfg, { hurt: false, ticks: 90 }).evs, 'knockdown').length === 0);
  check('walking in while holding it: no knee (he is going to tie up)', of(knee(cfg, { walkIn: true, ticks: 30 }).evs, 'knockdown').length === 0);
  const close = knee(cfg, { far: false, ticks: 90 });
  check('with the other man in reach the hold is a clinch, not a knee', of(close.evs, 'knockdown').length === 0 && of(close.evs, 'clinch').length === 1);
  check('takeKneeOn off: nothing', of(knee({ ...cfg, takeKneeOn: false }, { ticks: 90 }).evs, 'knockdown').length === 0);
}

// ── 4. The rates ────────────────────────────────────────────────────────────
console.log('\n=== 4. The rates ===');
{
  const old = { ...cfg, hurtRatesOn: false };
  const To = sim.stunThreshold(fresh(old, 0.72).fighters[1], old);
  check(`the bar: a fresh reference chin is rocked at ${T0.toFixed(0)} N·s (it was ${To.toFixed(0)}; × hurtStunBaseScale)`, Math.abs(T0 / To - cfg.hurtStunBaseScale) < 1e-9);
  // A clean standing hook: not on a fresh man, but as soon as he has lost a tenth of his health.
  const std = hook(cfg, cfg.hookImpulseMult, 1), worn = hook(cfg, cfg.hookImpulseMult, 1, s => { s.fighters[1].health = 0.85; }), wornOld = hook(old, cfg.hookImpulseMult, 1, s => { s.fighters[1].health = 0.85; });
  check(`a clean standing hook (${k.mag(of(std.evs, 'punchLand')[0]).toFixed(0)} N·s) rocks a man at 85% health; with the old bar it did not`, of(worn.evs, 'rocked').length === 1 && of(wornOld.evs, 'rocked').length === 0);
  // Compression: a stacked impulse counts for less toward a stun (and not at all less toward damage).
  const big = hook(cfg, 4.6, 1), bigRaw = hook(RAW, 4.6, 1);
  const rb = of(big.evs, 'rocked')[0], land = of(big.evs, 'punchLand')[0];
  const expect = cfg.stunSoftAt + (k.mag(land) - cfg.stunSoftAt) * cfg.stunSoftKeep;
  check(`a ${k.mag(land).toFixed(0)} N·s hook counts as ${rb?.impulse.toFixed(0)} toward the stun (stunSoftAt / stunSoftKeep): it rocks him; uncompressed it floored him`, rb && Math.abs(rb.impulse - expect) < 1e-6 && of(big.evs, 'knockdown').length === 0 && of(bigRaw.evs, 'knockdown').length === 1);
  check('…and it takes exactly the health it would have', Math.abs(big.s.fighters[1].damage.head - bigRaw.s.fighters[1].damage.head) < 1e-9);
  // After a hurt state ends the bar is raised for a while.
  const s0 = fresh(cfg, 0.72); s0.fighters[1].hurt = 0.05; s0.fighters[1].hurtMax = 1; s0.fighters[1].hurtKind = 'head';
  const s1 = run(s0, 6, () => [NONE, NONE]).s, s2 = run(s1, T(cfg.hurtAfterSeconds) + 5, () => [NONE, NONE]).s;
  const Ta = sim.stunThreshold(s1.fighters[1], cfg), Tb = sim.stunThreshold(s2.fighters[1], cfg);
  check(`just after a hurt state ends his bar is ${(Ta / T0).toFixed(2)}× (hurtAfterScale ${cfg.hurtAfterScale}); ${cfg.hurtAfterSeconds} s later it is back (${(Tb / T0).toFixed(2)}×)`, Ta / T0 > cfg.hurtAfterScale - 0.15 && Math.abs(Tb / T0 - 1) < 0.02);
}

// ── 5. Determinism ──────────────────────────────────────────────────────────
{
  const a = hook(RAW, 8, 4, null, 120).s, b = hook(RAW, 8, 4, null, 120).s;
  check('two identical runs through an instant KO end in the same state', JSON.stringify(a) === JSON.stringify(b));
  const nan = v => typeof v === 'number' ? Number.isNaN(v) : v && typeof v === 'object' ? Object.values(v).some(nan) : false;
  check('no NaN anywhere in it', !nan(a));
}

done();
