/** punch_test.mjs — range gating, hand selection, edge-triggering, one-at-a-time, event payloads (port of legacy punch_test + reach_test, all four punches). */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, v3len, v3dist } = core;
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const cfg = ({ ...createConfig(), ratingsOn: false, stylesOn: false });
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();

function fresh(dist, c = cfg) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;   // let the gloves settle on the new guard
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
  const { s: preLand } = run(fresh(MID), landTick, tapThen('jab'));   // the head as the fist found it (the impact pose moves it on the land tick)
  check('`at` equals the lead glove position on the land tick', v3dist(o.at, atLand.fighters[0].gloves[0].pos) < 1e-9);
  check('the glove sphere really overlaps the head box as it was at the impact', v3dist(atLand.fighters[0].gloves[0].pos, preLand.fighters[1].headBox) <= atLand.fighters[0].body.gloveR + preLand.fighters[1].headBox.r + 1e-9);
  const hurt = evs.find(e => e.type === 'hurt');
  check('hurt event on the defender with the same impulse', hurt?.side === 1 && hurt?.part === 'head' && near(v3len(hurt.impulse), v3len(o.impulse), 1e-9));
  check('the defender is staggered away (+x)', s.fighters[1].pos.x > MID / 2 + 0.02, `${s.fighters[1].pos.x.toFixed(3)}`);
  check('events come in order punchStart → punchLand → hurt', evs.map(e => e.type).filter(t => t.startsWith('punch') || t === 'hurt').join(',') === 'punchStart,punchLand,hurt', evs.map(e => e.type).join(','));
}
{
  // Close range (CONTRACT 2026-09-03): a cramped straight still lands, at reduced
  // power. v1's no-contact smother is gone.
  const midJab = outcome(run(fresh(MID), 40, tapThen('jab')).evs);
  const midCross = outcome(run(fresh(MID), 40, tapThen('cross')).evs);
  const { evs } = run(fresh(CLOSE), 40, tapThen('jab'));
  const o = outcome(evs);
  check('jab inside smotherDist still lands (a cramped jab is still a jab)', o?.type === 'punchLand', o?.type);
  check('…at reduced power', o?.power < midJab?.power * 0.9, `${o?.power?.toFixed(3)} vs ${midJab?.power?.toFixed(3)} at MID`);
  check('…and still hurts the defender', evs.some(e => e.type === 'hurt' && e.side === 1));
  // Soft arms (2026-09-19): at CLOSE the cross meets the guard glove pinned
  // against the face — the fist on the gloves on the head — and is absorbed
  // as a plain block (never a perfect one: nobody held a block). The jab
  // above still splits the guard and lands.
  // skelOn false (anim Phase 1.1): on the rigid skeleton this close cross no longer meets the pinned guard gloves and lands clean (LOG_SKELETON.md, behavioural shifts).
  const legacy = { ...cfg, skelOn: false };
  const closeCross = run(fresh(CLOSE, legacy), 40, tapThen('cross'), legacy).evs;
  const c = outcome(closeCross);
  // Overhaul 2026-11-11: a RESTING guard pinned on the face is not a block any more (guardPinnedCover) — the fist
  // lands THROUGH the hands at what they left of it. The second punch of every combination was being "blocked" by a
  // guard nobody held. With guardPinnedCover 1 (or guardShapeOn off) it is the plain block it was.
  check('cross inside smotherDist meets the guard gloves pinned on the face: a land THROUGH the hands (cramped and muffled), not a miss', c?.type === 'punchLand' && c.through === true && c.power < midCross.power * 0.5, `${c?.type} ${c?.power?.toFixed(3)} vs ${midCross?.power?.toFixed(3)}`);
  const oldRule = { ...legacy, guardPinnedCover: 1 };
  check('…guardPinnedCover 1: the plain block it was', outcome(run(fresh(CLOSE, oldRule), 40, tapThen('cross'), oldRule).evs)?.type === 'punchBlock');
  check('…and not a perfect block (the guard was not held)', !closeCross.some(e => e.type === 'perfectBlock'));
  check('no punchSmother is emitted any more', !evs.some(e => e.type === 'punchSmother'));
}
{
  // The glove stops at what it hit: through the hold the fist sits ON the
  // surface (solid bodies, 2026-09-18: the target is cut at the surface along
  // the punch line, never inside the head), not at the free-air peak.
  const first = run(fresh(MID), 40, tapThen('jab'));
  const landTick = outcome(first.evs).tick;
  const heldS = run(fresh(MID), landTick + 3, tapThen('jab')).s;
  const held = heldS.fighters[0], hd = heldS.fighters[1];
  const surface = hd.headBox.r + held.body.gloveR * (1 - cfg.contactSquash);
  check('a landed punch records its contact point', held.punch.contact !== null && held.punch.type === 'jab');
  check('…and the glove is held on the surface, not driven on into the head', v3dist(held.gloves[0].target, hd.headBox) >= surface - 0.005 && v3dist(held.gloves[0].pos, hd.headBox) >= surface - 0.005, `target ${v3dist(held.gloves[0].target, hd.headBox).toFixed(3)}, glove ${v3dist(held.gloves[0].pos, hd.headBox).toFixed(3)}, surface ${surface.toFixed(3)}`);
  const whiffed = run(fresh(FAR), 40, tapThen('jab')).s.fighters[0];
  check('a whiffed punch has no contact point', whiffed.punch.contact === null);
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
  // A cross pressed mid-jab is buffered and fires when the jab opens its chain
  // window (combo_test covers the timing) — never two in flight at once.
  const { evs } = run(fresh(MID), 60, i => [inp({ jab: i === 0, cross: i === 3 }), NONE]);
  check('a cross pressed mid-jab waits its turn (one punch at a time, then the cross)', evs.filter(e => e.type === 'punchStart').map(e => e.punch).join(',') === 'jab,cross', evs.filter(e => e.type === 'punchStart').map(e => e.punch).join(','));
  const noBuf = { ...cfg, punchBuffer: 0, punchChainAt: 1 };
  let s0 = fresh(MID); const e0 = [];
  for (let i = 0; i < 60; i++) { const r = sim.step(s0, [inp({ jab: i === 0, cross: i === 3 }), NONE], noBuf); s0 = r.state; e0.push(...r.events); }
  check('punchBuffer 0: a cross pressed mid-jab is dropped (v1 behaviour)', e0.filter(e => e.type === 'punchStart').length === 1);
  const { evs: e2 } = run(fresh(MID), 90, i => [inp({ jab: i === 0, cross: i === 40 }), NONE]);
  check('a cross pressed after the jab finished fires', e2.filter(e => e.type === 'punchStart').map(e => e.punch).join(',') === 'jab,cross');
}
{
  const { evs } = run(fresh(MID), 60, i => [inp({ jab: i === 0, cross: i === 0 }), NONE]);
  check('jab and cross on the same tick: the jab wins, one punch', evs.filter(e => e.type === 'punchStart').length === 1 && evs.find(e => e.type === 'punchStart')?.punch === 'jab');
}
{
  const { evs } = run(fresh(MID), 60, i => [inp({ hook: i === 0, uppercut: i === 0 }), NONE]);
  check('hook and uppercut on the same tick: the hook wins, one punch', evs.filter(e => e.type === 'punchStart').length === 1 && evs.find(e => e.type === 'punchStart')?.punch === 'hook');
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
  // The step-in (2026-09-16): a straight thrown with the stick forward at the
  // press lunges punchStepIn with it. From 1.15 m a standing jab whiffs
  // (lands to ~1.07 with the lean shift); the same jab pressed with the stick
  // forward — one tick, so this is the lunge and not a walk — closes to range and lands.
  const noStep = { ...cfg, punchStepIn: 0 };
  const stepIn = i => [inp({ jab: i === 0, move: { x: 0, y: i === 0 ? 1 : 0 } }), NONE];
  // (Overhaul 2026-11-11: from 1.10 m, not 1.15 — the lunge from 1.15 arrives on the very end of the arm, which is now
  // graded GLANCING; from 1.10 it lands clean. The standing jab whiffs from either.)
  const stood = outcome(run(fresh(1.10), 40, stepIn, noStep).evs);
  const lunged = outcome(run(fresh(1.10), 40, stepIn).evs);
  check('…and it is thrown as the STEP JAB variant', lunged?.variant === 'stepJab', lunged?.variant);
  check('a one-tick stick push at the press does not reach 1.10 m without the step-in', stood?.type === 'punchWhiff', stood?.type);
  check('with the step-in the same jab lunges into range and lands', lunged?.type === 'punchLand', lunged?.type);
  check('…harder than a standing jab (the lunge is momentum)', lunged?.power > standing?.power * 1.05, `${lunged?.power?.toFixed(3)} vs ${standing?.power?.toFixed(3)}`);
  // Context (2026-09-16): hit while backing off = rolling with it — less impulse, but a longer stumble.
  {
    const still = run(fresh(0.9), 40, i => [inp({ jab: i === 6 }), NONE]);
    // The dummy backs off from tick 0; the jab is timed so it still reaches (1.0 → ~0.9 by the resolve is the walk-in below).
    let s = fresh(0.8);
    const evs = [];
    let retreatTick = null;
    for (let i = 0; i < 40; i++) { const r = sim.step(s, [inp({ jab: i === 6 }), inp({ move: { x: 0, y: -1 } })], cfg); s = r.state; for (const e of r.events) evs.push(e); if (retreatTick === null && r.events.some(e => e.type === 'punchLand')) retreatTick = i; }
    const stillLand = outcome(still.evs), retreatLand = evs.find(e => e.type === 'punchLand');
    check('a jab lands on a backing-off dummy in this setup', stillLand?.type === 'punchLand' && retreatLand?.type === 'punchLand', `${stillLand?.type} / ${retreatLand?.type}`);
    check('…with less impulse than on a standing one (rolling with it)', retreatLand && stillLand && v3len(retreatLand.impulse) < v3len(stillLand.impulse) * 0.95, `${retreatLand && v3len(retreatLand.impulse).toFixed(0)} vs ${stillLand && v3len(stillLand.impulse).toFixed(0)} N·s`);
    const noRoll = { ...cfg, punchRollWith: 0, punchRetreatStumble: 0 };
    let s2 = fresh(0.8); let plain = null;
    for (let i = 0; i < 40; i++) { const r = sim.step(s2, [inp({ jab: i === 6 }), inp({ move: { x: 0, y: -1 } })], noRoll); s2 = r.state; plain = plain ?? r.events.find(e => e.type === 'punchLand'); }
    check('punchRollWith 0 restores the full impulse', plain && retreatLand && v3len(plain.impulse) > v3len(retreatLand.impulse), `${plain && v3len(plain.impulse).toFixed(0)} vs ${retreatLand && v3len(retreatLand.impulse).toFixed(0)}`);
  }
  const hookStep = run(fresh(1.05), 3, i => [inp({ hook: i === 0, move: { x: -1, y: 1 } }), NONE]).s;
  check('a hook never steps in', Math.hypot(hookStep.fighters[0].stagger.x, hookStep.fighters[0].stagger.z) < 1e-9, JSON.stringify(hookStep.fighters[0].stagger));
  const half = run(fresh(1.05), 3, i => [inp({ jab: i === 0, move: { x: 0, y: 0.3 } }), NONE]).s;
  check('a stick under punchStepInStick does not step', Math.hypot(half.fighters[0].stagger.x, half.fighters[0].stagger.z) < 1e-9);
  let r = fresh(0.9);
  for (let i = 0; i < 6; i++) r = sim.step(r, [inp({ move: { x: 0, y: -1 } }), NONE], cfg).state;
  const retreating = outcome(run(r, 40, i => [inp({ move: { x: 0, y: -1 }, jab: i === 0 }), NONE]).evs);
  check('backing out of range mid-punch → whiff (resolution is at impact, not the press)', retreating?.type === 'punchWhiff', retreating?.type);
}

