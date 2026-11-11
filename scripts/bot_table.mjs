#!/usr/bin/env node
/**
 * bot_table.mjs — every scripted player bot against the AI as every STYLE, on
 * the roster's own bodies, N seeded fights a cell, headless in Node. Prints
 * the bot × style matrix and how long the fights run.
 *
 *   node scripts/bot_table.mjs               # 20 fights per cell, medium difficulty
 *   node scripts/bot_table.mjs 10            # 10 fights per cell
 *   node scripts/bot_table.mjs 20 hard       # easy | medium | hard
 *   node scripts/bot_table.mjs 20 detail     # + lands, knockdowns, how the fights ended, AI tool use
 *   node scripts/bot_table.mjs 20 key=value  # config overrides (numbers / true / false)
 *   node scripts/bot_table.mjs 20 only=inside-fighter,counter-puncher cols=outboxer,counter   # part of the matrix
 *
 * The AI (side 1) fights each style on a roster body OF that style, with that
 * man's ratings, reach and guard (phase 3):
 *   pressure → monsoon   outboxer → lighthouse (1.98 m)   counter → alambre (southpaw)
 *   swarmer → boiler (1.63 m)   slugger → raffle (112 kg)
 * The bot (side 0) fights half of each cell as red (1.80 m, pressure body,
 * power 68) and half as blue (1.86 m, long, quick, power 58): the two
 * reference bodies, one each side of average. Ratings and styles are ON —
 * this is the game as shipped. Deterministic: the same arguments print the
 * same matrix.
 *
 * Targets (docs/OVERHAUL_SIM.md), on medium:
 *   - every legitimate plan wins against at least one style and is clearly worse against at least one
 *   - no legitimate plan wins more than 80% across the board
 *   - the masher ≤ 15% and the turtle ≤ 5% against every style
 *   - no style loses more than 85% to any one legitimate plan
 *   - no style column averages under 25% or over 75% for the AI across the legitimate plans
 *   - the plan that beats the swarmer is not the plan that beats the outboxer
 * and across difficulty: legitimate plans average ≤ ~45% on hard and ≥ ~75% on easy.
 */
import { kit } from './bots/kit.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';

export const BOTS = [jabAndMove, insideFighter, counterPuncher, turtle, masher];
export const STYLES = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];
/** The roster body the AI fights each style on. */
export const BODY = { pressure: 'monsoon', outboxer: 'lighthouse', counter: 'alambre', swarmer: 'boiler', slugger: 'raffle' };
/** The bodies the bot fights on, alternating by seed. */
export const BOT_BODIES = ['red', 'blue'];
const args = process.argv.slice(2);
const N = Number(args.find(a => /^\d+$/.test(a)) ?? 20);
const DIFF = { easy: 0, medium: 1, hard: 2 };
const diffName = args.find(a => a in DIFF) ?? 'medium';
const k = await kit({ rated: true });
const cfg = { ...k.cfg, aiDifficulty: DIFF[diffName] };
const opt = {};
for (const a of args) {
  const m = a.match(/^(\w+)=(.+)$/); if (!m) continue;
  if (m[1] === 'only' || m[1] === 'cols') opt[m[1]] = m[2].split(',');
  else if (m[1] === 'on') for (const pair of m[2].split(',')) { const [style, id] = pair.split(':'); BODY[style] = id; }   // on=counter:grandad — another roster body for a style
  else cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
}
const maxTicks = Math.round((cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds) + 40) / k.SIM_DT) * 2;
const spec = id => k.core.ROSTER.find(f => f.id === id);

/** One fight: `bot` (side 0, on red or blue by seed) against the AI as `style` (side 1, on that style's roster body). */
export function fight(bot, style, seed, c = cfg) {
  const specs = [spec(BOT_BODIES[seed % BOT_BODIES.length]), spec(BODY[style])];
  let s = k.sim.createState(specs, c, seed);
  let ai = k.ai.createAi(1, seed, c, k.ai.styleFor(specs[1], c));
  const player = bot.create(k, seed, c);
  const st = { winner: null, how: 'none', lands: [0, 0], thrown: [0, 0], kd: [0, 0], ticks: 0, causes: {}, round: 0, fightSeconds: 0 };
  let fighting = 0;
  for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
    const d = k.ai.aiStep(ai, s, c); ai = d.ai;
    const r = k.sim.step(s, [player.step(s), d.input], c); s = r.state;
    if (s.round.phase === 'fighting') fighting++;
    for (const e of r.events) {
      if (e.type === 'punchStart') st.thrown[e.side]++;
      else if (e.type === 'punchLand') st.lands[e.side]++;
      else if (e.type === 'knockdown') { st.kd[e.side]++; if (e.side === 1) st.causes[e.cause] = (st.causes[e.cause] ?? 0) + 1; }
      else if (e.type === 'ko' || e.type === 'tko') { st.winner = e.winner; st.how = e.type; }
      else if (e.type === 'decision') { st.winner = e.winner; st.how = 'decision'; }
    }
    st.ticks = i;
  }
  st.round = s.round.index + 1;                 // the round it ended in, 1-based
  st.fightSeconds = fighting * k.SIM_DT;        // seconds of boxing (rests and counts not included)
  st.ai = ai.used;
  return st;
}

