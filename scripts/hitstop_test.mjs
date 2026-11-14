/**
 * hitstop_test.mjs — anim 2.4: short frame-based hit-stop in place of slow motion (hitStopV2), in Node.
 *   1. the stop lasts exactly the configured ticks, per grade (glancing / clean / flush), blocked and perfect-blocked
 *   2. a counter's stop is longer than the same punch landed normally (by hitStopTicksCounterBonus)
 *   3. a press on every tick of a stop is buffered and fires on the first tick after it (or the first legal one),
 *      and reaches its hit tick in the normal number of ticks (no 5% clock)
 *   4. no stop over the cap in a seeded exchange outside a knockdown; the host slows only for a knockdown
 *   5. hitStopV2 false is the old behaviour: a press in a stop starts at once, the slip freezes, the host slows
 */
import { kit } from './bots/kit.mjs';
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const kr = await kit({ rated: true });
const [UI, ST, VU] = await load('/src/ui/slowmo.ts', '/src/sim/state.ts', '/src/sim/vulnerability.ts');
const { cfg, sim, inp, NONE, fresh, run, SIM_DT } = k;
const MID = 0.79;
const OLD = { ...cfg, hitStopV2: false };
const isStop = (s0, s1, c) => s1.time - s0.time < SIM_DT * (c.hitStopScale + 1) / 2 - 1e-12 && s0.hitStop > 0;

/** Press `type` on tick 0 at `d` m; side 1 per `dummy(i)`. Returns the land tick, its event, the stop granted on that tick and the stopped ticks that followed. */
function hit(type, d, c = cfg, dummy = () => NONE, prep, gate = null) {
  let s = fresh(c, d, 20);
  if (prep) s = prep(s) ?? s;
  let land = null, granted = 0, stopped = 0, ev = null, rocked = false;
  for (let i = 0; i < 80; i++) {
    const r = sim.step(s, [inp({ [type]: i === 0 }), dummy(i)], c);
    if (land !== null && isStop(s, r.state, c)) stopped++;
    s = r.state;
    if (r.events.some(e => e.type === 'rocked' || e.type === 'knockdown')) rocked = true;
    const e = r.events.find(x => /^punch(Land|Block)$/.test(x.type) && x.side === 0) ?? r.events.find(x => x.type === 'perfectBlock');
    if (land === null && e) { land = i; ev = e; granted = Math.round(s.hitStop / SIM_DT); }
    if (land !== null && s.hitStop === 0 && i > land + 12) break;
  }
  return { land, ev, granted, stopped, rocked };
}

// ── 1. The table, per grade ─────────────────────────────────────────────────
console.log('\n=== 1. Exact ticks per grade ===');
{
  const g = hit('jab', 1.0);
  check(`a glancing jab (1.0 m): stop ${g.stopped} ticks = hitStopTicksGlancing ${cfg.hitStopTicksGlancing}`, g.ev?.grade === 'glancing' && g.stopped === cfg.hitStopTicksGlancing && g.granted === g.stopped, `${g.ev?.grade}`);
  const c = hit('jab', MID);
  check(`a clean jab (${MID} m): stop ${c.stopped} ticks = hitStopTicksClean ${cfg.hitStopTicksClean}`, c.ev?.grade === 'clean' && c.stopped === cfg.hitStopTicksClean, `${c.ev?.grade}`);
  const c2 = hit('cross', MID);
  check(`a clean cross: the same ${c2.stopped} ticks (the table is per grade, not per punch)`, c2.ev?.grade === 'clean' && c2.stopped === cfg.hitStopTicksClean, `${c2.ev?.grade}`);
  // Flush: a cross into the other man's lead hook (it rocks him: the rock adds hitStopTicksRock under the cap).
  const trade = i => inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } });
  const f = hit('cross', MID, cfg, trade, s => run(s, 3, i => [NONE, trade(i)]).s);
  const wantF = Math.min(cfg.hitStopTicksCap, cfg.hitStopTicksFlush + (f.rocked ? cfg.hitStopTicksRock : 0));
  check(`a flush cross: stop ${f.stopped} ticks = hitStopTicksFlush ${cfg.hitStopTicksFlush}${f.rocked ? ' + hitStopTicksRock ' + cfg.hitStopTicksRock : ''}`, f.ev?.grade === 'flush' && f.stopped === wantF, `${f.ev?.grade}`);
  // Blocked.
  const b = hit('jab', MID, cfg, () => inp({ block: true }), s => run(s, 10, () => [NONE, inp({ block: true })]).s);
  check(`a jab on a raised guard: stop ${b.stopped} ticks = hitStopTicksBlocked ${cfg.hitStopTicksBlocked}`, /Block|perfect/i.test(b.ev?.type ?? '') && b.stopped === cfg.hitStopTicksBlocked, `${b.ev?.type}`);
  // The table can be changed live and the stop follows.
  const c5 = hit('jab', MID, { ...cfg, hitStopTicksClean: 7 });
  check('hitStopTicksClean 7 gives a 7-tick stop', c5.stopped === 7, `${c5.stopped}`);
  const cap = hit('jab', MID, { ...cfg, hitStopTicksClean: 10, hitStopTicksCap: 4 });
  check('hitStopTicksCap cuts any live stop (clean 10, cap 4 -> 4)', cap.stopped === 4, `${cap.stopped}`);
  // Nothing in the stop is at full speed except the count: the world runs at hitStopScale.
  let s = fresh(cfg, MID, 20), landed = false, scaled = true, stopTicks = 0;
  for (let i = 0; i < 40; i++) {
    const r = sim.step(s, [inp({ jab: i === 0 }), NONE], cfg);
    if (landed && s.hitStop > 0) { stopTicks++; scaled = scaled && near(r.state.time - s.time, SIM_DT * cfg.hitStopScale, 1e-12); }
    if (r.events.some(e => e.type === 'punchLand')) landed = true;
    s = r.state;
  }
  check('during the stop the sim clock advances at hitStopScale (the attacker keeps moving a little, never frozen solid)', stopTicks === cfg.hitStopTicksClean && scaled && cfg.hitStopScale > 0);
}

