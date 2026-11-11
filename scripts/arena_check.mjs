/**
 * arena_check.mjs — RENDER budget + value check for the ring/arena scene.
 *   - console clean (ReadPixels warning filtered, as verify does)
 *   - draw calls ≤ 300, triangles ≤ 150k (scene without fighters' cost counted anyway)
 *   - screenshots at closeness 0 and 1 framing (camDistMin/Max forced equal),
 *     plus greyscale siblings
 *   - VISUALS L1: the crowd/bowl band behind the far ropes is NOT brighter than
 *     the mat (mean linear luminance over small regions of the frame)
 */
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { frames, until } from './waits.js';
import { greyscaleCopy } from './greyscale.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });
const MAX_CALLS = 300, MAX_TRIS = 150_000;

// Frame-fraction regions: mat = canvas left of the centre decal; band = bowl above the far top rope.
const MAT_RECT  = { x: 0.12, y: 0.62, w: 0.10, h: 0.08 };
const BAND_RECT = { x: 0.35, y: 0.05, w: 0.30, h: 0.13 };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));

// ?ai=0: the luminance rects are frame fractions and the camera follows the
// fighters, so the scene has to hold still — the AI would walk the framing.
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 15_000 });
// Not bootReady's 15 s: this check boots at 2× on software GL beside three others, and ten frames of the arena
// (shader compiles included) can take longer than that on a busy machine. The wait is still on frames, not time.
await until(page, () => !!(window.__tick && window.__tick.ready && window.__tick.frames >= 10 && window.__cfg), undefined, { label: 'app booted and ticking', timeout: 90000 });
await page.evaluate(() => { window.__cfg.debugHitboxes = false; window.__cfg.debugFps = false; });

/** Mean linear luminance of `rects` (frame fractions) in a PNG, decoded in-page. */
async function regionLuminance(png, rects) {
  const url = 'data:image/png;base64,' + readFileSync(png).toString('base64');
  return page.evaluate(async ({ dataUrl, rects }) => {
    const img = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = dataUrl; });
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
    const lin = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
    return rects.map(r => {
      const x = Math.round(r.x * c.width), y = Math.round(r.y * c.height), w = Math.round(r.w * c.width), h = Math.round(r.h * c.height);
      const d = g.getImageData(x, y, w, h).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
      return sum / (d.length / 4);
    });
  }, { dataUrl: url, rects });
}

let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`); };

for (const [label, dist, fov] of [['close0', 6.5, 42], ['close1', 4.2, 34]]) {
  await page.evaluate(({ dist, fov }) => {
    window.__cfg.camDistMin = window.__cfg.camDistMax = dist;
    window.__cfg.camFovMin = window.__cfg.camFovMax = fov;
  }, { dist, fov });
  // The dolly settles on its own clock (camDollyLambda), so wait for the
  // distance, not a frame count — 40 frames was a 20 s timeout at the fps a
  // cold parallel run leaves headless GL with (2026-10-15).
  await until(page, d => Math.abs(window.__camDist() - d) < 0.05, dist, { label: `dolly at ${dist} m`, timeout: 60000 });
  const shot = `${OUT}/arena_${label}.png`;
  await page.screenshot({ path: shot });
  const grey = await greyscaleCopy(page, shot);
  const [mat, band] = await regionLuminance(shot, [MAT_RECT, BAND_RECT]);
  console.log(`${label}: ${shot}\n        ${grey}\n        mat Y=${mat.toFixed(4)}  bowl band Y=${band.toFixed(4)}`);
  check(band <= mat, `${label}: bowl band behind the far ropes not brighter than the mat (${band.toFixed(4)} ≤ ${mat.toFixed(4)})`);
  check(mat > 0.01, `${label}: mat region is lit (Y ${mat.toFixed(4)} > 0.01) — the sample landed on the canvas`);
}

await page.evaluate(() => { window.__cfg.debugFps = true; });
// The overlay publishes a sample once a 60-frame window has landed; wait for
// the sample itself, however long a loaded headless run takes to render it.
await until(page, () => !!window.__fps, undefined, { label: 'an fps sample', timeout: 90000 });
const fps = await page.evaluate(() => window.__fps);
console.log(`budget: ${fps ? `${fps.calls} calls, ${fps.tris} tris` : 'no fps sample'}`);
check(!!fps && fps.calls <= MAX_CALLS, `draw calls ≤ ${MAX_CALLS} (${fps?.calls})`);
check(!!fps && fps.tris <= MAX_TRIS, `triangles ≤ ${MAX_TRIS} (${fps?.tris})`);

// The high tier (desktop). Headless is software GL, which the app runs on the low tier, so everything above was
// the low tier against the original §7 budget. Force the high tier for its own, raised budget (CONTRACT §13,
// 2026-11-11) and the same value rule. Post is left off here: on a CPU rasteriser at 2× it is over a second a
// frame, and it adds a fixed dozen full-screen passes and no triangles.
const tier = await page.evaluate(() => window.__show.tier());
check(tier === 1, `software GL runs the low tier (tier ${tier})`);
const HI_CALLS = 400, HI_TRIS = 300_000;
await page.evaluate(() => { const c = window.__cfg; c.qualityTier = 2; c.postEnabled = false; c.debugFps = false; window.__fps = undefined; });
await frames(page, 4);
{
  const shot = `${OUT}/arena_high.png`;
  await page.screenshot({ path: shot });
  await greyscaleCopy(page, shot);
  const [mat, band] = await regionLuminance(shot, [MAT_RECT, BAND_RECT]);
  check(band <= mat, `high tier: bowl band behind the far ropes not brighter than the mat (${band.toFixed(4)} ≤ ${mat.toFixed(4)})`);
}
await page.evaluate(() => { window.__cfg.debugFps = true; });
await until(page, () => !!window.__fps, undefined, { label: 'a high-tier fps sample', timeout: 120000 });
const hi = await page.evaluate(() => ({ ...window.__fps, ...window.__show.crowd() }));
console.log(`high tier budget (post off): ${hi.calls} calls, ${hi.tris} tris, ${hi.people} people`);
check(hi.calls <= HI_CALLS, `high tier draw calls ≤ ${HI_CALLS} (${hi.calls})`);
check(hi.tris <= HI_TRIS, `high tier triangles ≤ ${HI_TRIS} (${hi.tris})`);

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(bad.length === 0, `console clean (${bad.length} error/warning)`);
await browser.close();

console.log(`${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
