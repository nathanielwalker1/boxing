#!/usr/bin/env node
/**
 * bot_table.mjs — every scripted player bot against the AI as every STYLE,
 * N seeded fights each, headless in Node. Prints the bot × style matrix.
 *
 *   node scripts/bot_table.mjs               # 10 fights per cell, medium difficulty
 *   node scripts/bot_table.mjs 20            # 20 fights per cell
 *   node scripts/bot_table.mjs 10 hard       # easy | medium | hard
 *   node scripts/bot_table.mjs 10 detail     # + lands, knockdowns, how the fights ended, AI tool use
 *   node scripts/bot_table.mjs 10 key=value  # config overrides (numbers / true / false)
 *
 * The bot is side 0 on the reference "red" body; the AI is side 1 on the
 * "blue" body with its style overridden (until the roster of eight lands), so
 * it holds that style's guard and fights from that style's StyleParams
 * (ai/style.ts `styleFor`). Ratings and styles are ON — this is the game as
 * shipped. Deterministic: the same arguments print the same matrix.
 *
 * Targets (docs/OVERHAUL_SIM.md), on medium:
 *   - every legitimate plan wins against at least one style and loses, or is clearly worse, against at least one
 *   - no legitimate plan wins more than 80% across the board
 *   - the masher ≤ 15% and the turtle 0–5% against every style
 *   - the plan that beats the swarmer is not the plan that beats the outboxer
 */
import { kit } from './bots/kit.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';

export const BOTS = [jabAndMove, insideFighter, counterPuncher, turtle, masher];
export const STYLES = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];
const args = process.argv.slice(2);
const N = Number(args.find(a => /^\d+$/.test(a)) ?? 10);
const DIFF = { easy: 0, medium: 1, hard: 2 };
const diffName = args.find(a => a in DIFF) ?? 'medium';
const k = await kit({ rated: true });
const cfg = { ...k.cfg, aiDifficulty: DIFF[diffName] };
for (const a of args) { const m = a.match(/^(\w+)=(.+)$/); if (m) cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]); }
const maxTicks = Math.round((cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds) + 40) / k.SIM_DT) * 2;

/** One fight: `bot` (side 0, red) against the AI as `style` (side 1, blue's body). */
export function fight(bot, style, seed, c = cfg) {
  const specs = [k.specs[0], { ...k.specs[1], style }];
  let s = k.sim.createState(specs, c, seed);
  let ai = k.ai.createAi(1, seed, c, k.ai.styleFor(specs[1], c));
  const player = bot.create(k, seed, c);
  const st = { winner: null, how: 'none', lands: [0, 0], thrown: [0, 0], kd: [0, 0], ticks: 0, causes: {} };
  for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
    const d = k.ai.aiStep(ai, s, c); ai = d.ai;
    const r = k.sim.step(s, [player.step(s), d.input], c); s = r.state;
    for (const e of r.events) {
      if (e.type === 'punchStart') st.thrown[e.side]++;
      else if (e.type === 'punchLand') st.lands[e.side]++;
      else if (e.type === 'knockdown') { st.kd[e.side]++; if (e.side === 1) st.causes[e.cause] = (st.causes[e.cause] ?? 0) + 1; }
      else if (e.type === 'ko' || e.type === 'tko') { st.winner = e.winner; st.how = e.type; }
      else if (e.type === 'decision') { st.winner = e.winner; st.how = 'decision'; }
    }
    st.ticks = i;
  }
  st.ai = ai.used;
  return st;
}

export function cell(bot, style, n = N, c = cfg) {
  const t = { w: 0, l: 0, d: 0, ko: 0, koBy: 0, lands: 0, taken: 0, kd: 0, kdBy: 0, secs: 0, ai: {}, causes: {} };
  for (let seed = 1; seed <= n; seed++) {
    const f = fight(bot, style, seed, c);
    if (f.winner === 0) { t.w++; if (f.how !== 'decision') t.ko++; } else if (f.winner === 1) { t.l++; if (f.how !== 'decision') t.koBy++; } else t.d++;
    t.lands += f.lands[0]; t.taken += f.lands[1]; t.kd += f.kd[1]; t.kdBy += f.kd[0]; t.secs += f.ticks * k.SIM_DT;
    for (const [key, v] of Object.entries(f.ai)) t.ai[key] = (t.ai[key] ?? 0) + v;
    for (const [key, v] of Object.entries(f.causes)) t.causes[key] = (t.causes[key] ?? 0) + v;
  }
  t.pct = t.w / n;
  return t;
}

