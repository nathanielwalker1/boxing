/**
 * pose_sheet.mjs — contact sheet for the gym, same spirit as scripts/pose_grid.mjs.
 *
 *   node spike/gym/pose_sheet.mjs [types] [phases] [presets]
 *   node spike/gym/pose_sheet.mjs jab,hook 9 SIDE,THREE_Q
 *
 * One row per camera preset, one column per phase, one sheet per punch. The gym
 * must already be running (npm run gym).
 *
 * VISUALS.md protocol steps 1-3: evenly spaced phases across p = 0..1, frozen
 * inputs (the scrubber holds the punch, nothing is time-dependent), and every
 * punch captured from more than one angle. Step 4's value check is deliberately
 * skipped — this spike is judging MOTION, and the flat-shaded primitives here
 * are not the shading the real game would ship.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const OUT = 'scripts/output/gym';
const PORT = process.env.PORT || 5174;

const types   = (process.argv[2] || 'jab,cross,hook').split(',');
const nPhase  = Number(process.argv[3] || 7);
const presets = (process.argv[4] || 'SIDE,THREE_Q').split(',');

const CELL_W = 420, CELL_H = 560;

// Framed on the player alone and pulled in close: a sheet is for reading the
// pose, not the staging.
const FRAME = {
  SIDE:    { az:  90, el:  6, dist: 3.20, fov: 40, targetY: 0.95, targetMix: 0 },
  THREE_Q: { az: 128, el: 18, dist: 3.30, fov: 42, targetY: 0.95, targetMix: 0 },
  OVER:    { az: 168, el: 12, dist: 2.55, fov: 55, targetY: 1.45, targetMix: 0 },
  FRONT:   { az:   4, el:  6, dist: 3.20, fov: 40, targetY: 0.95, targetMix: 0 },
  // The arc of a hook is a shape in the horizontal plane. From the side it is
  // mostly motion in depth and you cannot read it at all.
  TOP:     { az:  90, el: 80, dist: 3.00, fov: 40, targetY: 1.10, targetMix: 0 },
};

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: CELL_W, height: CELL_H } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForFunction(() => window.__gym && window.__gym.ready, null, { timeout: 15000 });
await page.addStyleTag({ content: '.lil-gui{display:none!important} #hud{display:none!important}' });
// Frozen inputs: no trail, no skeleton, no grid, no live clock. A cell must be
// reproducible or two sheets cannot be compared.
await page.evaluate(() => {
  const g = window.__gym.config.gym;
  // The grid stays on: it is the only reference that makes root translation
  // visible in a still.
  g.trails = false; g.skeleton = false; g.grid = true; g.paused = true;
});

const phases = Array.from({ length: nPhase }, (_, i) => i / (nPhase - 1));
const sheets = [];

for (const type of types) {
  const rows = [];
  for (const preset of presets) {
    const f = FRAME[preset];
    if (!f) { console.log(`  unknown preset ${preset}, skipping`); continue; }
    const cells = [];
    for (const p of phases) {
      const ms = await page.evaluate(([f, type, p]) => {
        const g = window.__gym;
        g.api.setCam(f);
        g.api.poseAt(type, p);
        return g.punch.t;
      }, [f, type, p]);
      const buf = await page.screenshot({ type: 'png' });
      cells.push({ p, ms, data: 'data:image/png;base64,' + buf.toString('base64') });
    }
    rows.push({ preset, cells });
  }
  sheets.push({ type, rows });
  console.log(`captured ${type}: ${rows.length} rows x ${phases.length} phases`);
}

// ── Assemble ────────────────────────────────────────────────────────────────
// Composed in a 2D canvas on a blank page rather than with an image library, so
// the spike stays dependency-free.
const blank = await browser.newPage();
await blank.goto('about:blank');

for (const sheet of sheets) {
  const dataUrl = await blank.evaluate(async ({ sheet, CELL_W, CELL_H }) => {
    const PAD = 6, LABEL_W = 92, TITLE_H = 30, HEAD_H = 22;
    const cols = sheet.rows[0].cells.length;
    const cv = document.createElement('canvas');
    cv.width  = LABEL_W + cols * (CELL_W + PAD) + PAD;
    cv.height = TITLE_H + HEAD_H + sheet.rows.length * (CELL_H + PAD) + PAD;
    const g = cv.getContext('2d');
    g.fillStyle = '#15151c'; g.fillRect(0, 0, cv.width, cv.height);

    g.fillStyle = '#ffd24a';
    g.font = 'bold 17px ui-monospace, monospace';
    g.fillText(`${sheet.type}  —  3D gym pose sheet`, PAD, 21);

    g.fillStyle = '#aab';
    g.font = '13px ui-monospace, monospace';
    sheet.rows[0].cells.forEach((c, i) => {
      g.fillText(`p ${c.p.toFixed(2)}  ${Math.round(c.ms)}ms`,
        LABEL_W + i * (CELL_W + PAD), TITLE_H + 15);
    });

    for (let r = 0; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      const y = TITLE_H + HEAD_H + r * (CELL_H + PAD);
      g.fillStyle = '#ffffff';
      g.font = 'bold 13px ui-monospace, monospace';
      g.fillText(row.preset, PAD, y + 18);
      for (let i = 0; i < row.cells.length; i++) {
        const img = new Image();
        img.src = row.cells[i].data;
        await img.decode();
        g.drawImage(img, LABEL_W + i * (CELL_W + PAD), y, CELL_W, CELL_H);
      }
    }
    return cv.toDataURL('image/png');
  }, { sheet, CELL_W, CELL_H });

  const path = `${OUT}/sheet_${sheet.type}.png`;
  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`  sheet → ${path}`);
}

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
if (errors.length) process.exit(1);
