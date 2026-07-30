import { chromium } from 'playwright';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
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

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Facing test screenshots saved to scripts/output/facing_*.png');
