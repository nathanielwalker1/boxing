/** determinism_test.mjs — same seed + same inputs → identical state; step never mutates its input; state is plain data. */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput } = core;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });

/** A 600-tick script: walk in, jab, cross, block, circle; the dummy blocks and throws once. */
function script(i) {
  const a = inp();
  const b = inp();
  // 40 ticks of walking + coast leaves ~0.83 m: in the jab's landing band. Any
  // longer and the pair hits the separation floor, where the jab smothers.
  if (i < 40) a.move = { x: 0, y: 1 };
  if (i === 100) a.jab = true;
  if (i >= 130 && i < 160) a.cross = true;             // held: fires once
  if (i >= 200 && i < 260) a.block = true;
  if (i >= 260 && i < 400) a.move = { x: 1, y: 0.2 };
  if (i === 300) a.jab = true;
  if (i >= 420 && i < 480) a.move = { x: 0, y: -1 };
  if (i === 500) a.cross = true;
  if (i >= 90 && i < 110) b.block = true;
  if (i === 320) b.jab = true;
  if (i >= 340 && i < 360) b.move = { x: -1, y: 0 };
  return [a, b];
}
function play(seed, n = 600) {
  let s = sim.createState(specs, cfg, seed);
  const evs = [];
  for (let i = 0; i < n; i++) { const r = sim.step(s, script(i), cfg); s = r.state; evs.push(...r.events); }
  return { s, evs };
}

// ── 1. Two runs, same seed ──────────────────────────────────────────────────
{
  const a = play(7), b = play(7);
  check('final states are byte-identical (JSON)', JSON.stringify(a.s) === JSON.stringify(b.s));
  check('event streams are identical', JSON.stringify(a.evs) === JSON.stringify(b.evs));
  const kinds = new Set(a.evs.map(e => e.type));
  check('the script exercised the systems (start, land, block, whiff/smother, hurt)', kinds.has('punchStart') && kinds.has('punchLand') && kinds.has('punchBlock') && kinds.has('hurt'), [...kinds].join(','));
  check('600 ticks advanced', a.s.tick === 600 && a.s.time > 9);
  check('the fight is still on (round clock not expired)', a.s.round.phase === 'fighting');
}

// ── 2. step never mutates its input ─────────────────────────────────────────
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}
{
  let s = sim.createState(specs, cfg, 3);
  for (let i = 0; i < 95; i++) s = sim.step(s, script(i), cfg).state;   // mid-walk, dummy blocking
  const before = JSON.stringify(s);
  deepFreeze(s);
  let threw = null;
  try { for (let i = 95; i < 140; i++) { const r = sim.step(s, script(i), cfg); s = r.state; deepFreeze(s); } }
  catch (e) { threw = e; }
  check('stepping a deep-frozen state never writes into it', threw === null, threw ? String(threw) : '');
  check('the frozen run reached the punch exchange', s.tick === 140 && before.length > 0);
}
{
  let s = sim.createState(specs, cfg, 3);
  const inputs = script(0);
  deepFreeze(inputs);
  let threw = null;
  try { sim.step(s, inputs, cfg); } catch (e) { threw = e; }
  check('step never writes into its inputs', threw === null);
  const snapshot = JSON.stringify(s);
  sim.step(s, script(0), cfg);
  check('the input state is unchanged (JSON before == after)', JSON.stringify(s) === snapshot);
}

// ── 3. State is plain data: survives a JSON round trip ──────────────────────
{
  let s = sim.createState(specs, cfg, 11);
  for (let i = 0; i < 120; i++) s = sim.step(s, script(i), cfg).state;
  const copy = JSON.parse(JSON.stringify(s));
  let a = s, b = copy;
  for (let i = 120; i < 300; i++) { a = sim.step(a, script(i), cfg).state; b = sim.step(b, script(i), cfg).state; }
  check('a JSON round-tripped state steps identically (no hidden references)', JSON.stringify(a) === JSON.stringify(b));
  check('createState is reproducible', JSON.stringify(sim.createState(specs, cfg, 11)) === JSON.stringify(sim.createState(specs, cfg, 11)));
}