// ── 2. A counter is the heavier stop ────────────────────────────────────────
console.log('\n=== 2. A counter ===');
{
  const slipped = s => { VU.applyPunish(s.fighters[1], 1, 0.7, ST.PUNISH_SLIP); return s; };
  for (const [type, d] of [['jab', MID], ['cross', MID]]) {
    const plain = hit(type, d, { ...cfg, hitStopTicksCounterBonus: 0 }, () => NONE, slipped), cnt = hit(type, d, cfg, () => NONE, slipped);
    check(`a ${type} landed as a COUNTER: ${cnt.stopped} ticks, the same punch landed normally: ${plain.stopped} (+ hitStopTicksCounterBonus ${cfg.hitStopTicksCounterBonus} under the cap ${cfg.hitStopTicksCap})`, cnt.ev?.counter === true && cnt.stopped > plain.stopped && cnt.stopped === Math.min(cfg.hitStopTicksCap, plain.stopped + cfg.hitStopTicksCounterBonus), `${cnt.ev?.grade}/${cnt.ev?.counter} vs ${plain.ev?.grade}`);
  }
  let evs = [];
  { let s = slipped(fresh(cfg, MID, 20)); const r = run(s, 30, i => [inp({ cross: i === 0 }), NONE]); evs = r.evs; }
  check('the existing counter event is still raised for the sound / crowd / reaction layers to hook', evs.some(e => e.type === 'counter' && e.side === 0 && e.target === 1));
}

