/**
 * slip_test.mjs — verify flick-vs-hold detection and slip whiff behavior.
 * Run with: node scripts/slip_test.mjs
 * Dev server must be running on localhost:5173.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(500);

// The dummy's FIRST attack timer is randomly drawn once at construction time,
// using the default 1.5-3.5s config bounds — before this script ever touches
// the tuning panel. Overriding the sliders can't cancel that already-picked
// number (it only affects the *next* draw, which happens after an attack
// resolves), so we push the bounds out now (via the existing tuning panel,
// same as a human dragging the slider — no source changes) so every
// *subsequent* draw is safely out of the way, then wait out the worst case
// for that first draw (3.5s delay + 0.8s windup) before the deterministic
// part of the test that relies on the T debug key being the only attack.
async function setGuiNumber(label, value) {
  const input = page.locator('.controller', { hasText: label }).locator('input[type=text]');
  await input.fill(String(value));
  await input.press('Enter');
}
await setGuiNumber('Attack Delay Min', 999);
await setGuiNumber('Attack Delay Max', 999);

// Filling the GUI's text input leaves keyboard focus there — click back onto
// the canvas so subsequent keyboard events reach Phaser, not the input.
await page.mouse.click(575, 400);

// Wait out the unavoidable first natural attack (worst case ~4.3s from page
// load); ~700ms has already elapsed above, so this tops it up with margin.
await page.waitForTimeout(4200);

// ── (a) FLICK — quick tap (<180ms) should trigger a visible slip/lean ───────
// Note: page.keyboard.press() sends keydown+keyup fast enough to sometimes
// race Phaser's per-frame JustDown check and get missed entirely (confirmed
// during development with the T key below) — down/wait/up is used
// throughout this script instead for reliability.
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(80);           // well under slipFlickMaxDurationMs (180ms)
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(90);           // mid-window (slipInvincibilityDuration 250ms) — lean visible
await page.screenshot({ path: 'scripts/output/slip_flick.png' });
await page.waitForTimeout(400);          // let the slip window fully resolve back to idle

// ── (b) HOLD — sustained press (>180ms) should produce normal footwork, no slip ─
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(500);          // well past the flick window — confirmed hold
await page.screenshot({ path: 'scripts/output/slip_hold_footwork.png' });
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(200);

// ── (c) Debug test-punch whiffing during an active slip window ─────────────
// Move well into landing range (current rangeMax=100, smotherDist=50; the
// 340px starting gap needs a solid approach to close under rangeMax).
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1900);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(200);

// Force an immediate dummy attack (T = temporary debug key). The dummy's own
// timer is now parked at 6-8s (clamped from 999 by the slider's max), so this
// is the only attack that can fire during this window.
await page.keyboard.down('T');
await page.waitForTimeout(50);
await page.keyboard.up('T');
// dummyWindupDuration=0.8s, impact fires at 0.4s. Flick partway through the
// windup so the 0.25s slip window covers the impact moment.
await page.waitForTimeout(200);
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(80);           // flick (<180ms)
await page.keyboard.up('ArrowDown');
await page.waitForTimeout(150);          // land right around the 400ms impact mark
await page.screenshot({ path: 'scripts/output/slip_whiff_vs_dummy_punch.png' });
await page.waitForTimeout(600);          // let windup/flash fully resolve

await browser.close();

console.log('Page errors:', errors.length ? errors : 'none');
console.log('Screenshots saved to scripts/output/');
