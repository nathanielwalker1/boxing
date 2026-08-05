/**
 * health_test.mjs — verify health/stamina bars, low-stamina telegraph, and
 * knockdown/recovery (Stage 6).
 * Run with: node scripts/health_test.mjs
 * Dev server must be running on localhost:5173.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const errors  = [];

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
};

async function setGuiNumber(page, label, value) {
  const input = page.locator('.controller', { hasText: label }).locator('input[type=text]');
  await input.fill(String(value));
  await input.press('Enter');
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1500);
  return page;
}

/**
 * Put the player a fixed distance in front of the dummy and pin the dummy so it
 * stays there. Replaces the "walk right for 1300 ms" setup the landing cases
 * used to rely on: both fighters close on each other now, so a timed walk
 * overshot into the smother zone and the jabs it was meant to land didn't.
 * Also silences the dummy's own offence, which otherwise damages the player
 * mid-case and muddies which bar moved.
 */
async function pinAt(page, dist) {
  await page.evaluate(d => {
    const sc = window.__game.scene.keys.RingScene;
    window.__config.dummyMoveSpeed           = 0;
    window.__config.dummyAttackDelayMin      = 999;
    window.__config.dummyAttackDelayMax      = 999;
    window.__config.dummyBlockReactionChance = 0;
    sc.dummy.attackTimer = 999;
    sc.fighter.x = sc.dummy.x - d;
    sc.fighter.y = sc.dummy.y;
    sc.fighter.vx = sc.fighter.vy = 0;
  }, dist);
  await page.waitForTimeout(150);
}

// Comfortably inside the jab's measured geometric reach (~85 px) and clear of
// the 50 px smother radius — see reach_test.mjs.
const JAB_RANGE = 65;

// ── (a) Health/stamina bars visible and changing during a fight ────────────
// Land a jab from a pinned distance so the dummy's health AND stamina bars
// visibly change.
{
  const page = await newPage();
  await pinAt(page, JAB_RANGE);
  await page.keyboard.down('J');
  await page.waitForTimeout(50);
  await page.keyboard.up('J');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'scripts/output/health_bars_changing.png' });
  await page.close();
}

// ── (b) Low-stamina punch telegraph ─────────────────────────────────────────
// Lower stamina max and raise per-punch drain (both within their existing
// slider ranges) so stamina starts just above the default lowStaminaThreshold
// (25) and crosses below it after exactly one punch — deterministic, no need
// to grind through many real punches. Range/landing doesn't matter here since
// the windup-duration effect fires regardless of whiff/smother/land.
{
  const page = await newPage();
  await setGuiNumber(page, 'Stamina Max', 30);
  await setGuiNumber(page, 'Drain / Punch', 20);
  await page.mouse.click(575, 400);   // GUI input steals keyboard focus — click back onto canvas

  // First jab: still full stamina (30) → normal-speed windup (~0.15s), should
  // be fully retracted well before 200ms. Measuring from keydown (not keyup)
  // for a precise, comparable elapsed time between the two punches.
  await page.keyboard.down('J');
  await page.waitForTimeout(200);
  await page.keyboard.up('J');
  await page.screenshot({ path: 'scripts/output/punch_normal_stamina.png' });
  await page.waitForTimeout(100);

  // Second jab: stamina now ~10 (<25 threshold) → windup stretched by
  // lowStaminaWindupMultiplier (2.5x, ~0.375s) — should still be visibly
  // extended at the same 200ms mark where the normal punch had already
  // finished.
  await page.keyboard.down('J');
  await page.waitForTimeout(200);
  await page.keyboard.up('J');
  await page.screenshot({ path: 'scripts/output/punch_low_stamina_telegraph.png' });
  await page.close();
}

// ── (c) Knockdown triggering down pose + recovery ───────────────────────────
// Fresh page (dummy starts at full, untouched health) — amplify damage-per-
// force to its slider max (0.3, ~75-95 per landed jab depending on approach
// momentum) so two landed jabs reliably take the dummy from 100 to 0.
{
  const page = await newPage();
  await setGuiNumber(page, 'Damage / Force', 0.3);
  await page.mouse.click(575, 400);

  // Re-pin before EACH jab: a landed punch knocks the dummy back through the
  // stagger spring, which would otherwise carry it out of reach for the second.
  for (let i = 0; i < 2; i++) {
    await pinAt(page, JAB_RANGE);
    await page.keyboard.down('J');
    await page.waitForTimeout(50);
    await page.keyboard.up('J');
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: 'scripts/output/knockdown_down_pose.png' });

  // knockdownRecoveryDuration defaults to 2.5s — wait it out, then confirm recovery.
  await page.waitForTimeout(2600);
  await page.screenshot({ path: 'scripts/output/knockdown_recovered.png' });
  await page.close();
}