// ── 5. Hook and uppercut (legacy punch_test §4–5, reach_test ordering) ──────
// The stick is held only on the press tick: held for the whole punch it walks
// the fighter sideways through its own hook (the legacy test's flake).
const tapWith = (type, moveX) => i => [inp({ [type]: i === 0, move: { x: i === 0 ? moveX : 0, y: 0 } }), NONE];
/** Glove reach at the resolve tick: how far forward of the fighter's centre the fist is. */
function reachOf(type, moveX = 0) {
  let s = fresh(FAR);
  for (let i = 0; i < 60; i++) {
    s = sim.step(s, tapWith(type, moveX)(i), cfg).state;
    const f = s.fighters[0];
    if (f.punch.type !== null && f.punch.resolved) return f.gloves[f.punch.hand === 'lead' ? 0 : 1].pos.x - f.pos.x;
  }
  return null;
}
{
  const hookMid = outcome(run(fresh(0.7), 40, tapWith('hook', -1)).evs);
  const hookClose = outcome(run(fresh(CLOSE), 40, tapWith('hook', -1)).evs);
  check('hook inside smotherDist → punchLand (hooks work at close range)', hookClose?.type === 'punchLand', hookClose?.type);
  // Overhaul 2026-11-11: inside range the hook button throws the SHOVEL HOOK (compact, shovelHookPower of a hook) and the
  // uppercut button the INSIDE UPPERCUT. Still no close-range ramp: the only loss is the variant's own weight.
  check('…as the shovel hook, at its own full power: no close-range ramp on a hook', hookClose?.variant === 'shovelHook' && near(hookClose?.power, hookMid?.power * cfg.shovelHookPower, 0.02), `${hookClose?.variant} ${hookClose?.power?.toFixed(3)} vs ${hookMid?.power?.toFixed(3)} at 0.7 m`);
  const baseOnly = { ...cfg, variantsOn: false };
  const hookCloseBase = outcome(run(fresh(CLOSE), 40, tapWith('hook', -1), baseOnly).evs);
  check('…and with variants off the base hook lands at FULL power at close range', near(hookCloseBase?.power, hookMid?.power, 0.02), `${hookCloseBase?.power?.toFixed(3)}`);
  const upCloseVariant = outcome(run(fresh(CLOSE), 40, tapWith('uppercut', 1)).evs);
  check('an uppercut at close range is the inside uppercut', upCloseVariant?.variant === 'insideUppercut', upCloseVariant?.variant);
  const upClose = outcome(run(fresh(CLOSE), 40, tapWith('uppercut', 1), baseOnly).evs);   // the base punch, for the ordering below
  check('uppercut inside smotherDist → punchLand (locked spec)', upClose?.type === 'punchLand', upClose?.type);
  check('…on the head, with the rear hand', upClose?.part === 'head' && upClose?.hand === 'rear', `${upClose?.part} ${upClose?.hand}`);
  const hookAtMid = outcome(run(fresh(0.75), 40, tapWith('hook', -1)).evs);
  check('hook at 0.75 m lands', hookAtMid?.type === 'punchLand', hookAtMid?.type);
  const cross = outcome(run(fresh(MID), 40, tapThen('cross')).evs);
  check('impulse ordering: uppercut > hook > cross (jabDamage … uppercutDamage)', upClose?.power > hookMid?.power && hookMid?.power > cross?.power, `${upClose?.power?.toFixed(2)} ${hookMid?.power?.toFixed(2)} ${cross?.power?.toFixed(2)}`);
  const reach = { jab: reachOf('jab'), cross: reachOf('cross'), hook: reachOf('hook', -1), uppercut: reachOf('uppercut', -1) };
  check('reach ordering: straights > hook > uppercut', reach.cross > reach.hook && reach.jab > reach.hook && reach.hook > reach.uppercut, JSON.stringify(reach, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v));
  // Hooks and uppercuts are inside punches (elbow bent at contact); the
  // *ReachScale sliders trade the elbow for range.
  check('the hook lands to ≥ 0.78 m centre-to-centre at reach scale 1', reach.hook + fresh(MID).fighters[0].body.gloveR + fresh(MID).fighters[1].body.headR >= 0.78, `${reach.hook?.toFixed(3)}`);
  const longer = { ...cfg, hookReachScale: 1.3 };
  const farHook = outcome(run(fresh(0.9), 40, tapWith('hook', -1), longer).evs);
  check('hookReachScale 1.3 lands a hook at 0.9 m', farHook?.type === 'punchLand', farHook?.type);
  const upFar = outcome(run(fresh(MID), 40, tapWith('uppercut', 1)).evs);
  check('the uppercut is an inside punch: it whiffs at mid range', upFar?.type === 'punchWhiff', upFar?.type);
}
{
  // Hand from the stick at the press: x < 0 = lead, x ≥ 0 = rear (CONTRACT 2026-09-02).
  const start = (type, moveX, st = fresh(MID)) => run(st, 40, tapWith(type, moveX)).evs.find(e => e.type === 'punchStart');
  check('hook with the stick left = lead hand', start('hook', -1)?.hand === 'lead', start('hook', -1)?.hand);
  check('hook with the stick right = rear hand', start('hook', 1)?.hand === 'rear', start('hook', 1)?.hand);
  check('hook with the stick centred = rear hand', start('hook', 0)?.hand === 'rear', start('hook', 0)?.hand);
  check('uppercut follows the same rule', start('uppercut', -1)?.hand === 'lead' && start('uppercut', 1)?.hand === 'rear');
  check('a small nudge counts (any x < 0)', start('hook', -0.1)?.hand === 'lead');
  const flipped = run(fresh(0.7), 8, i => [inp({ hook: i === 0, move: { x: i === 0 ? -1 : 1, y: 0 } }), NONE]);
  check('the hand is locked at the press: flipping the stick mid-punch changes nothing', flipped.evs.find(e => e.type === 'punchStart')?.hand === 'lead' && flipped.s.fighters[0].punch.type === 'hook' && flipped.s.fighters[0].punch.hand === 'lead');
  const sp = [{ ...ROSTER[0], stance: 'southpaw' }, ROSTER[1]];
  let s = sim.createState(sp, cfg, 1);
  s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], cfg).state;
  check('southpaw: stick left is still the lead hand (the rule is stance-independent)', start('hook', -1, s)?.hand === 'lead');
}
{
  // A hook sends the head sideways: its impulse follows the fist across the face.
  // 0.75 m (was 0.7): with the arms in the sim (2026-09-18) the rear hook at
  // 0.7 meets the dummy's guard forearm and is absorbed as a block.
  const lead = outcome(run(fresh(0.75), 40, tapWith('hook', -1)).evs);
  const rear = outcome(run(fresh(0.75), 40, tapWith('hook', 1)).evs);
  check('lead hook (from -z) carries a +z impulse component; rear hook (from +z) carries -z', lead?.impulse.z > 0 && rear?.impulse.z < 0, `${lead?.impulse.z?.toFixed(0)} / ${rear?.impulse.z?.toFixed(0)}`);
  check('…and both still drive the defender back (+x)', lead?.impulse.x > 0 && rear?.impulse.x > 0);
  check('the sideways part of a hook is comparable to the back part (≈45°, swing 0.85 on a 55° arc)', Math.abs(lead?.impulse.z) > Math.abs(lead?.impulse.x) * 0.7, `${lead?.impulse.z?.toFixed(0)} vs ${lead?.impulse.x?.toFixed(0)}`);
  const up = outcome(run(fresh(CLOSE), 40, tapWith('uppercut', 1)).evs);
  check('an uppercut\'s impulse stays on the attacker→defender line (the lift is the reaction\'s job)', Math.abs(up?.impulse.z) < Math.abs(up?.impulse.x) * 0.15, `${up?.impulse.z?.toFixed(0)} vs ${up?.impulse.x?.toFixed(0)}`);
  const jab = outcome(run(fresh(MID), 40, tapThen('jab')).evs);
  check('a straight keeps a straight impulse', jab?.impulse.z === 0);
}
{
  // Contact rests where the glove touched: on the head surface along the
  // line from the head's centre to the glove. A hook finishes just past the
  // centreline, so it rests on the point of the chin, mirrored per hand.
  const landTickOf = (type, moveX, dist = 0.7) => outcome(run(fresh(dist), 40, tapWith(type, moveX)).evs).tick;
  const heldAfter = (type, moveX, dist = 0.7) => run(fresh(dist), landTickOf(type, moveX, dist) + 2, tapWith(type, moveX)).s;
  const held = heldAfter('hook', -1);
  const a = held.fighters[0], d = held.fighters[1];
  const r = d.headBox.r + a.body.gloveR * (1 - cfg.contactSquash);
  // Solid bodies (2026-09-18): the glove is not steered to the contact point
  // any more — it is stopped AT the surface by clampGloves and presses on.
  check('a landed hook records a contact point and the glove sits on the head surface (not inside it)', a.punch.contact !== null && v3dist(a.gloves[0].pos, d.headBox) >= r - 0.005, `glove ${v3dist(a.gloves[0].pos, d.headBox).toFixed(3)} from the head centre, surface at ${r.toFixed(3)}`);
  {
    const soft = { ...cfg, contactSolid: 0 };
    const landTick = outcome(run(fresh(0.7, soft), 40, tapWith('hook', -1), soft).evs).tick;
    const s = run(fresh(0.7, soft), landTick + 2, tapWith('hook', -1), soft).s;
    check('contactSolid 0: the old way, the glove target moves to the contact point for the hold', v3dist(s.fighters[0].gloves[0].target, s.fighters[0].punch.contact) < 1e-9);
  }
  // Against the head as it was when the fist arrived: the impact pose (2026-09-19) moves the head on the land tick itself.
  const before = run(fresh(0.7), landTickOf('hook', -1), tapWith('hook', -1)).s.fighters[1];
  check('the contact point sits one (squashed) glove radius off the head surface (where the head was at the impact)', near(v3dist(a.punch.contact, before.headBox), r, 0.03), `${v3dist(a.punch.contact, before.headBox).toFixed(3)} vs ${r.toFixed(3)}`);
  check('…on the attacker\'s side of the head', a.punch.contact.x < d.headBox.x, `${(a.punch.contact.x - d.headBox.x).toFixed(3)}`);
  const rear = heldAfter('hook', 1).fighters[0];
  check('lead and rear hooks rest on mirrored sides of the chin', a.punch.contact.z > rear.punch.contact.z, `${a.punch.contact.z.toFixed(3)} vs ${rear.punch.contact.z.toFixed(3)}`);
  const up = heldAfter('uppercut', 1, CLOSE);
  const ua = up.fighters[0], ud = up.fighters[1];
  check('an uppercut rests under the chin: contact below the head centre', ua.punch.contact !== null && ua.punch.contact.y < ud.headBox.y, `${ua.punch.contact && (ua.punch.contact.y - ud.headBox.y).toFixed(3)}`);
}

done();
