/**
 * arena_look.mjs — the arena as a picture (overhaul step 8, the show).
 *
 *   node scripts/arena_look.mjs before   → docs/overhaul/arena_before_*.png (tracked)
 *   node scripts/arena_look.mjs after    → docs/overhaul/arena_after_*.png  (tracked)
 *   node scripts/arena_look.mjs          → scripts/output/arena_look/wip_*.png
 *   ... tier=1 | tier=2                  → force the quality tier (after the show group exists)
 *   ... hot                              → also capture the play view with the crowd on its feet
 *
 * Per set, colour + `_grey` sibling:
 *   play      the play camera as shipped (follow camera, fighters at the bell)
 *   az        contact sheet: the play camera's seat at 8 azimuths round the ring
 *   wide      an establishing angle from high in the stands
 *   low       a low ringside angle looking up through the ropes
 * Not a test: it prints draw calls / triangles and fails only on console noise.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, until } from './waits.js';
import { greyscaleCopy } from './greyscale.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const label = args.find(a => /^(before|after)$/.test(a)) ?? null;
const tier = Number((args.find(a => /^tier=/.test(a)) ?? 'tier=0').slice(5));
const hot = args.includes('hot');
const OUT = label ? resolve(HERE, '..', 'docs', 'overhaul') : resolve(HERE, 'output', 'arena_look');
mkdirSync(OUT, { recursive: true });
const name = (view) => `${OUT}/${label ? `arena_${label}` : 'wip'}${tier ? `_t${tier}` : ''}_${view}.png`;
const W = 960, H = 600;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 20_000 });
await bootReady(page, { frames: 10 });
await page.evaluate((tier) => {
  const c = window.__cfg;
  c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false;
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;
  if (tier && 'qualityTier' in c) c.qualityTier = tier;
  const hud = document.getElementById('hud'); if (hud) hud.style.opacity = '0';
}, tier);

/** Park the camera on the fixed seat: azimuth / elevation in degrees, distance, look height, fov. null = the shipped follow camera. */
async function seat(s) {
  await page.evaluate((s) => {
    const c = window.__cfg;
    window.__seat0 ??= { camFollow: c.camFollow, camAzimuthDeg: c.camAzimuthDeg, camElevationDeg: c.camElevationDeg, camDistMin: c.camDistMin, camDistMax: c.camDistMax, camLookY: c.camLookY, camFovMin: c.camFovMin, camFovMax: c.camFovMax };
    if (!s) { Object.assign(c, window.__seat0); return; }
    c.camFollow = 0; c.camAzimuthDeg = s.az; c.camElevationDeg = s.el;
    c.camDistMin = c.camDistMax = s.dist; c.camLookY = s.lookY; c.camFovMin = c.camFovMax = s.fov;
  }, s);
  await frames(page, 6);
}

async function shoot(view) {
  const f = name(view);
  await page.screenshot({ path: f });
  const g = await greyscaleCopy(page, f);
  console.log(`${view} → ${f}\n${' '.repeat(view.length)}   ${g}`);
  return f;
}

async function sheet(files, labels, cols, out) {
  const data = await page.evaluate(async ({ imgs, labels, w, h, cols }) => {
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
      g.fillStyle = '#fff'; g.fillText(labels[i], x + 6, y + 16);
    }
    return canvas.toDataURL('image/png');
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), labels, w: W / 2, h: H / 2, cols });
  writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
  const g = await greyscaleCopy(page, out);
  console.log(`sheet → ${out}\n        ${g}`);
}

// 1. The play camera as shipped.
await seat(null);
await shoot('play');

// 2. The play seat at 8 azimuths (the follow camera can end up anywhere round the ring).
const play = await page.evaluate(() => ({ el: window.__seat0.camElevationDeg, dist: window.__seat0.camDistMax, lookY: window.__seat0.camLookY, fov: window.__seat0.camFovMax }));
const TMP = resolve(HERE, 'output', 'arena_look'); mkdirSync(TMP, { recursive: true });
const azFiles = [], azLabels = [];
for (let k = 0; k < 8; k++) {
  const az = k * 45;
  await seat({ az, ...play });
  const f = `${TMP}/_az${az}.png`;
  await page.screenshot({ path: f });
  azFiles.push(f); azLabels.push(`az ${az}`);
}
await sheet(azFiles, azLabels, 4, name('az'));

// 3. Wide establishing angle from the stands; 4. low ringside angle.
await seat({ az: 62, el: 24, dist: 17, lookY: 1.4, fov: 44 });
await shoot('wide');
await seat({ az: 115, el: 1.5, dist: 6.4, lookY: 1.5, fov: 48 });
await shoot('low');

// 5. The crowd on its feet (only once the show hook exists).
if (hot) {
  await seat(null);
  const ok = await page.evaluate(() => { const s = window.__show; if (!s) return false; s.react('knockdown', 1, { x: 0, y: 1, z: 0 }); return true; });
  if (ok) {
    await until(page, () => window.__show.excitement() > 0.8, undefined, { label: 'crowd up', timeout: 20000 });
    await frames(page, 30);
    await shoot('play_hot');
    await seat({ az: 62, el: 24, dist: 17, lookY: 1.4, fov: 44 });
    await shoot('wide_hot');
  } else console.log('hot: no window.__show hook yet — skipped');
}

await seat(null);
await page.evaluate(() => { window.__cfg.debugFps = true; });
await until(page, () => !!window.__fps && window.__fps.calls > 0, undefined, { label: 'an fps sample', timeout: 90000 });
await frames(page, 70);
const fps = await page.evaluate(() => window.__fps);
console.log(`budget (play camera${tier ? `, tier ${tier}` : ''}): ${fps.calls} calls, ${fps.tris} tris, headless ${fps.fps} fps / ${fps.msAvg} ms (trend only)`);
await browser.close();
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
