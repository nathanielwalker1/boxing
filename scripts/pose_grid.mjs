/**
 * pose_grid.mjs — the contact sheet the punch trajectories get re-authored
 * against (Stage 18b part 1).
 *
 * Drives the pose scrubber (see src/poseDebug.js) and captures one crop per
 * cell: 4 punch types × 2 rig slots × 2 facings × 7 progress values, plus an
 * assembled grid per punch type. Every cell goes through the shipped
 * drawRig()/computePose()/punchKey() path — this script sets config values and
 * screenshots, it never evaluates a pose itself. If it did, the sheet could
 * agree with itself while disagreeing with the game, which is the one failure
 * mode that would make authoring against it actively harmful.
 *
 * Output: scripts/output/pose_grid/
 *   cells/<type>_<slot>_<facing>_p<NN>.png   one crop per cell
 *   <type>.png                               4 rows × 7 columns, labelled
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, settled } from './waits.js';
import { greyscaleCopy } from './greyscale.js';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';

const OUT   = 'scripts/output/pose_grid';
const CELLS = `${OUT}/cells`;
mkdirSync(CELLS, { recursive: true });

const TYPES    = ['jab', 'cross', 'hook', 'uppercut'];
const SLOTS    = ['lead', 'rear'];
const FACINGS  = ['right', 'left'];
const PROGRESS = [0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9];

// Crop half-extents in WORLD px around the RIG's visual centre. Wide enough for
// a fully extended hook plus the aim-bend range. The rig spans -67..+44 around
// the container origin, so the crop is centred 11 px above it rather than on it.
const HALF_W    = 95;
const HALF_H    = 80;
const RIG_CY    = -11;

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

// Freeze the world around the subject: the dummy holds still at a fixed
// separation so the follow camera has nothing to chase, and the scrubber owns
// the player. Camera zoom is pinned so every cell is captured at the same scale
// — otherwise a hook that pushes the pair apart would silently rescale the sheet.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  const c  = window.__config;
  c.dummyMoveSpeed           = 0;
  c.dummyAttackDelayMin      = 999;
  c.dummyAttackDelayMax      = 999;
  c.dummyBlockReactionChance = 0;
  sc.dummy.attackTimer       = 999;
  // Pin the framing so every cell is captured at the same scale and position:
  // one fixed zoom, anchored on the player alone (camPairMix 0) with no
  // left-third bias (camBiasFrac 0), so the subject sits dead centre. Without
  // this the bias pushes the player to the frame edge and the crop clamps.
  c.camZoomMin = c.camZoomMax = 2;
  c.camPairMix  = 0;
  c.camBiasFrac = 0;
  c.poseDebugEnabled = true;
  c.poseDebugTarget  = 'player';
  c.poseDebugJoints  = true;
  c.poseDebugAim     = 0;

  const ring = sc._getRingBounds();
  const cx   = (ring.left + ring.right) / 2;
  const cy   = (ring.top + ring.bottom) / 2;
  // The subject sits at ring centre (so the camera's arena clamp never kicks in
  // and shifts the crop) and the dummy stands well clear of the crop box.
  sc.dummy.x = sc.dummy._loco.x = cx + 260;  sc.dummy.y = sc.dummy._loco.y = cy;
  sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
  sc.fighter.x = cx;  sc.fighter.y = cy;
  sc.fighter.vx = sc.fighter.vy = 0;
});

// Let the camera stop moving before the first capture, on the camera's own
// state rather than a fixed sleep — it eases toward its target over several
// frames and a crop taken mid-ease is offset from every later one.
await settled(page, () => window.__cam().main.scrollX, { epsilon: 0.05, stableFrames: 8, label: 'camera scrollX' });
await settled(page, () => window.__cam().main.zoom,    { epsilon: 0.001, stableFrames: 8, label: 'camera zoom' });

/**
 * Page-space clip rect around the frozen fighter, at the live camera transform.
 *
 * window.__cam() projects into CANVAS space, and the canvas is letterboxed
 * inside the page (960×640 at an offset, not 1280×800 at the origin), so the
 * canvas's own bounding rect has to be added. Without that the crop lands ~160
 * px left and 80 px high of the subject — which is exactly the off-centre sheet
 * this replaced.
 */
async function clipRect() {
  const { cam, canvas } = await page.evaluate(() => ({
    cam: window.__cam(),
    canvas: window.__game.canvas.getBoundingClientRect().toJSON(),
  }));
  const z = cam.main.zoom;
  const w = HALF_W * 2 * z, h = HALF_H * 2 * z;
  const r = {
    x: Math.round(canvas.x + cam.player.screen.x - w / 2),
    y: Math.round(canvas.y + cam.player.screen.y + RIG_CY * z - h / 2),
    width:  Math.round(w),
    height: Math.round(h),
  };
  // A crop that runs off the canvas would be silently clamped by Playwright,
  // which shifts the subject within the cell and makes the sheet's columns
  // disagree with each other. Fail loudly instead.
  if (r.x < canvas.x || r.y < canvas.y ||
      r.x + r.width > canvas.x + canvas.width || r.y + r.height > canvas.y + canvas.height) {
    throw new Error(`crop ${JSON.stringify(r)} falls outside the canvas ` +
      `${JSON.stringify(canvas)} — the camera is not framing the subject where this expects`);
  }
  return r;
}

