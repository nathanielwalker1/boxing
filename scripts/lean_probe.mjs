// LEAN (+ PUNCH), measured on the drawn bones against the sim. ?human=1, no AI, the frame clock stepped by hand (one drawn
// frame per tick). Per scenario (a flick left / right / back, the level held, optionally Shift held, optionally a punch
// pressed while the lean is held) every tick: the sim head's offset (slip.offset, + = the dodge distance), the DRAWN head
// in the fighter's own frame from where it stood at tick 0 (fwd + = toward the other man, lat + = his right, up), the
// spine's tilt (hips -> neck: back + = leaning away, side + = to his right, deg), the shoulder line's turn off square (deg,
// + = right shoulder forward), and the punch / clip label. One summary line per scenario: the peak drawn head travel in
// the dodge direction against the sim's, and the biggest one-tick jumps of head and spine (pops).
// argv: [2] scenario names comma-separated or 'all', [3] 'rows' to print the per-tick rows, [4] cfg JSON or '-'.
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until } from './waits.js';

const ONLY = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : null;
const ROWS = process.argv[3] === 'rows';
const CFG = process.argv[4] && process.argv[4] !== '-' ? JSON.parse(process.argv[4]) : null;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 300 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(() => {
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
  const raf = window.requestAnimationFrame.bind(window);
  let q = [], T = 0;
  window.__manual = false;
  window.requestAnimationFrame = cb => { if (window.__manual) { q.push(cb); return 1; } return raf(cb); };
  window.__goManual = () => { T = performance.now(); window.__manual = true; };
  window.__stepFrames = (n, ms) => { for (let i = 0; i < n; i++) { const cbs = q; q = []; T += ms; for (const c of cbs) c(T); } };
});
await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await bootReady(page);
await until(page, () => !!window.__humanProbe?.(0) && !!window.__humanProbe?.(1), undefined, { label: 'human views', timeout: 150_000 });
await page.evaluate(o => { const c = window.__cfg; c.debugHitboxes = false; c.refEnabled = false; if (o) Object.assign(c, o); window.__goManual(); }, CFG);

const EV = { L: { 4: { move: { x: -1, y: 0 } }, 5: { move: { x: -1, y: 0 } } }, R: { 4: { move: { x: 1, y: 0 } }, 5: { move: { x: 1, y: 0 } } },
  B: { 4: { move: { x: 0, y: -1 } }, 5: { move: { x: 0, y: -1 } } }, D: null };
