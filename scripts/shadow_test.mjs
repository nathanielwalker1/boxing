/**
 * shadow_test.mjs — Stage 14 part 2 (contact shadows) + part 4 (depth sorting).
 * Run with: node scripts/shadow_test.mjs   (dev server must be running)
 *
 * The shadow is deliberately NOT drawn inside the fighter's container: that
 * container is rotated and vertically squashed for slip and knockdown, so a
 * shadow caught in the transform would tilt off the ground during a slip and
 * squash during a knockdown — exactly backwards. It lives in its own scene
 * layer and is positioned from the fighter's world (x, y) alone.
 *
 * "World position alone" is the property with teeth, so it is tested by moving
 * the things that must NOT move it and checking the shadow stayed put:
 *   - an active slip, which visibly leans and rotates the drawn rig;
 *   - an active hit reaction, which displaces the head and torso far enough to
 *     move the hurtboxes;
 *   - the movement bob.
 * Each of those asserts the rig ACTUALLY moved as well, so a shadow that stayed
 * put because nothing happened can't pass by accident.
 *
 * Knockdown is the one intended exception: the body is lying on the canvas
 * rather than standing on it, so the ellipse widens and flattens.
 *
 * Part 4 rides along at the end because it is the same question — draw order —
 * and shadows are what make it legible: a fighter whose shadow is clearly in
 * front must not be drawn behind.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, until, soft } from './waits.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const EPS = 0.001;

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

// Nothing may wander during the probes: no dummy AI, no attacks, no separation
// shove, and a health floor so a test impulse can't trigger a real knockdown.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__config.dummyMoveSpeed            = 0;
  window.__config.dummyAttackDelayMin       = 999;
  window.__config.dummyAttackDelayMax       = 999;
  window.__config.dummyBlockReactionChance  = 0;
  window.__config.fighterSeparationDist     = 0;
  window.__config.healthDamagePerForce      = 0;
  sc.dummy.attackTimer = 999;

  window.__place = (px, py, dx, dy) => {
    sc.fighter.x = px; sc.fighter.y = py;
    sc.fighter.vx = sc.fighter.vy = 0;
    sc.dummy._loco.x = sc.dummy.x = dx; sc.dummy._loco.y = sc.dummy.y = dy;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
  };
  // Everything the assertions read, sampled in one go so the fighter can't step
  // between the shadow read and the rig read.
  window.__probe = () => ({
    shadows: sc._shadowGeom(),
    drawn:   sc.shadowGfx.commandBuffer.length,
    player: {
      x: sc.fighter.x, y: sc.fighter.y,
      bob: sc.fighter._bob,
      slip: sc.fighter.slipTimer,
      gfxX: sc.fighter.gfx.x, gfxY: sc.fighter.gfx.y,
      gfxRot: sc.fighter.gfx.rotation, gfxScaleY: sc.fighter.gfx.scaleY,
      react: sc.fighter.reaction.pose(),
      head: sc.fighter.getHurtboxes().head,
      depth: sc.fighter.container.depth,
      down: sc.fighter.isDown,
    },
    dummy: {
      x: sc.dummy.x, y: sc.dummy.y,
      depth: sc.dummy.container.depth,
      down: sc.dummy.isDown,
    },
    cfg: {
      offsetY: window.__config.shadowOffsetY,
      rx: window.__config.shadowRadiusX,
      ry: window.__config.shadowRadiusY,
      downScale: window.__config.shadowDownRadiusScale,
    },
  });
});

const results = [];
const check = (ok, msg) => results.push({ ok, msg });

/** The shadow sits exactly under the fighter's feet at their world (x, y). */
function assertAnchored(p, tag) {
  const [ps, ds] = p.shadows;
  const okP = Math.abs(ps.x - p.player.x) < EPS && Math.abs(ps.y - (p.player.y + p.cfg.offsetY)) < EPS;
  const okD = Math.abs(ds.x - p.dummy.x)  < EPS && Math.abs(ds.y - (p.dummy.y  + p.cfg.offsetY)) < EPS;
  check(okP, `${tag} — player shadow at (${ps.x.toFixed(2)}, ${ps.y.toFixed(2)}), world (${p.player.x.toFixed(2)}, ${p.player.y.toFixed(2)}) + ${p.cfg.offsetY}`);
  check(okD, `${tag} — dummy shadow at (${ds.x.toFixed(2)}, ${ds.y.toFixed(2)}), world (${p.dummy.x.toFixed(2)}, ${p.dummy.y.toFixed(2)}) + ${p.cfg.offsetY}`);
}