/** The whole matrix and the verdict on the targets. */
export function matrix(n = N, c = cfg, bots = BOTS, styles = STYLES) {
  const rows = bots.map(bot => ({ bot, cells: styles.map(style => cell(bot, style, n, c)) }));
  const problems = [];
  const best = {};
  for (const r of rows) {
    const pcts = r.cells.map(x => x.pct), avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    r.avg = avg;
    if (r.bot.legit) {
      if (Math.max(...pcts) < 0.5) problems.push(`${r.bot.name} does not win (≥ 50%) against any style`);
      if (Math.min(...pcts) > Math.max(...pcts) - 0.25 && Math.min(...pcts) >= 0.5) problems.push(`${r.bot.name} is not clearly worse against any style (${Math.round(Math.min(...pcts) * 100)}–${Math.round(Math.max(...pcts) * 100)}%)`);
      if (avg > 0.8) problems.push(`${r.bot.name} wins ${Math.round(avg * 100)}% across the board (> 80%)`);
    } else {
      const cap = r.bot.name === 'turtle' ? 0.05 : 0.15;
      styles.forEach((s, i) => { if (pcts[i] > cap + 1e-9) problems.push(`${r.bot.name} wins ${Math.round(pcts[i] * 100)}% against the ${s} (> ${cap * 100}%)`); });
    }
  }
  for (const s of ['swarmer', 'outboxer']) {
    const i = styles.indexOf(s);
    if (i < 0) continue;
    const legit = rows.filter(r => r.bot.legit).sort((x, y) => y.cells[i].pct - x.cells[i].pct);
    best[s] = legit[0]?.bot.name;
  }
  if (best.swarmer && best.swarmer === best.outboxer) problems.push(`the same plan (${best.swarmer}) is the best against both the swarmer and the outboxer`);
  return { rows, problems, best, styles };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`\nBots (side 0, ${k.specs[0].id}) vs the AI as each style (side 1, ${k.specs[1].id}'s body) — ${N} seeded fights per cell, ${cfg.roundCount} × ${cfg.roundSeconds} s, ${diffName}\n`);
  const m = matrix();
  console.log('win %            legit  ' + m.styles.map(s => s.padStart(9)).join(' ') + '      avg');
  for (const r of m.rows) {
    console.log(`${r.bot.name.padEnd(16)} ${(r.bot.legit ? 'yes' : 'no').padEnd(5)}  ${r.cells.map(x => `${Math.round(x.pct * 100)}%`.padStart(9)).join(' ')}   ${`${Math.round(r.avg * 100)}%`.padStart(6)}`);
    if (args.includes('detail')) {
      console.log(`${''.padEnd(16)} W-L-D  ${r.cells.map(x => `${x.w}-${x.l}-${x.d}`.padStart(9)).join(' ')}`);
      console.log(`${''.padEnd(16)} KO for-against ${r.cells.map(x => `${x.ko}-${x.koBy}`.padStart(7)).join(' ')}`);
      console.log(`${''.padEnd(16)} lands for-against / fight ${r.cells.map(x => `${(x.lands / N).toFixed(0)}-${(x.taken / N).toFixed(0)}`.padStart(7)).join(' ')}`);
      console.log(`${''.padEnd(16)} avg seconds ${r.cells.map(x => (x.secs / N).toFixed(0).padStart(6)).join(' ')}`);
    }
  }
  if (args.includes('detail')) {
    const use = {};
    for (const r of m.rows) r.cells.forEach((x, i) => { use[m.styles[i]] ??= {}; for (const [key, v] of Object.entries(x.ai)) use[m.styles[i]][key] = (use[m.styles[i]][key] ?? 0) + v; });
    console.log('\nAI tool use by style (all bots):');
    for (const s of m.styles) console.log(`  ${s.padEnd(9)} ${Object.entries(use[s]).filter(([key]) => key !== 'cutOff').map(([key, v]) => `${key} ${v}`).join(' · ')}`);
  }
  console.log(`\nBest legitimate plan against the swarmer: ${m.best.swarmer}; against the outboxer: ${m.best.outboxer}.`);
  console.log(m.problems.length ? `\nTARGETS NOT MET:\n  - ${m.problems.join('\n  - ')}` : '\nTARGETS MET.');
}