// ── (d) Stamina chip damage on being hit (Stage 17 part 0d) ─────────────────
// Before this stage stamina only drained from THROWING and from HOLDING the
// guard, so being hit was free and turtling cost nothing. The chip is derived
// from the same post-block-reduction `force` value health damage uses, so these
// checks all read that force directly (through the receiveStaminaChip call the
// resolver makes) rather than asserting a flat per-hit number that doesn't exist.
console.log('\n=== (d) Stamina chip damage on being hit ===');
{
  const page = await newPage();
  const cfg = await page.evaluate(() => ({
    perHitForce: window.__config.staminaDrainPerHitForce,
    blockedMult: window.__config.staminaDrainBlockedMult,
    regenDelay:  window.__config.staminaRegenDelayAfterHit,
  }));

  // Instrument the dummy's chip so each case can read the exact (force, blocked)
  // pair the resolver handed it — the ground truth, taken at the call site.
  await page.evaluate(() => {
    const sc = window.__game.scene.keys.RingScene;
    window.__config.healthDamagePerForce = 0;   // no knockdowns mid-section
    window.__chips = [];
    const orig = sc.dummy.receiveStaminaChip.bind(sc.dummy);
    sc.dummy.receiveStaminaChip = (force, blocked) => {
      window.__chips.push({ force, blocked });
      return orig(force, blocked);
    };
  });

  // Land one punch and report the stamina delta it cost.
  async function chipCase({ key = 'KeyM', dist = 55, guard = null, perfectWindow = 0 } = {}) {
    await pinAt(page, dist);
    await page.evaluate(g => {
      const sc = window.__game.scene.keys.RingScene;
      sc.dummy.stamina = 100;
      sc.dummy._hitRegenDelay = 0;
      sc.dummy.blockTimer = 0; sc.dummy.isBlocking = false; sc.dummy.blockHeldTime = Infinity;
      if (g) {
        // Raise the guard NOW, on the press frame. Whether that counts as a
        // perfect block is decided by perfectBlockWindow, which each case sets
        // explicitly — so the branch under test is chosen deterministically
        // rather than by whether the ~90 ms flight beat a 0.12 s clock.
        sc.dummy.blockTimer = 2.0;
        sc.dummy.isBlocking = true;
        sc.dummy.blockHeldTime = 0;
      }
      window.__chips.length = 0;
    }, guard);
    await page.evaluate(w => { window.__config.perfectBlockWindow = w; }, perfectWindow);
    await page.keyboard.down(key);
    await page.waitForTimeout(70);
    await page.keyboard.up(key);
    await page.waitForTimeout(280);
    return page.evaluate(() => ({
      chips:   window.__chips.slice(),
      stamina: window.__game.scene.keys.RingScene.dummy.stamina,
      delay:   window.__game.scene.keys.RingScene.dummy._hitRegenDelay,
    }));
  }

  const clean = await chipCase();
  check('an unblocked hit costs stamina, scaled off the shared force value',
    clean.chips.length === 1 && clean.stamina < 100 &&
    Math.abs((100 - clean.stamina) - clean.chips[0].force * cfg.perHitForce) < 0.5,
    `force ${clean.chips[0]?.force.toFixed(0)} × ${cfg.perHitForce} = ` +
    `${(clean.chips[0]?.force * cfg.perHitForce).toFixed(2)}, stamina 100 → ${clean.stamina.toFixed(2)}`);

  const blocked = await chipCase({ guard: true, perfectWindow: 0 });
  check('a blocked hit costs less — blockReduction has already cut the force',
    blocked.chips.length === 1 && blocked.chips[0].blocked &&
    blocked.chips[0].force < clean.chips[0].force,
    `clean force ${clean.chips[0]?.force.toFixed(0)} → blocked ${blocked.chips[0]?.force.toFixed(0)} ` +
    `(stamina cost ${(100 - clean.stamina).toFixed(2)} → ${(100 - blocked.stamina).toFixed(2)}, ` +
    `blocked mult ${cfg.blockedMult})`);

  const perfect = await chipCase({ guard: true, perfectWindow: 0.5 });
  // Asserted on the chip and the regen pause, NOT on stamina landing exactly at
  // 100: the guard is held throughout these cases and staminaDrainPerSecondBlocking
  // keeps draining it (~0.7 over the case), which is the pre-existing continuous
  // block cost and is deliberately not waived.
  check('a PERFECT block waives the chip entirely — and its regen pause with it',
    perfect.chips.length === 0 && perfect.delay === 0,
    `${perfect.chips.length} chips applied, regen delay ${perfect.delay.toFixed(2)}s ` +
    `(a normal blocked hit costs ${(100 - blocked.stamina).toFixed(2)} stamina); ` +
    `residual ${(100 - perfect.stamina).toFixed(2)} is the continuous guard drain, not a chip`);

  // Regen suppression. Without it the chip is close to a no-op: at
  // staminaRegenPerSecond 20 a worst-case ~6-point chip is repaid in ~300 ms.
  await chipCase();
  const t0 = await page.evaluate(() => ({
    s: window.__game.scene.keys.RingScene.dummy.stamina,
    d: window.__game.scene.keys.RingScene.dummy._hitRegenDelay,
  }));
  await page.waitForTimeout(140);
  const during = await page.evaluate(() => window.__game.scene.keys.RingScene.dummy.stamina);
  await page.waitForTimeout(1200);
  const after  = await page.evaluate(() => window.__game.scene.keys.RingScene.dummy.stamina);
  check('regen is suppressed for staminaRegenDelayAfterHit, then resumes',
    during <= t0.s + 0.01 && after > during + 1,
    `${cfg.regenDelay}s delay: ${t0.s.toFixed(2)} → ${during.toFixed(2)} still suppressed ` +
    `(${t0.d.toFixed(2)}s left at sample) → ${after.toFixed(2)} once it lapsed`);

  // ── Spiral check ────────────────────────────────────────────────────────
  // Chip damage can now push a fighter into the lowStaminaThreshold telegraph
  // mid-exchange, which is intended. What must NOT happen is a runaway: being
  // hit once making the next hit a near-certainty because the telegraph slowed
  // your punches, which draws more hits, which drains more stamina.
  //
  // The guard against that is arithmetic, not a special case — one worst-case
  // chip has to be small next to the distance from full stamina down to the
  // threshold, so getting clipped once costs a fraction of the gap rather than
  // crossing it. MEASURED separately: 8 unanswered clean uppercuts take a
  // fighter from 100 to 62.8, never reaching 25.
  const worst = await page.evaluate(() => {
    const c = window.__config;
    // The heaviest force this build produces: an advancing uppercut countering a
    // fully-exposed target. Momentum + per-punch damage + counter bonus.
    const force = (c.punchForceBase + c.playerMass * c.punchMomentumScale)
                  * c.uppercutDamage * (1 + c.counterForceBonus);
    return {
      force,
      chip: force * c.staminaDrainPerHitForce,
      gap:  c.staminaMax - c.lowStaminaThreshold,
      repayS: (force * c.staminaDrainPerHitForce) / c.staminaRegenPerSecond,
      delay: c.staminaRegenDelayAfterHit,
    };
  });
  check('one worst-case hit cannot push a healthy fighter into the low-stamina telegraph',
    worst.chip < worst.gap / 4,
    `heaviest chip ${worst.chip.toFixed(1)} vs ${worst.gap} of headroom above the threshold ` +
    `(${(worst.gap / worst.chip).toFixed(1)} such hits would be needed), ` +
    `and it is repaid ${worst.repayS.toFixed(2)}s after the ${worst.delay}s pause lapses`);

  // Getting hit at 0 stamina must clamp, not go negative and not throw.
  const zero = await page.evaluate(() => {
    const d = window.__game.scene.keys.RingScene.dummy;
    d.stamina = 0;
    d.receiveStaminaChip(9999, false);
    return d.stamina;
  });
  check('getting hit at 0 stamina clamps rather than erroring', zero === 0, `stamina ${zero}`);

  // Symmetry — the player pays it too, from the dummy's own jab. Mirrored on
  // Fighter rather than shared through a base class, per the existing convention.
  const mirrored = await page.evaluate(async () => {
    const sc = window.__game.scene.keys.RingScene;
    sc.fighter.stamina = 100;
    sc.fighter._hitRegenDelay = 0;
    window.__config.staminaRegenPerSecond = 0;   // isolate the chip from regen
    const before = sc.fighter.stamina;
    sc.dummy._loco.x = sc.fighter.x + 60;
    sc.dummy._loco.y = sc.fighter.y;
    sc.dummy.forceAttack();
    await new Promise(r => setTimeout(r, 1400));
    return { before, after: sc.fighter.stamina, delay: sc.fighter._hitRegenDelay };
  });
  check('the player pays the same chip from the dummy\'s punches (mirrored, not inherited)',
    mirrored.after < mirrored.before,
    `player stamina ${mirrored.before.toFixed(2)} → ${mirrored.after.toFixed(2)}`);

  await page.screenshot({ path: 'scripts/output/stamina_chip.png' });
  await page.close();
}

await browser.close();

// ─── Report ──────────────────────────────────────────────────────────────────
// This file used to be screenshots-only: it collected page errors and then never
// looked at them, and always exited 0. Both are reported now, so a regression in
// here actually fails the suite instead of being found by eye.
const failed = results.filter(r => !r.pass);
console.log('\nScreenshots → scripts/output/');
console.log('Page errors:', errors.length ? errors : 'none');
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.label}`));
  process.exit(1);
}

console.log('Page errors:', errors.length ? errors : 'none');
console.log('Screenshots saved to scripts/output/');
