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

// ── 4. The rng state is carried, not consumed by Math.random ────────────────
{
  const a = play(1, 200).s, b = play(2, 200).s;
  check('the seed is carried in the state', a.seed === 1 && b.seed === 2);
  check('the rng words differ by seed', JSON.stringify(a.rng) !== JSON.stringify(b.rng));
}

done();
