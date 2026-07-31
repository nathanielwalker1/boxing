import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

async function freshLoad() {
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1200);
}

// ── 1. Idle pose baseline ────────────────────────────────────────────────────
await freshLoad();
await page.screenshot({ path: 'scripts/output/block_01_idle.png' });

// ── 2. Block engage — should read as guard pose almost immediately ─────────
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(120);
await page.screenshot({ path: 'scripts/output/block_02_engaged.png' });

// ── 3. Block disengage — should snap back to idle immediately ──────────────
await page.keyboard.up('ShiftLeft');
await page.waitForTimeout(80);
await page.screenshot({ path: 'scripts/output/block_03_disengaged.png' });

// ── 4. Block-then-punch: hold block, try to punch — should NOT punch ───────
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(100);
await page.keyboard.press('j');   // jab while blocking
await page.waitForTimeout(80);
await page.screenshot({ path: 'scripts/output/block_04_punch_blocked.png' });
await page.keyboard.up('ShiftLeft');
await page.waitForTimeout(80);

// ── 5. Release-then-punch: releasing block allows an immediate punch ───────
await page.keyboard.press('j');
await page.waitForTimeout(60);   // mid punch-duration (punchDuration default 150ms)
await page.screenshot({ path: 'scripts/output/block_05_punch_after_release.png' });
await page.waitForTimeout(200);

// ── 6. Punch-then-block: punch, immediately hold block — punch should
//    finish its animation before guard engages ─────────────────────────────
await page.keyboard.press('j');
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(40);    // early in punch window — should still be punching, not guarding
await page.screenshot({ path: 'scripts/output/block_06a_punch_finishing.png' });
await page.waitForTimeout(160);   // past punchDuration — guard should now be engaged
await page.screenshot({ path: 'scripts/output/block_06b_guard_after_punch.png' });
await page.keyboard.up('ShiftLeft');
await page.waitForTimeout(80);

// ── 7. Debug test-punch WITHOUT block — dummy hits player, full stagger ────
await freshLoad();
await page.screenshot({ path: 'scripts/output/block_07a_before_hit_unblocked.png' });
await page.keyboard.down('t');
await page.waitForTimeout(30);
await page.keyboard.up('t');
await page.waitForTimeout(100);
await page.screenshot({ path: 'scripts/output/block_07b_after_hit_unblocked.png' });

// ── 8. Debug test-punch WHILE blocking — reduced stagger ───────────────────
await freshLoad();
await page.screenshot({ path: 'scripts/output/block_08a_before_hit_blocked.png' });
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(100);   // let block fully engage first
await page.keyboard.down('t');
await page.waitForTimeout(30);
await page.keyboard.up('t');
await page.waitForTimeout(100);
await page.screenshot({ path: 'scripts/output/block_08b_after_hit_blocked.png' });
await page.keyboard.up('ShiftLeft');

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Block test screenshots saved to scripts/output/block_*.png');
