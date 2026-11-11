/**
 * ai_tools_test.mjs — the AI uses the overhaul's tools, and its behaviour is a
 * StyleParams object (src/ai/style.ts). In Node, AI on side 1.
 *   - over seeded fights against the scripted bots it throws body shots, slips or
 *     rolls, pivots off the ropes, shoves, bursts, feints, ties up, cuts the ring off
 *   - it never bursts or clinches by accident (stick discipline; macros only)
 *   - a style is data: the same AI with another StyleParams fights differently
 *   - aiToolsOn off = none of the tools
 *   - the bot table's target: legitimate plans win, the masher and the turtle lose
 * (dummy_ai_test.mjs pins the pre-overhaul heuristics with the tools off.)
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';

const k = await kit();
const { cfg, sim, ai, specs, SIM_DT } = k;
const fast = { ...cfg, roundCount: 2, roundSeconds: 20, betweenRoundSeconds: 3 };

function fight(bot, seed, c = fast, style = null) {
  let s = sim.createState(specs, c, seed);
  let a = ai.createAi(1, seed, c, style);
  const player = bot.create(k, seed, c);
  const out = { winner: undefined, evs: {}, variants: new Set(), aiBurstsNoMacro: 0, dist: 0, n: 0 };
  const limit = Math.round((c.roundCount * (c.roundSeconds + c.betweenRoundSeconds) + 30) / SIM_DT) * 2;
  for (let i = 0; i < limit && s.round.phase !== 'over'; i++) {
    const d = ai.aiStep(a, s, c);
    const inMacro = d.ai.macro !== null || a.macro !== null;
    a = d.ai;
    const r = sim.step(s, [player.step(s), d.input], c); s = r.state;
    for (const e of r.events) {
      if (e.side === 1 || e.type === 'clinch') out.evs[e.type] = (out.evs[e.type] ?? 0) + 1;
      if (e.type === 'punchStart' && e.side === 1) out.variants.add(e.variant);
      if (e.type === 'burst' && e.side === 1 && !inMacro && a.used.burst === 0) out.aiBurstsNoMacro++;
      if (e.type === 'ko' || e.type === 'tko' || e.type === 'decision') out.winner = e.winner;
    }
    if (s.round.phase === 'fighting') { out.dist += k.dist(s); out.n++; }
  }
  out.used = a.used;
  out.avgDist = out.dist / Math.max(1, out.n);
  return out;
}
const sum = (fs, f) => fs.reduce((t, x) => t + f(x), 0);

// ── 1. The tools get used ───────────────────────────────────────────────────
console.log('\n=== 1. The AI uses the tools ===');
const fights = [];
for (const bot of [jabAndMove, insideFighter, counterPuncher, turtle]) for (const seed of [1, 2]) fights.push(fight(bot, seed));
{
  const used = {};
  for (const f of fights) for (const [key, v] of Object.entries(f.used)) used[key] = (used[key] ?? 0) + v;
  console.log(`     ${Object.entries(used).map(([key, v]) => `${key} ${v}`).join(' · ')}`);
  for (const tool of ['body', 'pivot', 'push', 'burst', 'feint', 'clinch', 'cutOff']) check(`it used: ${tool}`, used[tool] > 0, `${used[tool]}`);
  check('it slipped or rolled under something', used.slip + used.roll > 0, `slip ${used.slip}, roll ${used.roll}`);
  const variants = new Set(); for (const f of fights) for (const v of f.variants) variants.add(v);
  check(`it threw body variants and inside variants (${[...variants].join(', ')})`, ['bodyJab', 'bodyCross', 'bodyHook'].some(v => variants.has(v)) && ['shovelHook', 'insideUppercut'].some(v => variants.has(v)));
  check('the sim saw the moves as events (pivot, pushOff, burst, feint, slip)', ['pivot', 'pushOff', 'burst', 'feint', 'slip'].every(t => sum(fights, f => f.evs[t] ?? 0) > 0), JSON.stringify(Object.fromEntries(['pivot', 'pushOff', 'burst', 'feint', 'slip', 'clinch'].map(t => [t, sum(fights, f => f.evs[t] ?? 0)]))));
}

// ── 2. Off, and discipline ──────────────────────────────────────────────────
console.log('\n=== 2. Tools off; no accidents ===');
{
  const off = { ...fast, aiToolsOn: false };
  const fs = [1, 2, 3].map(seed => fight(insideFighter, seed, off));
  const used = sum(fs, f => Object.values(f.used).reduce((a, b) => a + b, 0));
  check('aiToolsOn off: it uses none of them', used === 0, `${used}`);
  check('…and still never double-taps into a burst or grabs by accident (stick discipline)', sum(fs, f => (f.evs.burst ?? 0) + (f.evs.pivot ?? 0) + (f.evs.pushOff ?? 0) + (f.evs.feint ?? 0)) === 0 && sum(fs, f => f.evs.clinch ?? 0) === 0, JSON.stringify(fs.map(f => f.evs)));
}

// ── 3. A style is data ──────────────────────────────────────────────────────
console.log('\n=== 3. StyleParams ===');
{
  const base = ai.defaultStyle(fast);
  check('defaultStyle is plain data built from the ai… config keys', JSON.parse(JSON.stringify(base)).standoff === fast.aiStandoffDist && base.bodyRate === fast.aiBodyRate && base.guard === 'high');
  const outboxer = { ...base, pressWeight: 0, probeWeight: 6, circleWeight: 4, holdWeight: 0, probeDist: 1.15, standoff: 1.0, jabWeight: 8, crossWeight: 2, hookWeight: 0, uppercutWeight: 0, bodyRate: 0, bodyRateHighGuard: 0, resetChance: 0.8 };
  const swarmer = { ...base, pressWeight: 8, probeWeight: 0, circleWeight: 0, holdWeight: 0, standoff: 0.6, jabWeight: 1, crossWeight: 1, hookWeight: 5, uppercutWeight: 3, bodyRate: 0.6, resetChance: 0, attackDelayMin: 0.5, attackDelayMax: 1.2 };
  const o = [1, 2].map(seed => fight(turtle, seed, fast, outboxer)), w = [1, 2].map(seed => fight(turtle, seed, fast, swarmer));
  const dO = sum(o, f => f.avgDist) / 2, dW = sum(w, f => f.avgDist) / 2;
  check(`an outboxer style keeps its distance, a swarmer style closes (${dO.toFixed(2)} m vs ${dW.toFixed(2)} m average)`, dO > dW + 0.15);
  const jabs = fs => { const v = new Set(); for (const f of fs) for (const x of f.variants) v.add(x); return v; };
  check('…and their punches are their own (the outboxer never hooks; the swarmer goes to the body)', !['hook', 'shovelHook', 'bodyHook'].some(v => jabs(o).has(v)) && ['bodyHook', 'bodyJab', 'bodyCross', 'risingUppercut'].some(v => jabs(w).has(v)), `${[...jabs(o)].join(',')} | ${[...jabs(w)].join(',')}`);
  const a1 = ai.createAi(1, 3, fast, swarmer);
  check('the style rides on the AI state (serialisable)', JSON.parse(JSON.stringify(a1)).style.standoff === 0.6);
}

// ── 4. The bot table's target ───────────────────────────────────────────────
console.log('\n=== 4. Plans ===');
{
  // (Short fights to keep the suite fast; `node scripts/bot_table.mjs` is the full table at the real fight length.)
  const N = 8;
  const tally = bot => { let w = 0, l = 0; for (let seed = 1; seed <= N; seed++) { const f = fight(bot, seed, fast); if (f.winner === 0) w++; else if (f.winner === 1) l++; } return { w, l }; };
  for (const bot of [jabAndMove, insideFighter, counterPuncher]) { const t = tally(bot); check(`${bot.name} (a legitimate plan) can win: ${t.w}-${t.l} over ${N}`, t.w > 0); }
  for (const bot of [turtle, masher]) { const t = tally(bot); check(`${bot.name} (not a plan) loses more than it wins: ${t.w}-${t.l} over ${N}`, t.l > t.w); }
}

done();