const SC = [];
for (const ek of ['N', 'L', 'R', 'B', 'D']) for (const shift of [false, true]) for (const pk of [null, 'jab', 'cross', 'hook', 'uppercut']) {
  if ((ek === 'D' || ek === 'N') && shift) continue;   // (N = no lean: the baseline)
  SC.push({ name: `${ek}${shift ? '_shift' : ''}${pk ? '_' + pk : ''}`, ek, shift, pk });
}
const all = [];
for (const sc of SC) {
  if (ONLY && !ONLY.includes(sc.name)) continue;
  const r = await page.evaluate(sc => {
    const w = window, N = 34;
    const script = [];
    for (let t = 0; t < N; t++) script[t] = {};
    const ev = { L: { 4: { move: { x: -1, y: 0 } }, 5: { move: { x: -1, y: 0 } } }, R: { 4: { move: { x: 1, y: 0 } }, 5: { move: { x: 1, y: 0 } } }, B: { 4: { move: { x: 0, y: -1 } }, 5: { move: { x: 0, y: -1 } } } }[sc.ek];
    if (ev) for (const [k, v] of Object.entries(ev)) script[+k] = { ...v };
    if (sc.ek === 'D' || sc.shift) for (let t = sc.shift ? 0 : 4; t < 30; t++) script[t] = { ...script[t], level: true };
    if (sc.pk) script[10] = { ...script[10], [sc.pk]: true };
    w.__sim.place(1.0);
    w.__stepFrames(20, 1000 / 60);   // settle the views on the fresh placing
    w.__sim.place(1.0);
    w.__sim.script(0, script);
    const rows = [];
    let ref = null;
    for (let t = 0; t < N; t++) {
      w.__stepFrames(1, 1000 / 60);
      const s = w.__sim.state().fighters[0], p = w.__humanProbe(0);
      const yaw = s.yaw, F = [Math.cos(yaw), Math.sin(yaw)], R = [-Math.sin(yaw), Math.cos(yaw)];
      // (the sim's right: the sim frame's right is +90 deg from forward in x-z; sign checked by the L / R scenarios' lat)
      const h = p.head, hp = p.hips, nk = p.shoulders ? [(p.shoulders.left[0] + p.shoulders.right[0]) / 2, (p.shoulders.left[1] + p.shoulders.right[1]) / 2, (p.shoulders.left[2] + p.shoulders.right[2]) / 2] : h;
      if (!ref) ref = { h: [...h], o: [s.pos.x, s.pos.z] };
      const dx = h[0] - ref.h[0], dz = h[2] - ref.h[2];
      const sp = [nk[0] - hp[0], nk[1] - hp[1], nk[2] - hp[2]];
      const spF = sp[0] * F[0] + sp[2] * F[1], spR = sp[0] * R[0] + sp[2] * R[1];
      const sh = [p.shoulders.right[0] - p.shoulders.left[0], p.shoulders.right[2] - p.shoulders.left[2]];
      const shF = sh[0] * F[0] + sh[1] * F[1], shR = sh[0] * R[0] + sh[1] * R[1];
      rows.push({ t, off: s.slip.active ? +(s.slip.offset * 100).toFixed(1) : 0, dir: s.slip.dir, kind: s.slip.kind, punch: s.punch.type ? `${s.punch.hand[0]}${s.punch.type}${s.punch.resolved ? '*' : ''}` : '',
        fwd: +((dx * F[0] + dz * F[1]) * 100).toFixed(1), lat: +((dx * R[0] + dz * R[1]) * 100).toFixed(1), up: +((h[1] - ref.h[1]) * 100).toFixed(1),
        tiltB: +(-Math.atan2(spF, sp[1]) * 180 / Math.PI).toFixed(1), tiltS: +(Math.atan2(spR, sp[1]) * 180 / Math.PI).toFixed(1),
        turn: +(Math.atan2(shF, shR) * 180 / Math.PI).toFixed(1), clip: p.label ?? p.clip, gL: p.gloves.lead.map(v => +v.toFixed(3)), gR: p.gloves.rear.map(v => +v.toFixed(3)) });
    }
    return rows;
  }, sc);
  // summary
  const dirOf = { L: 'lat-', R: 'lat+', B: 'fwd-', D: 'up-' }[sc.ek];
  const val = row => dirOf === 'lat-' ? -row.lat : dirOf === 'lat+' ? row.lat : dirOf === 'fwd-' ? -row.fwd : -row.up;
  const peak = Math.max(...r.map(val)), simPeak = Math.max(...r.map(x => Math.abs(x.off)));
  let popH = 0, popS = 0, popT = 0, popAt = 0, popG = 0, popGAt = 0;
  for (let i = 2; i < r.length; i++) {
    const a = r[i - 2], b = r[i - 1], c = r[i];
    const acc = Math.hypot(c.fwd - 2 * b.fwd + a.fwd, c.lat - 2 * b.lat + a.lat, c.up - 2 * b.up + a.up);
    if (acc > popH) { popH = acc; popAt = c.t; }
    popS = Math.max(popS, Math.abs(c.tiltB - 2 * b.tiltB + a.tiltB), Math.abs(c.tiltS - 2 * b.tiltS + a.tiltS));
    popT = Math.max(popT, Math.abs(c.turn - 2 * b.turn + a.turn));
    for (const g of ['gL', 'gR']) { const d = Math.hypot(...c[g].map((v, k) => v - 2 * b[g][k] + a[g][k])) * 100; if (d > popG) { popG = d; popGAt = c.t; } }
  }
  const at10 = r[Math.min(r.length - 1, 16)];
  all.push({ name: sc.name, peak, simPeak });
  console.log(`${sc.name.padEnd(18)} drawn head ${dirOf} peak ${peak.toFixed(1)} cm (sim ${simPeak.toFixed(1)}) | head jerk ${popH.toFixed(1)} cm/t2 @${popAt}, spine jerk ${popS.toFixed(1)} deg, turn jerk ${popT.toFixed(1)} deg, glove jerk ${popG.toFixed(1)} cm @${popGAt} | t16: tiltB ${at10.tiltB} tiltS ${at10.tiltS} turn ${at10.turn} ${at10.clip}`);
  if (ROWS) for (const x of r) console.log(`   t${String(x.t).padStart(2)} off ${String(x.off).padStart(5)} d${x.dir} ${x.punch.padEnd(10)} head fwd ${String(x.fwd).padStart(6)} lat ${String(x.lat).padStart(6)} up ${String(x.up).padStart(6)} | tiltB ${String(x.tiltB).padStart(6)} tiltS ${String(x.tiltS).padStart(6)} turn ${String(x.turn).padStart(6)} | ${x.clip}`);
}
console.log(`console errors/warnings: ${logs.length}${logs.length ? ' — ' + logs.slice(0, 3).join(' | ') : ''}`);
await browser.close();
