/**
 * human_check.mjs — the realistic-boxer proof page (human.html): screenshots of the camera presets in the guard
 * and reach poses, console capture, fps. Render check only. Fails on any console error / warning.
 *   PORT=5195 node scripts/human_check.mjs            (boxer.glb)
 *   PORT=5195 V=2 node scripts/human_check.mjs        (boxer_v2.glb + fighter lights; files named human_v2_*)
 *   TM=agx|neutral|aces adds a tone mapping to the page (files get the _tm suffix).
 * The dev server reloads the page when other workers edit shared files; a reload mid-run restarts the capture
 * (at most 3 attempts).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });
const V2 = process.env.V === '2';
const TMV = process.env.TM || '';
const qs = [V2 ? 'v=2' : '', TMV ? `tm=${TMV}` : ''].filter(Boolean).join('&');
const tag = (V2 ? 'human_v2' : 'human') + (TMV ? `_${TMV}` : '');

async function run() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
    const logs = [];
    page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
    page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
    await page.goto(`${DEV_URL}/human.html${qs ? '?' + qs : ''}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await until(page, () => window.__human && window.__human.ready, undefined, { label: 'boxer loaded', timeout: 280_000 });
    const raf = n => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
    // cameras: 1 play, 2 side, 3 upper-body close-up (dark), 4 lower body (light), 5 scalp,
    // 6 gloves close, 7 dark face, 8 light face, 9 boots close
    const shots = {};
    let reloads = 0;
    // each shot is self-contained (pose + camera), so a dev-server reload only repeats that shot
    const shot = async (pose, key, path) => {
      for (;;) {
        try {
          await until(page, () => window.__human && window.__human.ready, undefined, { label: 'boxer loaded', timeout: 280_000 });
          await page.evaluate(([p, k]) => { window.__human.pose(p); window.__human.preset(k); }, [pose, key]);
          await raf(6);
          await page.screenshot({ path });
          return;
        } catch (e) {
          if (!/Execution context was destroyed|navigation|undefined/i.test(e.message) || ++reloads > 6) throw e;
        }
      }
    };
    for (const pose of ['guard', 'reach']) {
      const cams = pose === 'guard'
        ? [['1', 'play'], ['2', 'side'], ['3', 'upper'], ['4', 'lower'], ['5', 'head'], ['6', 'glove'], ['7', 'face_dark'], ['8', 'face_light'], ['9', 'boots']]
        : [['1', 'play'], ['2', 'side'], ['3', 'upper'], ['4', 'lower'], ['6', 'glove']];
      for (const [key, cam] of cams) {
        const name = pose === 'guard' && (cam === 'play' || cam === 'side') ? `${tag}_${cam}` : `${tag}_${pose}_${cam}`;
        shots[name] = `${OUT}/${name}.png`;
        await shot(pose, key, shots[name]);
      }
    }
    if (reloads) console.log(`(page reloaded ${reloads} time(s) during the run; shots repeated)`);
    let info = { fps: NaN, tris: NaN };
    try {
      await raf(90);
      info = await page.evaluate(() => ({ fps: window.__human.fps, tris: window.__human.tris }));
    } catch (e) {
      if (!/Execution context was destroyed|navigation|undefined/i.test(e.message)) throw e;
      console.log('(reload during the fps sample; fps not measured this run)');
    }
    return { shots, info, logs };
  } finally {
    await browser.close();
  }
}

let res = null;
for (let attempt = 1; attempt <= 3 && !res; attempt++) {
  try {
    res = await run();
  } catch (e) {
    const nav = /Execution context was destroyed|navigation/i.test(e.message);
    console.error(`attempt ${attempt}: ${e.message.split('\n')[0]}`);
    if (!nav) process.exit(1);
  }
}
if (!res) { console.error('FAILED — page kept reloading.'); process.exit(1); }
const { shots, info, logs } = res;
writeFileSync(`${OUT}/${tag}_console.json`, JSON.stringify(logs, null, 2));
console.log(Object.values(shots).join('\n'));
console.log(`fps (headless software GL, not the desktop number) → ${info.fps}; triangles in scene → ${Math.round(info.tris)}`);
logs.forEach(m => console.log(`  [${m.type.padEnd(9)}] ${m.text}`));
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
console.log('PASS — console clean.');
