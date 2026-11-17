/**
 * mocap_geo_probe.mjs — AI vs AI with the mocap glove geometry (cfg.mocapGeo) on vs off: per style, N seeded fights
 * of the style against itself (ROSTER[0] vs ROSTER[1] bodies), at the human mode's punchTimeScale.
 *   node scripts/mocap_geo_probe.mjs [on|off|both] [fights=20] [seconds=20] [rangeScale]
 * Prints per style: mean centre-to-centre distance while fighting, punches thrown / landed / blocked / whiffed per
 * minute (both fighters), knockdowns per fight, mean fight length (s).
 */
import { load } from './load.mjs';
import { loadMocapLib } from './lib/mocap_load.mjs';

const [core, sim, AI, mocap] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts');
loadMocapLib(mocap);
const mode = process.argv[2] ?? 'both', N = Number(process.argv[3] ?? 20), SECS = Number(process.argv[4] ?? 20), SCALE = process.argv[5];
const STYLES = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];

function fight(style, seed, on) {
  const base = core.createConfig();
  const cfg = { ...base, punchTimeScale: base.humanPunchTimeScale, mocapGeo: on, ...(SCALE ? { mocapRangeScale: Number(SCALE) } : {}) };
  const specs = [{ ...core.ROSTER[0], style }, { ...core.ROSTER[1], style }];
  let s = sim.createState(specs, cfg, seed);
  let a = AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), b = AI.createAi(1, seed + 1, cfg, AI.styleFor(specs[1], cfg));
  const c = { dist: 0, n: 0, thrown: 0, landed: 0, blocked: 0, whiffed: 0, kd: 0, t: 0 };
  const ticks = Math.round(SECS * 60);
  for (let i = 0; i < ticks; i++) {
    const da = AI.aiStep(a, s, cfg), db = AI.aiStep(b, s, cfg); a = da.ai; b = db.ai;
    const r = sim.step(s, [da.input, db.input], cfg); s = r.state;
    if (s.round.phase === 'fighting') { c.dist += core.v2dist(s.fighters[0].pos, s.fighters[1].pos); c.n++; }
    for (const e of r.events) {
      if (e.type === 'punchStart') c.thrown++;
      else if (e.type === 'punchLand') c.landed++;
      else if (e.type === 'punchBlock') c.blocked++;
      else if (e.type === 'punchWhiff') c.whiffed++;
      else if (e.type === 'knockdown') c.kd++;
    }
    c.t = s.time;
    if (r.events.some(e => e.type === 'ko' || e.type === 'tko')) break;
  }
  return c;
}

function row(style, on) {
  const tot = { dist: 0, n: 0, thrown: 0, landed: 0, blocked: 0, whiffed: 0, kd: 0, t: 0 };
  for (let k = 0; k < N; k++) { const c = fight(style, 1000 + k * 17, on); for (const key in tot) tot[key] += c[key]; }
  const min = tot.t / 60;
  return `${style.padEnd(9)} ${on ? 'on ' : 'off'}  dist ${(tot.dist / Math.max(1, tot.n)).toFixed(2)}  thrown ${(tot.thrown / min).toFixed(0).padStart(3)}  landed ${(tot.landed / min).toFixed(0).padStart(3)}  blocked ${(tot.blocked / min).toFixed(0).padStart(3)}  whiffed ${(tot.whiffed / min).toFixed(0).padStart(3)} /min  kd ${(tot.kd / N).toFixed(2)}/fight  length ${(tot.t / N).toFixed(1)} s`;
}

console.log(`mocap_geo_probe: ${N} fights x ${SECS} s per style, style vs itself${SCALE ? ', mocapRangeScale ' + SCALE : ''}`);
for (const st of STYLES) {
  if (mode !== 'on') console.log(row(st, false));
  if (mode !== 'off') console.log(row(st, true));
}