export function cell(bot, style, n = N, c = cfg) {
  const t = { w: 0, l: 0, d: 0, ko: 0, koBy: 0, lands: 0, taken: 0, kd: 0, kdBy: 0, secs: 0, ai: {}, causes: {}, fights: [] };
  for (let seed = 1; seed <= n; seed++) {
    const f = fight(bot, style, seed, c);
    if (f.winner === 0) { t.w++; if (f.how !== 'decision') t.ko++; } else if (f.winner === 1) { t.l++; if (f.how !== 'decision') t.koBy++; } else t.d++;
    t.lands += f.lands[0]; t.taken += f.lands[1]; t.kd += f.kd[1]; t.kdBy += f.kd[0]; t.secs += f.fightSeconds;
    t.fights.push({ how: f.how, round: f.round, secs: f.fightSeconds, kd: f.kd[0] + f.kd[1] });
    for (const [key, v] of Object.entries(f.ai)) t.ai[key] = (t.ai[key] ?? 0) + v;
    for (const [key, v] of Object.entries(f.causes)) t.causes[key] = (t.causes[key] ?? 0) + v;
  }
  t.pct = t.w / n;
  return t;
}

const median = xs => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
/** Fight length and arc over a set of fights. */
export function arc(fights, c = cfg) {
  const stops = fights.filter(f => f.how === 'ko' || f.how === 'tko');
  return {
    n: fights.length,
    stoppage: stops.length / Math.max(1, fights.length),
    medianStop: median(stops.map(f => f.secs)),
    round1: stops.filter(f => f.round === 1).length / Math.max(1, fights.length),
    lastRound: fights.filter(f => f.round >= c.roundCount).length / Math.max(1, fights.length),
    kd: fights.reduce((a, f) => a + f.kd, 0) / Math.max(1, fights.length),
  };
}