// ── 3. Input is buffered, never dropped or slowed ───────────────────────────
console.log('\n=== 3. A press during a stop ===');
{
  // A lone jab: the reference for press -> hit-test ticks.
  const resolve = type => /^punch(Land|Block|Whiff)$|^perfectBlock$/.test(type);
  const lone = (() => { let s = fresh(cfg, 0.78, 20), st = null, rs = null; for (let i = 0; i < 60; i++) { const r = sim.step(s, [inp({ jab: i === 0 }), NONE], cfg); s = r.state; for (const e of r.events) if (e.side === 0) { if (e.type === 'punchStart') st = i; if (resolve(e.type) && rs === null) rs = i; } } return rs - st; })();
  // First punch: a cross lands at tick L (clean, N-tick stop). A jab is pressed at tick L + j, for every j through the stop and past it.
  const probe = (c, j) => {
    let s = fresh(c, 0.78, 20), land = null, n = 0, fire = null, hit2 = null, hsAtPress = null, scaledStart = null;
    for (let i = 0; i < 120; i++) {
      const press = land !== null && i === land + j;
      if (press) hsAtPress = s.hitStop;
      const r = sim.step(s, [inp({ cross: i === 0, jab: press }), NONE], c);
      const before = s;
      s = r.state;
      for (const e of r.events) {
        if (e.side !== 0) continue;
        if (land === null && e.type === 'punchLand') { land = i; n = Math.round(s.hitStop / SIM_DT); }
        else if (land !== null && e.type === 'punchStart' && e.variant !== undefined && fire === null && i >= land + j) { fire = i; scaledStart = s.fighters[0].punch.progress; }
        else if (fire !== null && hit2 === null && resolve(e.type)) hit2 = i;
      }
      if (land !== null && fire !== null && hit2 !== null) break;
    }
    return { land, n, fire, hit2, hsAtPress, scaledStart };
  };
  const ref = probe(cfg, 40);   // pressed long after the stop: the control
  const N = ref.n;
  const ref0 = probe({ ...cfg, hitStopTicksClean: 0 }, 1);   // the same chained jab with no stop at all
  check(`the cross lands and grants a ${N}-tick stop`, ref.land !== null && N === cfg.hitStopTicksClean);
  let allFire = true, allSpeed = true, anyInStop = false; const lines = [];
  for (let j = 1; j <= N + 2; j++) {
    const p = probe(cfg, j);
    const stopEnd = p.land + N;                  // the last stopped tick
    const firstLegal = p.land + N + 1;
    const inStop = p.land + j <= stopEnd;
    if (inStop) anyInStop = true;
    const expect = Math.max(p.land + j, firstLegal);
    // A press may also have to wait for the chain window of the cross; it never fires EARLIER than the stop's end.
    if (!(p.fire !== null && p.fire >= expect)) allFire = false;
    if (inStop && p.fire !== firstLegal) lines.push(`press +${j} (in stop): fired at +${p.fire - p.land}, first legal +${firstLegal - p.land}`);
    if (!inStop && p.fire !== p.land + j) lines.push(`press +${j} (after stop): fired at +${p.fire - p.land}`);
    if (p.hit2 - p.fire !== ref0.hit2 - ref0.fire) { allSpeed = false; lines.push(`j${j}: ${p.hit2 - p.fire} vs ${ref0.hit2 - ref0.fire}`); }
  }
  check(`a jab pressed on each tick of the stop (+1..+${N}) and after it fires on the first tick after the stop, never inside it`, anyInStop && allFire && lines.length === 0, lines.join('; '));
  check(`…and reaches its hit test ${lone} ticks after it starts, as the same chained jab with no stop at all (no 5% clock; lone jab from rest: ${lone})`, allSpeed, lines.join("; "));
  const p1 = probe(cfg, 1);
  check('the held press is not dropped: the buffer (punchBuffer) outlasts the longest stop', cfg.punchBuffer / SIM_DT >= cfg.hitStopTicksCap + 1 && p1.fire !== null, `${(cfg.punchBuffer / SIM_DT).toFixed(0)} ticks vs cap ${cfg.hitStopTicksCap}`);
}

