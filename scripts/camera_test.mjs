/**
 * Dynamic camera (Stage 15) — FollowCamera zoom solve + arena clamp.
 *
 * What this guards, in order of importance:
 *   1. FRAMING — both fighters, plus their drawn extent, stay inside the
 *      viewport with margin at every separation the ring allows. This is the
 *      one that breaks the game if it regresses (a fighter off-frame).
 *   2. BOUNDS — the view never extends past the ARENA (ring + arenaMargin*),
 *      so no void, at any zoom. And when the arena is SMALLER than the view on
 *      an axis, the camera centers on it rather than pinning to one edge.
 *   3. LIMITS — the solved zoom stays inside [camZoomMin, camZoomMax].
 *   4. STABILITY — held at a fixed separation, the zoom does not hunt. The
 *      framing solve is continuous in separation, so without the deadzone +
 *      asymmetric rates it breathes constantly. Also measured under fast
 *      in-and-out footwork, where the zoom is SUPPOSED to move — what is
 *      checked there is that it does not overshoot or ring.
 *   5. REACH — at big separations the ring's top and bottom edges are both
 *      inside the frame with room around them. That reachable band is the
 *      entire point of the stage (it is where the ropes/crowd get drawn).
 *
 * Fighter positions are pinned every frame rather than driven by input: the
 * sweep needs exact separations, and the dummy's AI would walk out of them.
 *
 * Requires the dev server running.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, until, soft } from './waits.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

const failures = [];
const pass = (name, detail) => console.log(`  [PASS] ${name.padEnd(50)} — ${detail}`);
const fail = (name, detail) => { failures.push(`${name}: ${detail}`); console.log(`  [FAIL] ${name.padEnd(50)} — ${detail}`); };

// The dummy is frozen for the whole run: its AI would walk out of every
// separation this sweep is trying to hold, and a punch would add stagger
// wobble on top of the pinned position.
await page.evaluate(() => {
  window.__config.dummyMoveSpeed      = 0;
  window.__config.dummyAttackDelayMin = 9999;
  window.__config.dummyAttackDelayMax = 9999;
});

const CFG = await page.evaluate(() => ({
  zoomMin: window.__config.camZoomMin,
  zoomMax: window.__config.camZoomMax,
  padX:    window.__config.camFramePaddingX,
  padY:    window.__config.camFramePaddingY,
  ext:     window.__config.camFighterExtent,
  dead:    window.__config.camZoomDeadzone,
  mX:      window.__config.arenaMarginX,
  mY:      window.__config.arenaMarginY,
}));
const B  = await page.evaluate(() => window.__cam().ring);
const cx = (B.left + B.right) / 2, cy = (B.top + B.bottom) / 2;
const RIG_MARGIN_X = 24;                       // fighters clamp this far off the ropes
const MAX_SEP = (B.right - B.left) - RIG_MARGIN_X * 2;

console.log(`ring ${(B.right - B.left)}×${(B.bottom - B.top)}, arena margin ${CFG.mX}/${CFG.mY}, ` +
            `zoom [${CFG.zoomMin}, ${CFG.zoomMax}], pad ${CFG.padX}/${CFG.padY}, extent ${CFG.ext}\n`);

/**
 * Hold the pair at fixed world positions for `frames` frames, then report the
 * camera state plus the zoom trace (so stability can be measured on the tail
 * rather than on a single sample).
 */
const hold = (px, py, dx, dy, frames = 200) => page.evaluate(async (a) => {
  const sc = window.__game.scene.keys.RingScene;
  const f  = sc.fighter, d = sc.dummy;
  const zoom = [];
  for (let i = 0; i < a.frames; i++) {
    f.x = a.px; f.y = a.py; f.vx = 0; f.vy = 0;
    d._loco.x = a.dx; d._loco.y = a.dy; d._loco.vx = 0; d._loco.vy = 0;
    await new Promise(r => requestAnimationFrame(r));
    zoom.push(sc.followCam.zoom);
  }
  return { ...window.__cam(), zoom };
}, { px, py, dx, dy, frames });

