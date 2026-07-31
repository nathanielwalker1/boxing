import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output/dummy_attack', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

async function freshLoad() {
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);
}

// Default cadence is randomized 1.5–3.5s; poll every 60ms for up to ~4.3s so
// we reliably catch a full windup→impact cycle regardless of the roll.
async function burstUntilStagger(prefix, maxMs, intervalMs) {
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < maxMs) {
    await page.screenshot({ path: `scripts/output/dummy_attack/${prefix}_${String(i).padStart(3, '0')}.png` });
    i++;
    await page.waitForTimeout(intervalMs);
  }
}

// Fighters start ~340px apart, far outside the dummy's engage distance — close
// some of the gap first so it reaches its standoff (and so a punch of its own
// has a chance to land) inside the capture window below. The dummy's own
// movement AI covers the rest, exactly as it would in a real fight.
async function closeDistance() {
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(200);
}

// ── A. Unblocked dummy attack — windup, impact, stagger ─────────────────────
await freshLoad();
await closeDistance();
await burstUntilStagger('unblocked', 4300, 60);

// ── B. Blocked dummy attack — player holds Shift throughout ────────────────
await freshLoad();
await closeDistance();
await page.keyboard.down('ShiftLeft');
await page.waitForTimeout(150);   // let block fully engage before the attack fires
await burstUntilStagger('blocked', 4300, 60);
await page.keyboard.up('ShiftLeft');

await browser.close();
console.log('Page errors:', errors.length ? errors : 'none');
console.log('Dummy attack screenshots saved to scripts/output/dummy_attack/');
