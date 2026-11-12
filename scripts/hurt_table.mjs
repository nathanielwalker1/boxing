#!/usr/bin/env node
/**
 * hurt_table.mjs — how often does anybody get hurt? (polish phase, item 3)
 *
 * Seeded fights, 3 × 60 s, medium, ratings and styles on, headless:
 *   - the AI against the AI, every style against every other on their roster bodies ("AI v AI")
 *   - the three legitimate scripted bots against every style ("bot v AI")
 *   - with `all`, the masher and the turtle too (balance: they must still lose)
 * Per fight: how many times each hurt state happened, knockdowns by kind and cause, how it ended.
 *
 *   node scripts/hurt_table.mjs                 # 3 seeds a pairing
 *   node scripts/hurt_table.mjs 6               # 6 seeds a pairing
 *   node scripts/hurt_table.mjs 3 key=value …   # config overrides (numbers / true / false)
 *   node scripts/hurt_table.mjs 3 all           # + masher and turtle rows
 *
 * Targets (docs/POLISH_SIM.md): in a typical competitive 3-rounder someone is visibly hurt at least once or
 * twice; a knockdown in roughly 35–55% of fights; a one-punch finish in roughly 2–5%.
 */
import { kit } from './bots/kit.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';
import * as humanPace from './bots/human_pace.mjs';

export const STYLES = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];
export const BODY = { pressure: ['monsoon', 'red'], outboxer: ['lighthouse', 'blue'], counter: ['alambre', 'grandad'], swarmer: ['boiler'], slugger: ['raffle'] };
const KEYS = ['rocked', 'bodyHurt', 'liverShot', 'guardBreak', 'knockdown', 'finisher', 'stuffed', 'episodes'];

