/**
 * lookbook.mjs — every roster fighter on a turntable, one sheet (overhaul run).
 *
 *   node scripts/lookbook.mjs            → scripts/output/lookbook/lookbook.png (+ _grey)
 *   node scripts/lookbook.mjs before     → docs/overhaul/lookbook_before.png (+ _grey), tracked
 *   node scripts/lookbook.mjs after      → docs/overhaul/lookbook_after.png (+ _grey), tracked
 *   node scripts/lookbook.mjs wip red    → only fighter `red`, to scripts/output (cells still written)
 *   node scripts/lookbook.mjs gen 8      → 8 generated fighters (seeds 1…8; `gen 8 40` starts at seed 40)
 *                                          → scripts/output/lookbook/lookbook_gen.png, or docs/overhaul with `after`
 *
 * Rows = fighters; columns = front, three-quarter, side, back (settled rest
 * guard), the held block, mid-cross, then two portraits with the arms hung
 * out of the way: the face at rest, and the face and body state at full
 * (wince, a swollen eye, cuts, sweat, reddening). Cells go to
 * scripts/output/lookbook/cells so one view can be read at full size. Drives
 * window.__look (main.ts) and the rig's probe (window.__rig, window.__rigGen);
 * the turntable is the fixed-seat camera's azimuth, the fighter stands still.
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
const label = args.find(a => /^(before|after|wip)$/.test(a)) ?? null;
const rest = args.filter(a => a !== label);
const gen = rest[0] === 'gen' ? { n: Number(rest[1] ?? 8), from: Number(rest[2] ?? 1) } : null;
const only = gen ? [] : rest;
const OUT = label && label !== 'wip' ? resolve(HERE, '..', 'docs', 'overhaul') : resolve(HERE, 'output', 'lookbook');   // only before / after are tracked
mkdirSync(OUT, { recursive: true });

const CALM = { wince: 0, mouthOpen: 0, swell: [0, 0], cuts: { browL: 0, browR: 0, cheekL: 0, cheekR: 0, nose: 0, lip: 0 } };
const DRY = { sweat: 0, redden: { head: 0, body: 0 } };
const HURT = { wince: 0.8, mouthOpen: 0.5, swell: [0, 1], cuts: { browL: 1, cheekR: 0.5, nose: 0, lip: 0.7, browR: 0, cheekL: 0 } };
const SPENT = { sweat: 1, redden: { head: 0.9, body: 1 } };
// name, pose, camera azimuth (deg; 0 = the fighter's front), elevation, distance, look height (× fighter height), state
const VIEWS = [
  ['front', 'rest', 0, 6, 2.8, 0.5, {}],
  ['3/4', 'rest', 38, 8, 2.8, 0.5, {}],
  ['side', 'rest', 90, 6, 2.8, 0.5, {}],
  ['back', 'rest', 180, 8, 2.8, 0.5, {}],
  ['block', 'block', 32, 8, 1.8, 0.76, {}],
  ['cross', 'cross', 40, 8, 2.8, 0.5, {}],
  ['face', 'rest', 28, 4, 1.05, 0.9, { portrait: true }],
  ['hurt', 'rest', -28, 4, 1.05, 0.9, { portrait: true, face: HURT, body: SPENT }],
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
// Not a test: waits longer than waits.bootReady's 15 s, which software GL on a loaded machine can exceed.
await page.waitForFunction(() => !!(window.__tick && window.__tick.ready && window.__tick.frames >= 5 && window.__cfg), null, { timeout: 120_000 });
void bootReady;
await page.evaluate(() => {
  const c = window.__cfg;
  c.rigQuality = 1;   // the desktop fighter mesh, even though headless software GL picks the low tier for the arena
  c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false;
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000; c.camCountLambda = 1000;
  // A precaution, not a fix for anything seen: the sheet takes minutes and a round is 30 s, so the fight behind
  // the posed fighter would otherwise run out and restart while the sheet is being shot. Hold the clock.
  // (I first blamed this for a blue, banded sheet. It was not the cause: the cells are correct, and the banding
  // was the image viewer reducing the 2400 × 3386 sheet. Judge colour from scripts/output/lookbook/cells.)
  c.roundSeconds = 36000;
  window.__sim.reset(1);
});
const roster = gen
  ? await page.evaluate(({ n, from }) => window.__rigGen(Array.from({ length: n }, (_, i) => from + i)), gen)
  : (await page.evaluate(() => window.__roster())).filter(id => !only.length || only.includes(id));
const labels = await page.evaluate(ids => ids.map(id => { const s = window.__rosterSpec ? window.__rosterSpec(id) : null; return s ? `${id} — ${s.name}, ${s.heightM} m ${s.massKg} kg, ${s.style}` : id; }), roster);

const rows = [];
for (const id of roster) {
  const row = [];
  for (const [name, kind, az, el, dist, lookFrac, st] of VIEWS) {
    await page.evaluate(([id, kind, az, el, dist, lookFrac, camAz, fov]) => {
      window.__look(id, kind, camAz - az);
      const c = window.__cfg;
      const h = window.__states()[0].body.heightM;
      c.camAzimuthDeg = camAz; c.camElevationDeg = el; c.camDistMin = dist; c.camDistMax = dist;
      c.camFovMin = fov; c.camFovMax = fov; c.camLookY = h * lookFrac;
    }, [id, kind, az, el, dist, lookFrac, CAM_AZ, FOV]);
    await frames(page, 2);   // the view exists (a new fighter rebuilds it) before its state is set
    await page.evaluate(([st, calm, dry]) => {
      const r = window.__rig[0];
      r.portrait(!!st.portrait); r.setFace(st.face ?? calm); r.setBodyState(st.body ?? dry);
    }, [st, CALM, DRY]);
    await frames(page, 12);  // the face eases in; cloth and hair springs settle
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
  w: W, h: H, cols: VIEWS.map(v => v[0]), labels,
});
const path = `${OUT}/lookbook${gen ? '_gen' : ''}${label ? '_' + label : ''}.png`;
writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
const grey = await greyscaleCopy(page, path);
await browser.close();
console.log(`lookbook → ${path}\n           ${grey}\n   cells → ${CELLS}`);
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
