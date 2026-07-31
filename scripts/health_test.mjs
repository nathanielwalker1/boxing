/**
 * health_test.mjs — verify health/stamina bars, low-stamina telegraph, and
 * knockdown/recovery (Stage 6).
 * Run with: node scripts/health_test.mjs
 * Dev server must be running on localhost:5173.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const errors  = [];

async function setGuiNumber(page, label, value) {
  const input = page.locator('.controller', { hasText: label }).locator('input[type=text]');
  await input.fill(String(value));
  await input.press('Enter');
}

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
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

await browser.close();

console.log('Page errors:', errors.length ? errors : 'none');
console.log('Screenshots saved to scripts/output/');
