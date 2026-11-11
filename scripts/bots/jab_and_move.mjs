/**
 * bots/jab_and_move.mjs — stick and move, as a person who knows how would do
 * it (phase 4; the phase 1–3 bot stood at 1.0 m whoever was in front of it,
 * circled one way, threw nothing but the jab and had no answer to a punch).
 *
 *   - the range is HIS, not a constant: it waits just outside the reach of
 *     the man in front of it and steps in behind the jab from there
 *   - jab, double jab, body jab, the jab going away — and the straight right:
 *     behind a jab, when he walks onto it, and when he is worn or hurt
 *   - it leaves at an angle and circles AWAY from his power hand (mirrored for
 *     a southpaw)
 *   - it reads what a person can read: a man dipping to load a big one (step
 *     out), a punch already on its way when it is too close to leave (cover)
 *   - crowded: shove and hop out; on the ropes: pivot off; hurt: tie up, or
 *     cover and go
 * A legitimate plan: it must be able to win.
 */
import { makeBot, dist, ready } from './util.mjs';

export const name = 'jab-and-move';
export const legit = true;

/** How far a man's jab lands from, m, standing (measured over the roster: heights_test, OVERHAUL_SIM.md phase 3). */
export const reachOf = f => 1.13 + 1.7 * (f.body.upperArm + f.body.forearm - 0.696);

export function create(k, seed, cfg) {
  return makeBot(k, seed, (b, s) => {
    const me = s.fighters[0], opp = s.fighters[1], d = dist(s);
    const m = b.mem;
    m.cool = Math.max(0, (m.cool ?? 0) - 1);
    m.side = Math.max(0, (m.side ?? 0) - 1);
    const mine = reachOf(me), his = reachOf(opp);
    // Away from his power hand: his rear hand is on my left if he is orthodox, on my right if he is a southpaw.
    const away = opp.stance === 'southpaw' ? -1 : 1;
    // Where it waits: outside what he can reach, and no further than a step jab of its own covers.
    const STEP = 0.14;                                   // what the step of a step jab adds
    const wait = Math.min(his + 0.1, mine + STEP - 0.02);
    const fr = k.core.frameOf(me.yaw);
    const closing = -(opp.vel.x * fr.fwd.x + opp.vel.z * fr.fwd.z);   // + = he is coming at me, m/s
    const free = me.punch.type === null;
    const off = (n = 12, back = -0.6) => { for (let i = 0; i < n; i++) b.push({ move: { x: away, y: back } }); };

    // Hurt: tie him up if he is close enough to grab, else cover and go.
    if (me.hurt > 0) {
      if (d < cfg.clinchRange - 0.03 && me.clinch.cd === 0 && free) { for (let i = 0; i < 16; i++) b.push({ block: true, level: true }); return; }
      return { block: d < his + 0.1, move: { x: away, y: -1 } };
    }
    // On the ropes: pivot off them, toward the open side.
    if (me.ropes > 0.35 && free && me.burstCd === 0 && m.side === 0) { m.side = 40; b.flick(away, 0, { block: true }); for (let i = 0; i < 10; i++) b.push({ move: { x: away, y: 0.4 } }); return; }
    // Crowded: he is inside my jab. Shove and hop out; or the jab going away; or just go.
    if (d < Math.min(0.76, mine - 0.28)) {
      if (free && me.pushCd === 0 && d < cfg.pushRange - 0.08 && b.chance(0.6)) { b.flick(0, 1, { block: true }); b.push({}, {}); b.doubleTap(0, -1, 8); return; }
      if (free && me.burstCd === 0 && b.chance(0.5)) { b.doubleTap(0, -1, 8); return; }
      if (ready(k, s, cfg) && m.cool === 0) { m.cool = 14; return { jab: true, move: { x: away * 0.4, y: -1 } }; }
      return { block: !!b.seenPunch.type, move: { x: away * 0.7, y: -1 } };
    }
    // He is loading a big one (the dip before a power punch) and I am in his reach: be gone before it starts.
    if (opp.level > 0.35 && opp.punch.type === null && d < his + 0.12) {
      if (free && me.burstCd === 0) { b.doubleTap(away * 0.5, -1, 8); return; }
      return { move: { x: away * 0.6, y: -1 } };
    }
    // A punch of his is on its way and I am where it lands: too late to leave — cover, and keep the feet going.
    if (b.seenPunch.type && b.seenPunch.type !== 'jab' && d < his + 0.05 && free) return { block: true, move: { x: away * 0.6, y: -0.8 } };
    if (b.seenPunch.type && d < his) return { move: { x: away * 0.6, y: -1 } };

    if (ready(k, s, cfg) && m.cool === 0 && !opp.down) {
      const worn = opp.health < 0.2 || opp.hurt > 0;
      // He walks onto it: the straight right down the middle, then off.
      if (closing > 0.45 * cfg.moveSpeed && d <= mine - 0.05 && d > 0.74) { m.cool = 30; b.push({ cross: true }); off(14, -0.7); return; }
      // In range and set.
      if (d <= mine - 0.03) {
        m.cool = 26;
        if (worn || b.chance(0.2)) { b.combo([['jab'], ['cross']], 4); off(12, -0.6); return; }   // the 1-2
        if (b.chance(0.25)) { b.combo([['jab'], ['jab']], 4); off(14, -0.6); return; }
        if (b.chance(0.15)) { b.lowThen('jab'); off(12, -0.6); return; }
        b.push({ jab: true, move: { x: away * 0.3, y: 0 } }); off(12, -0.5);
        return;
      }
      // Just outside it: step in behind the jab, and out again at an angle.
      if (d <= mine + STEP) { m.cool = 24; b.push({ jab: true, move: { x: 0, y: 1 } }); if (worn) b.push({}, {}, {}, { cross: true }); off(11, -0.75); return; }
    }
    // Otherwise: hold the waiting distance, circling away from his right hand; never drift onto the ropes.
    if (me.ropes > 0.2) return { move: { x: away, y: 0.5 } };
    return { move: { x: away * 0.8, y: d > wait + 0.08 ? 0.7 : d < wait - 0.06 ? -0.8 : 0 } };
  });
}