// ── 1. Tracks world position ────────────────────────────────────────────────
for (const [px, py, dx, dy] of [[300, 300, 620, 300], [420, 200, 560, 470], [250, 480, 700, 180]]) {
  await page.evaluate(a => window.__place(...a), [px, py, dx, dy]);
  await gameTime(page, 0.12);
  assertAnchored(await page.evaluate(() => window.__probe()), `placed (${px},${py})/(${dx},${dy})`);
}

// ── 2. An active SLIP must not move it ──────────────────────────────────────
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__place(360, 320, 640, 320);
  window.__config.slipInvincibilityDuration = 6;   // hold the window open
  sc.fighter._triggerSlip(-1, -1);
});
await gameTime(page, 0.5);
{
  const p = await page.evaluate(() => window.__probe());
  check(p.player.slip > 0, `slip is active (${p.player.slip.toFixed(2)}s left)`);
  // The slip has to have visibly moved the DRAWN rig, or "the shadow didn't
  // move" proves nothing. Fighter._draw expresses it as a lean + squash on the
  // gfx child, which is exactly the transform a container-parented shadow would
  // have been dragged through.
  const moved = Math.abs(p.player.gfxX) > 1 || Math.abs(p.player.gfxRot) > 0.02 || Math.abs(p.player.gfxScaleY - 1) > 0.02;
  check(moved, `slip visibly moved the rig (gfx x=${p.player.gfxX.toFixed(1)} rot=${p.player.gfxRot.toFixed(3)} scaleY=${p.player.gfxScaleY.toFixed(3)})`);
  assertAnchored(p, 'mid-slip');
  const [ps] = p.shadows;
  check(Math.abs(ps.rx - p.cfg.rx) < EPS && Math.abs(ps.ry - p.cfg.ry) < EPS,
    `mid-slip — shadow keeps its flat resting shape (${ps.rx} × ${ps.ry})`);
}
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.slipTimer = 0;
  window.__config.slipInvincibilityDuration = 0.25;
});
await gameTime(page, 0.12);

// ── 3. An active HIT REACTION must not move it ──────────────────────────────
// A fighter rocked back by a cross has moved their upper body, not their feet.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__place(360, 320, 640, 320);
  sc.fighter.receiveHit('cross', 600);
});
await gameTime(page, 0.09);
{
  const p = await page.evaluate(() => window.__probe());
  const r = p.player.react;
  const rocked = Math.abs(r.headX) + Math.abs(r.headY) + Math.abs(r.torsoX) + Math.abs(r.torsoY) > 2;
  check(rocked, `hit reaction is displacing the rig (head ${r.headX.toFixed(1)},${r.headY.toFixed(1)} torso ${r.torsoX.toFixed(1)},${r.torsoY.toFixed(1)} tilt ${r.tilt.toFixed(3)})`);
  // Second, independent witness that the reaction really moved the body: the
  // head hurtbox is solved from the same offsets, so it has left its rest spot.
  const headOff = Math.hypot(p.player.head.x - p.player.x, p.player.head.y - p.player.y + 50);
  check(headOff > 2, `hit reaction moved the head hurtbox ${headOff.toFixed(1)} px off rest`);
  assertAnchored(p, 'mid-reaction');
}

// ── 4. The movement BOB must not move it ────────────────────────────────────
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.reaction.reset();
  window.__place(360, 320, 640, 320);
  sc.fighter._bobPhase = 0;
});
await page.keyboard.down('ArrowLeft');
await gameTime(page, 0.4);
{
  const p = await page.evaluate(() => window.__probe());
  check(Math.abs(p.player.bob) > 0.2, `movement bob is active (${p.player.bob.toFixed(2)} px)`);
  assertAnchored(p, 'mid-bob');
}
await page.keyboard.up('ArrowLeft');
await gameTime(page, 0.3);

