/**
 * build_ladder.mjs — are the creator's builds balanced? Five heavyweight builds (height / weight extremes through
 * core/creator.ts) fight a round robin under the game's own AI, same style on both corners, full fights under the real
 * human-mode config. 10 pairings x 3 AI styles x (seeds x 2 corners). Only the body differs.
 *   node scripts/build_ladder.mjs [--smoke] [--seeds=2]
 * Runs on 2 worker threads. Prints a build table, the head-to-head win matrix, the per-style split, one summary line.
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { load } from './load.mjs';
import { loadMocapLib } from './lib/mocap_load.mjs';

const THREADS = 2;
const STYLES = ['outboxer', 'pressure', 'counter'];
const NAMES = ['mid', 'tall-light', 'tall-heavy', 'short-light', 'short-heavy'];

async function makeEnv() {
  const [core, sim, AI, mocap] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts', '/src/core/creator.ts');
  loadMocapLib(mocap);
  const cfg = core.createConfig();
  cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
  core.applyHumanMode(cfg);
  return { core, sim, AI, cfg };
}

async function loadCreator() {
  const [creator] = await load('/src/core/creator.ts');
  return creator;
}

function buildSpecs(creator, cfg) {
  const d0 = creator.defaultDraft(cfg);
  const mk = (h, m) => creator.draftToSpec({ ...d0, heightM: h, massKg: m }, cfg);
  const hm = (cfg.createHeightMin + cfg.createHeightMax) / 2, wm = (cfg.createMassMin + cfg.createMassMax) / 2;
  const H = [cfg.createHeightMin, cfg.createHeightMax], W = [cfg.createMassMin, cfg.createMassMax];
  const raw = [mk(hm, wm), mk(H[1], W[0]), mk(H[1], W[1]), mk(H[0], W[0]), mk(H[0], W[1])];
  return raw.map((s, i) => ({ ...s, id: NAMES[i] }));
}

function fight(env, specA, specB, style, seed) {
  const { sim, AI, cfg } = env;
  const specs = [specA, specB].map(s => ({ ...s, style }));
  let s = sim.createState(specs, cfg, seed);
  const drivers = specs.map((sp, side) => {
    let ai = AI.createAi(side, seed, cfg, AI.styleFor(sp, cfg));
    return st => { const d = AI.aiStep(ai, st, cfg); ai = d.ai; return d.input; };
  });
  const landed = [0, 0];
  const maxTicks = 60 * (cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds + 40)) + 600;
  let winner = null, method = 'none';
  for (let t = 0; t < maxTicks; t++) {
    const r = sim.step(s, [drivers[0](s), drivers[1](s)], cfg); s = r.state;
    for (const e of r.events) {
      if (e.type === 'punchLand') landed[e.side]++;
      else if (e.type === 'ko' || e.type === 'tko') { winner = e.winner; method = 'ko'; }
      else if (e.type === 'decision') { winner = e.winner; method = 'decision'; }
    }
    if (s.round.phase === 'over') break;
  }
  return { winner, method, landed };
}

if (!isMainThread) {
  const env = await makeEnv();
  const specs = buildSpecs(await loadCreator(), env.cfg);
  parentPort.on('message', m => {
    if (m.done) process.exit(0);
    parentPort.postMessage({ ...m, r: fight(env, specs[m.a], specs[m.b], m.style, m.seed) });
  });
  parentPort.postMessage({ ready: true });
} else {
  const smoke = process.argv.includes('--smoke');
  const seedArg = process.argv.find(a => a.startsWith('--seeds='));
  const SEEDS = smoke ? 1 : seedArg ? +seedArg.slice(8) : 2;
  const env = await makeEnv();
  const specs = buildSpecs(await loadCreator(), env.cfg);

  // jobs: a is corner A (side 0), b is corner B (side 1); each seed fought twice with corners swapped
  let jobs = [];
  for (const style of STYLES) for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) for (let k = 0; k < SEEDS; k++) {
    const seed = 2000 + k * 53 + i * 11 + j;
    jobs.push({ a: i, b: j, style, seed }, { a: j, b: i, style, seed });
  }
  if (smoke) jobs = [jobs[0], jobs[1], jobs[jobs.length - 2], jobs[jobs.length - 1]];

  const t0 = Date.now();
  const results = [];
  await new Promise((resolve, reject) => {
    let next = 0, finished = 0;
    const path = fileURLToPath(import.meta.url);
    for (let w = 0; w < THREADS; w++) {
      const worker = new Worker(path);
      const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : { done: true });
      worker.on('message', m => {
        if (m.ready) return feed();
        results.push(m);
        if (++finished === jobs.length) resolve(); else feed();
      });
      worker.on('error', reject);
    }
  });
  const wall = (Date.now() - t0) / 1000;

  const blankSplit = () => ({ w: 0, l: 0, d: 0 });
  const T = NAMES.map(() => ({ w: 0, l: 0, d: 0, koFor: 0, koAgainst: 0, landed: 0, against: 0, n: 0, style: Object.fromEntries(STYLES.map(s => [s, blankSplit()])) }));
  const M = NAMES.map(() => NAMES.map(() => blankSplit()));
  const corner = { A: 0, B: 0, D: 0 };
  for (const { a, b, style, r } of results) {
    const ids = [a, b];
    if (r.winner === null) corner.D++; else corner[r.winner === 0 ? 'A' : 'B']++;
    for (const side of [0, 1]) {
      const me = ids[side], them = ids[1 - side], q = T[me];
      const key = r.winner === null ? 'd' : r.winner === side ? 'w' : 'l';
      q[key]++; q.style[style][key]++; M[me][them][key]++;
      if (r.method === 'ko') { if (key === 'w') q.koFor++; else if (key === 'l') q.koAgainst++; }
      q.landed += r.landed[side]; q.against += r.landed[1 - side]; q.n++;
    }
  }

  const pad = (v, n) => String(v).padStart(n), padr = (v, n) => String(v).padEnd(n);
  const c = env.cfg;
  console.log(padr('build', 13) + pad('h m', 6) + pad('kg', 5) + pad('pow', 5) + pad('spd', 5) + pad('chin', 5) + pad('sta', 5) + pad('def', 5)
    + pad('W-L-D', 10) + pad('KO for', 8) + pad('KO agst', 9) + pad('lnd/f', 7) + pad('lndAg/f', 9));
  NAMES.forEach((nm, i) => {
    const s = specs[i], q = T[i];
    console.log(padr(nm, 13) + pad(s.heightM.toFixed(2), 6) + pad(s.massKg, 5) + pad(s.power, 5) + pad(s.speed, 5) + pad(s.chin, 5) + pad(s.stamina, 5) + pad(s.defense, 5)
      + pad(`${q.w}-${q.l}-${q.d}`, 10) + pad(q.koFor, 8) + pad(q.koAgainst, 9) + pad((q.landed / q.n).toFixed(1), 7) + pad((q.against / q.n).toFixed(1), 9));
  });
  console.log('\nhead-to-head, row build vs column build: W-L-D');
  console.log(padr('', 13) + NAMES.map(n => pad(n, 13)).join(''));
  NAMES.forEach((nm, i) => console.log(padr(nm, 13) + NAMES.map((_, j) => pad(i === j ? '-' : `${M[i][j].w}-${M[i][j].l}-${M[i][j].d}`, 13)).join('')));
  for (const st of STYLES) {
    console.log(`\nW-L-D under ${st}`);
    NAMES.forEach((nm, i) => { const q = T[i].style[st]; console.log(padr(nm, 13) + `${q.w}-${q.l}-${q.d}`); });
  }
  console.log(`\ncorner A wins ${corner.A}, corner B wins ${corner.B}, draws ${corner.D}`);
  console.log(`${results.length} fights, ${wall.toFixed(0)} s wall, ${THREADS} threads${smoke ? ' (smoke)' : ''}`);
  process.exit(0);
}
