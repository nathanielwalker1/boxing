/**
 * filmstrip.mjs — a scripted exchange, frame by frame, from the play camera
 * (docs/FEEL.md "how to judge a motion change", step 2).
 *
 *   node scripts/filmstrip.mjs exchange            → scripts/output/filmstrip/exchange.png
 *   node scripts/filmstrip.mjs slip_counter before → docs/overhaul/strip_slip_counter_before.png (tracked)
 *
 * Each scenario is tick-exact input for both sides fed through window.__replay
 * (a fresh deterministic sim per frame), so a strip is reproducible and a
 * before/after pair shows the same ticks. Frames also go to
 * scripts/output/filmstrip/frames/<name>_tNN.png for reading at full size.
 * Never hold the stick through a punch in a script: one-tick presses.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';

const at = (o) => { const a = []; for (const [k, v] of Object.entries(o)) a[Number(k)] = v; return a; };
const hold = (a, key, from, to) => { for (let i = from; i <= to; i++) a[i] = { ...(a[i] ?? {}), [key]: true }; return a; };
const flick = (x, t) =>({ [t]: { move: { x, y: 0 } }, [t + 1]: { move: { x, y: 0 } } });

/** dist (m), side-0 script, side-1 script, first tick, last tick, tick step, roster ids (optional). */
export const SCENARIOS = {
  // A 1-2 lands, the dummy answers and misses, a lead hook misses: the everyday exchange.
  exchange: { dist: 0.85, s0: at({ 2: { jab: true }, 10: { cross: true }, 34: { hook: true, move: { x: -1, y: 0 } } }), s1: at({ 22: { jab: true }, 44: { cross: true } }), from: 0, to: 69, step: 3 },
  // The dummy jabs, the player flicks away from it and crosses into the window: slip → counter (→ rocked).
  slip_counter: { dist: 0.79, s0: at({ ...flick(-1, 0), 12: { cross: true } }), s1: at({ 0: { jab: true } }), from: 0, to: 46, step: 2 },
  // The only body shot the baseline has: the dummy slips the wrong way and the cross finds the body.
  body: { dist: 0.79, s0: at({ 0: { cross: true } }), s1: at(flick(-1, 4)), from: 0, to: 46, step: 2 },
  // ── Overhaul scenarios (need the SIM workstream's mechanics) ──
  // The dummy jabs, the player slips to the lead side (which loads the lead hand) and hooks with it: a flush counter.
  flush_counter: { dist: 0.79, s0: at({ ...flick(-1, 0), 12: { hook: true, move: { x: -1, y: 0 } } }), s1: at({ 0: { jab: true } }), from: 0, to: 69, step: 3 },
  // Level held, lead hook: a clean liver shot at t=26; the buckle arrives about 36 ticks later.
  body_hook: { dist: 0.7, s0: hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], from: 0, to: 92, step: 4 },
  // Chest to chest: shovel hook, inside uppercut, then down for a body hook; the dummy hooks back.
  inside: { dist: 0.55, s0: hold(at({ 2: { hook: true, move: { x: -1, y: 0 } }, 14: { uppercut: true, move: { x: 1, y: 0 } }, 30: { hook: true, move: { x: -1, y: 0 } } }), 'level', 26, 44), s1: at({ 20: { hook: true, move: { x: -1, y: 0 } } }), from: 0, to: 69, step: 3 },
};

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const label = args.find(a => /^(before|after|wip)$/.test(a)) ?? null;
const names = args.filter(a => a !== label);
const run = names.length ? names : Object.keys(SCENARIOS);
const FRAMES = resolve(HERE, 'output', 'filmstrip', 'frames');
const OUT = label ? resolve(HERE, '..', 'docs', 'overhaul') : resolve(HERE, 'output', 'filmstrip');
mkdirSync(FRAMES, { recursive: true }); mkdirSync(OUT, { recursive: true });
const W = 480, H = 300, COLS = 6;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 20_000 });
await bootReady(page);
await page.evaluate(() => {
  const c = window.__cfg;
  c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false;
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;
  c.camDistMin = 2.4; c.camLookY = 1.25;   // close on the pair, as Nate plays it
  window.__focus = -1;
});

for (const name of run) {
  const sc = SCENARIOS[name];
  if (!sc) { console.error(`no scenario '${name}' (have: ${Object.keys(SCENARIOS).join(', ')})`); process.exit(2); }
  const files = [], ticks = [];
  for (let t = sc.from; t <= sc.to; t += sc.step) {
    await page.evaluate(([dist, s0, s1, t]) => window.__replay(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {})), [sc.dist, Array.from(sc.s0, x => x ?? null), Array.from(sc.s1, x => x ?? null), t]);
    await frames(page, 3);
    const f = `${FRAMES}/${name}_t${String(t).padStart(3, '0')}.png`;
    await page.screenshot({ path: f });
    files.push(f); ticks.push(t);
  }
  const sheet = await page.evaluate(async ({ imgs, ticks, w, h, cols }) => {
    const rows = Math.ceil(imgs.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = w * cols; canvas.height = h * rows;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = '13px monospace';
    for (let i = 0; i < imgs.length; i++) {
      const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = imgs[i]; });
      const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(img, x, y, w, h);
      g.fillStyle = '#fff'; g.fillText(`t=${ticks[i]}`, x + 6, y + 16);
    }
    return canvas.toDataURL('image/png');
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), ticks, w: W, h: H, cols: COLS });
  const path = `${OUT}/${label ? `strip_${name}_${label}` : name}.png`;
  writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
  console.log(`${name} → ${path} (${files.length} frames)`);
}
await browser.close();
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
