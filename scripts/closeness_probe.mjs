/**
 * closeness_probe.mjs — HOW CLOSE WERE THE PUNCHES. Seeded AI-vs-AI fights under the real human-mode config
 * (core/humanMode.ts applyHumanMode, mocapGeo + mocapOutcome on), every pairing of the AI styles, reading the closeness
 * fields the sim puts on its punch events (margin, evadeAge, evadeLeft, ramp). Reads only; changes nothing.
 *   node scripts/closeness_probe.mjs [fightsPerPairing=2] [secondsPerFight=60]
 * Prints one table per punch type: land / block / dodge / whiff counts, the whiff margin and land margin histograms
 * (cm: 0-5, 5-10, 10-20, 20-40, 40+), the dodge evadeAge histogram (50 ms bins), and the mean / max closing and opening
 * speed between the fighters at the genuine-whiff ticks.
 */
import { load } from './load.mjs';
import { loadMocapLib } from './lib/mocap_load.mjs';

const [core, sim, AI, mocap] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts');
loadMocapLib(mocap);
const FIGHTS = +(process.argv[2] || 2), SECS = +(process.argv[3] || 60);   // (15 pairings x 2 x 60 s is ~2 min: 3 x 90 s over every ORDERED pairing was ~8 min)
const cfg = core.createConfig();
cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
core.applyHumanMode(cfg);
const DT = core.SIM_DT;

const TYPES = ['jab', 'cross', 'hook', 'uppercut'];
const BINS = [0.05, 0.10, 0.20, 0.40, Infinity];
const binOf = m => BINS.findIndex(b => m < b);
const rec = Object.fromEntries(TYPES.map(t => [t, { land: 0, block: 0, dodge: 0, whiff: 0, wm: [0, 0, 0, 0, 0], lm: [0, 0, 0, 0, 0], age: [], close: [], open: [], ramp: [] }]));
const ageBin = a => Math.min(11, Math.floor(a / 0.05 + 1e-9));

let fights = 0, ticks = 0;
const t0 = Date.now();
for (const A of AI.STYLE_IDS) for (const B of AI.STYLE_IDS) {
  if (AI.STYLE_IDS.indexOf(A) > AI.STYLE_IDS.indexOf(B)) continue;   // unordered pairings (the mirror is the same fight with the bodies swapped)
  for (let k = 0; k < FIGHTS; k++) {
    const seed = 100 + k * 7 + AI.STYLE_IDS.indexOf(A) * 31 + AI.STYLE_IDS.indexOf(B);
    const specs = [{ ...core.ROSTER[0], style: A }, { ...core.ROSTER[1], style: B }];
    let s = sim.createState(specs, cfg, seed);
    let a = AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), b = AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg));
    let prev = Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
    for (let t = 0; t < SECS * 60; t++) {
      const da = AI.aiStep(a, s, cfg), db = AI.aiStep(b, s, cfg); a = da.ai; b = db.ai;
      const r = sim.step(s, [da.input, db.input], cfg); s = r.state; ticks++;
      const dist = Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
      const closing = (prev - dist) / DT; prev = dist;
      for (const e of r.events) {
        const q = rec[e.punch];
        if (!q || e.margin === undefined) continue;
        if (e.type === 'punchLand') { q.land++; q.lm[binOf(e.margin)]++; if (e.ramp !== undefined) q.ramp.push(e.ramp); }
        else if (e.type === 'punchBlock' || e.type === 'perfectBlock') { q.block++; q.lm[binOf(e.margin)]++; }
        else if (e.type === 'punchWhiff') {
          if (e.dodged) { q.dodge++; if (e.evadeAge !== undefined) q.age.push(e.evadeAge); }
          else { q.whiff++; q.wm[binOf(e.margin)]++; (closing >= 0 ? q.close : q.open).push(Math.abs(closing)); }
        }
      }
    }
    fights++;
  }
}

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const mx = a => a.length ? Math.max(...a) : 0;
const pad = (v, n) => String(v).padStart(n);
console.log(`closeness probe: ${fights} fights (${FIGHTS} seeds x ${AI.STYLE_IDS.length * (AI.STYLE_IDS.length + 1) / 2} style pairings) x ${SECS} s, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
console.log('margin bins (cm): 0-5 | 5-10 | 10-20 | 20-40 | 40+   (whiff: metres SHORT of reach; land+block: metres INSIDE reach)');
console.log(['type', 'land', 'block', 'dodge', 'whiff'].map((h, i) => i ? pad(h, 6) : h.padEnd(9)).join('')
  + '  | whiff margin           | land+block margin      | close mean/max  open mean/max (m/s, n)');
for (const t of TYPES) {
  const q = rec[t];
  console.log(t.padEnd(9) + [q.land, q.block, q.dodge, q.whiff].map(v => pad(v, 6)).join('')
    + '  | ' + q.wm.map(v => pad(v, 4)).join(' ') + '  | ' + q.lm.map(v => pad(v, 4)).join(' ')
    + `  | ${mean(q.close).toFixed(2)}/${mx(q.close).toFixed(2)} (${q.close.length})  ${mean(q.open).toFixed(2)}/${mx(q.open).toFixed(2)} (${q.open.length})`);
}
console.log('dodge evadeAge histogram (50 ms bins: 0-50, 50-100, ... last bin is 550+), per type');
for (const t of TYPES) {
  const h = new Array(12).fill(0);
  for (const a of rec[t].age) h[ageBin(a)]++;
  console.log(t.padEnd(9) + h.map(v => pad(v, 4)).join(' ') + `   (n ${rec[t].age.length}, mean ${(mean(rec[t].age) * 1000).toFixed(0)} ms)`);
}
const all = TYPES.flatMap(t => rec[t].ramp);
console.log(`straight lands with the close-range ramp active (ramp < 1): ${all.filter(v => v < 1).length} of ${all.length}, mean ramp ${mean(all).toFixed(3)}`);
