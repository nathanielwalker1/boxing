import { chromium } from 'playwright';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1500);

// Hold RIGHT — fighter should hit the right rope wall and stop there
await page.keyboard.down('ArrowRight');
await page.waitForTimeout(3000);
await page.keyboard.up('ArrowRight');
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/output/boundary_right.png' });

// Hold LEFT — cross from right wall to left wall
await page.keyboard.down('ArrowLeft');
await page.waitForTimeout(5000);
await page.keyboard.up('ArrowLeft');
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/output/boundary_left.png' });

// Hold UP — top rope
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(3000);
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/output/boundary_top.png' });

// Hold DOWN — bottom rope
await page.keyboard.down('ArrowDown');
await page.waitForTimeout(4000);
await page.keyboard.up('ArrowDown');
await page.waitForTimeout(400);
await page.screenshot({ path: 'scripts/output/boundary_bottom.png' });

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Boundary screenshots saved.');