/** Framing/bounds facts for one settled camera state. */
function analyse(c) {
  const v = c.view, a = c.arena, e = CFG.ext;
  const xs = [c.player.x, c.dummy.x], ys = [c.player.y, c.dummy.y];
  return {
    v, a,
    // Smallest gap between a fighter's drawn box and the frame edge.
    margin: Math.min(
      Math.min(...xs) - e - v.left, v.right  - (Math.max(...xs) + e),
      Math.min(...ys) - e - v.top,  v.bottom - (Math.max(...ys) + e),
    ),
    voidX: Math.max(a.left - v.left, v.right - a.right),
    voidY: Math.max(a.top - v.top, v.bottom - a.bottom),
    wider:  v.width  > a.right - a.left + 0.01,
    taller: v.height > a.bottom - a.top + 0.01,
  };
}

// ── 1. Framing sweep ─────────────────────────────────────────────────────────
// Separations from clinch to rope-to-rope, on the horizontal axis and on the
// diagonal (which is what actually binds the vertical solve).
console.log('Framing sweep — both fighters inside the frame, with margin:');
let worstMargin = Infinity, worstCase = '';
const zooms = [];

const CASES = [];
for (const s of [40, 80, 140, 200, 280, 360, 440, MAX_SEP]) CASES.push({ name: `x-sep ${s}`, s, dy: 0 });
for (const dy of [40, 80, 120]) CASES.push({ name: `x-sep 240 / y-sep ${dy * 2}`, s: 240, dy });
CASES.push({ name: 'diagonal, both corners', s: MAX_SEP, dy: 120 });

for (const k of CASES) {
  const c = await hold(cx - k.s / 2, cy - k.dy, cx + k.s / 2, cy + k.dy);
  const r = analyse(c);
  zooms.push({ name: k.name, zoom: r.v.zoom, ...r });

  if (r.margin < worstMargin) { worstMargin = r.margin; worstCase = k.name; }

  // Hard requirement: the drawn box is inside the frame at all.
  if (r.margin < 0) {
    fail(`framing — ${k.name}`, `fighter box overhangs the frame by ${(-r.margin).toFixed(1)}px`);
  } else {
    // Soft requirement: the requested padding is held. A clamp (camZoomMin,
    // the arena-fit floor, or the zoom deadzone) can legitimately erode it —
    // the deadzone alone is worth up to ~viewW * dead / (2 * zoom) per side.
    const erosion = (r.v.width * CFG.dead) / (2 * r.v.zoom);
    const floor   = Math.min(CFG.padX, CFG.padY) - erosion;
    if (r.margin + 0.5 < floor) {
      fail(`framing — ${k.name}`,
           `margin ${r.margin.toFixed(1)}px < padding ${Math.min(CFG.padX, CFG.padY)}px ` +
           `even allowing ${erosion.toFixed(1)}px of deadzone erosion (zoom ${r.v.zoom.toFixed(3)})`);
    } else {
      pass(`framing — ${k.name}`,
           `zoom ${r.v.zoom.toFixed(3)}, view ${r.v.width.toFixed(0)}×${r.v.height.toFixed(0)}, ` +
           `margin ${r.margin.toFixed(1)}px`);
    }
  }
}
console.log(`  worst margin over the sweep: ${worstMargin.toFixed(1)}px (${worstCase})\n`);

// ── 2. Zoom limits ───────────────────────────────────────────────────────────
const lo = Math.min(...zooms.map(z => z.zoom)), hi = Math.max(...zooms.map(z => z.zoom));
if (lo < CFG.zoomMin - 0.001 || hi > CFG.zoomMax + 0.001) {
  fail('zoom stays within [camZoomMin, camZoomMax]', `observed ${lo.toFixed(3)} … ${hi.toFixed(3)}`);
} else {
  pass('zoom stays within [camZoomMin, camZoomMax]',
       `observed ${lo.toFixed(3)} … ${hi.toFixed(3)} inside [${CFG.zoomMin}, ${CFG.zoomMax}]`);
}

// ── 3. The view never leaves the arena ───────────────────────────────────────
const leaks = zooms.filter(z => (!z.wider && z.voidX > 0.5) || (!z.taller && z.voidY > 0.5));
if (leaks.length) {
  fail('view never extends past the arena bounds',
       leaks.map(l => `${l.name}: ${Math.max(l.voidX, l.voidY).toFixed(1)}px of void`).join('; '));
} else {
  pass('view never extends past the arena bounds', `${zooms.length} cases, all inside`);
}

