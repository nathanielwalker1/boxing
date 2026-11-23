/**
 * bot_ladder.mjs — does skill win? Every bot (cheat + honest, scripts/bots/) and the game's own five AI styles at the
 * default difficulty fight every other one, full fights under the real human-mode config, ending by KO / TKO / decision.
 * Both fighters share ROSTER[0]'s body; each seed is fought twice with the corners swapped.
 *   node scripts/bot_ladder.mjs [seedsPerPairing=1] [workers=min(cpus-2, 6)]
 * One fight is ~5 s of Node time (6000+ ticks), so the 105 pairings x 2 corners = 210 fights (seeds=1) run across worker
 * threads: ~3 min on 6 workers. Rating method: Bradley-Terry maximum likelihood on the aggregate pair scores (win 1, draw
 * 0.5), solved by damped Newton-style sweeps (all ratings updated together until the largest change is < 0.001 point)
 * and shown on the Elo scale (1500 start, 400-point logistic). One virtual draw against a fixed 1500 anchor per player
 * keeps an unbeaten / winless bot finite. Prints one table, a cheat-vs-honest/AI table, and two summary lines.
 */
import { Worker } from 'node:worker_threads';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BOTS } from './bots/index.mjs';

const SEEDS = +(process.argv[2] || 1);
const WORKERS = +(process.argv[3] || Math.max(1, Math.min(6, os.cpus().length - 2)));
const AI_IDS = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'].map(s => 'ai_' + s);   // = ai/style.ts STYLE_IDS
const IDS = [...Object.keys(BOTS), ...AI_IDS];
const groupOf = id => (BOTS[id] ? BOTS[id].group : 'ai');

const jobs = [];
for (let i = 0; i < IDS.length; i++) for (let j = i + 1; j < IDS.length; j++)
  for (let k = 0; k < SEEDS; k++) {
    const seed = 1000 + k * 37 + i * 101 + j;
    jobs.push({ a: IDS[i], b: IDS[j], seed }, { a: IDS[j], b: IDS[i], seed });   // corners swapped, same seed
  }

const t0 = Date.now();
const results = [];
await new Promise((resolve, reject) => {
  let next = 0, finished = 0;
  const workerPath = fileURLToPath(new URL('./bots/_worker.mjs', import.meta.url));
  for (let w = 0; w < WORKERS; w++) {
    const worker = new Worker(workerPath);
    const feed = () => {
      if (next < jobs.length) worker.postMessage(jobs[next++]);
      else worker.postMessage({ done: true });
    };
    worker.on('message', m => {
      if (m.ready) return feed();
      results.push(m);
      if (++finished === jobs.length) resolve();
      else feed();
    });
    worker.on('error', reject);
  }
});
const wall = (Date.now() - t0) / 1000;

// ---- aggregate -------------------------------------------------------------------------------------------------
const T = Object.fromEntries(IDS.map(id => [id, { w: 0, l: 0, d: 0, koWins: 0, thrown: 0, landed: 0, ticks: 0, dist: 0, away: 0 }]));
const pair = {};   // pair[a][b] = { n, score } from a's point of view
for (const a of IDS) { pair[a] = {}; for (const b of IDS) if (a !== b) pair[a][b] = { n: 0, score: 0 }; }
for (const m of results) {
  const ids = [m.a, m.b], { r } = m;
  for (const side of [0, 1]) {
    const me = ids[side], q = T[me], st = r.stats[side];
    const sc = r.winner === null ? 0.5 : r.winner === side ? 1 : 0;
    if (sc === 1) { q.w++; if (r.method === 'ko') q.koWins++; } else if (sc === 0) q.l++; else q.d++;
    q.thrown += st.thrown; q.landed += st.landed; q.ticks += st.ticks; q.dist += st.distSum; q.away += st.away;
    pair[me][ids[1 - side]].n++; pair[me][ids[1 - side]].score += sc;
  }
}

// ---- rating ----------------------------------------------------------------------------------------------------
const K = Math.LN10 / 400, rating = Object.fromEntries(IDS.map(id => [id, 1500]));
const E = (ri, rj) => 1 / (1 + Math.pow(10, (rj - ri) / 400));
for (let it = 0; it < 20000; it++) {
  let maxStep = 0; const nr = {};
  for (const i of IDS) {
    let n = 1, act = 0.5, exp = E(rating[i], 1500);   // the virtual draw against the 1500 anchor
    for (const j of IDS) if (j !== i) { const p = pair[i][j]; n += p.n; act += p.score; exp += p.n * E(rating[i], rating[j]); }
    const step = clamp(2 * (act - exp) / (n * K), -50, 50);
    nr[i] = rating[i] + step; maxStep = Math.max(maxStep, Math.abs(step));
  }
  Object.assign(rating, nr);
  if (maxStep < 0.001) break;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- tables ----------------------------------------------------------------------------------------------------
const order = [...IDS].sort((x, y) => rating[y] - rating[x]);
const pad = (v, n) => String(v).padStart(n), padr = (v, n) => String(v).padEnd(n);
console.log(`bot ladder: ${results.length} fights (${IDS.length} fighters, ${SEEDS} seed(s) per pairing, corners swapped), ${wall.toFixed(0)} s wall on ${WORKERS} workers (${(results.length / wall).toFixed(2)} fights/s)`);
console.log(padr('bot', 16) + padr('kind', 8) + pad('rating', 7) + pad('W-L-D', 12) + pad('KO%wins', 9) + pad('thrown/min', 11) + pad('land%', 7) + pad('dist m', 8) + pad('away%', 7));
for (const id of order) {
  const q = T[id], g = q.w + q.l + q.d, mins = q.ticks / 3600;
  console.log(padr(id, 16) + padr(groupOf(id), 8) + pad(Math.round(rating[id]), 7) + pad(`${q.w}-${q.l}-${q.d}`, 12)
    + pad(q.w ? (100 * q.koWins / q.w).toFixed(0) + '%' : '-', 9) + pad((q.thrown / mins).toFixed(1), 11)
    + pad(q.thrown ? (100 * q.landed / q.thrown).toFixed(0) + '%' : '-', 7) + pad((q.dist / q.ticks).toFixed(2), 8) + pad((100 * q.away / q.ticks).toFixed(0) + '%', 7));
}
const wp = (a, b) => { const p = pair[a][b]; return p.n ? 100 * p.score / p.n : NaN; };
const opp = IDS.filter(id => groupOf(id) !== 'cheat');
console.log('\ncheat bot win % (draw = half) against each honest bot and AI style');
console.log(padr('cheat bot', 16) + opp.map(o => pad(o.replace('ai_', 'ai:'), 11)).join(''));
const cheats = IDS.filter(id => groupOf(id) === 'cheat');
for (const c of cheats) console.log(padr(c, 16) + opp.map(o => pad(wp(c, o).toFixed(0) + '%', 11)).join(''));
const above = cheats.map(c => ({ c, over: opp.filter(o => rating[c] > rating[o]) })).filter(x => x.over.length);
console.log('cheat bots above any honest bot or AI style: ' + (above.length ? above.map(x => `${x.c} (${Math.round(rating[x.c])}, above ${x.over.join(' ')})`).join('; ') : 'none'));
console.log(`honest-bot triangle (win %): boxer vs swarmer ${wp('boxer', 'swarmer').toFixed(0)}%, swarmer vs counter ${wp('swarmer', 'counter').toFixed(0)}%, counter vs boxer ${wp('counter', 'boxer').toFixed(0)}%`);
process.exit(0);
