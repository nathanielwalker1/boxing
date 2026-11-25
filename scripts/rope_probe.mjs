// ROPES, measured on the drawn MESH against the drawn (bowed) ropes. ?human=1, no AI. Per scenario the player (side 0) is
// put by a rope or in a corner and driven (walk back into it, strafe into it, lean back off it, slip toward it, get knocked
// down on it); every drawn frame every sampled skinned vertex of BOTH men is checked against each side's rope plane at
// its own height (bow included), and the deepest it goes past the rope's outer face is kept. "low" = vertices under the
// top rope (a body must never be there), "any" = including a head / arm over the top rope.
// argv: [2] scenario names comma-separated or 'all', [3] cfg JSON or '-'. Prints one line per scenario.
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';

const ONLY = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const CFG = process.argv[3] && process.argv[3] !== '-' ? JSON.parse(process.argv[3]) : null;
const SHOTS = process.argv[4] === 'shots';   // screenshots every 12 drawn frames into scripts/output/rope/
const OUT = new URL('./output/rope/', import.meta.url).pathname;
if (SHOTS) (await import('fs')).mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(() => {
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  // the frame clock: free until __goManual, then only __stepFrames moves it (60 fps, one drawn frame per tick)
  const raf = window.requestAnimationFrame.bind(window);
  let q = [], T = 0;
  window.__manual = false;
  window.requestAnimationFrame = cb => { if (window.__manual) { q.push(cb); return 1; } return raf(cb); };
  window.__goManual = () => { T = performance.now(); window.__manual = true; };
  window.__stepFrames = (n, ms) => { for (let i = 0; i < n; i++) { const cbs = q; q = []; T += ms; for (const c of cbs) c(T); } };
});
await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await bootReady(page);
await until(page, () => !!window.__humanMesh?.[0] && !!window.__humanMesh?.[1] && !!window.__ropes, undefined, { label: 'mesh + ropes', timeout: 150_000 });
await page.evaluate(o => { const c = window.__cfg; c.debugHitboxes = false; c.refEnabled = false; if (o) Object.assign(c, o); window.__goManual(); }, CFG);

// scenario: where the two stand (fractions of the bound), what each side does per tick (functions of tick, as source)
const SC = [
  { name: 'back_east', p: [0.92, 0], o: [0.2, 0], ticks: 200, p0: 't => ({ move: { x: 0, y: -1 } })' },
  { name: 'back_north', p: [0, -0.92], o: [0, -0.2], ticks: 200, p0: 't => ({ move: { x: 0, y: -1 } })' },
  { name: 'back_corner', p: [0.92, 0.92], o: [0.35, 0.35], ticks: 220, p0: 't => ({ move: { x: 0, y: -1 } })' },
  { name: 'strafe_into_south', p: [0, 0.8], o: [-1.0, 0.8], ticks: 200, p0: 't => ({ move: { x: 1, y: 0 } })' },
  { name: 'strafe_into_south_r', p: [0, 0.8], o: [-1.0, 0.8], ticks: 200, p0: 't => ({ move: { x: -1, y: 0 } })' },
  { name: 'walk_diag_corner', p: [0.6, 0.6], o: [-0.4, -0.2], ticks: 220, p0: 't => ({ move: { x: 0.7, y: -0.7 } })' },
  { name: 'lean_back_on_ropes', p: [0.95, 0], o: [0.1, 0], ticks: 160, p0: 't => (t < 60 ? { move: { x: 0, y: -1 } } : (t >= 80 && t < 84) || (t >= 120 && t < 124) ? { move: { x: 0, y: -1 } } : {})' },
  { name: 'slip_toward_rope', p: [0.3, 0.95], o: [-0.6, 0.95], ticks: 120, p0: 't => ((t >= 20 && t < 24) || (t >= 70 && t < 74) ? { move: { x: 1, y: 0 } } : {})' },
  // knockdowns as anim_film's kd_* (0.79 m, one punch, healthDamagePerImpulse 0.006): the player stands at the bound, his back to it
  { name: 'knockdown_on_ropes', p: [1, 0], o: [1, 0], oAbs: [-0.79, 0], ticks: 420, kd: true, p0: 't => ({})', p1: 't => (t === 2 ? { cross: true } : {})' },
  { name: 'knockdown_on_ropes_hook', p: [1, 0], o: [1, 0], oAbs: [-0.79, 0], ticks: 420, kd: true, p0: 't => ({})', p1: 't => (t === 2 ? { hook: true, move: { x: -1, y: 0 } } : {})' },
  { name: 'knockdown_in_corner', p: [1, 1], o: [1, 1], oAbs: [-0.56, -0.56], ticks: 420, kd: true, p0: 't => ({})', p1: 't => (t === 2 ? { cross: true } : {})' },
  { name: 'knockdown_in_corner_hook', p: [1, 1], o: [1, 1], oAbs: [-0.56, -0.56], ticks: 420, kd: true, p0: 't => ({})', p1: 't => (t === 2 ? { hook: true, move: { x: 1, y: 0 } } : {})' },
];

