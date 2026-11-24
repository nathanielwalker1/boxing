// REPLAY A/B: one real flow knockdown (as replay_real_probe: both men on the AI, damage scaled, frame clock stepped by
// hand at 60 fps), then the SAME knockdown replay (window.__replayStart) played again under each setting in argv[2]
// (a JSON list of cfg overlays; [] = only the base). Per pass, both men, every drawn frame: the drawn head, chest
// (shoulder midpoint) and both gloves (bones); a "jump" = the point off the midpoint of its neighbours by more than
// 3 cm (at quarter speed a real motion is a few mm a frame). Prints per pass the count and worst per joint.
// argv: [2] variants JSON, [3] damage scale (default 6). Screens of the first pass: none.
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until } from './waits.js';

const VARS = JSON.parse(process.argv[2] || '[]'), DMG = +(process.argv[3] || 6);
const BOOT = process.argv[4] && process.argv[4] !== '-' ? JSON.parse(process.argv[4]) : null;   // cfg overlay from boot (the whole run)
const t0 = Date.now();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(() => {
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  const raf = window.requestAnimationFrame.bind(window); let q = [], T = 0; window.__manual = false;
  window.requestAnimationFrame = cb => { if (window.__manual) { q.push(cb); return 1; } return raf(cb); };
  window.__goManual = () => { T = performance.now(); window.__manual = true; };
  window.__stepFrames = (n, ms) => { for (let i = 0; i < n; i++) { const cbs = q; q = []; T += ms; for (const c of cbs) c(T); } };
});
await page.goto(`${DEV_URL}/?menu=1&human=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await bootReady(page);
const on = s => until(page, x => window.__flow.state().screen === x, s, { label: `screen ${s}`, timeout: 60_000 });
await page.evaluate(o => { const c = window.__cfg; window.__flow.rounds(1, 900); c.flowWalkOn = false; c.flowStareSeconds = 0.1; c.debugHitboxes = false; if (o) Object.assign(c, o); }, BOOT);
if (BOOT) console.log(`boot cfg ${JSON.stringify(BOOT)}`);
for (const s of ['select', 'opponent', 'fight']) { await page.keyboard.press('Enter'); await on(s); }
await until(page, () => !!window.__humanProbe?.(0) && !!window.__humanProbe?.(1) && window.__tick.simTicks > 5, undefined, { label: 'fight', timeout: 150_000 });
await page.evaluate(async DMG => {
  const c = window.__cfg; c.healthDamagePerImpulse *= DMG;
  const AI = await import('/src/ai/index.ts'), core = await import('/src/core/index.ts');
  const st = window.__sim.state(); const spec = core.ROSTER.find(r => r.id === st.fighters[0].specId);
  let ai = AI.createAi(0, 7, c, AI.styleFor(spec, c));
  window.__sim.drive(0, s => { const d = AI.aiStep(ai, s, c); ai = d.ai; return d.input; });
  window.__goManual();
}, DMG);
// LIVE first: 600 drawn frames of the live fight at 60 fps, the same jump count (what Nate plays)
{
  const r = await page.evaluate(() => {
    const w = window, tr = [];
    for (let n = 0; n < 600 && !w.__flow.state().replay; n++) {
      w.__stepFrames(1, 1000 / 60);
      tr.push([0, 1].map(s => { const p = w.__humanProbe(s), f = w.__sim.state().fighters[s]; return { head: p.head, gL: p.gloves.left, gR: p.gloves.right, lab: p.label, down: f.down, pos: [f.pos.x, f.pos.z], org: p.origin, tick: w.__sim.state().tick }; }));
    }
    const out = {}, list = [];
    for (let i = 1; i < tr.length - 1; i++) for (const s of [0, 1]) {
      const a = tr[i - 1][s].head, b = tr[i][s].head, c = tr[i + 1][s].head;
      const d = Math.hypot(b[0] - (a[0] + c[0]) / 2, b[1] - (a[1] + c[1]) / 2, b[2] - (a[2] + c[2]) / 2) * 100;
      if (d > 6) list.push(`f${i} t${tr[i][s].tick} s${s} head ${d.toFixed(1)} cm | ${tr[i - 1][s].lab} -> ${tr[i][s].lab} -> ${tr[i + 1][s].lab} | sim pos step ${(Math.hypot(tr[i][s].pos[0] - tr[i - 1][s].pos[0], tr[i][s].pos[1] - tr[i - 1][s].pos[1]) * 100).toFixed(1)} cm, origin step ${(Math.hypot(tr[i][s].org[0] - tr[i - 1][s].org[0], tr[i][s].org[2] - tr[i - 1][s].org[2]) * 100).toFixed(1)} cm${tr[i][s].down ? ' DOWN' : ''}`);
    }
    w.__liveList = list;
    for (const s of [0, 1]) for (const j of ['head', 'gL', 'gR']) {
      let cnt = 0, worst = 0, lab = '';
      for (let i = 1; i < tr.length - 1; i++) {
        if (tr[i][s].down) continue;
        const a = tr[i - 1][s][j], b = tr[i][s][j], c = tr[i + 1][s][j];
        const d = Math.hypot(b[0] - (a[0] + c[0]) / 2, b[1] - (a[1] + c[1]) / 2, b[2] - (a[2] + c[2]) / 2) * 100;
        if (d > 6) cnt++;
        if (d > worst) { worst = d; lab = tr[i][s].lab; }
      }
      out[`s${s}${j}`] = `${cnt}/${worst.toFixed(1)}`;
    }
    return { n: tr.length, out, list: list.slice(0, 30) };
  });
  for (const l of r.list) console.log('  ' + l);
  console.log(`LIVE ${r.n} frames at 60 fps, jumps over 6 cm (count/worst cm): ${Object.entries(r.out).map(([k, v]) => `${k} ${v}`).join(' ')}`);
}
let g = 0;
while (!(await page.evaluate(() => window.__flow.state().replay))) { await page.evaluate(() => window.__stepFrames(4, 250)); if (++g > 600) { console.log('no knockdown'); process.exit(1); } }
console.log(`knockdown after ${g} live steps (${((Date.now() - t0) / 1000).toFixed(0)} s)`);

const pass = async (label, overlay) => {
  const r = await page.evaluate(({ overlay, first }) => {
    const w = window, c = w.__cfg, saved = {};
    if (overlay) for (const k of Object.keys(overlay)) { saved[k] = c[k]; c[k] = overlay[k]; }
    if (!first) { if (!w.__replayStart()) return { err: 'no replay' }; }
    const tr = [];
    let n = 0;
    const stg = [];
    while ((n === 0 || w.__replayOn()) && n < 1200) {
      w.__humanStages = {};
      w.__stepFrames(1, 1000 / 60); n++;
      stg.push(w.__humanStages[0] ? w.__humanStages[0].map(([nm, l, r]) => [nm, [...l], [...r]]) : null);
      const P = [0, 1].map(s => w.__humanProbe(s));
      tr.push(P.map(p => ({ head: p.head, chest: [0, 1, 2].map(k => (p.shoulders.left[k] + p.shoulders.right[k]) / 2), gL: p.gloves.left, gR: p.gloves.right, lab: p.label })));
    }
    for (const k of Object.keys(saved)) c[k] = saved[k];
    // per drawing stage (side 0): how many drawn frames its glove output jumps by more than 3 cm (off its neighbours' midpoint)
    const stageJ = {};
    for (let i = 1; i < stg.length - 1; i++) {
      const A = stg[i - 1], B = stg[i], C = stg[i + 1];
      if (!A || !B || !C) continue;
      B.forEach(([nm, l, r], k) => {
        const a = A.find(x => x[0] === nm), cc = C.find(x => x[0] === nm);
        if (!a || !cc) return;
        const j = Math.max(...[[l, a[1], cc[1]], [r, a[2], cc[2]]].map(([b, aa, c2]) => Math.hypot(b[0] - (aa[0] + c2[0]) / 2, b[1] - (aa[1] + c2[1]) / 2, b[2] - (aa[2] + c2[2]) / 2) * 100));
        const key = `${String(k).padStart(2, '0')} ${nm}`;
        stageJ[key] ??= 0; if (j > 3) stageJ[key]++;
      });
    }
    const out = {};
    for (const s of [0, 1]) for (const j of ['head', 'chest', 'gL', 'gR']) {
      let cnt = 0, worst = 0, at = 0, lab = '';
      for (let i = 1; i < tr.length - 1; i++) {
        const a = tr[i - 1][s][j], b = tr[i][s][j], cc = tr[i + 1][s][j];
        const d = Math.hypot(b[0] - (a[0] + cc[0]) / 2, b[1] - (a[1] + cc[1]) / 2, b[2] - (a[2] + cc[2]) / 2) * 100;
        if (d > 3) cnt++;
        if (d > worst) { worst = d; at = i; lab = tr[i][s].lab; }
      }
      out[`s${s}${j}`] = { cnt, worst: +worst.toFixed(1), at, lab };
    }
    return { frames: tr.length, out, stageJ };
  }, { overlay, first: label === 'base (first)' });
  if (r.stageJ && Object.keys(r.stageJ).length) console.log(`   side 0 glove jumps by stage: ${Object.entries(r.stageJ).sort().map(([k, v]) => `${k}:${v}`).join(' | ')}`);
  if (r.err) { console.log(`${label}: ${r.err}`); return; }
  const tot = Object.values(r.out).reduce((a, v) => a + v.cnt, 0);
  console.log(`${label.padEnd(44)} ${r.frames} frames, jumps over 3 cm: ${tot} | ${Object.entries(r.out).map(([k, v]) => `${k} ${v.cnt}/${v.worst}`).join(' ')}`);
  const w = Object.entries(r.out).sort((a, b) => b[1].worst - a[1].worst)[0];
  console.log(`   worst ${w[0]} ${w[1].worst} cm at frame ${w[1].at} (${w[1].lab})`);
};
await pass('base (first)', null);
await pass('base (again)', null);
for (const v of VARS) await pass(JSON.stringify(v), v);
console.log(`console errors/warnings: ${logs.filter(l => !/GPU stall/.test(l)).length}; wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await browser.close();