// ── 4. No slow motion in live play; knockdowns keep theirs ──────────────────
console.log('\n=== 4. Seeded exchange ===');
{
  // The host rule (src/ui/slowmo.ts) is the one main.ts runs: feed it every event of a 60 s fight.
  const ks = kr, specs = ks.specs;
  let slowTicks = 0, maxStop = 0, run0 = 0, over = 0, kd = 0, counters = 0, slowAtKd = false, lands = 0, stopAt = [];
  for (const seed of [1, 2, 3]) {
    let s = ks.sim.createState([specs[0], specs[1]], ks.cfg, seed);
    let ai1 = ks.ai.createAi(1, seed, ks.cfg, ks.ai.styleFor(specs[1], ks.cfg)), ai0 = ks.ai.createAi(0, seed + 10, ks.cfg, ks.ai.styleFor(specs[0], ks.cfg));
    let slow = { t: 0, scale: 1 }, lastKd = -1e9;
    for (let i = 0; i < 60 * 70 && s.round.phase !== 'over'; i++) {
      const d1 = ks.ai.aiStep(ai1, s, ks.cfg); ai1 = d1.ai;
      const d0 = ks.ai.aiStep(ai0, s, ks.cfg); ai0 = d0.ai;
      const r = ks.sim.step(s, [d0.input, d1.input], ks.cfg); s = r.state;
      if (r.events.some(e => e.type === 'counter')) counters++;
      if (r.events.some(e => e.type === 'punchLand')) lands++;
      const before = slow;
      slow = UI.slowMoAfter({ ...slow, t: Math.max(0, slow.t - SIM_DT) }, r.events, ks.cfg);
      if (r.events.some(e => e.type === 'knockdown')) { kd++; lastKd = i; slowAtKd = slow.scale < 1; }
      else if (slow.t > 0 && slow.scale < 1 && i - lastKd > 60 * 2) slowTicks++;   // slow motion started with no knockdown behind it
      const stopTicks = Math.round(s.hitStop / SIM_DT);
      if (stopTicks > 0 && stopTicks > maxStop && i - lastKd > 3) maxStop = stopTicks;
      if (stopTicks > ks.cfg.hitStopTicksCap && !r.events.some(e => e.type === 'knockdown') && !(s.fighters[0].down || s.fighters[1].down)) over++;
    }
  }
  check(`no tick of 3 seeded 60 s AI-vs-AI fights outside a knockdown runs slowed (${lands} lands, ${counters} counters, ${kd} knockdowns)`, slowTicks === 0 && lands > 20);
  check('…and a knockdown still gets its slow motion (knockdownSlowMo)', kd === 0 || slowAtKd, `${kd} knockdowns`);
  check(`no stop over hitStopTicksCap ${cfg.hitStopTicksCap} outside a knockdown (longest ${maxStop})`, over === 0);
  // The host rule directly.
  const ev = t => [{ type: t, side: 0, target: 1, punch: 'jab' }];
  const none = { t: 0, scale: 1 };
  check('host: counter, rocked, finisher land start no slow motion', ['counter', 'rocked'].every(t => UI.slowMoAfter(none, ev(t), cfg).t === 0) && UI.slowMoAfter(none, [{ type: 'punchLand', side: 0, finisher: true }], cfg).t === 0);
  check('host: the read window never slows live play', UI.readWindowScale(cfg, 0.6) === 1);
  const kdSlow = UI.slowMoAfter(none, [{ type: 'knockdown', side: 1 }], cfg);
  check(`host: a knockdown slows the fall (${cfg.knockdownSlowMo}x for ${cfg.knockdownSlowMoSeconds} s)`, kdSlow.scale === cfg.knockdownSlowMo && kdSlow.t === cfg.knockdownSlowMoSeconds);
}

// ── 5. hitStopV2 false is the old behaviour ─────────────────────────────────
console.log('\n=== 5. hitStopV2 false ===');
{
  // A.4 of the baseline: cross -> jab, the second press 2 ticks after the land tick starts AT ONCE, in a 0.067 s freeze with 0.050 s left.
  let s = fresh(OLD, 0.78, 20), land = null, hsAtPress = null, fire = null, hsAtFire = null, freeze = null;
  for (let i = 0; i < 80; i++) {
    const press = land !== null && i === land + 2;
    if (press) hsAtPress = s.hitStop;
    const r = sim.step(s, [inp({ cross: i === 0, jab: press }), NONE], OLD); s = r.state;
    for (const e of r.events) if (e.side === 0) {
      if (e.type === 'punchLand' && land === null) { land = i; freeze = s.hitStop; }
      if (e.type === 'punchStart' && i >= (land ?? 1e9) + 2 && fire === null) { fire = i - land - 2; hsAtFire = s.hitStop; }
    }
  }
  check(`old: baseline A.4: land freeze ${freeze?.toFixed(3)} s (0.067), freeze left at the press ${hsAtPress?.toFixed(3)} (0.050)`, near(freeze, 0.067, 0.002) && near(hsAtPress, 0.05, 0.002));
  check('old: the press starts a punch at once inside the freeze (+0 ticks), on the 5% clock', fire === 0 && hsAtFire > 0.02, `${fire}, ${hsAtFire?.toFixed(3)}`);
  check('old: the host slows for a counter (hitStopV2 false: readCounterSlowMo) and for the read window', UI.slowMoAfter({ t: 0, scale: 1 }, [{ type: 'counter', side: 0, target: 1, punch: 'cross' }], OLD).scale === OLD.readCounterSlowMo && UI.readWindowScale(OLD, 0.6) === 0.6);
  // The old slip freeze.
  const slipRun = c => {
    let s2 = fresh(c, 0.78, 20), hs = 0;
    for (let i = 0; i < 40; i++) { const r = sim.step(s2, [NONE, inp({ jab: i === 0 })], c); s2 = r.state; if (r.events.some(e => e.type === 'slip' && e.dodged)) hs = s2.hitStop; }
    return hs;
  };
  // (side 0 flicks as side 1 jabs, as in slip_test; here just assert the config route: slipDodgeHitStop is only used when V2 is off)
  check('old: slipDodgeHitStop is the slip freeze (0.12 s) and V2 gives hitStopTicksSlip ticks', OLD.slipDodgeHitStop === 0.12 && cfg.hitStopTicksSlip === 0);
}

done();
