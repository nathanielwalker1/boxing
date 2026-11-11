/**
 * lookbook.mjs — every roster fighter on a turntable, one sheet (overhaul run).
 *
 *   node scripts/lookbook.mjs            → scripts/output/lookbook/lookbook.png (+ _grey)
 *   node scripts/lookbook.mjs before     → docs/overhaul/lookbook_before.png (+ _grey), tracked
 *   node scripts/lookbook.mjs after red  → only fighter `red` (cells still written)
 *
 * Rows = fighters; columns = front, three-quarter, side, back (settled rest
 * guard), the held block, mid-cross. Cells go to scripts/output/lookbook/cells
 * so one view can be read at full size. Drives window.__look (main.ts); the
 * turntable is the fixed-seat camera's azimuth, the fighter stands still.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';
import { greyscaleCopy } from './greyscale.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CELLS = resolve(HERE, 'output', 'lookbook', 'cells');
mkdirSync(CELLS, { recursive: true });
const args = process.argv.slice(2);
const label = args[0] && /^(before|after|wip)$/.test(args[0]) ? args[0] : null;
const only = args.filter(a => a !== label);
const OUT = label && label !== 'wip' ? resolve(HERE, '..', 'docs', 'overhaul') : resolve(HERE, 'output', 'lookbook');   // only before / after are tracked
mkdirSync(OUT, { recursive: true });

// name, pose, camera azimuth (deg; 0 = the fighter's front), elevation, distance, look height (× fighter height)
const VIEWS = [
  ['front', 'rest', 0, 6, 2.8, 0.5],
  ['3/4', 'rest', 38, 8, 2.8, 0.5],
  ['side', 'rest', 90, 6, 2.8, 0.5],
  ['back', 'rest', 180, 8, 2.8, 0.5],
  ['block', 'block', 32, 8, 1.8, 0.76],
  ['cross', 'cross', 40, 8, 2.8, 0.5],
];
const FOV = 46;   // the lens must stay inside the ropes (ring half 3.05 m), so the full figure needs a wide-ish lens
// The lens stays on one clear seat (ringside panels block others) and the
// fighter turns: view angle v = camera azimuth − fighter yaw.
const CAM_AZ = 180;
const W = 300, H = 420;

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
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000; c.camCountLambda = 1000;
});
const roster = (await page.evaluate(() => window.__roster())).filter(id => !only.length || only.includes(id));

const rows = [];
for (const id of roster) {
  const row = [];
  for (const [name, kind, az, el, dist, lookFrac] of VIEWS) {
    await page.evaluate(([id, kind, az, el, dist, lookFrac, camAz, fov]) => {
      window.__look(id, kind, camAz - az);
      const c = window.__cfg;
      const h = window.__states()[0].body.heightM;
      c.camAzimuthDeg = camAz; c.camElevationDeg = el; c.camDistMin = dist; c.camDistMax = dist;
      c.camFovMin = fov; c.camFovMax = fov; c.camLookY = h * lookFrac;
    }, [id, kind, az, el, dist, lookFrac, CAM_AZ, FOV]);
    await frames(page, 4);
    const file = `${CELLS}/${id}_${name.replace('/', '')}.png`;
    await page.screenshot({ path: file });
    row.push(file);
  }
  rows.push(row);
}

const sheet = await page.evaluate(async ({ rows, w, h, cols, labels }) => {
  const canvas = document.createElement('canvas');
  const top = 26, left = 0;
  canvas.width = left + w * cols.length; canvas.height = top + h * rows.length;
  const g = canvas.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = rows[r][c]; });
      g.drawImage(img, left + c * w, top + r * h, w, h);
    }
    g.fillStyle = '#fff'; g.font = '13px monospace';
    g.fillText(labels[r], 6, top + r * h + 16);
  }
  g.fillStyle = '#ddd'; g.font = '13px monospace';
  cols.forEach((c, i) => g.fillText(c, left + i * w + 6, 17));
  return canvas.toDataURL('image/png');
}, {
  rows: rows.map(r => r.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64'))),
  w: W, h: H, cols: VIEWS.map(v => v[0]), labels: roster,
});
const path = `${OUT}/lookbook${label ? '_' + label : ''}.png`;
writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
const grey = await greyscaleCopy(page, path);
await browser.close();
console.log(`lookbook → ${path}\n           ${grey}\n   cells → ${CELLS}`);
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