// ── 5. Knockdown — the one intended shape change ────────────────────────────
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__config.knockdownRecoveryDuration = 30;
  window.__place(360, 320, 640, 320);
  sc.dummy._triggerKnockdown();
});
await gameTime(page, 0.15);
{
  const p = await page.evaluate(() => window.__probe());
  const [ps, ds] = p.shadows;
  const s = p.cfg.downScale;
  check(p.dummy.down, 'dummy is down');
  check(Math.abs(ds.rx - p.cfg.rx * s) < EPS && Math.abs(ds.ry - p.cfg.ry / s) < EPS,
    `down — dummy shadow widened + flattened to ${ds.rx.toFixed(1)} × ${ds.ry.toFixed(1)} (rest ${p.cfg.rx} × ${p.cfg.ry})`);
  check(Math.abs(ps.rx - p.cfg.rx) < EPS && Math.abs(ps.ry - p.cfg.ry) < EPS,
    'down — the standing fighter\'s shadow is unaffected');
  assertAnchored(p, 'down');
}
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.dummy.isDown = false; sc.dummy.knockdownTimer = 0;
  sc.dummy.health = window.__config.healthMax;
  window.__config.knockdownRecoveryDuration = 2.5;
});
await gameTime(page, 0.12);

// ── 6. The enable toggle actually stops the draw ────────────────────────────
{
  await page.evaluate(() => { window.__config.shadowEnabled = false; });
  await gameTime(page, 0.12);
  const off = await page.evaluate(() => window.__probe());
  check(off.drawn === 0, `shadowEnabled false → nothing drawn (buffer ${off.drawn})`);
  await page.evaluate(() => { window.__config.shadowEnabled = true; });
  await gameTime(page, 0.12);
  const on = await page.evaluate(() => window.__probe());
  check(on.drawn > 0, `shadowEnabled true → shadows drawn (buffer ${on.drawn})`);
}

// ── 7. Layering + depth sort (part 4) ───────────────────────────────────────
{
  const layers = await page.evaluate(() => {
    const sc = window.__game.scene.keys.RingScene;
    return {
      shadow: sc.shadowGfx.depth,
      ropes:  sc.arena.ropeGfx.depth,
      flash:  sc.flashGfx.depth,
      debug:  sc.debugGfx.depth,
      player: sc.fighter.container.depth,
      dummy:  sc.dummy.container.depth,
    };
  });
  check(layers.shadow > layers.ropes, `shadow layer (${layers.shadow}) is above the ring (${layers.ropes})`);
  check(layers.shadow < layers.player && layers.shadow < layers.dummy,
    `shadow layer (${layers.shadow}) is below both fighters (${layers.player}, ${layers.dummy})`);
  check(layers.player < layers.flash && layers.dummy < layers.flash,
    `both fighters stay under flashGfx (${layers.flash}) and debugGfx (${layers.debug})`);
}

// Lower on screen = nearer the camera = drawn on top, both ways round.
for (const [dy, who] of [[-40, 'player'], [40, 'dummy']]) {
  await page.evaluate(d => window.__place(460, 320, 500, 320 + d), dy);
  await gameTime(page, 0.12);
  const p = await page.evaluate(() => window.__probe());
  const front = p.player.depth > p.dummy.depth ? 'player' : 'dummy';
  check(front === who,
    `dummy ${dy < 0 ? 'above' : 'below'} the player → ${who} draws in front (depths ${p.player.depth.toFixed(2)} vs ${p.dummy.depth.toFixed(2)})`);
}

// A dead-level pair must resolve the same way every time, not flicker.
{
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.__place(460, 320, 500, 320));
    await gameTime(page, 0.07);
    const p = await page.evaluate(() => window.__probe());
    samples.push(p.player.depth > p.dummy.depth ? 'player' : 'dummy');
  }
  const stable = samples.every(s => s === samples[0]);
  check(stable && samples[0] === 'player',
    `level pair resolves deterministically to the player in front (${samples.join(',')})`);
}

await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('Page errors:', errors.length ? errors : 'none');
if (failed.length || errors.length) process.exit(1);
