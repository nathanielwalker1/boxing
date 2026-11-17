/**
 * human_fight_check.mjs — the game with the human fighters (?human=1), from the play camera. Each beat is a
 * deterministic run of the sim fed TICK BY TICK (window.__rigReplay, rig/replay.ts) through the human views, so
 * events (hit snap, sweat, reactions) are in the frames. Frames -> scripts/output/human_fight/<beat>_tNNN.png,
 * one sheet per beat -> <beat>.png. Then fps from the overlay with human on and off, and the console (must be
 * clean). Render check only.
 *   PORT=5195 node scripts/human_fight_check.mjs [beat ...]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'human_fight');
mkdirSync(OUT, { recursive: true });
const W = 640, H = 400;
const at = o => { const a = []; for (const [k, v] of Object.entries(o)) a[Number(k)] = v; return a; };
const hold = (a, key, from, to) => { for (let i = from; i <= to; i++) a[i] = { ...(a[i] ?? {}), [key]: true }; return a; };
const flick = (x, y, t) => ({ [t]: { move: { x, y } }, [t + 1]: { move: { x, y } } });
const range = (a, b, s) => { const r = []; for (let t = a; t <= b; t += s) r.push(t); return r; };
const FLOOR = { camLookY: 0.75, camDistMin: 3.3 };

// ticks are absolute; `hit: true` adds the tick side 0's first punch resolves to the label
const BEATS = [
  { name: 'idle', dist: 0.85, s0: [], s1: [], ticks: range(10, 85, 15) },
  { name: 'jab', dist: 0.85, s0: at({ 2: { jab: true } }), s1: [], ticks: range(4, 24, 4), hit: true },
  { name: 'cross', dist: 0.85, s0: at({ 2: { cross: true } }), s1: [], ticks: range(10, 30, 4), hit: true },
  { name: 'combo', dist: 0.8, s0: at({ 2: { jab: true }, 16: { cross: true }, 34: { hook: true, move: { x: -1, y: 0 } } }), s1: [], ticks: range(6, 62, 4), hit: true, cols: 5 },
  { name: 'jab_cross', dist: 0.85, s0: at({ 2: { jab: true }, 9: { cross: true } }), s1: [], ticks: range(8, 41, 3), hit: true, cols: 4 },
  { name: 'pull', dist: 1.0, s0: [], s1: at(flick(0, -1, 70)), ticks: range(70, 94, 4) },   // late, so the last beat's reaction has worn off
  { name: 'slip_lead', dist: 1.0, s0: [], s1: at(flick(-1, 0, 4)), ticks: range(4, 24, 4) },
  { name: 'slip_rear', dist: 1.0, s0: [], s1: at(flick(1, 0, 4)), ticks: range(4, 24, 4) },
  { name: 'roll', dist: 1.0, s0: [], s1: hold(at(flick(1, 0, 8)), 'level', 0, 30), ticks: range(8, 28, 4) },
  { name: 'level', dist: 1.2, s0: [], s1: hold([], 'level', 10, 70), ticks: [6, 14, 22, 30, 46, 80] },
  // integration (mocapGeo): at the distances the AI keeps; `offs` = ticks relative to the first hit test
  { name: 'i_idle', dist: 1.3, s0: [], s1: [], ticks: [10, 40] },
  { name: 'i_jab', dist: 1.3, s0: at({ 2: { jab: true } }), s1: [], offs: [-4, -2, 0, 3, 8, 14], hit: true },
  { name: 'i_cross', dist: 1.15, s0: at({ 2: { cross: true } }), s1: [], offs: [-8, -4, 0, 3, 8, 16], hit: true },
  { name: 'i_lead_hook', dist: 1.05, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], offs: [-8, -4, 0, 3, 8, 16], hit: true },
  { name: 'i_rear_hook', dist: 1.2, s0: at({ 2: { hook: true, move: { x: 1, y: 0 } } }), s1: [], offs: [-8, -4, 0, 3, 8, 16], hit: true },
  { name: 'i_rear_upper', dist: 0.9, s0: at({ 2: { uppercut: true, move: { x: 1, y: 0 } } }), s1: [], offs: [-8, -4, 0, 3, 8, 16], hit: true },
  { name: 'i_jab_cross', dist: 1.15, s0: at({ 2: { jab: true }, 9: { cross: true } }), s1: [], ticks: range(8, 41, 3), hit: true, cols: 4 },
  { name: 'i_block', dist: 1.2, s0: at({ 30: { jab: true } }), s1: hold([], 'block', 4, 90), ticks: [4, 8, 14, 30, 40, 46], hit: true },
  { name: 'i_whiff', dist: 1.75, s0: at({ 2: { jab: true } }), s1: [], offs: [-2, 0, 4, 10], hit: true },
  { name: 'i_close', dist: 0.75, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } }, 20: { uppercut: true, move: { x: 1, y: 0 } } }), s1: at({ 10: { jab: true } }), ticks: range(4, 52, 4), cols: 4 },
  { name: 'knockdown', dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], cfg: { healthDamagePerImpulse: 0.006, ...FLOOR }, ticks: range(16, 316, 20), cols: 4 },
];
const only = process.argv.slice(2);
if (only.length) BEATS.splice(0, BEATS.length, ...BEATS.filter(b => only.includes(b.name)));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
page.on('crash', () => console.error('  PAGE CRASHED'));
// Other workers save shared files while this runs: keep Vite's HMR socket from ever connecting, so no reload lands mid-film.
await page.addInitScript(() => {
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
});

async function boot(human) {
  await page.goto(`${DEV_URL}/?ai=0&menu=0${human ? '&human=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bootReady(page);
  if (human) await until(page, () => typeof window.__rigReplay === 'function', undefined, { label: 'human views up', timeout: 60_000 });
  await page.evaluate(() => {
    const c = window.__cfg;
    c.debugHitboxes = false; c.refEnabled = false;
    c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;
    c.camDistMin = 2.4; c.camLookY = 1.25;   // close on the pair, as Nate plays it (filmstrip.mjs)
    window.__focus = -1;
  });
}
async function fpsSample() {
  await frames(page, 30);   // the overlay averages over a second; count frames, not game time
  await until(page, () => (window.__fps?.fps ?? 0) > 0, undefined, { label: 'fps overlay sample', timeout: 30_000 });
  return page.evaluate(() => window.__fps.fps);
}
const args = b => [b.dist, Array.from(b.s0, x => x ?? null), Array.from(b.s1, x => x ?? null)];

await boot(true);
const sheets = [];
// Another worker edits shared files; a Vite full reload mid-beat destroys the page context: boot again and redo the beat.
for (const b of BEATS) {
  for (let attempt = 0; ; attempt++) {
    try { await shootBeat(b); break; } catch (e) {
      if (attempt >= 3 || !/context was destroyed|navigation|Target closed|__rigReplay is not a function|__replay is not a function/i.test(String(e.message))) throw e;
      console.error(`  ${b.name}: page reloaded under the run (${String(e.message).split('\n')[0]}); booting again`);
      await boot(true);
    }
  }
}
async function shootBeat(b) {
  const restore = await page.evaluate(over => { const was = {}; for (const k in over) { was[k] = window.__cfg[k]; window.__cfg[k] = over[k]; } return was; }, b.cfg ?? {});
  if (b.hit) {
    b.hitTick = await page.evaluate(([dist, s0, s1]) => {
      for (let t = 1; t < 80; t++) {
        window.__replay(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {}));
        if (window.__states()[0].punch.resolved) return t;
      }
      return -1;
    }, args(b));
    if (b.offs) b.ticks = b.offs.map(o => Math.max(1, b.hitTick + o));
  }
  const files = [], labels = [];
  for (const t of b.ticks) {
    await page.evaluate(([dist, s0, s1, t]) => window.__rigReplay(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {})), [...args(b), t]);
    await frames(page, 3);
    const f = `${OUT}/${b.name}_t${String(t).padStart(3, '0')}.png`;
    await page.screenshot({ path: f }).catch(async e => {
      console.error(`  ${b.name} t=${t}: capture failed (${String(e.message).split('\n')[0]}); retrying once`);
      await frames(page, 2);
      await page.screenshot({ path: f, timeout: 120_000 });
    });
    const lab = await page.evaluate(() => `${window.__human?.[0]?.label() ?? '?'} | ${window.__human?.[1]?.label() ?? '?'}`);
    files.push(f);
    labels.push(`${b.name} t=${t}${b.hitTick ? ` (1st hit ${b.hitTick})` : ''}  ${lab}`);
  }
  await page.evaluate(was => { Object.assign(window.__cfg, was); }, restore);
  const sheet = await page.evaluate(async ({ imgs, labels, w, h, cols }) => {
    const rows = Math.ceil(imgs.length / cols);
    const cv = document.createElement('canvas'); cv.width = w * cols; cv.height = h * rows;
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height); g.font = '12px monospace';
    for (let i = 0; i < imgs.length; i++) {
      const im = await new Promise(r => { const x = new Image(); x.onload = () => r(x); x.src = imgs[i]; });
      const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(im, x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, g.measureText(labels[i]).width + 10, 18);
      g.fillStyle = '#fff'; g.fillText(labels[i], x + 5, y + 13);
    }
    return cv.toDataURL('image/png');
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), labels, w: W / 2, h: H / 2, cols: b.cols ?? 3 });
  const path = `${OUT}/${b.name}.png`;
  writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
  sheets.push(path);
}

// fps: the live fight (AI off, fighters placed close), human on, then off
await page.evaluate(() => { for (const s of [0, 1]) window.__rig?.[s]?.freeze?.(false); window.__sim.place(0.85); });
const fpsOn = await fpsSample();
await boot(false);
await page.evaluate(() => { window.__sim.place(0.85); });
const fpsOff = await fpsSample();
await browser.close();

console.log(sheets.join('\n'));
for (const b of BEATS) if (b.hitTick) console.log(`  ${b.name}: first hit tick ${b.hitTick}`);
console.log(`fps (headless software GL) human on ${fpsOn}, off ${fpsOff}`);
const benign = t => /GPU stall due to ReadPixels/.test(t);
logs.filter(m => (m.type === 'info' || m.type === 'log') && /human/.test(m.text)).forEach(m => console.log(`  [${m.type}] ${m.text}`));
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
console.log('PASS — console clean.');
