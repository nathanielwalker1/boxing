// REAL knockdown replay, measured on the drawn MESH. A flow fight (?menu=1&human=1), both men on the AI, damage scaled so
// knockdowns come quickly. Once a knockdown replay is up the page's frame clock is stepped by hand at 60 fps (so 0.25x
// plays exactly as on a 60 Hz screen: four drawn frames per tick), and every drawn frame we read the skinned vertices of
// both men (window.__humanMesh). Per land in the clip: the closest the punching glove's mesh gets to the scored part's mesh
// (head / torso) in the frames round the land. Per drawn frame per glove: the jump (centroid off the midpoint of its
// neighbours) — what reads as a glove teleporting in slow motion. Frames round each land are saved from the replay camera.
// argv: [2] replays to capture (default 2), [3] damage scale (default 3), [4] cfg JSON or '-'. Output: scripts/output/replay_real/.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until } from './waits.js';

const WANT = +(process.argv[2] || 2), DMG = +(process.argv[3] || 3);
const CFG = process.argv[4] && process.argv[4] !== '-' ? JSON.parse(process.argv[4]) : null;
// screenshots from the replay camera: drawn frames [5]..[6] every [7] (default 270..360 every 3; 0 0 = none)
const SHOT_FROM = +(process.argv[5] ?? 270), SHOT_TO = +(process.argv[6] ?? 360), SHOT_STEP = +(process.argv[7] ?? 3);
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'replay_real');
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(() => {
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  // the frame clock: free until __manual, then only __stepFrames moves it (fixed ms per frame)
  const raf = window.requestAnimationFrame.bind(window);
  let q = [], T = 0;
  window.__manual = false;
  window.requestAnimationFrame = cb => { if (window.__manual) { q.push(cb); return 1; } return raf(cb); };
  window.__goManual = () => { T = performance.now(); window.__manual = true; };
  window.__stepFrames = (n, ms) => { for (let i = 0; i < n; i++) { const cbs = q; q = []; T += ms; for (const c of cbs) c(T); } };
});
await page.goto(`${DEV_URL}/?menu=1&human=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await bootReady(page);
const key = async k => { await page.keyboard.press(k); await page.waitForTimeout(0); };
const on = s => until(page, x => window.__flow.state().screen === x, s, { label: `screen ${s}`, timeout: 60_000 });
await page.evaluate(() => { const c = window.__cfg; window.__flow.rounds(1, 900); c.flowWalkOn = false; c.flowStareSeconds = 0.1; c.debugHitboxes = false; });
await key('Enter'); await on('select');
await key('Enter'); await on('opponent');
await key('Enter'); await on('fight');
await until(page, () => !!window.__humanMesh?.[0] && !!window.__humanMesh?.[1] && window.__tick.simTicks > 5, undefined, { label: 'fight + mesh hook', timeout: 150_000 });
await page.evaluate(async ({ DMG, CFG }) => {
  const c = window.__cfg; c.healthDamagePerImpulse *= DMG; if (CFG) Object.assign(c, CFG);
  const AI = await import('/src/ai/index.ts'), core = await import('/src/core/index.ts');
  const st = window.__sim.state(); const spec = core.ROSTER.find(r => r.id === st.fighters[0].specId);
  let ai = AI.createAi(0, 7, c, AI.styleFor(spec, c));
  window.__sim.drive(0, s => { const d = AI.aiStep(ai, s, c); ai = d.ai; return d.input; });
  window.__goManual();
}, { DMG, CFG });

const step = (n, ms) => page.evaluate(([n, ms]) => window.__stepFrames(n, ms), [n, ms]);
const results = [];
let shot = 0;
for (let r = 0; r < WANT; r++) {
  // live fight at 50 ms a frame until a replay is up (or the fight ends)
  let guard = 0;
  while (!(await page.evaluate(() => window.__flow.state().replay))) {
    await step(4, 250);
    if (++guard > 400) break;
    if (guard % 25 === 0) console.log(await page.evaluate(() => { const s = window.__sim.state(); return `  live t ${s.time.toFixed(0)} s, health ${s.fighters.map(f => f.health.toFixed(2)).join(' / ')}, phase ${s.round.phase}, screen ${window.__flow.state().screen}`; }));
    const scr = await page.evaluate(() => window.__flow.state().screen);
    if (scr !== 'fight') { const ok = await page.evaluate(() => window.__flow.state().replay); if (!ok) break; }
  }
  if (!(await page.evaluate(() => window.__flow.state().replay))) { console.log(`replay ${r + 1}: none came (fight ended or timed out)`); break; }
  // the replay, frame by frame at 60 fps
  const fr = [];
  while (await page.evaluate(() => window.__flow.state().replay)) {
    await step(1, 1000 / 60);
    if (fr.length >= SHOT_FROM && fr.length <= SHOT_TO && (fr.length - SHOT_FROM) % SHOT_STEP === 0) await page.screenshot({ path: `${OUT}/r${r + 1}_f${String(fr.length).padStart(3, '0')}.png` });
    fr.push(await page.evaluate(() => {
      const m = [0, 1].map(s => window.__humanMesh[s]());
      const ev = [0, 1].map(s => (window.__humanProbe(s)?.events ?? []).filter(e => e.type === 'punchLand' && e.side === s).map(e => ({ punch: e.punch, hand: e.hand, part: e.part, power: e.power })));
      const P = [0, 1].map(s => window.__humanProbe(s));
      const lead = P.map(p => p.gloves.lead[0] === p.gloves.left[0] ? 'L' : 'R');
      // the bone glove points and the hands' / forearms' LOCAL rotations (is the wobble the hand turning?)
      const bones = P.map(p => ({ gl: p.gloves.left, gr: p.gloves.right, qLH: p.lq.LeftHand, qRH: p.lq.RightHand, qLF: p.lq.LeftForeArm, qRF: p.lq.RightForeArm, label: p.label }));
      return { m, ev, lead, bones };
    }));
    if (fr.length > 2000) break;
  }
  // per land: closest glove-mesh to part-mesh over the frames round it
  const cen = a => { let x = 0, y = 0, z = 0; const n = a.length / 3; for (let i = 0; i < a.length; i += 3) { x += a[i]; y += a[i + 1]; z += a[i + 2]; } return [x / n, y / n, z / n]; };
  const minD = (A, B) => { let best = 1e9; for (let i = 0; i < A.length; i += 3) for (let j = 0; j < B.length; j += 3) { const d = (A[i] - B[j]) ** 2 + (A[i + 1] - B[j + 1]) ** 2 + (A[i + 2] - B[j + 2]) ** 2; if (d < best) best = d; } return Math.sqrt(best); };
  // glove jumps: centroid off the midpoint of its neighbours, cm, every frame, both men
  const pops = [];
  for (const s of [0, 1]) for (const g of ['L', 'R']) {
    const c = fr.map(f => cen(f.m[s][g]));
    for (let i = 1; i < c.length - 1; i++) { const mid = c[i - 1].map((v, k) => (v + c[i + 1][k]) / 2); const d = Math.hypot(...c[i].map((v, k) => v - mid[k])) * 100; if (d > 1.0) pops.push({ f: i, s, g, cm: +d.toFixed(1) }); }
  }
  const lands = [];
  fr.forEach((f, i) => f.ev.forEach((evs, s) => evs.forEach(e => {
    const g = e.hand === 'lead' ? f.lead[s] : (f.lead[s] === 'L' ? 'R' : 'L');
    let best = { d: 1e9, at: 0 };
    for (let k = Math.max(0, i - 4); k <= Math.min(fr.length - 1, i + 12); k++) { const d = minD(fr[k].m[s][g], fr[k].m[1 - s][e.part === 'head' ? 'head' : 'torso']); if (d < best.d) best = { d, at: k - i }; }
    lands.push({ f: i, s, ...e, g, gapCm: +(best.d * 100).toFixed(1), atFrame: best.at });
  })));
  results.push({ replay: r + 1, frames: fr.length, lands, pops: pops.sort((a, b) => b.cm - a.cm) });
  // raw: per frame, both men's glove / head / torso centroids and vertex counts (to read the jumps by eye)
  writeFileSync(`${OUT}/r${r + 1}_raw.json`, JSON.stringify(fr.map((f, i) => ({ i, ev: f.ev, b: f.bones, c: f.m.map(m => Object.fromEntries(Object.entries(m).map(([k, a]) => [k, [...cen(a).map(v => +v.toFixed(3)), a.length / 3]]))) }))));
  console.log(`replay ${r + 1}: ${fr.length} drawn frames, ${lands.length} lands`);
  for (const l of lands) console.log(`  f${l.f} side ${l.s} ${l.hand} ${l.punch} -> ${l.part}: closest glove-to-${l.part} mesh ${l.gapCm} cm at ${l.atFrame >= 0 ? '+' : ''}${l.atFrame} frames`);
  console.log(`  glove jumps over 1 cm: ${pops.length} (over 2 cm: ${pops.filter(p => p.cm > 2).length}); worst: ${pops.slice(0, 6).map(p => `f${p.f} s${p.s}${p.g} ${p.cm}`).join(', ')}`);
  void shot;
}
console.log(`console errors/warnings: ${logs.length}${logs.length ? ' — ' + logs.slice(0, 3).join(' | ') : ''}`);
console.log(`wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await browser.close();
