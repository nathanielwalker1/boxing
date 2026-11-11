/**
 * lib/drill_bots.js — scripted players for the gym drills, for the BROWSER
 * (gym_check.mjs, flow_look.mjs). The page-side twins of the Node bots in
 * drills_test.mjs: each is a policy `(state) => partial FrameInput` handed to
 * `window.__sim.drive(0, policy)`, which main.ts calls on every sim tick, so a
 * bot reacts tick-exactly whatever the frame rate (a headless run draws a few
 * frames a second; a slip has to be timed to a sixtieth).
 *
 * `installDrillBots(page)` defines `window.__drillBot(id)` in the page: a
 * fresh policy for that drill, or null.
 */
export async function installDrillBots(page) {
  await page.evaluate(() => {
    const dist = s => Math.hypot(s.fighters[0].pos.x - s.fighters[1].pos.x, s.fighters[0].pos.z - s.fighters[1].pos.z);
    /** A bot: a queue of scripted ticks; when it is empty the policy is asked (it may push ticks and / or return one). */
    const make = policy => {
      const q = [];
      const b = {
        q, mem: { n: 0 },
        push: (...t) => { for (const x of t) q.push(x); },
        idle: n => { for (let i = 0; i < n; i++) q.push({}); },
        /** A flick: two ticks of push, one released (`hold` on all three: level = a roll). */
        flick: (x, y, hold = {}) => b.push({ ...hold, move: { x, y } }, { ...hold, move: { x, y } }, { ...hold }),
      };
      return s => {
        if (s.round.phase !== 'fighting' || s.fighters[0].down) { q.length = 0; return {}; }
        if (q.length) return q.shift();
        return policy(b, s) ?? {};
      };
    };
    /** The lateral sign of a hand for a stance (core/math.ts handLateralSign): the lead is the left hand for orthodox. */
    const handSign = (hand, stance) => ((hand === 'lead') === (stance === 'orthodox') ? -1 : 1);
    /** Sees the opponent's punch start, waits, takes it with the head (under a hook, away from a straight), and may answer. */
    const slipper = counter => {
      let was = false;
      return make((b, s) => {
        const opp = s.fighters[1], on = opp.punch.type !== null && !opp.punch.resolved, fresh = on && !was;
        was = on;
        if (!fresh) return {};
        const hand = handSign(opp.punch.hand, opp.stance);
        b.idle(4);
        if (opp.punch.type === 'hook') b.flick(-hand, 0, { level: true }); else b.flick(hand, 0);
        if (counter) { b.idle(6); b.push({ [opp.punch.type === 'hook' ? 'hook' : 'cross']: true, move: { x: hand, y: 0 } }); }
        was = true;
        return {};
      });
    };
    const BOTS = {
      // Jab when he is on the end of it, step back out when he gets close.
      'jab-and-move': () => make((b, s) => {
        const d = dist(s);
        if (d < 0.8) return { move: { x: 0.5, y: -1 } };
        if (d < 1.08 && s.fighters[0].punch.type === null) { b.push({ jab: true }); b.idle(10); return {}; }
        return d > 1.15 ? { move: { x: 0, y: 0.6 } } : {};
      }),
      // Walk at him, stepping across the way he is going.
      'cut-off': () => make((b, s) => {
        const o = s.fighters[1], me = s.fighters[0];
        const right = { x: -Math.sin(me.yaw), z: Math.cos(me.yaw) };
        const side = o.vel.x * right.x + o.vel.z * right.z;
        return { move: { x: Math.max(-1, Math.min(1, side * 1.2)), y: 1 } };
      }),
      // In behind the guard, then short hooks and uppercuts at his chest.
      'get-inside': () => make((b, s) => {
        const d = dist(s);
        if (d > 0.62) return { block: true, move: { x: 0, y: 1 } };
        if (s.fighters[0].punch.type === null) { b.push({ hook: true, move: { x: b.mem.n++ % 2 ? 1 : -1, y: 0.4 } }); b.idle(7); b.push({ uppercut: true, move: { x: 0, y: 0.4 } }); b.idle(9); return {}; }
        return { move: { x: 0, y: 0.5 } };
      }),
      'slip-timing': () => slipper(false),
      'slip-counter': () => slipper(true),
      // Close, then low and to the body.
      'body-work': () => make((b, s) => {
        if (dist(s) > 0.78) return { move: { x: 0, y: 1 } };
        for (let i = 0; i < 9; i++) b.push({ level: true });
        b.push({ level: true, [b.mem.n++ % 2 ? 'hook' : 'cross']: true, move: { x: -1, y: 0 } });
        b.idle(16);
        return {};
      }),
      // Tie him up when he is on you; otherwise guard up and get along the ropes.
      'survive': () => make((b, s) => (s.fighters[0].clinch.cd === 0 && dist(s) < 0.75 ? { block: true, level: true } : { block: dist(s) < 1.0, move: { x: 1, y: -0.4 } })),
      // A jab and a cross at a man who stands there.
      'free-sparring': () => make((b, s) => {
        if (dist(s) > 0.95) return { move: { x: 0, y: 1 } };
        b.push({ jab: true }); b.idle(12); b.push({ cross: true }); b.idle(20);
        return {};
      }),
    };
    window.__drillBot = id => (BOTS[id] ? BOTS[id]() : null);
  });
}
