/** punch_test.mjs — range gating, hand selection, edge-triggering, one-at-a-time, event payloads (port of legacy punch_test + reach_test jab/cross cases). */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, v3len, v3dist } = core;
const cfg = createConfig();
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();

function fresh(dist) {
  let s = sim.createState(specs, cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], cfg).state;   // let the gloves settle on the new guard
  return s;
}
/** Run n ticks; returns final state and events tagged with their tick. */
function run(s, n, inputs, c = cfg) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const r = sim.step(s, inputs(i), c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
  }
  return { s, evs };
}
const tapThen = (type, hold = {}) => i => [inp({ ...hold, [type]: i === 0 }), NONE];
const outcome = evs => evs.find(e => e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchSmother' || e.type === 'punchBlock');

const FAR = 1.3, MID = 0.79, CLOSE = 0.5;
check(`test distances bracket the band (smother ${cfg.smotherDist}, rangeMax ${cfg.rangeMax})`, CLOSE < cfg.smotherDist && MID > cfg.smotherDist && MID < cfg.rangeMax && FAR > cfg.rangeMax);

// ── 1. Range gating ─────────────────────────────────────────────────────────
{
  const { evs } = run(fresh(FAR), 40, tapThen('jab'));
  const o = outcome(evs);
  check('jab far outside reach → punchWhiff', o?.type === 'punchWhiff', o?.type);
  check('whiff carries side and punch', o?.side === 0 && o?.punch === 'jab');
  check('a whiff does not hurt anyone', !evs.some(e => e.type === 'hurt'));
}
{
  // Just inside rangeMax but beyond the glove: the geometric test whiffs too.
  const { evs } = run(fresh(cfg.rangeMax - 0.05), 40, tapThen('jab'));
  check('inside rangeMax but beyond the glove → whiff (landing is geometric)', outcome(evs)?.type === 'punchWhiff', outcome(evs)?.type);
}
{
  const { s, evs } = run(fresh(MID), 40, tapThen('jab'));
  const o = outcome(evs);
  check('jab at mid range → punchLand', o?.type === 'punchLand', o?.type);
  check('lands on the head', o?.part === 'head', o?.part);
  check('land carries side 0 → target 1, jab, lead hand', o?.side === 0 && o?.target === 1 && o?.punch === 'jab' && o?.hand === 'lead');
  check('impulse points from attacker to defender (+x), no vertical component', o?.impulse.x > 0 && o?.impulse.y === 0 && Math.abs(o?.impulse.z) < 1e-9, JSON.stringify(o?.impulse));
  check('power is positive and near the jab multiplier', o?.power > 0.5 && o?.power < 1.2, `${o?.power}`);
  const landTick = o.tick;
  const { s: atLand } = run(fresh(MID), landTick + 1, tapThen('jab'));
  check('`at` equals the lead glove position on the land tick', v3dist(o.at, atLand.fighters[0].gloves[0].pos) < 1e-9);
  check('the glove sphere really overlaps the head box on the land tick', v3dist(atLand.fighters[0].gloves[0].pos, atLand.fighters[1].headBox) <= atLand.fighters[0].body.gloveR + atLand.fighters[1].headBox.r + 1e-9);
  const hurt = evs.find(e => e.type === 'hurt');
  check('hurt event on the defender with the same impulse', hurt?.side === 1 && hurt?.part === 'head' && near(v3len(hurt.impulse), v3len(o.impulse), 1e-9));
  check('the defender is staggered away (+x)', s.fighters[1].pos.x > MID / 2 + 0.02, `${s.fighters[1].pos.x.toFixed(3)}`);
  check('events come in order punchStart → punchLand → hurt', evs.map(e => e.type).filter(t => t.startsWith('punch') || t === 'hurt').join(',') === 'punchStart,punchLand,hurt', evs.map(e => e.type).join(','));
}
{
  const { evs } = run(fresh(CLOSE), 40, tapThen('jab'));
  const o = outcome(evs);
  check('jab inside smotherDist → punchSmother', o?.type === 'punchSmother', o?.type);
  check('smother carries side, target, punch', o?.side === 0 && o?.target === 1 && o?.punch === 'jab');
  const c = outcome(run(fresh(CLOSE), 40, tapThen('cross')).evs);
  check('cross inside smotherDist → punchSmother too', c?.type === 'punchSmother', c?.type);
}

// ── 2. Hand selection ───────────────────────────────────────────────────────
{
  const j = run(fresh(MID), 40, tapThen('jab')).evs.find(e => e.type === 'punchStart');
  const c = run(fresh(MID), 40, tapThen('cross')).evs.find(e => e.type === 'punchStart');
  check('jab = lead hand', j?.hand === 'lead', j?.hand);
  check('cross = rear hand', c?.hand === 'rear', c?.hand);
  const jl = run(fresh(MID), 40, tapThen('jab', { move: { x: 1, y: 0 } })).evs.find(e => e.type === 'punchStart');
  check('jab ignores the joystick direction', jl?.hand === 'lead');
  const cl = outcome(run(fresh(MID), 40, tapThen('cross')).evs);
  check('cross lands with the rear hand', cl?.type === 'punchLand' && cl?.hand === 'rear', `${cl?.type} ${cl?.hand}`);
  check('cross hits harder than the jab', cl?.power > outcome(run(fresh(MID), 40, tapThen('jab')).evs)?.power);
}
{
  // Southpaw: lead is the right hand; the jab still comes off the lead.
  const sp = [{ ...ROSTER[0], stance: 'southpaw' }, ROSTER[1]];
  let s = sim.createState(sp, cfg, 1);
  s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], cfg).state;
  check('southpaw lead glove sits on the right (+z facing +x)', s.fighters[0].gloves[0].pos.z > 0);
  const { evs } = run(s, 40, tapThen('jab'));
  check('southpaw jab is still the lead hand and lands', evs.find(e => e.type === 'punchStart')?.hand === 'lead' && outcome(evs)?.type === 'punchLand');
}

