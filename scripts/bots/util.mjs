/**
 * bots/util.mjs — what the scripted player policies share. A bot drives side 0
 * through FrameInput ONLY (what a player's hands can do); it may look at the
 * SimState the way a player looks at the screen, but everything it reads about
 * the opponent's punches goes through a REACTION delay (bots do not get to be
 * faster than a person).
 *
 *   const bot = makeBot(k, seed, (b, s) => { …decide…; return input; });
 *   input = bot.step(s);
 *
 * `b` (the bot's memory) has:
 *   b.q            a queue of scripted ticks (partial inputs) — a flick, a combo, a level-then-punch. While it has
 *                  entries the policy is not asked.
 *   b.rng          a seeded stream (core/rng)
 *   b.seenPunch    the opponent's punch as it was REACT ticks ago: { type, hand, variant, fresh } (fresh = it began
 *                  on that delayed tick)
 *   b.t            ticks since the bell
 * and helpers: push(...ticks), flick(x, y), doubleTap(x, y), lowThen(press, x), combo([...presses], gap).
 */
export const REACT = 11;   // ticks of reaction: 0.18 s

export function makeBot(k, seed, policy) {
  const { core, inp } = k;
  const rng = core.seedRng((seed * 2654435761 + 12345) >>> 0);
  const hist = [];
  const b = {
    q: [], rng, t: 0, seenPunch: { type: null, hand: 'lead', variant: 'jab', fresh: false }, mem: {},
    chance: p => core.rngChance(rng, p),
    pick: arr => arr[core.rngInt(rng, 0, arr.length - 1)],
    push: (...ticks) => { for (const t of ticks) b.q.push(t); },
    /** A flick: 2 ticks of push, 1 released (with `hold` merged into all three: { block: true } = pivot / push-off, { level: true } = roll). */
    flick: (x, y, hold = {}) => b.push({ ...hold, move: { x, y } }, { ...hold, move: { x, y } }, { ...hold }),
    /** A double-tap: flick, then the push again held `n` ticks. */
    doubleTap: (x, y, n = 6) => { b.flick(x, y); for (let i = 0; i < n; i++) b.push({ move: { x, y } }); },
    /** Drop the level for 9 ticks, then press (stick x for the hand, y for step / retreat). */
    lowThen: (press, x = 0, y = 0) => { for (let i = 0; i < 9; i++) b.push({ level: true }); b.push({ level: true, [press]: true, move: { x, y } }); },
    /** Presses `gap` ticks apart: [['jab'], ['cross'], ['hook', -1]]. They buffer and chain in the sim. */
    combo: (presses, gap = 3) => { presses.forEach(([p, x = 0, y = 0], n) => { b.push({ [p]: true, move: { x, y } }); if (n < presses.length - 1) for (let i = 1; i < gap; i++) b.push({}); }); },
  };
  return {
    b,
    step(s) {
      const opp = s.fighters[1];
      hist.push({ type: opp.punch.type, hand: opp.punch.hand, variant: opp.punch.variant, resolved: opp.punch.resolved });
      if (hist.length > REACT + 2) hist.shift();
      const then = hist[hist.length - 1 - REACT], before = hist[hist.length - 2 - REACT];
      b.seenPunch = then ? { type: then.resolved ? null : then.type, hand: then.hand, variant: then.variant, fresh: !!then.type && !then.resolved && !(before && before.type && !before.resolved) } : { type: null, hand: 'lead', variant: 'jab', fresh: false };
      b.t += 1;
      if (s.round.phase !== 'fighting' || s.fighters[0].down) { b.q.length = 0; return inp(); }
      if (b.q.length) return inp(b.q.shift());
      return inp(policy(b, s) ?? {});
    },
  };
}

export const dist = s => Math.hypot(s.fighters[0].pos.x - s.fighters[1].pos.x, s.fighters[0].pos.z - s.fighters[1].pos.z);
/** Which way to slip away from the opponent's punching hand, as stick x (both orthodox: his lead hand is on my right, so away is my left). */
export const awayFrom = (k, opp, hand) => k.core.handLateralSign(hand, opp.stance);
/** Can side 0 start a punch right now? */
export const ready = (k, s, c) => k.sim.canStartPunch(s.fighters[0], c) && s.fighters[0].punch.type === null;