/** The whole matrix and the verdict on the targets. */
export function matrix(n = N, c = cfg, bots = BOTS, styles = STYLES) {
  const rows = bots.map(bot => ({ bot, cells: styles.map(style => cell(bot, style, n, c)) }));
  const problems = [];
  const best = {};
  const legitRows = rows.filter(r => r.bot.legit);
  for (const r of rows) {
    const pcts = r.cells.map(x => x.pct), avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    r.avg = avg;
    if (r.bot.legit) {
      if (Math.max(...pcts) < 0.5) problems.push(`${r.bot.name} does not win (≥ 50%) against any style`);
      if (Math.min(...pcts) > Math.max(...pcts) - 0.25 && Math.min(...pcts) >= 0.5) problems.push(`${r.bot.name} is not clearly worse against any style (${Math.round(Math.min(...pcts) * 100)}–${Math.round(Math.max(...pcts) * 100)}%)`);
      if (avg > 0.8) problems.push(`${r.bot.name} wins ${Math.round(avg * 100)}% across the board (> 80%)`);
      styles.forEach((s, i) => { if (pcts[i] > 0.85 + 1e-9) problems.push(`the ${s} loses ${Math.round(pcts[i] * 100)}% to ${r.bot.name} (> 85%)`); });
    } else {
      const cap = r.bot.name === 'turtle' ? 0.05 : 0.15;
      styles.forEach((s, i) => { if (pcts[i] > cap + 1e-9) problems.push(`${r.bot.name} wins ${Math.round(pcts[i] * 100)}% against the ${s} (> ${cap * 100}%)`); });
    }
  }
  // The AI's side of each column: its win share across the legitimate plans (draws are neither's).
  const columns = styles.map((s, i) => {
    const w = legitRows.reduce((a, r) => a + r.cells[i].l, 0), all = legitRows.reduce((a, r) => a + r.cells[i].w + r.cells[i].l + r.cells[i].d, 0);
    return all ? w / all : NaN;
  });
  if (legitRows.length) styles.forEach((s, i) => { if (columns[i] < 0.25 - 1e-9 || columns[i] > 0.75 + 1e-9) problems.push(`the ${s} wins ${Math.round(columns[i] * 100)}% across the legitimate plans (outside 25–75%)`); });
  for (const s of ['swarmer', 'outboxer']) {
    const i = styles.indexOf(s);
    if (i < 0) continue;
    const legit = [...legitRows].sort((x, y) => y.cells[i].pct - x.cells[i].pct);
    best[s] = legit[0]?.bot.name;
  }
  if (best.swarmer && best.swarmer === best.outboxer) problems.push(`the same plan (${best.swarmer}) is the best against both the swarmer and the outboxer`);
  const legitAvg = legitRows.length ? legitRows.reduce((a, r) => a + r.avg, 0) / legitRows.length : NaN;
  return { rows, problems, best, styles, columns, legitAvg, arcLegit: arc(legitRows.flatMap(r => r.cells.flatMap(x => x.fights)), c), arcAll: arc(rows.flatMap(r => r.cells.flatMap(x => x.fights)), c) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bots = opt.only ? BOTS.filter(b => opt.only.includes(b.name)) : BOTS;
  const styles = opt.cols ? STYLES.filter(s => opt.cols.includes(s)) : STYLES;
  console.log(`\nBots (side 0, as ${BOT_BODIES.join(' and ')} by turns) vs the AI as each style on its roster body (side 1) — ${N} seeded fights per cell, ${cfg.roundCount} × ${cfg.roundSeconds} s, ${diffName}\n`);
  const m = matrix(N, cfg, bots, styles);
  const W = 11;
  console.log('win %            legit  ' + m.styles.map(s => s.padStart(W)).join(' ') + '      avg');
  console.log('                 body   ' + m.styles.map(s => BODY[s].padStart(W)).join(' '));
  for (const r of m.rows) {
    console.log(`${r.bot.name.padEnd(16)} ${(r.bot.legit ? 'yes' : 'no').padEnd(5)}  ${r.cells.map(x => `${Math.round(x.pct * 100)}%`.padStart(W)).join(' ')}   ${`${Math.round(r.avg * 100)}%`.padStart(6)}`);
    if (args.includes('detail')) {
      console.log(`${''.padEnd(16)} W-L-D  ${r.cells.map(x => `${x.w}-${x.l}-${x.d}`.padStart(W)).join(' ')}`);
      console.log(`${''.padEnd(16)} KO f-a ${r.cells.map(x => `${x.ko}-${x.koBy}`.padStart(W)).join(' ')}`);
      console.log(`${''.padEnd(16)} lands  ${r.cells.map(x => `${(x.lands / N).toFixed(0)}-${(x.taken / N).toFixed(0)}`.padStart(W)).join(' ')}`);
      console.log(`${''.padEnd(16)} KDs    ${r.cells.map(x => `${(x.kd / N).toFixed(1)}-${(x.kdBy / N).toFixed(1)}`.padStart(W)).join(' ')}`);
      console.log(`${''.padEnd(16)} box s  ${r.cells.map(x => (x.secs / N).toFixed(0).padStart(W)).join(' ')}`);
      console.log(`${''.padEnd(16)} AI down by: ${r.cells.map(x => Object.entries(x.causes).map(([key, v]) => `${key} ${v}`).join(',') || '-').join(' | ')}`);
    }
  }
  console.log(`${'AI wins, legit'.padEnd(16)}        ${m.columns.map(x => `${Math.round(x * 100)}%`.padStart(W)).join(' ')}`);
  if (args.includes('detail')) {
    const use = {};
    for (const r of m.rows) r.cells.forEach((x, i) => { use[m.styles[i]] ??= {}; for (const [key, v] of Object.entries(x.ai)) use[m.styles[i]][key] = (use[m.styles[i]][key] ?? 0) + v; });
    console.log('\nAI tool use by style (all bots):');
    for (const s of m.styles) console.log(`  ${s.padEnd(9)} ${Object.entries(use[s]).filter(([key]) => key !== 'cutOff').map(([key, v]) => `${key} ${v}`).join(' · ')}`);
  }
  const say = (label, a) => console.log(`${label}: ${a.n} fights · ${Math.round(a.stoppage * 100)}% end by stoppage (median ${Number.isNaN(a.medianStop) ? '—' : a.medianStop.toFixed(0) + ' s of boxing'}) · ${Math.round(a.round1 * 100)}% stopped in round 1 · ${Math.round(a.lastRound * 100)}% reach the last round · ${a.kd.toFixed(1)} knockdowns a fight`);
  console.log(`\nLegitimate plans average ${Math.round(m.legitAvg * 100)}%.`);
  say('Fight length, legitimate plans', m.arcLegit);
  say('Fight length, all bots        ', m.arcAll);
  console.log(`\nBest legitimate plan against the swarmer: ${m.best.swarmer}; against the outboxer: ${m.best.outboxer}.`);
  console.log(m.problems.length ? `\nTARGETS NOT MET:\n  - ${m.problems.join('\n  - ')}` : '\nTARGETS MET.');
}
