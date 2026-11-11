/**
 * pose_grid.mjs — the contact sheet (CONTRACT §6, CLAUDE.md verification 2).
 *
 *   node scripts/pose_grid.mjs                 # all punches
 *   node scripts/pose_grid.mjs jab hook        # a subset
 *
 * One sheet per punch: rows = side 0 (faces +x) lead/rear, side 1 (faces -x)
 * lead/rear; columns = progress 0, .15, .30, .45, .60, .75, .90. Plus a
 * greyscale sibling. Cells go to scripts/output/pose_grid/cells/.
 *
 * Drives the page through window.__pose (main.ts). Every punch is posed by
 * running the real sim, so the sheets show the kinetic chain as it plays.
 * Jab and cross have one hand each, so one row per side; hook and uppercut
 * take their hand from the joystick, so both hands are rows.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';
import { greyscaleCopy } from './greyscale.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'pose_grid');
mkdirSync(`${OUT}/cells`, { recursive: true });

const PUNCHES = ['jab', 'cross', 'hook', 'uppercut'];
const wanted = process.argv.slice(2).filter(a => PUNCHES.includes(a));
const punches = wanted.length ? wanted : PUNCHES;
const PROGRESS = [0, 0.15, 0.30, 0.45, 0.60, 0.75, 0.90];
const ROWS = [[0, 'lead'], [0, 'rear'], [1, 'lead'], [1, 'rear']];
const NATURAL_HAND = { jab: 'lead', cross: 'rear' };   // fixed-hand punches; hook/uppercut get both rows
const rowsFor = punch => NATURAL_HAND[punch] ? ROWS.filter(([, h]) => h === NATURAL_HAND[punch]) : ROWS;
const CELL = 320;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CELL, height: CELL } });
const logs = [];
// "GPU stall due to ReadPixels" is headless Chromium's screenshot path, not the app (see verify.mjs).
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15_000 });
// Software GL under a loaded machine can take well past waits.bootReady's 15 s to boot two skinned fighters; this sheet is not a test, so it waits longer.
await page.waitForFunction(() => !!(window.__tick && window.__tick.ready && window.__tick.frames >= 5 && window.__cfg), null, { timeout: 120_000 });
void bootReady;
await page.evaluate(() => {
  window.__cfg.debugHitboxes = true;
  window.__cfg.debugFps = false;
  window.__cfg.camDriftAmp = 0;
  window.__cfg.camDistMin = 2.6;
  window.__cfg.camFovMin = 40;
  window.__cfg.camLookY = 1.1;
  window.__cfg.camFollowLambda = 1000;
});

for (const punch of punches) {
  const cells = [];
  const rows = rowsFor(punch);
  for (const [side, hand] of rows) {
    const row = [];
    for (const p of PROGRESS) {
      await page.evaluate(([s, pu, h, pr]) => {
        window.__pose(s, pu, h, pr);
        window.__pose(1 - s, 'rest', 'lead', 0);
        window.__focus = s;
      }, [side, punch, hand, p]);
      await frames(page, 3);
      const file = `${OUT}/cells/${punch}_${hand}_s${side}_p${String(Math.round(p * 100)).padStart(2, '0')}.png`;
      await page.screenshot({ path: file });
      row.push(file);
    }
    cells.push(row);
  }
  // Assemble in-page: the browser is already the image library we have.
  const sheet = await page.evaluate(async ({ rows, cell, labels, cols }) => {
    const canvas = document.createElement('canvas');
    canvas.width = cell * cols.length + 80; canvas.height = cell * rows.length + 30;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#ddd'; g.font = '14px monospace';
    cols.forEach((c, i) => g.fillText(`p=${c}`, 80 + i * cell + 6, 20));
    for (let r = 0; r < rows.length; r++) {
      g.fillText(labels[r], 6, 30 + r * cell + cell / 2);
      for (let c = 0; c < rows[r].length; c++) {
        const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = rows[r][c]; });
        g.drawImage(img, 80 + c * cell, 30 + r * cell, cell, cell);
      }
    }
    return canvas.toDataURL('image/png');
  }, {
    rows: cells.map(r => r.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64'))),
    cell: CELL, cols: PROGRESS, labels: rows.map(([s, h]) => `s${s} ${h}`),
  }).catch(e => { logs.push(`sheet assembly: ${e.message}`); return null; });
  if (sheet) {
    const path = `${OUT}/${punch}.png`;
    writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
    await greyscaleCopy(page, path);
    console.log(`${punch} → ${path} (+ _grey)`);
  }
}
await browser.close();
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