// ── 4. Reachable band above and below the ring ───────────────────────────────
// The acceptance condition for the stage: at full separation the ring's top and
// bottom edges are both on screen with room around them for the apron/ropes.
{
  const c = await hold(cx - MAX_SEP / 2, cy, cx + MAX_SEP / 2, cy);
  const above = B.top - c.view.top, below = c.view.bottom - B.bottom;
  if (above > 10 && below > 10) {
    pass('ring top+bottom edges reachable at max separation',
         `${above.toFixed(0)}px visible above, ${below.toFixed(0)}px below (zoom ${c.view.zoom.toFixed(3)})`);
  } else {
    fail('ring top+bottom edges reachable at max separation',
         `only ${above.toFixed(0)}px above / ${below.toFixed(0)}px below — the rope band is not reachable`);
  }
}

// ── 5. Stability: fixed separation must not breathe ──────────────────────────
{
  // 400 frames: long enough that the settle transient is well clear of the tail.
  const c    = await hold(cx - 150, cy, cx + 150, cy, 400);
  const tail = c.zoom.slice(-180);
  const p2p  = Math.max(...tail) - Math.min(...tail);
  if (p2p > 0.005) {
    fail('zoom is stable at a fixed separation',
         `peak-to-peak ${p2p.toFixed(4)} over 3s — the zoom is hunting`);
  } else {
    pass('zoom is stable at a fixed separation',
         `peak-to-peak ${p2p.toFixed(5)} over 3s at zoom ${c.view.zoom.toFixed(3)}`);
  }
}

// ── 6. Stability under fast in-and-out footwork ──────────────────────────────
// Here the zoom SHOULD move — the pair really is changing separation. What is
// checked is that it does not exceed the range the two endpoints justify (i.e.
// no overshoot/ringing) and that it does not chase every cycle to the extremes.
{
  const near = 90, far = 330;
  const ends = [];
  for (const s of [near, far]) {
    const c = await hold(cx - s / 2, cy, cx + s / 2, cy, 240);
    ends.push(c.view.zoom);
  }
  const [zNear, zFar] = ends;

  const osc = await page.evaluate(async (a) => {
    const sc = window.__game.scene.keys.RingScene;
    const f  = sc.fighter, d = sc.dummy;
    const zoom = [];
    // 6 full in-out cycles, one per second, moving CONTINUOUSLY rather than
    // teleporting between the endpoints — a teleport makes the camera's own
    // trailing center the dominant term and stops measuring the zoom. Peak
    // closing speed here is ~300 px/s per fighter, well above dummyMoveSpeed.
    const mid = (a.near + a.far) / 2, amp = (a.far - a.near) / 2;
    for (let i = 0; i < 6 * 60; i++) {
      const s = mid + amp * Math.sin((i / 60) * Math.PI * 2);
      f.x = a.cx - s / 2; f.y = a.cy; f.vx = 0; f.vy = 0;
      d._loco.x = a.cx + s / 2; d._loco.y = a.cy; d._loco.vx = 0; d._loco.vy = 0;
      await new Promise(r => requestAnimationFrame(r));
      zoom.push(sc.followCam.zoom);
    }
    return zoom;
  }, { cx, cy, near, far });

  const oLo = Math.min(...osc), oHi = Math.max(...osc);
  const band = Math.max(zNear, zFar) - Math.min(zNear, zFar);
  // Overshoot past either steady-state endpoint means the smoothing is ringing.
  const over = Math.max(0, Math.min(zNear, zFar) - oLo, oHi - Math.max(zNear, zFar));
  // Direction reversals: one per leg of footwork is the floor (12 legs). Many
  // more than that would mean the zoom is hunting inside each leg.
  let reversals = 0;
  for (let i = 2; i < osc.length; i++) {
    const a1 = osc[i] - osc[i - 1], a0 = osc[i - 1] - osc[i - 2];
    if (Math.abs(a1) > 1e-4 && Math.abs(a0) > 1e-4 && Math.sign(a1) !== Math.sign(a0)) reversals++;
  }
  if (reversals > 24) {
    fail('no zoom hunting under fast footwork',
         `${reversals} direction reversals over 12 legs of footwork — the zoom is hunting`);
  } else {
    pass('no zoom hunting under fast footwork', `${reversals} direction reversals over 12 legs`);
  }
  if (over > 0.05) {
    fail('no zoom overshoot under fast footwork',
         `zoom reached ${oLo.toFixed(3)}…${oHi.toFixed(3)}, ${over.toFixed(3)} past the ` +
         `steady-state band ${Math.min(zNear, zFar).toFixed(3)}…${Math.max(zNear, zFar).toFixed(3)}`);
  } else {
    pass('no zoom overshoot under fast footwork',
         `swing ${(oHi - oLo).toFixed(3)} of a ${band.toFixed(3)} steady-state band ` +
         `(${((oHi - oLo) / Math.max(0.001, band) * 100).toFixed(0)}% — the rest is the lazy zoom-in rate)`);
  }
}

