/**
 * human_fight_check.mjs — the game with the human fighters (?human=1), from the play camera, fighters ~0.85 m
 * apart: idle, jab / cross / lead hook landing, a blocked punch, a head hit, walking forward. Each beat is a
 * deterministic window.__replay per frame; the hit tick is found by stepping until the punch resolves.
 * Frames -> scripts/output/human_fight/<beat>_tNNN.png, one sheet per beat -> <beat>.png. Then fps from the
 * overlay with human on and off, and the console (must be clean). Render check only.
 *   PORT=5195 node scripts/human_fight_check.mjs
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
const walk = Array.from({ length: 60 }, () => ({ move: { x: 0, y: 1 } }));

// offsets are ticks relative to the hit tick (hit: true) or absolute ticks
const BEATS = [
  { name: 'idle', dist: 0.85, s0: [], s1: [], ticks: [10, 25, 40, 55, 70, 85] },
  { name: 'jab', dist: 0.85, s0: at({ 2: { jab: true } }), s1: [], hit: 0, offs: [-6, -3, 0, 2, 6, 12] },
  { name: 'cross', dist: 0.85, s0: at({ 2: { cross: true } }), s1: [], hit: 0, offs: [-8, -4, 0, 2, 6, 12] },
  { name: 'lead_hook', dist: 0.75, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], hit: 0, offs: [-8, -4, 0, 2, 6, 12] },
  { name: 'blocked', dist: 0.85, s0: at({ 12: { cross: true } }), s1: hold([], 'block', 0, 80), hit: 0, offs: [-6, -2, 0, 3, 8, 14] },
  { name: 'head_hit', dist: 0.85, s0: at({ 2: { cross: true } }), s1: [], hit: 0, offs: [1, 4, 8, 13, 19, 26] },
  { name: 'walk_fwd', dist: 1.9, s0: walk, s1: [], ticks: [14, 20, 26, 32, 38, 44] },
];

const only = process.argv.slice(2);   // beat names to film (default: all)
if (only.length) BEATS.splice(0, BEATS.length, ...BEATS.filter(b => only.includes(b.name)));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
page.on('crash', () => console.error('  PAGE CRASHED'));

async function boot(human) {
  await page.goto(`${DEV_URL}/?ai=0&menu=0${human ? '&human=1' : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bootReady(page);
  await page.evaluate(() => {
    const c = window.__cfg;
    c.debugHitboxes = false; c.refEnabled = false;
    c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;
    c.camDistMin = 2.4; c.camLookY = 1.25;   // close on the pair, as Nate plays it (filmstrip.mjs)
    window.__focus = -1;
  });
}

async function fpsSample() {
  await frames(page, 30);   // the overlay averages over a second; a held replay pauses game time, so count frames
  await until(page, () => (window.__fps?.fps ?? 0) > 0, undefined, { label: 'fps overlay sample', timeout: 30_000 });
  return page.evaluate(() => window.__fps?.fps ?? -1);
}

await boot(true);
// the hit tick of each punch beat: step the replay until side 0's punch has resolved
for (const b of BEATS.filter(x => x.hit !== undefined)) {
  b.hitTick = await page.evaluate(([dist, s0, s1]) => {
    for (let t = 1; t < 80; t++) {
      window.__replay(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {}));
      if (window.__states()[0].punch.resolved) return t;
    }
    return -1;
  }, [b.dist, Array.from(b.s0, x => x ?? null), Array.from(b.s1, x => x ?? null)]);
  b.ticks = b.offs.map(o => b.hitTick + o);
}

const sheets = [];
for (const b of BEATS) {
  const files = [], labels = [];
  for (const t of b.ticks) {
    await page.evaluate(([dist, s0, s1, t]) => window.__replay(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {})),
      [b.dist, Array.from(b.s0, x => x ?? null), Array.from(b.s1, x => x ?? null), t]);
    await frames(page, 4);
    const f = `${OUT}/${b.name}_t${String(t).padStart(3, '0')}.png`;
    await page.screenshot({ path: f }).catch(async e => {
      console.error(`  ${b.name} t=${t}: capture failed (${String(e.message).split('\n')[0]}); retrying once`);
      logs.slice(-8).forEach(m => console.error(`    [${m.type}] ${m.text}`));
      await frames(page, 2);
      await page.screenshot({ path: f, timeout: 120_000 });
    });
    const lab = await page.evaluate(() => `${window.__human?.[0]?.label() ?? '?'} | ${window.__human?.[1]?.label() ?? '?'}`);
    files.push(f);
    labels.push(`${b.name} t=${t}${b.hitTick !== undefined ? ` (hit ${b.hitTick})` : ''}  ${lab}`);
  }
  const sheet = await page.evaluate(async ({ imgs, labels, w, h }) => {
    const cols = 3, rows = Math.ceil(imgs.length / cols);
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
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), labels, w: W, h: H });
  const path = `${OUT}/${b.name}.png`;
  writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
  sheets.push(path);
}

// fps: the live fight (AI off, fighters placed close), human on, then off
await page.evaluate(() => { window.__sim.place(0.85); });
const fpsOn = await fpsSample();
await boot(false);
await page.evaluate(() => { window.__sim.place(0.85); });
const fpsOff = await fpsSample();
await browser.close();

console.log(sheets.join('\n'));
for (const b of BEATS) if (b.hitTick !== undefined) console.log(`  ${b.name}: hit tick ${b.hitTick}`);
console.log(`fps (headless software GL) human on ${fpsOn}, off ${fpsOff}`);
const benign = t => /GPU stall due to ReadPixels/.test(t);
logs.filter(m => (m.type === 'info' || m.type === 'log') && /human/.test(m.text)).forEach(m => console.log(`  [${m.type}] ${m.text}`));
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
console.log('PASS — console clean.');
