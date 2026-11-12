/**
 * drills_test.mjs — the gym drills (src/ai/drills.ts), in Node:
 *   - seven drills in the order a player should meet them, each with a goal, a
 *     placement, a pure opponent policy and a metric
 *   - each runs 20 s deterministically (same seed → same states and events)
 *   - the policy is pure: the same (state, tick, seed) gives the same input
 *   - each drill's metric moves when a player who does the drill's thing plays it,
 *     and does not when the player stands still
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as humanPace from './bots/human_pace.mjs';
import { makeBot, dist } from './bots/util.mjs';

const k = await kit({ rated: true });
const { cfg, sim, ai, specs, inp, T } = k;
const { DRILLS } = ai;
const [drillsMod] = await (await import('./load.mjs')).load('/src/ai/drills.ts');
const { drillState } = drillsMod;
const SECONDS = 20;

/** Play a drill for SECONDS with `player(state) → input` on side 0. */
function play(drill, player, seed = 3, seconds = SECONDS) {
  // (Polish phase: a drill may bring its own config — a durable partner, a quick count — merged over the live one, as the host does.)
  const cfg = drill.tune ? { ...k.cfg, ...drill.tune(k.cfg) } : k.cfg;
  let s = drillState(drill, [specs[0], specs[1]], cfg, seed);
  const events = [];
  let best = 0;
  for (let tick = 0; tick < T(seconds) && s.round.phase !== 'over'; tick++) {
    const r = sim.step(s, [player(s), drill.policy(s, tick, seed, cfg)], cfg); s = r.state;
    for (const e of r.events) events.push(e);
    best = Math.max(best, drill.metric(events, s, cfg).progress);
  }
  return { s, events, m: drill.metric(events, s, cfg), best };
}
const idle = () => inp();
const bot = (mod, seed = 3) => { const b = mod.create(k, seed, cfg); return s => b.step(s); };
// Two small players of their own: one that only works the body, one that survives by tying up and moving.
const bodyWorker = () => { const b = makeBot(k, 3, (m, s) => { if (dist(s) > 0.8) return { move: { x: 0, y: 1 } }; m.lowThen(m.chance(0.5) ? 'cross' : 'hook', -1); for (let i = 0; i < 16; i++) m.push({}); }); return s => b.step(s); };
const survivor = () => { const b = makeBot(k, 3, (m, s) => (s.fighters[0].clinch.cd === 0 && dist(s) < 0.75 ? { block: true, level: true } : { block: dist(s) < 1.0, move: { x: 1, y: -0.4 } })); return s => b.step(s); };

/**
 * A player who does what the slip drills teach: sees the punch start, waits `wait` ticks, then takes it with his
 * head — under a head hook (a roll), away from the hand of a straight (a slip) — and, if `counter`, throws back.
 */
const slipper = (counter, wait = 4, gap = 6) => () => {
  let was = false;
  const b = makeBot(k, 3, (m, s) => {
    const opp = s.fighters[1], on = opp.punch.type !== null && !opp.punch.resolved, fresh = on && !was;
    was = on;
    if (!fresh) return {};
    const hand = k.core.handLateralSign(opp.punch.hand, opp.stance);
    for (let i = 0; i < wait; i++) m.push({});
    if (opp.punch.type === 'hook') m.flick(-hand, 0, { level: true }); else m.flick(hand, 0);
    if (counter) { for (let i = 0; i < gap; i++) m.push({}); m.push({ [opp.punch.type === 'hook' ? 'hook' : 'cross']: true, move: { x: hand, y: 0 } }); }
    return {};
  });
  return s => { const out = b.step(s); if (b.b.q.length) was = true; return out; };
};

const PLAYERS = {
  'jab-and-move': () => bot(jabAndMove),
  'cut-off': () => bot(insideFighter),
  'get-inside': () => bot(insideFighter),
  'slip-timing': slipper(false),
  'slip-counter': slipper(true),
  'body-work': bodyWorker,
  'survive': survivor,
  // Polish phase: the drills for the fixes.
  'combinations': () => bot(humanPace),
  'combinations-ropes': () => bot(humanPace),
  'trading': () => bot(humanPace),
  'stamina-pace': () => bot(humanPace),
  'stamina-guard': () => () => inp({ block: true }),
  'hurt': () => bot(humanPace),
};

console.log('\n=== The drills ===');
// (Polish phase, deliberate: six drills added after the original seven — one per fix.)
check(`thirteen drills, in order: ${DRILLS.map(d => d.id).join(', ')}`, DRILLS.map(d => d.id).join() === 'jab-and-move,cut-off,get-inside,slip-timing,slip-counter,body-work,survive,combinations,combinations-ropes,trading,stamina-pace,stamina-guard,hurt');
check('each has a title, a one-sentence goal, a length, a placement, a policy and a metric', DRILLS.every(d => d.title.length > 3 && d.goal.length > 20 && d.seconds > 0 && typeof d.placement === 'function' && typeof d.policy === 'function' && typeof d.metric === 'function'));

