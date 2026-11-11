#!/usr/bin/env node
/**
 * bot_table.mjs — every scripted player bot against the AI, N seeded fights
 * each, headless in Node. Prints a win / loss / KO table.
 *
 *   node scripts/bot_table.mjs            # 20 fights per bot
 *   node scripts/bot_table.mjs 40         # 40 fights per bot
 *   node scripts/bot_table.mjs 20 key=value …   # with config overrides (numbers / true / false)
 *
 * The target (docs/OVERHAUL_SIM.md): every LEGITIMATE plan can win — jab-and-
 * move, inside fighter, counter puncher — and the two that are not plans, the
 * masher and the turtle, lose. The bot is side 0 (the reference "red" fighter),
 * the AI side 1 ("blue"), both from the roster; a fight is the configured
 * rounds × seconds. Deterministic: the same N and overrides print the same table.
 */
import { kit } from './bots/kit.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';

const BOTS = [jabAndMove, insideFighter, counterPuncher, turtle, masher];
const args = process.argv.slice(2);
const N = Number(args.find(a => /^\d+$/.test(a)) ?? 20);
const k = await kit();
const cfg = { ...k.cfg };
for (const a of args) { const m = a.match(/^(\w+)=(.+)$/); if (m) cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]); }
const maxTicks = Math.round((cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds) + 40) / k.SIM_DT) * 2;

/** One fight. Returns how it ended and what happened in it. */
export function fight(bot, seed) {
  let s = k.sim.createState(k.specs, cfg, seed);
  let ai = k.ai.createAi(1, seed, cfg);
  const player = bot.create(k, seed, cfg);
  const st = { winner: null, how: 'none', lands: [0, 0], thrown: [0, 0], kd: [0, 0], flush: [0, 0], body: [0, 0], counters: [0, 0], ticks: 0, causes: {}, hurts: [0, 0] };
  for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
    const d = k.ai.aiStep(ai, s, cfg); ai = d.ai;
    const r = k.sim.step(s, [player.step(s), d.input], cfg); s = r.state;
    for (const e of r.events) {
      if (e.type === 'punchStart') st.thrown[e.side]++;
      else if (e.type === 'punchLand') { st.lands[e.side]++; if (e.grade === 'flush') st.flush[e.side]++; if (e.part === 'body') st.body[e.side]++; if (e.counter) st.counters[e.side]++; }
      else if (e.type === 'knockdown') { st.kd[e.side]++; if (e.side === 1) st.causes[e.cause] = (st.causes[e.cause] ?? 0) + 1; }
      else if (e.type === 'rocked' || e.type === 'bodyHurt') st.hurts[e.side]++;
      else if (e.type === 'ko' || e.type === 'tko') { st.winner = e.winner; st.how = e.type; }
      else if (e.type === 'decision') { st.winner = e.winner; st.how = 'decision'; }
    }
    st.ticks = i;
  }
  st.ai = ai.used;
  return st;
}

function row(bot) {
  const t = { w: 0, l: 0, d: 0, ko: 0, koBy: 0, lands: 0, taken: 0, thrown: 0, kd: 0, kdBy: 0, flush: 0, secs: 0, ai: {}, causes: {}, counters: 0, body: 0, hurts: 0 };
  for (let seed = 1; seed <= N; seed++) {
    const f = fight(bot, seed);
    if (f.winner === 0) { t.w++; if (f.how !== 'decision') t.ko++; } else if (f.winner === 1) { t.l++; if (f.how !== 'decision') t.koBy++; } else t.d++;
    t.lands += f.lands[0]; t.taken += f.lands[1]; t.thrown += f.thrown[0]; t.kd += f.kd[1]; t.kdBy += f.kd[0]; t.flush += f.flush[0]; t.secs += f.ticks * k.SIM_DT;
    for (const [key, v] of Object.entries(f.ai)) t.ai[key] = (t.ai[key] ?? 0) + v;
    for (const [key, v] of Object.entries(f.causes)) t.causes[key] = (t.causes[key] ?? 0) + v;
    t.counters += f.counters[0]; t.body += f.body[0]; t.hurts += f.hurts[1];
  }
  return t;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`\nBots (side 0, ${k.specs[0].id}) vs the AI (side 1, ${k.specs[1].id}) — ${N} seeded fights each, ${cfg.roundCount} × ${cfg.roundSeconds} s\n`);
  console.log('bot              legit   W   L   D   KO-W  KO-L  win%   lands/fight  taken/fight  land%  KDs for-against  avg s');
  let ok = true;
  const aiUse = {};
  for (const bot of BOTS) {
    const t = row(bot);
    const pct = t.w / N;
    console.log(`${bot.name.padEnd(16)} ${(bot.legit ? 'yes' : 'no').padEnd(5)} ${String(t.w).padStart(3)} ${String(t.l).padStart(3)} ${String(t.d).padStart(3)}   ${String(t.ko).padStart(3)}   ${String(t.koBy).padStart(3)}   ${(pct * 100).toFixed(0).padStart(3)}%   ${(t.lands / N).toFixed(1).padStart(8)}     ${(t.taken / N).toFixed(1).padStart(8)}    ${(100 * t.lands / Math.max(1, t.thrown)).toFixed(0).padStart(3)}%   ${String(t.kd).padStart(4)} - ${String(t.kdBy).padEnd(4)}      ${(t.secs / N).toFixed(0).padStart(4)}`);
    if (args.includes('detail')) console.log(`    his knockdowns of the AI by cause: ${JSON.stringify(t.causes)} · flush ${t.flush} · body lands ${t.body} · counters ${t.counters} · times he hurt the AI ${t.hurts}`);
    if (bot.legit ? t.w === 0 : t.w > t.l) ok = false;
    for (const [key, v] of Object.entries(t.ai)) aiUse[key] = (aiUse[key] ?? 0) + v;
  }
  console.log(`\nAI tool use over all fights: ${Object.entries(aiUse).map(([key, v]) => `${key} ${v}`).join(' · ')}`);
  console.log(ok ? '\nTARGET MET: every legitimate plan wins some; the masher and the turtle lose more than they win.' : '\nTARGET NOT MET (see docs/OVERHAUL_SIM.md for which knob).');
}
