/**
 * bots/inside_fighter.mjs — the pressure man. Walks in behind the jab with the
 * guard up when he sees a punch coming, gets inside, and works there: body
 * hooks (the lead one is the liver), shovel hooks, the uppercut through the
 * middle, in threes. Rolls under a hook when he reads one. Finishes a hurt man.
 * A legitimate plan: it must be able to win.
 */
import { makeBot, dist, ready } from './util.mjs';

export const name = 'inside-fighter';
export const legit = true;

export function create(k, seed, cfg) {
  return makeBot(k, seed, (b, s) => {
    const me = s.fighters[0], opp = s.fighters[1], d = dist(s);
    const m = b.mem;
    m.cool = Math.max(0, (m.cool ?? 0) - 1);
    const inside = d < cfg.rangeInside + 0.03;
    // A hook read at close range: roll under it (toward where it came from) and come up.
    if (b.seenPunch.fresh && b.seenPunch.type === 'hook' && d < 0.85 && me.punch.type === null && b.chance(0.6)) {
      b.flick(-k.core.handLateralSign(b.seenPunch.hand, opp.stance), 0, { level: true });
      for (let i = 0; i < 20; i++) b.push({});
      b.push({ hook: true, move: { x: -1, y: 0 } });   // the rising hook
      return;
    }
    // A punch coming and not inside yet: guard up, keep walking.
    if (b.seenPunch.type && !inside) return { block: true, move: { x: 0, y: 0.55 } };
    if (inside && ready(k, s, cfg) && m.cool === 0) {
      m.cool = 34;
      const hurt = opp.hurt > 0;
      const r = core_float(k, b);
      if (hurt || r < 0.25) { b.combo([['hook', -1], ['uppercut', 1], ['hook', 1]], 4); return; }   // upstairs: shovel hook, uppercut, shovel hook
      if (r < 0.6) { b.lowThen('hook', -1); b.push({}, {}, { hook: true, move: { x: 1, y: 0 } }, {}, {}, {}, { uppercut: true, move: { x: 1, y: 0 } }); return; }   // liver, then up
      if (r < 0.8) { b.lowThen('cross'); b.push({}, {}, { hook: true, move: { x: -1, y: 0 } }); return; }   // body cross, hook
      b.combo([['uppercut', 1], ['hook', -1]], 4);
      return;
    }
    // Mid range: come in behind the jab.
    if (!inside && d < 1.08 && ready(k, s, cfg) && m.cool === 0) { m.cool = 16; return { jab: true, move: { x: 0, y: 1 } }; }
    // Walk him down; cut the ring off by leaning the way he is going.
    const fr = k.core.frameOf(me.yaw);
    const lat = opp.vel.x * fr.right.x + opp.vel.z * fr.right.z;
    return { move: { x: Math.abs(lat) > 0.4 ? Math.sign(lat) * 0.5 : 0, y: inside ? 0.2 : 1 } };
  });
}
const core_float = (k, b) => k.core.rngFloat(b.rng);