// ── 3. Edge-triggering and one punch at a time ──────────────────────────────
{
  const { evs } = run(fresh(MID), 90, () => [inp({ jab: true }), NONE]);
  check('a held jab flag fires exactly once', evs.filter(e => e.type === 'punchStart').length === 1, `${evs.filter(e => e.type === 'punchStart').length}`);
}
{
  const { evs } = run(fresh(MID), 60, i => [inp({ jab: i === 0, cross: i === 3 }), NONE]);
  check('a cross pressed mid-jab is ignored (one punch at a time)', evs.filter(e => e.type === 'punchStart').length === 1);
  const { evs: e2 } = run(fresh(MID), 90, i => [inp({ jab: i === 0, cross: i === 40 }), NONE]);
  check('a cross pressed after the jab finished fires', e2.filter(e => e.type === 'punchStart').map(e => e.punch).join(',') === 'jab,cross');
}
{
  const { evs } = run(fresh(MID), 60, i => [inp({ jab: i === 0, cross: i === 0 }), NONE]);
  check('jab and cross on the same tick: the jab wins, one punch', evs.filter(e => e.type === 'punchStart').length === 1 && evs.find(e => e.type === 'punchStart')?.punch === 'jab');
}
{
  const { evs } = run(fresh(MID), 60, i => [inp({ hook: i === 0, uppercut: i === 2 }), NONE]);
  check('hook / uppercut are not in the Stage-1 table: no punch starts', !evs.some(e => e.type === 'punchStart'));
}
{
  const { s, evs } = run(fresh(MID), 40, i => [NONE, inp({ jab: i === 0 })]);
  const o = outcome(evs);
  check('the dummy side can throw too: side 1 jab lands on side 0', o?.type === 'punchLand' && o?.side === 1 && o?.target === 0, `${o?.type} ${o?.side}`);
  check('its impulse points toward side 0 (-x)', o?.impulse.x < 0);
  check('side 0 is pushed toward -x', s.fighters[0].pos.x < -MID / 2 - 0.02);
}

// ── 4. Momentum: an advancing jab hits harder ───────────────────────────────
{
  const standing = outcome(run(fresh(MID), 40, tapThen('jab')).evs);
  // 6 ticks of run-up + 8 ticks to the jab's peak closes ~0.4 m, so start at
  // 1.2 m to arrive at MID on the resolve tick (from 1.0 m it is a smother).
  let s = fresh(1.2);
  for (let i = 0; i < 6; i++) s = sim.step(s, [inp({ move: { x: 0, y: 1 } }), NONE], cfg).state;
  const advancing = outcome(run(s, 40, i => [inp({ move: { x: 0, y: 1 }, jab: i === 0 }), NONE]).evs);
  check('an advancing jab lands', advancing?.type === 'punchLand', advancing?.type);
  check('…and carries more impulse than a standing one', advancing?.power > standing?.power * 1.05, `${advancing?.power?.toFixed(3)} vs ${standing?.power?.toFixed(3)}`);
  let r = fresh(0.9);
  for (let i = 0; i < 6; i++) r = sim.step(r, [inp({ move: { x: 0, y: -1 } }), NONE], cfg).state;
  const retreating = outcome(run(r, 40, i => [inp({ move: { x: 0, y: -1 }, jab: i === 0 }), NONE]).evs);
  check('backing out of range mid-punch → whiff (resolution is at impact, not the press)', retreating?.type === 'punchWhiff', retreating?.type);
}

done();