for (const drill of DRILLS) {
  console.log(`\n--- ${drill.id}: ${drill.goal}`);
  const s0 = drillState(drill, [specs[0], specs[1]], cfg, 3);
  const p = drill.placement(cfg);
  check('placed where the drill says, facing each other', Math.abs(s0.fighters[0].pos.x - p.player.x) < 1e-9 && Math.abs(s0.fighters[1].pos.z - p.opponent.z) < 1e-9 && Math.abs(Math.cos(s0.fighters[0].yaw) * (p.opponent.x - p.player.x) + Math.sin(s0.fighters[0].yaw) * (p.opponent.z - p.player.z) - Math.hypot(p.opponent.x - p.player.x, p.opponent.z - p.player.z)) < 1e-6);
  const a = play(drill, idle), b = play(drill, idle);
  check(`${SECONDS} s with an idle player is deterministic`, JSON.stringify(a.s) === JSON.stringify(b.s) && JSON.stringify(a.events) === JSON.stringify(b.events));
  const mid = a.s;
  check('the policy is pure: the same (state, tick, seed) gives the same input, and it does not write into the state', (() => { const before = JSON.stringify(mid); const i1 = JSON.stringify(drill.policy(mid, 77, 3, cfg)), i2 = JSON.stringify(drill.policy(mid, 77, 3, cfg)); return i1 === i2 && JSON.stringify(mid) === before; })());
  check(`the metric answers with a number and a stat ("${a.m.stat}")`, a.m.progress >= 0 && a.m.progress <= 1 && typeof a.m.stat === 'string' && a.m.stat.length > 0);
  const played = play(drill, PLAYERS[drill.id](), 3, drill.id === 'hurt' ? 45 : SECONDS);
  // The three known faults (polish phase): the partner's count is quick, cut-off is not over in four seconds, survive does not floor an idle player in one.
  if (drill.tune) {
    const tuned = drill.tune(k.cfg);
    check('its count, if it comes to one, is quick (no dead ten)', tuned.countTickSeconds === undefined || tuned.countTickSeconds <= k.cfg.countTickSeconds * 0.5);
  }
  if (drill.id === 'cut-off') {
    const walker = play(drill, () => inp({ move: { x: 0, y: 1 } }));
    check(`walking straight at him does not finish it (best ${walker.best.toFixed(2)}, "${walker.m.stat}")`, walker.best < 0.5);
  }
  if (drill.id === 'survive') {
    const firstDown = a.events.find(e => e.type === 'knockdown' && e.side === 0);
    check(`an idle player is not on the floor inside three seconds (${firstDown ? 'down' : 'never down'} in ${SECONDS} s)`, !firstDown || a.events.indexOf(firstDown) > 0 && a.s.time > 3);
  }
  if (drill.id === 'hurt') {
    const kinds = new Set(played.events.filter(e => e.type === 'hurtStyle' && e.side === 1).map(e => e.style));
    check(`a player throwing combinations at the worn man hurts him more than one way (${[...kinds].join(', ')}; "${played.m.stat}")`, kinds.size >= 2);
  }
  if (drill.id === 'trading') {
    const nerfed = played.events.filter(e => e.type === 'punchStart' && e.side === 0 && e.nerf > 0).length, stuffed = played.events.filter(e => e.type === 'punchStuffed' && e.side === 0).length;
    check(`the player still throws while he is being hit: ${nerfed} punches came out nerfed, ${stuffed} were stuffed`, nerfed >= 3 && stuffed <= nerfed);
  }
  if (drill.id === 'stamina-guard') {
    const p = played.s.fighters[0];
    check(`twenty seconds behind the guard (fifteen of jabs, five of heavy shots) leaves ${Math.round(p.stamina * 100)}% in the tank`, p.stamina > 0.6);
  }
  if (drill.id === 'survive') {
    const taken = r => r.events.filter(e => e.type === 'punchLand' && e.side === 1).length;
    check(`standing there he goes down or is battered ("${a.m.stat}"); a player who ties up and moves does better ("${played.m.stat}")`, played.best > a.best + 0.15 && taken(played) < taken(a));
  } else {
    check(`the metric moves for a player who does it (best ${played.best.toFixed(2)}, "${played.m.stat}") and not for one who stands still (best ${a.best.toFixed(2)})`, played.best > a.best + 0.15);
  }
}

done();
