/** block_test.mjs — block absorbs, block/punch mutual exclusion, instant switching (port of legacy block_test). */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, v3len } = core;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;

function fresh(dist = MID) {
  let s = sim.createState(specs, cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], cfg).state;
  return s;
}
function run(s, n, inputs, onTick) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), cfg);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (onTick) onTick(s, i, r.events);
  }
  return { s, evs };
}
const outcome = evs => evs.find(e => e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchSmother' || e.type === 'punchBlock');

// ── 1. A blocked punch ──────────────────────────────────────────────────────
const clean = run(fresh(), 40, i => [inp({ jab: i === 0 }), NONE]);
const blocked = run(fresh(), 40, i => [inp({ jab: i === 0 }), inp({ block: true })]);
{
  const o = outcome(blocked.evs);
  check('jab into a held block → punchBlock, no punchLand', o?.type === 'punchBlock' && !blocked.evs.some(e => e.type === 'punchLand'), o?.type);
  check('punchBlock carries side, target, punch, at', o?.side === 0 && o?.target === 1 && o?.punch === 'jab' && typeof o?.at?.x === 'number');
  const hc = clean.evs.find(e => e.type === 'hurt'), hb = blocked.evs.find(e => e.type === 'hurt');
  check('the blocked hurt impulse is reduced by blockReduction', hb && hc && near(v3len(hb.impulse), v3len(hc.impulse) * (1 - cfg.blockReduction), 1e-6), `${v3len(hb?.impulse ?? { x: 0, y: 0, z: 0 }).toFixed(2)} vs ${v3len(hc?.impulse ?? { x: 0, y: 0, z: 0 }).toFixed(2)}`);
  check('a blocked defender staggers less than a clean one', blocked.s.fighters[1].pos.x < clean.s.fighters[1].pos.x);
  check('a blocked defender still moves a little (block absorbs, does not delete)', blocked.s.fighters[1].pos.x > MID / 2 + 1e-4);
  check('the defender is in the block guard', blocked.s.fighters[1].block && blocked.s.fighters[1].guard === 'block');
  const noBlock = { ...cfg, blockReduction: 0 };
  let s = fresh();
  const evs = [];
  for (let i = 0; i < 40; i++) { const r = sim.step(s, [inp({ jab: i === 0 }), inp({ block: true })], noBlock); s = r.state; evs.push(...r.events); }
  const hb0 = evs.find(e => e.type === 'hurt');
  check('blockReduction = 0: the block event still fires but at full impulse', outcome(evs)?.type === 'punchBlock' && near(v3len(hb0.impulse), v3len(hc.impulse), 1e-6));
}

// ── 2. Block pose: gloves rise and tighten ──────────────────────────────────
{
  const rest = fresh();
  const { s } = run(rest, 40, () => [inp({ block: true }), NONE]);
  for (const i of [0, 1]) {
    check(`glove ${i} is higher while blocking`, s.fighters[0].gloves[i].pos.y > rest.fighters[0].gloves[i].pos.y + 0.02, `${s.fighters[0].gloves[i].pos.y.toFixed(3)} vs ${rest.fighters[0].gloves[i].pos.y.toFixed(3)}`);
    check(`glove ${i} is pulled in laterally while blocking`, Math.abs(s.fighters[0].gloves[i].pos.z) < Math.abs(rest.fighters[0].gloves[i].pos.z));
  }
  check('blockT counts the seconds the guard has been up', near(s.fighters[0].blockT, 39 * SIM_DT, 1e-9), `${s.fighters[0].blockT}`);
  const { s: released } = run(s, 1, () => [NONE, NONE]);
  check('release: block off, blockT reset on the very next tick', !released.fighters[0].block && released.fighters[0].blockT === 0 && released.fighters[0].guard === 'rest');
}

// ── 3. Mutual exclusion ─────────────────────────────────────────────────────
{
  const { s, evs } = run(fresh(), 30, () => [inp({ block: true, jab: true }), NONE]);
  check('cannot punch while blocking', !evs.some(e => e.type === 'punchStart') && s.fighters[0].punch.type === null);
  check('…and the block is up', s.fighters[0].block);
}
{
  // Held jab under a held block, then release block: the flag was never an
  // edge, so nothing fires (v1 JustDown semantics).
  const { evs } = run(fresh(), 40, i => [inp({ block: i < 20, jab: true }), NONE]);
  check('a jab held under the block does not fire when the block drops', !evs.some(e => e.type === 'punchStart'));
}
{
  // Release block on tick 20 and press jab on the same tick: fires that tick.
  let fired = null;
  run(fresh(), 40, i => [inp({ block: i < 20, jab: i === 20 }), NONE], (s, i, evs) => { if (fired === null && evs.some(e => e.type === 'punchStart')) fired = i; });
  check('a punch fires on the very tick the block is released', fired === 20, `fired at ${fired}`);
}
{
  // Punch, then hold block from the next tick: the punch plays out, and the
  // block engages the tick after the punch finishes.
  let endTick = null, blockOn = null, blockedDuring = false;
  run(fresh(), 60, i => [inp({ jab: i === 0, block: i >= 1 }), NONE], (s, i) => {
    const f = s.fighters[0];
    if (f.punch.type !== null && f.block) blockedDuring = true;
    if (endTick === null && i > 0 && f.punch.type === null) endTick = i;
    if (blockOn === null && f.block) blockOn = i;
  });
  check('block never engages while the punch is in flight', !blockedDuring);
  check('block engages on the tick after the punch finishes', endTick !== null && blockOn === endTick + 1, `punch ended ${endTick}, block on ${blockOn}`);
}
{
  // Dummy side: block is a level for either fighter.
  const { s } = run(fresh(), 10, () => [NONE, inp({ block: true })]);
  check('side 1 blocks from input too', s.fighters[1].block && s.fighters[1].guard === 'block');
}

done();
