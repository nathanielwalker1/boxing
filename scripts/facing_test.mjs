import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1500);

// 1. Initial state — fighter left of dummy, should face right (toward dummy)
await page.screenshot({ path: 'scripts/output/facing_01_initial.png' });

// 2. Sidestep LEFT (away from dummy, moving further left) — old bug flipped
//    facing to left here because vx < 0. Correct: dummy still to the right,
//    so fighter should keep facing right.
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(1200);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_02_sidestep_left.png' });

// 3. Move RIGHT, all the way past the dummy's x position, to end up
//    behind/past the opponent. Fighter should now face LEFT (dummy behind him).
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(4000);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_03_past_dummy.png' });

// 4. Sidestep further RIGHT (away from dummy again, now moving away while
//    already past it) — old bug would keep/flip facing based on vx > 0
//    (facing right), but correct behavior: dummy is now to the LEFT, so
//    fighter should face left.
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(800);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_04_sidestep_right_past.png' });

// 5. Move back LEFT across the dummy again — should flip back to facing right.
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(4000);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(300);
await page.screenshot({ path: 'scripts/output/facing_05_back_left.png' });

// ── 6. Facing while BLOCKING ────────────────────────────────────────────────
// Regression guard for the bug where holding block made the fighter read as
// facing AWAY from the opponent. Two independent things are checked, because
// the symptom was visual while the facing variable itself was always correct:
//
//   a) facingRight / container.scaleX still track the opponent continuously
//      while block is held, from both sides — i.e. block did not fork onto a
//      separate facing source.
//   b) the BLOCK POSE ITSELF still leans toward the opponent: in rig-local
//      space (+x = toward the opponent) the limbs must reach further forward
//      than backward. This is what actually broke — a shared absolute block
//      angle pair parked the rear glove 25 px behind the torso, so the
//      silhouette pointed backwards even though scaleX was right.

const failures = [];

// Freeze the dummy so it can be pinned on either side.
await page.evaluate(() => {
  window.__config.dummyMoveSpeed      = 0;
  window.__config.dummyAttackDelayMin = 999;
  window.__config.dummyAttackDelayMax = 999;
  window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
});

const pin = (px, dx) => page.evaluate(({ px, dx }) => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.x = px; sc.fighter.y = 320; sc.fighter.vx = 0; sc.fighter.vy = 0;
  sc.dummy._loco.x = dx; sc.dummy._loco.y = 320;
  sc.dummy._loco.vx = 0; sc.dummy._loco.vy = 0;
  sc.dummy.x = dx; sc.dummy.y = 320;
  sc.dummy.staggerX = 0; sc.dummy.staggerY = 0;
  sc.dummy.staggerVx = 0; sc.dummy.staggerVy = 0;
}, { px, dx });

const sample = () => page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  const f  = sc.fighter;
  const p  = window.__rig.computePose(null, f.isBlocking ? 1 : 0, 0);
  const xs = [p.lead.wx, p.rear.wx, p.lead.ex, p.rear.ex];
  return {
    blocking:    f.isBlocking,
    facingRight: f.facingRight,
    scaleX:      f.container.scaleX,
    expectRight: sc.dummy.x > f.x,
    fwdReach:    Math.max(...xs),
    backReach:   Math.min(...xs),
  };
});

for (const [label, px, dx] of [['dummy right', 400, 620], ['dummy left', 620, 400]]) {
  await pin(px, dx);
  await page.keyboard.down('Shift');
  // Sample repeatedly across the whole hold, not just once at the end.
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(120);
    await pin(px, dx);
    const s = await sample();
    if (!s.blocking) { failures.push(`[${label}] block never engaged`); break; }
    if (s.facingRight !== s.expectRight) {
      failures.push(`[${label}] sample ${i}: facingRight=${s.facingRight}, expected ${s.expectRight}`);
    }
    if (s.scaleX !== (s.expectRight ? 1 : -1)) {
      failures.push(`[${label}] sample ${i}: scaleX=${s.scaleX} disagrees with facing`);
    }
    if (s.fwdReach <= Math.abs(s.backReach)) {
      failures.push(`[${label}] sample ${i}: block pose points backwards ` +
                    `(fwd ${s.fwdReach.toFixed(1)} <= back ${Math.abs(s.backReach).toFixed(1)})`);
    }
  }
  await page.screenshot({
    path: `scripts/output/facing_06_block_${label.replace(' ', '_')}.png`,
    clip: { x: 160 + px - 95, y: 80 + 320 - 115, width: 190, height: 200 },
  });
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
}

// ── 7. Rapid block toggling while circling ──────────────────────────────────
// Facing must track the opponent every frame with no stuck or delayed state.
await pin(400, 620);
for (let i = 0; i < 10; i++) {
  const past = i >= 5;                       // second half: circle past the dummy
  await pin(past ? 700 : 400, 620);
  if (i % 2 === 0) await page.keyboard.down('Shift');
  else             await page.keyboard.up('Shift');
  await page.waitForTimeout(100);
  await pin(past ? 700 : 620 - 220, 620);
  const s = await sample();
  if (s.facingRight !== s.expectRight) {
    failures.push(`[toggle ${i}] facingRight=${s.facingRight}, expected ${s.expectRight} ` +
                  `(blocking=${s.blocking})`);
  }
}
await page.keyboard.up('Shift');

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Facing test screenshots saved to scripts/output/facing_*.png');

if (failures.length) {
  console.error('FACING FAILURES:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('Block-facing checks: PASS');