export async function hurtTable({ n = 3, overrides = {}, all = false, quiet = false } = {}) {
  const k = await kit({ rated: true });
  const cfg = { ...k.cfg, roundSeconds: 60, roundCount: 3, aiDifficulty: 1, ...overrides };
  const spec = id => k.core.ROSTER.find(f => f.id === id);
  const maxTicks = Math.round((cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds) + 60) * 60 * 2);

  function fight(specs, drivers, seed) {
    let s = k.sim.createState(specs, cfg, seed);
    const st = { n: Object.fromEntries(KEYS.map(x => [x, 0])), kinds: {}, causes: {}, styles: {}, how: 'none', winner: null, onePunch: false, lastKd: null, kdBy: [0, 0], lands: [0, 0], thrown: [0, 0], onAi: { rocked: 0, bodyHurt: 0, knockdown: 0 }, overs: [] };
    for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
      const ins = [drivers[0](s), drivers[1](s)];
      const wasHurt = [s.fighters[0].hurt > 0, s.fighters[1].hurt > 0];
      const r = k.sim.step(s, ins, cfg); s = r.state;
      for (const e of r.events) {
        // An EPISODE: a man who was not hurt becomes hurt (a rocking shot on a man already rocked only extends it).
        if ((e.type === 'rocked' || e.type === 'bodyHurt') && !wasHurt[e.side]) { st.n.episodes++; wasHurt[e.side] = true; }
        if ((e.type === 'rocked' || e.type === 'bodyHurt' || e.type === 'knockdown') && e.side === 1) st.onAi[e.type]++;
        if (e.type === 'punchStart') st.thrown[e.side]++;
        if (e.type === 'rocked') st.n.rocked++;
        else if (e.type === 'bodyHurt') st.n.bodyHurt++;
        else if (e.type === 'liverShot') st.n.liverShot++;
        else if (e.type === 'guardBreak') st.n.guardBreak++;
        else if (e.type === 'punchStuffed') st.n.stuffed++;
        else if (e.type === 'punchLand') { st.lands[e.side]++; if (e.finisher) st.n.finisher++; }
        else if (e.type === 'hurtStyle') st.styles[e.style] = (st.styles[e.style] ?? 0) + 1;
        else if (e.type === 'knockdown') {
          st.n.knockdown++; st.kdBy[e.side]++;
          const kind = e.kind ?? 'unkinded';
          st.kinds[kind] = (st.kinds[kind] ?? 0) + 1; st.causes[e.cause] = (st.causes[e.cause] ?? 0) + 1;
          st.lastKd = { kind, cause: e.cause, count: e.count, first: st.n.knockdown === 1 };
          if (e.over !== undefined) st.overs.push(e.over);
        } else if (e.type === 'ko' || e.type === 'tko') {
          st.how = e.type; st.winner = e.winner;
          // A one-punch finish: the fight ended on its FIRST knockdown (waved off, or counted out).
          st.onePunch = e.type === 'ko' && st.n.knockdown === 1;
          st.waved = !!e.waved;
        } else if (e.type === 'decision') { st.how = 'decision'; st.winner = e.winner; }
      }
    }
    return st;
  }
  const aiDriver = (side, specOf, seed) => { let ai = k.ai.createAi(side, seed, cfg, k.ai.styleFor(specOf, cfg)); return s => { const d = k.ai.aiStep(ai, s, cfg); ai = d.ai; return d.input; }; };
  const botDriver = (bot, seed) => { const p = bot.create(k, seed, cfg); return s => p.step(s); };

  const groups = { 'AI v AI': [], 'bot v AI': [] };
  const rows = {};
  for (let a = 0; a < STYLES.length; a++) for (let b = 0; b < STYLES.length; b++) {
    if (a === b) continue;
    for (let seed = 1; seed <= n; seed++) {
      const ida = BODY[STYLES[a]][seed % BODY[STYLES[a]].length]; let idb = BODY[STYLES[b]][(seed >> 1) % BODY[STYLES[b]].length];
      const specs = [spec(ida), spec(idb)];
      groups['AI v AI'].push(fight(specs, [aiDriver(0, specs[0], seed * 31 + a), aiDriver(1, specs[1], seed * 17 + b)], seed * 100 + a * 10 + b));
    }
  }
  // The human stand-in (bots/human_pace.mjs): what he does to the AI is the question Nate asked.
  for (const style of STYLES) for (let seed = 1; seed <= n * 2; seed++) {
    let botId = ['red', 'blue'][seed % 2]; const aiId = BODY[style][(seed >> 1) % BODY[style].length];
    if (botId === aiId) botId = ['red', 'blue'][(seed + 1) % 2];
    const specs = [spec(botId), spec(aiId)];
    (groups['human pace v AI'] ??= []).push(fight(specs, [botDriver(humanPace, seed), aiDriver(1, specs[1], seed)], seed));
  }
  const bots = all ? [jabAndMove, insideFighter, counterPuncher, masher, turtle] : [jabAndMove, insideFighter, counterPuncher];
  for (const bot of bots) for (const style of STYLES) for (let seed = 1; seed <= n; seed++) {
    let botId = ['red', 'blue'][seed % 2]; const aiId = BODY[style][(seed >> 1) % BODY[style].length];
    if (botId === aiId) botId = ['red', 'blue'][(seed + 1) % 2];
    const specs = [spec(botId), spec(aiId)];
    const f = fight(specs, [botDriver(bot, seed), aiDriver(1, specs[1], seed)], seed);
    (bot.legit ? groups['bot v AI'] : (groups['masher / turtle'] ??= [])).push(f);
    const row = rows[bot.name] ??= { w: 0, n: 0 }; row.n++; if (f.winner === 0) row.w++;
  }

  const summary = {};
  for (const [name, fights] of Object.entries(groups)) {
    const N = fights.length; if (!N) continue;
    const share = fn => fights.filter(fn).length / N;
    const per = key => fights.reduce((t, f) => t + f.n[key], 0) / N;
    const tally = key => { const t = {}; for (const f of fights) for (const [x, v] of Object.entries(f[key])) t[x] = (t[x] ?? 0) + v; return t; };
    const s = summary[name] = {
      n: N,
      per: Object.fromEntries(KEYS.map(x => [x, per(x)])),
      any: Object.fromEntries(KEYS.map(x => [x, share(f => f.n[x] > 0)])),
      hurtAny: share(f => f.n.rocked + f.n.bodyHurt + f.n.knockdown > 0),
      hurtTwice: share(f => f.n.rocked + f.n.bodyHurt + f.n.knockdown >= 2),
      stoppage: share(f => f.how === 'ko' || f.how === 'tko'), ko: share(f => f.how === 'ko'), tko: share(f => f.how === 'tko'),
      onePunch: share(f => f.onePunch), waved: share(f => f.waved),
      kd3: share(f => f.n.knockdown >= 3),
      kinds: tally('kinds'), causes: tally('causes'), styles: tally('styles'),
    };
    if (quiet) continue;
    const p = x => `${Math.round(x * 100)}%`;
    console.log(`\n${name} — ${N} fights, ${cfg.roundCount} × ${cfg.roundSeconds} s`);
    console.log(`  per fight:        HURT EPISODES ${s.per.episodes.toFixed(2)} (a man not hurt becomes hurt) · rocking shots ${s.per.rocked.toFixed(2)} · winded ${s.per.bodyHurt.toFixed(2)} · liver shots ${s.per.liverShot.toFixed(2)} · guard breaks ${s.per.guardBreak.toFixed(2)} · knockdowns ${s.per.knockdown.toFixed(2)} · finishers ${s.per.finisher.toFixed(2)} · stuffs ${s.per.stuffed.toFixed(2)}`);
    console.log(`  fights with ≥ 1:  rocked ${p(s.any.rocked)} · winded ${p(s.any.bodyHurt)} · liver ${p(s.any.liverShot)} · guard break ${p(s.any.guardBreak)} · KNOCKDOWN ${p(s.any.knockdown)} (3 or more: ${p(s.kd3)})`);
    console.log(`  somebody visibly hurt (rocked / winded / down): once ${p(s.hurtAny)}, twice or more ${p(s.hurtTwice)}`);
    console.log(`  ended by stoppage ${p(s.stoppage)} (counted out ${p(s.ko)}, three knockdowns ${p(s.tko)}) · ONE-PUNCH finish (over on the first knockdown) ${p(s.onePunch)} · waved off without a count ${p(s.waved)}`);
    console.log(`  knockdowns by cause: ${Object.entries(s.causes).map(([x, v]) => `${x} ${v}`).join(' · ') || '—'}   by kind: ${Object.entries(s.kinds).map(([x, v]) => `${x} ${v}`).join(' · ') || '—'}`);
    const overs = fights.flatMap(f => f.overs).sort((a, b) => a - b);
    if (overs.length) console.log(`  head-shot knockdowns, × the stun threshold: median ${overs[Math.floor(overs.length / 2)].toFixed(1)} · 90th pct ${overs[Math.floor(overs.length * 0.9)].toFixed(1)} · max ${overs[overs.length - 1].toFixed(1)} (${overs.length})`);
    const onAi = key => fights.reduce((t, f) => t + f.onAi[key], 0) / N;
    console.log(`  side 0 → side 1: throws ${(fights.reduce((t, f) => t + f.thrown[0], 0) / N / 3).toFixed(0)} a minute, lands ${(fights.reduce((t, f) => t + f.lands[0], 0) / N).toFixed(0)} a fight · rocks him ${onAi('rocked').toFixed(2)} · winds him ${onAi('bodyHurt').toFixed(2)} · floors him ${onAi('knockdown').toFixed(2)} a fight · hurt him at least once in ${p(share(f => f.onAi.rocked + f.onAi.bodyHurt + f.onAi.knockdown > 0))} of fights, floored him in ${p(share(f => f.onAi.knockdown > 0))} · side 0 wins ${p(share(f => f.winner === 0))}`);
    if (Object.keys(s.styles).length) console.log(`  hurt sub-kinds: ${Object.entries(s.styles).map(([x, v]) => `${x} ${v}`).join(' · ')}`);
  }
  if (!quiet) console.log(`\nBots' win share: ${Object.entries(rows).map(([name, r]) => `${name} ${Math.round(100 * r.w / r.n)}%`).join(' · ')}`);
  return { summary, rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const overrides = {};
  for (const a of args) { const m = a.match(/^(\w+)=(.+)$/); if (m) overrides[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]); }
  await hurtTable({ n: Number(args.find(a => /^\d+$/.test(a)) ?? 3), overrides, all: args.includes('all') });
}