// ── 7. Arena smaller than the view on an axis → center, don't pin ────────────
{
  await page.evaluate(() => {
    window.__config.ringWidth  = 200;
    window.__config.ringHeight = 120;
    window.__config.arenaMarginX = 0;
    window.__config.arenaMarginY = 0;
  });
  const c = await hold(480, 320, 520, 320, 200);
  const r = analyse(c);
  const offX = Math.abs((c.view.left + c.view.right) / 2 - (c.arena.left + c.arena.right) / 2);
  const offY = Math.abs((c.view.top + c.view.bottom) / 2 - (c.arena.top + c.arena.bottom) / 2);
  if (!r.wider || !r.taller) {
    fail('arena-smaller-than-view case is actually exercised',
         `view ${c.view.width.toFixed(0)}×${c.view.height.toFixed(0)} still fits the ` +
         `${(c.arena.right - c.arena.left).toFixed(0)}×${(c.arena.bottom - c.arena.top).toFixed(0)} arena`);
  } else if (offX > 0.5 || offY > 0.5) {
    fail('view centers on an arena smaller than itself',
         `off-center by ${offX.toFixed(1)}px / ${offY.toFixed(1)}px — it pinned to an edge`);
  } else {
    pass('view centers on an arena smaller than itself',
         `view ${c.view.width.toFixed(0)}×${c.view.height.toFixed(0)} over a ` +
         `${(c.arena.right - c.arena.left).toFixed(0)}×${(c.arena.bottom - c.arena.top).toFixed(0)} arena, centered`);
  }
  await page.evaluate((k) => {
    window.__config.ringWidth  = k.w;
    window.__config.ringHeight = k.h;
    window.__config.arenaMarginX = k.mX;
    window.__config.arenaMarginY = k.mY;
  }, { w: B.right - B.left, h: B.bottom - B.top, mX: CFG.mX, mY: CFG.mY });
}

// ── Screenshots ──────────────────────────────────────────────────────────────
// The acceptance shot: max separation, ring top AND bottom edges in frame.
await hold(cx - MAX_SEP / 2, cy, cx + MAX_SEP / 2, cy, 200);
await page.screenshot({ path: 'scripts/output/camera_max_separation.png' });

// The tight end: clinched.
await hold(cx - 20, cy, cx + 20, cy, 240);
await page.screenshot({ path: 'scripts/output/camera_clinch.png' });

// A knockdown, so the framing is checked against a downed rig too.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.x = 400; sc.fighter.y = 330;
  sc.dummy._loco.x = 520; sc.dummy._loco.y = 320;
  sc.dummy.takeDamage(window.__config.healthMax);
});
await gameTime(page, 0.9);
await page.screenshot({ path: 'scripts/output/camera_knockdown.png' });

await browser.close();

console.log('\nPage errors:', errors.length ? errors : 'none');
console.log('Screenshots → scripts/output/camera_max_separation.png, camera_clinch.png, camera_knockdown.png');

if (failures.length || errors.length) {
  console.error(`\nCAMERA FAILURES (${failures.length}):\n  ` + failures.join('\n  '));
  process.exit(1);
}
console.log('Camera checks: PASS');