const results = [];
for (const sc of SC) {
  if (ONLY && !ONLY.includes(sc.name)) continue;
  const r = await page.evaluate(async sc => {
    const w = window, c = w.__cfg, sim = await import('/src/sim/index.ts');
    const b = sim.bound ? sim.bound(c) : null;
    const pts0 = w.__ropes.points(), h = pts0[1][0][0];   // side 1 (normal +x) starts at x = h
    const B = b ?? (h - c.ringInset);
    const dmg0 = c.healthDamagePerImpulse; if (sc.kd) c.healthDamagePerImpulse = 0.02;
    w.__sim.place(1);
    const s = w.__sim.state();
    s.fighters[0].pos = { x: sc.p[0] * B, z: sc.p[1] * B }; s.fighters[1].pos = { x: sc.o[0] * B + (sc.oAbs?.[0] ?? 0), z: sc.o[1] * B + (sc.oAbs?.[1] ?? 0) };
    const ang = Math.atan2(s.fighters[1].pos.z - s.fighters[0].pos.z, s.fighters[1].pos.x - s.fighters[0].pos.x);
    s.fighters[0].yaw = ang; s.fighters[1].yaw = ang + Math.PI;
    const f0 = eval(sc.p0), f1 = sc.p1 ? eval(sc.p1) : (() => ({}));
    const start = s.tick;
    w.__sim.drive(0, st => { const t = st.tick - start; return t < sc.ticks ? f0(t) : {}; });
    w.__sim.drive(1, st => { const t = st.tick - start; return t < sc.ticks ? f1(t) : {}; });
    return { start, h, B, dmg0 };
  }, sc);
  let worstLow = 0, worstAny = 0, worstPart = '', worstT = 0, nFrames = 0, framesThrough = 0, down = false;
  for (;;) {
    const m = await page.evaluate(({ h }) => {
      window.__stepFrames(2, 1000 / 60);
      const w = window, c = w.__cfg, P = w.__ropes.points(), rt = c.ropeThickR;
      const NX = [0, 1, 0, -1], NZ = [-1, 0, 1, 0], TX = [1, 0, -1, 0], TZ = [0, 1, 0, -1];
      const N = P[0][0].length / 3 - 1;
      const ys = P[0].map(r => r[1 + 3 * Math.round(N / 2)]);   // rope heights at mid-span (sagged) — close enough for the band
      const bowAt = (k, j, u) => { const fi = (u + h) / (2 * h) * N, i0 = Math.max(0, Math.min(N - 1, Math.floor(fi))), a = fi - i0, r = P[k][j];
        const d = i => (r[3 * i] * NX[k] + r[3 * i + 2] * NZ[k]) - h; return d(i0) * (1 - a) + d(i0 + 1) * a; };
      let low = 0, any = 0, part = '', through = 0;
      const st = w.__sim.state();
      for (const side of [0, 1]) {
        const M = w.__humanMesh[side](true);
        for (const key of ['head', 'torso', 'L', 'R', 'rest']) {
          const A = M[key];
          for (let i = 0; i < A.length; i += 3) {
            const x = A[i], y = A[i + 1], z = A[i + 2];
            for (let k = 0; k < 4; k++) {
              const qn = x * NX[k] + z * NZ[k];
              if (qn < h - 0.3) continue;
              const qu = x * TX[k] + z * TZ[k];
              if (qu < -h - 0.4 || qu > h + 0.4) continue;   // (past the post too: a foot backed into a corner)
              let j = 0; while (j < ys.length - 1 && y > ys[j]) j++;
              // the bow between the rope under and the rope over this height
              let bow;
              if (y <= ys[0]) bow = bowAt(k, 0, qu); else if (y >= ys[ys.length - 1]) bow = bowAt(k, ys.length - 1, qu);
              else { const a = (y - ys[j - 1]) / (ys[j] - ys[j - 1]); bow = bowAt(k, j - 1, qu) * (1 - a) + bowAt(k, j, qu) * a; }
              // (past the rope's STRAIGHT line, rope thickness included: the bowed-rope comparison misread a bowing rope by
              //  up to a metre — a body ON the canvas must never pass the line; a standing one may push a rope out, judged by eye)
              const depth = (st.fighters[side].down ? qn - h - rt : qn - (h + Math.max(0, Math.min(bow, c.ropeBowMax))) - rt);
              if (depth > any) any = depth;
              if (y < ys[ys.length - 1] + 0.03 && depth > low) { low = depth; part = `s${side} ${key} @${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)} side${k} qn${qn.toFixed(2)} qu${qu.toFixed(2)}`; }
              if (y < ys[ys.length - 1] + 0.03 && depth > 0.03) through = 1;
            }
          }
        }
      }
      // the rope system's own view: its slide offset and the deepest capsule surface past each side's unbowed rope line
      const caps = w.__ropes.capsules(0) ?? [];
      let capD = -9;
      for (const cp of caps) for (const [x, , z] of [[cp[0], cp[1], cp[2]], [cp[3], cp[4], cp[5]]]) for (let k = 0; k < 4; k++) capD = Math.max(capD, x * NX[k] + z * NZ[k] + cp[6] - h);
      const off = w.__ropes.state().off[0];
      // the head three ways: the rope system's capsule, the view's head bone, the skinned head vertices' centroid
      const capH = caps.find(cp => cp[7] === 'head'), pH = w.__humanProbe(0).head, mH = w.__humanMesh[0]().head;
      let mx = 0, my = 0, mz = 0; for (let i = 0; i < mH.length; i += 3) { mx += mH[i]; my += mH[i + 1]; mz += mH[i + 2]; }
      const nH = mH.length / 3, f3 = a => a.map(v => v.toFixed(2)).join(',');
      // the deepest 'rest' vertex past side 1's rope (+x): which mesh / bone it is, and that bone's own world x
      const R0 = w.__humanMesh[0](true).rest; let bi = -1, bx = -9;
      for (let i = 0; i < R0.length; i += 3) { const q = Math.max(Math.abs(R0[i]), Math.abs(R0[i + 2])); if (q > bx) { bx = q; bi = i / 3; } }
      const nm = bi >= 0 ? w.__humanMeshRestNames[0]()[bi] : '-';
      const P0 = w.__humanProbe(0);
      w.__headDbg = `deepest rest ${f3(R0.slice(bi * 3, bi * 3 + 3))} = ${nm} | bones hips ${f3(P0.hips)} kneeR ${f3(P0.knees[1])} footR ${f3(P0.feet.right)} footL ${f3(P0.feet.left)} | cap ${capH ? f3(capH.slice(0, 3)) : '-'} bone ${f3(pH)} skin ${f3([mx / nH, my / nH, mz / nH])}`;
      return { low, any, part, through, tick: st.tick, down: st.fighters[0].down || st.fighters[1].down, p1: st.fighters[1].punch.type, hp: st.fighters[0].health, ph: st.round.phase, capD, off, pos: [st.fighters[0].pos.x, st.fighters[0].pos.z] };
    }, r);
    nFrames++; framesThrough += m.through; if (m.down) down = true;
    if (SHOTS && nFrames % 12 === 0 && nFrames <= 120) await page.screenshot({ path: `${OUT}/${sc.name}_t${String(m.tick - r.start).padStart(3, '0')}.png` });
    if (sc.kd && nFrames % 6 === 0 && nFrames <= 120) console.log(`   t${m.tick - r.start} down ${m.down} mesh past rope ${(m.low * 100).toFixed(1)} cm (${m.part}) | capsules past the line ${(m.capD * 100).toFixed(1)} cm | slide ${m.off.map(v => (v * 100).toFixed(1)).join(',')} cm | sim pos ${m.pos.map(v => v.toFixed(2)).join(',')} h ${r.h.toFixed(2)} | head ${await page.evaluate(() => window.__headDbg)}`);
    if (m.low > worstLow) { worstLow = m.low; worstPart = m.part; worstT = m.tick - r.start; }
    if (m.any > worstAny) worstAny = m.any;
    if (m.tick - r.start >= sc.ticks) break;
  }
  await page.evaluate(r => { window.__cfg.healthDamagePerImpulse = r.dmg0; window.__sim.drive(0, null); window.__sim.drive(1, null); }, r);
  results.push(sc.name);
  console.log(`${sc.name.padEnd(22)} under top rope: worst ${(worstLow * 100).toFixed(1)} cm past the rope (${worstPart || '-'} at tick ${worstT}), frames over 3 cm ${framesThrough}/${nFrames}; incl. over the top rope ${(worstAny * 100).toFixed(1)} cm${sc.kd ? (down ? ', went down' : ', NO KNOCKDOWN') : ''}`);
}
console.log(`rope update cost: ${await page.evaluate(() => { const k = window.__ropes.cost; return k.n ? (k.sum / k.n).toFixed(3) : '-'; })} ms a frame (mean over frames it worked)`);
console.log(`console errors/warnings: ${logs.length}${logs.length ? ' — ' + logs.slice(0, 3).join(' | ') : ''}; wall ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await browser.close();
