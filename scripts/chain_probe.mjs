/**
 * chain_probe.mjs — the kinetic chain of a punch in numbers, per tick (docs/FEEL.md "how to judge a motion
 * change", step 3; docs/POLISH_RIG.md item 4). A look script, not a test.
 *
 *   PORT=5193 node scripts/chain_probe.mjs                      → every punch / hand at 0.85 m, summary tables
 *   PORT=5193 node scripts/chain_probe.mjs hook:lead ticks      → the per-tick table for one punch as well
 *   PORT=5193 node scripts/chain_probe.mjs cfg:hookV2=false     → with a config key set (A/B a toggle)
 *   PORT=5193 node scripts/chain_probe.mjs dist:0.55            → at another range
 *
 * Runs the scripted punch through window.__rigReplay (the real sim AND the real rig, springs included) and reads,
 * for the puncher (side 0, facing +x): the sim's crouch, lean, torso twist (the shoulder line), arm joints, glove
 * and head; and the rig's drawn hips (yaw, height, sideways shift), feet (pivot, heel) and knees (window.__rig[0].chain()).
 * For each channel it prints when it starts moving (5% of its range), when it peaks and where its fastest tick
 * is. A punch that works shows foot / hips first, then shoulders, the fist last.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady } from './waits.js';

const args = process.argv.slice(2);
const cfgArgs = args.filter(a => /^cfg:/.test(a)).map(a => a.slice(4).split('='));
const dist = Number((args.find(a => /^dist:/.test(a)) ?? 'dist:0.85').slice(5));
const perTick = args.includes('ticks');
const want = args.filter(a => /^(jab|cross|hook|uppercut):(lead|rear)$/.test(a));
const ALL = ['hook:lead', 'hook:rear', 'uppercut:lead', 'uppercut:rear', 'jab:lead', 'cross:rear'];
const LAST = { jab: 22, cross: 34, hook: 38, uppercut: 40 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
const logs = [];
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 20_000 });
await bootReady(page);
await page.evaluate(sets => { for (const [k, v] of sets) window.__cfg[k] = v === 'true' ? true : v === 'false' ? false : Number(v); window.__look('red', 'rest', 0); }, cfgArgs);

const DEG = 180 / Math.PI;
for (const key of want.length ? want : ALL) {
  const [punch, hand] = key.split(':');
  const rows = await page.evaluate(([dist, punch, hand, last]) => {
    const s0 = []; s0[2] = { [punch]: true, move: { x: hand === 'lead' ? -1 : 1, y: 0 } };
    const script = Array.from({ length: last + 1 }, (_, i) => s0[i] ?? {});
    const out = [];
    for (let t = 2; t <= last; t++) {
      window.__rigReplay(dist, script, t, [], {});
      const f = window.__states()[0];
      const ch = window.__rig[0].chain?.() ?? null;
      const i = hand === 'lead' ? 0 : 1;
      const a = f.arms[i], g = f.gloves[i].pos;
      const v1 = { x: a.shoulder.x - a.elbow.x, y: a.shoulder.y - a.elbow.y, z: a.shoulder.z - a.elbow.z };
      const v2 = { x: g.x - a.elbow.x, y: g.y - a.elbow.y, z: g.z - a.elbow.z };
      const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z, l1 = Math.hypot(v1.x, v1.y, v1.z), l2 = Math.hypot(v2.x, v2.y, v2.z);
      out.push({
        t, phase: f.punch.type ? f.punch.phase : '-', variant: f.punch.type ? f.punch.variant : '-',
        crouch: f.crouch, leanF: f.lean.fwd, leanL: f.lean.lat, shYaw: f.torsoTwist,
        elbowDeg: Math.acos(Math.max(-1, Math.min(1, dot / (l1 * l2 || 1)))), elbowUp: a.elbow.y - a.shoulder.y,
        fistF: g.x - f.pos.x, fistU: g.y, fistL: g.z - f.pos.z,
        headF: f.headBox.x - f.pos.x, headPastSh: f.headBox.x - f.arms[0].shoulder.x, headL: f.headBox.z - f.pos.z, headY: f.headBox.y,
        hipYaw: ch ? ch.hipYaw : NaN, hipY: ch ? ch.hipY : NaN, hipL: ch ? ch.hipLat : NaN,
        footYaw: ch ? ch.footYaw[i] : NaN, heel: ch ? ch.heel[i] : NaN, heelRear: ch ? ch.heel[1] : NaN, kneeIn: ch ? ch.kneeIn[i] : NaN,
      });
    }
    return out;
  }, [dist, punch, hand, LAST[punch]]);

  const hitT = rows.find(r => r.phase === 'recover')?.t ?? NaN;
  console.log(`\n=== ${punch} (${hand}) at ${dist} m — variant ${rows.find(r => r.variant !== '-')?.variant}; press t=2, hit test t=${hitT - 1}→${hitT} ===`);
  const CH = [
    ['heel (punch side) cm', r => r.heel * 100], ['foot pivot °', r => r.footYaw * DEG], ['knee turn-in cm', r => r.kneeIn * 100],
    ['hip height cm', r => r.hipY * 100], ['hip sideways cm', r => r.hipL * 100], ['hip yaw °', r => r.hipYaw * DEG],
    ['shoulder yaw °', r => r.shYaw * DEG], ['elbow angle °', r => r.elbowDeg * DEG], ['elbow above shoulder cm', r => r.elbowUp * 100],
    ['fist forward cm', r => r.fistF * 100], ['fist height cm', r => r.fistU * 100], ['fist sideways cm', r => r.fistL * 100],
    ['head forward cm', r => r.headF * 100], ['head past lead shoulder cm', r => r.headPastSh * 100], ['head height cm', r => r.headY * 100],
  ];
  if (perTick) {
    console.log(['t', 'phase', ...CH.map(c => c[0])].join(' | '));
    for (const r of rows) console.log([r.t, r.phase, ...CH.map(c => c[1](r).toFixed(1))].join(' | '));
  }
  console.log('channel | rest | start t | extreme (t) | at hit | fastest tick (per tick)');
  for (const [name, get] of CH) {
    const v = rows.map(get);
    if (v.some(x => Number.isNaN(x))) { console.log(`${name} | (no rig probe)`); continue; }
    const v0 = v[0];
    let ext = 0, extI = 0;
    v.forEach((x, i) => { if (Math.abs(x - v0) > Math.abs(ext)) { ext = x - v0; extI = i; } });
    const range = Math.abs(ext);
    const startI = v.findIndex(x => Math.abs(x - v0) > 0.05 * range);
    let rate = 0, rateI = 0;
    for (let i = 1; i < v.length; i++) if (Math.abs(v[i] - v[i - 1]) > Math.abs(rate) && rows[i].t <= hitT) { rate = v[i] - v[i - 1]; rateI = i; }
    const atHit = v[rows.findIndex(r => r.t === hitT)] ?? NaN;
    console.log(`${name} | ${v0.toFixed(1)} | ${range < 0.05 ? '—' : rows[startI].t} | ${(v0 + ext).toFixed(1)} (t=${rows[extI].t}) | ${atHit.toFixed(1)} | ${rate.toFixed(1)} at t=${rows[rateI].t}`);
  }
}
await browser.close();
if (logs.length) { console.error(`page errors:\n  ${logs.join('\n  ')}`); process.exit(1); }