// ── 3b. Overhaul 2026-11-11: the new systems, same guarantees ───────────────
// A script that drives every new input combination: level, body shots, a roll, a pivot, a double-tap burst, a feint,
// a push-off, a clinch, a slip chain, a guard under fire — with the AI (and its tools) on side 1.
{
  const [aiMod] = await load('/src/ai/index.ts');
  const flick = (i, at, x, y) => (i >= at && i < at + 2 ? { x, y } : null);
  function script2(i) {
    const a = inp();
    const mv = flick(i, 60, 1, 0) ?? flick(i, 67, -1, 0) ?? flick(i, 150, 0, 1) ?? flick(i, 153, 0, 1) ?? flick(i, 260, 1, 0) ?? flick(i, 330, 0, 1) ?? flick(i, 420, -1, 0);
    if (i < 45) a.move = { x: 0, y: 1 };
    if (mv) a.move = mv;
    if (i >= 90 && i < 120) a.level = true;
    if (i === 100) a.jab = true;            // body jab
    if (i === 112) a.hook = true;           // body hook
    if (i === 180) a.cross = true;
    if (i >= 183 && i < 190) a.block = true;   // feint
    if (i >= 255 && i < 264) a.block = true;   // pivot (with the flick at 260)
    if (i >= 325 && i < 334) a.block = true;   // push-off (with the flick at 330)
    if (i >= 380 && i < 410) { a.block = true; a.level = true; }   // clinch
    if (i >= 415 && i < 424) a.level = true;   // roll (with the flick at 420)
    if (i === 470 || i === 474 || i === 490) a.jab = true;
    if (i === 478) a.cross = true;
    if (i >= 520 && i < 600) a.block = true;
    return a;
  }
  function play2(seed, n = 700) {
    let s = sim.createState(specs, cfg, seed);
    let a = aiMod.createAi(1, seed, cfg);
    const evs = [];
    for (let i = 0; i < n; i++) {
      const d = aiMod.aiStep(a, s, cfg); a = d.ai;
      const r = sim.step(s, [script2(i), d.input], cfg); s = r.state; evs.push(...r.events);
    }
    return { s, evs, a };
  }
  const a = play2(5), b = play2(5);
  check('overhaul: two runs of the new-systems script are byte-identical (state, events, AI)', JSON.stringify(a.s) === JSON.stringify(b.s) && JSON.stringify(a.evs) === JSON.stringify(b.evs) && JSON.stringify(a.a) === JSON.stringify(b.a));
  const kinds = new Set(a.evs.map(e => e.type));
  const want = ['slip', 'burst', 'feint', 'pivot', 'pushOff', 'punchStart'];
  check(`…and that script exercised the new moves (${want.filter(w => kinds.has(w)).join(', ')})`, want.every(w => kinds.has(w)), [...kinds].join(','));
  const variants = new Set(a.evs.filter(e => e.type === 'punchStart').map(e => e.variant));
  check(`…and several variants (${[...variants].join(', ')})`, variants.size >= 4);
  // Every new field is cloned: stepping a deep-frozen state through the whole script never writes into it.
  let s = sim.createState(specs, cfg, 5), ai2 = aiMod.createAi(1, 5, cfg), threw = null;
  try {
    for (let i = 0; i < 700; i++) { deepFreeze(s); deepFreeze(ai2); const d = aiMod.aiStep(ai2, s, cfg); ai2 = d.ai; s = sim.step(s, [script2(i), d.input], cfg).state; }
  } catch (e) { threw = e; }
  check('overhaul: a deep-frozen state (and AI state) is never written into across the whole script', threw === null, threw ? String(threw) : '');
  // JSON round trip mid-fight with every new field live.
  let p = sim.createState(specs, cfg, 5), pa = aiMod.createAi(1, 5, cfg);
  for (let i = 0; i < 400; i++) { const d = aiMod.aiStep(pa, p, cfg); pa = d.ai; p = sim.step(p, [script2(i), d.input], cfg).state; }
  let q = JSON.parse(JSON.stringify(p)), qa = JSON.parse(JSON.stringify(pa));
  for (let i = 400; i < 700; i++) {
    const d1 = aiMod.aiStep(pa, p, cfg); pa = d1.ai; p = sim.step(p, [script2(i), d1.input], cfg).state;
    const d2 = aiMod.aiStep(qa, q, cfg); qa = d2.ai; q = sim.step(q, [script2(i), d2.input], cfg).state;
  }
  check('overhaul: a JSON round-tripped state + AI step identically (plain data, no hidden references)', JSON.stringify(p) === JSON.stringify(q) && JSON.stringify(pa) === JSON.stringify(qa));
  const f = p.fighters[0];
  const fields = ['level', 'riseT', 'range', 'posture', 'stillT', 'flat', 'ropes', 'cornered', 'angle', 'turned', 'hop', 'burstT', 'burstCd', 'pivot', 'tap', 'guardHp', 'guardBroken', 'blockStun', 'guardDroop', 'fatigue', 'punchSlow', 'staminaCap', 'wear', 'guardRest', 'damage', 'hurtKind', 'buckle', 'liverT', 'liverMag', 'clinch', 'pushCd', 'getUp', 'loaded', 'loadedT', 'combo', 'comboT'];
  check('every new FighterState field is present on the stepped state', fields.every(k => f[k] !== undefined), fields.filter(k => f[k] === undefined).join(','));
}

// ── 4. The rng state is carried, not consumed by Math.random ────────────────
{
  const a = play(1, 200).s, b = play(2, 200).s;
  check('the seed is carried in the state', a.seed === 1 && b.seed === 2);
  check('the rng words differ by seed', JSON.stringify(a.rng) !== JSON.stringify(b.rng));
}

done();
