/**
 * verify.js — headless screenshot + console capture for the dev server.
 * Usage: node scripts/verify.js
 * Requires the dev server to already be running (npm run dev).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, 'output');
mkdirSync(OUT, { recursive: true });

const URL = DEV_URL;

console.log(`Connecting to ${URL} …`);

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const consoleLogs = [];
page.on('console', msg => {
  consoleLogs.push({ type: msg.type(), text: msg.text() });
});
page.on('pageerror', err => {
  consoleLogs.push({ type: 'pageerror', text: err.message });
});

await page.goto(URL, { waitUntil: 'networkidle', timeout: 15_000 });

// Give Phaser time to initialise and paint at least one frame
await page.waitForTimeout(2500);

const screenshotPath = `${OUT}/screenshot.png`;
const consolePath    = `${OUT}/console.json`;

await page.screenshot({ path: screenshotPath, fullPage: false });
writeFileSync(consolePath, JSON.stringify(consoleLogs, null, 2));

await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\nScreenshot → ${screenshotPath}`);
console.log(`Console log → ${consolePath}\n`);

const errors = consoleLogs.filter(m => m.type === 'error' || m.type === 'pageerror');
const warns  = consoleLogs.filter(m => m.type === 'warning');

if (consoleLogs.length === 0) {
  console.log('Console: (empty — no messages)');
} else {
  consoleLogs.forEach(m => console.log(`  [${m.type.padEnd(9)}] ${m.text}`));
}

console.log('');
if (errors.length > 0) {
  console.error(`FAILED — ${errors.length} console error(s) detected.`);
  process.exit(1);
} else if (warns.length > 0) {
  console.warn(`WARN — ${warns.length} console warning(s) (non-fatal).`);
} else {
  console.log('PASS — no errors or warnings in console.');
}