const clip  = await clipRect();
const cells = [];
console.log(`crop ${clip.width}×${clip.height} at (${clip.x}, ${clip.y})\n`);

for (const type of TYPES) {
  for (const slot of SLOTS) {
    for (const facing of FACINGS) {
      for (const p of PROGRESS) {
        await page.evaluate(([t, s, f, pr]) => {
          const c = window.__config;
          c.poseDebugPunch = t; c.poseDebugArm = s; c.poseDebugFacing = f; c.poseDebugProgress = pr;
        }, [type, slot, facing, p]);
        await frames(page, 2);   // the pose is drawn in update(), not on assignment
        const name = `${type}_${slot}_${facing}_p${String(Math.round(p * 100)).padStart(2, '0')}`;
        await page.screenshot({ path: `${CELLS}/${name}.png`, clip });
        cells.push({ type, slot, facing, p, name });
      }
    }
    console.log(`  captured ${type} / ${slot}`);
  }
}

// ── Assemble one labelled grid per punch type ───────────────────────────────
// Composed in a blank page's 2D canvas rather than with an image library, so the
// suite stays dependency-free (CLAUDE.md: keep the tooling minimal).
const sheet = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await sheet.goto('about:blank');

for (const type of TYPES) {
  const rows = [];
  for (const slot of SLOTS) {
    for (const facing of FACINGS) {
      rows.push({
        label: `${slot} / facing ${facing}`,
        imgs: PROGRESS.map(p => {
          const c = cells.find(x => x.type === type && x.slot === slot && x.facing === facing && x.p === p);
          return 'data:image/png;base64,' + readFileSync(`${CELLS}/${c.name}.png`).toString('base64');
        }),
      });
    }
  }

  const dataUrl = await sheet.evaluate(async ({ rows, progress, title, cw, ch }) => {
    const PAD = 8, LABEL_W = 150, HEAD_H = 34, TITLE_H = 34;
    const canvas = document.createElement('canvas');
    canvas.width  = LABEL_W + progress.length * (cw + PAD) + PAD;
    canvas.height = TITLE_H + HEAD_H + rows.length * (ch + PAD) + PAD;
    const g = canvas.getContext('2d');
    g.fillStyle = '#15151c'; g.fillRect(0, 0, canvas.width, canvas.height);

    g.fillStyle = '#ffffff';
    g.font = 'bold 18px monospace';
    g.fillText(title, PAD, 24);

    g.font = '13px monospace';
    g.fillStyle = '#9fb4d0';
    progress.forEach((p, i) => {
      g.fillText(`p = ${p}`, LABEL_W + i * (cw + PAD), TITLE_H + 22);
    });

    const load = src => new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = src; });
    for (let r = 0; r < rows.length; r++) {
      const y = TITLE_H + HEAD_H + r * (ch + PAD);
      g.fillStyle = '#d8e2f0';
      g.font = '13px monospace';
      g.fillText(rows[r].label, PAD, y + ch / 2);
      for (let i = 0; i < rows[r].imgs.length; i++) {
        const im = await load(rows[r].imgs[i]);
        g.drawImage(im, LABEL_W + i * (cw + PAD), y, cw, ch);
        g.strokeStyle = '#2c3242';
        g.strokeRect(LABEL_W + i * (cw + PAD) + 0.5, y + 0.5, cw, ch);
      }
    }
    return canvas.toDataURL('image/png');
  }, { rows, progress: PROGRESS, title: `${type.toUpperCase()} — pose progress`, cw: clip.width, ch: clip.height });

  writeFileSync(`${OUT}/${type}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
  // VISUALS.md protocol step 4. The grey sibling is produced for the assembled
  // sheet only, not per cell — 112 extra files nobody opens is not a value check.
  const grey = await greyscaleCopy(sheet, `${OUT}/${type}.png`);
  console.log(`  grid → ${OUT}/${type}.png  (+ ${grey.split('/').pop()})`);
}

// Turning the scrubber off must leave nothing stuck: the fighter goes back to
// tracking the opponent, its own punches work again, and the rig redraws from
// live state. Asserted rather than assumed, because a scrubber that poisons the
// running game is worse than no scrubber.
await page.evaluate(() => { window.__config.poseDebugEnabled = false; });
await frames(page, 3);
const restored = await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.startPunch('left', 'jab', 0);
  return {
    scaleX:     sc.fighter.container.scaleX,
    facingRight: sc.fighter.facingRight,
    punchTimer: sc.fighter.punchTimer,
  };
});
const clean = restored.punchTimer > 0 &&
              Math.sign(restored.scaleX) === (restored.facingRight ? 1 : -1);
console.log(`\ndisabling the scrubber restores normal behaviour: ${clean ? 'PASS' : 'FAIL'} ` +
            `(punchTimer ${restored.punchTimer.toFixed(3)}, scaleX ${restored.scaleX}, ` +
            `facingRight ${restored.facingRight})`);

await browser.close();
console.log(`\n${cells.length} cells → ${CELLS}/`);
console.log('Page errors:', errors.length ? errors : 'none');
if (!clean || errors.length) process.exit(1);
