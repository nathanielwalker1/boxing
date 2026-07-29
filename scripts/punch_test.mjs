/**
 * punch_test.mjs — verify all three range states and hook hand selection.
 * Run with: node scripts/punch_test.mjs
 * Dev server must be running on localhost:5173.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1500);

// ── 1. WHIFF — punch from starting position (340 px apart, > rangeMax 220) ──
await page.keyboard.press('J');
await page.waitForTimeout(350);
await page.screenshot({ path: 'scripts/output/punch_whiff.png' });

// ── 2. Move toward dummy then LAND punch ─────────────────────────────────────
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1200);          // close the gap
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(200);
await page.keyboard.press('J');           // jab — should LAND
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/output/punch_land.png' });

// ── 3. Get very close → SMOTHER a jab ───────────────────────────────────────
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(1500);          // walk into smother distance
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(200);
await page.keyboard.press('J');           // jab — should SMOTHER
await page.waitForTimeout(350);
await page.screenshot({ path: 'scripts/output/punch_smother.png' });

// ── 4. Hook at smother distance → should LAND (hooks work at close range) ───
await page.keyboard.press('I');           // hook
await page.waitForTimeout(350);
await page.screenshot({ path: 'scripts/output/punch_hook_close.png' });

// ── 5. Back up to mid-range, hook left vs hook right ────────────────────────
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(800);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(200);

// Hook while holding left → left hand (lead arm should extend)
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(100);
await page.keyboard.press('I');
await page.waitForTimeout(300);
await page.keyboard.up('ArrowLeft');
await page.screenshot({ path: 'scripts/output/punch_hook_left.png' });

// Hook while holding right → right hand (rear arm should extend)
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(100);
await page.keyboard.press('I');
await page.waitForTimeout(300);
await page.keyboard.up('ArrowRight');
await page.screenshot({ path: 'scripts/output/punch_hook_right.png' });

await browser.close();

console.log('Page errors:', errors.length ? errors : 'none');
console.log('Screenshots saved to scripts/output/');
