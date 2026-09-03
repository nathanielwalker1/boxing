/**
 * verify.mjs — headless screenshot + greyscale sibling + console capture + fps.
 *   node scripts/verify.mjs            (PORT honoured; run_tests starts a server)
 * Fails on any console error or warning. Prints the fps overlay's sample —
 * headless GL is not the desktop number, so fps is reported, not asserted.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';
import { greyscaleCopy } from './greyscale.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));

await page.goto(`${DEV_URL}/?tune=1`, { waitUntil: 'networkidle', timeout: 15_000 });
await bootReady(page, { frames: 10 });
await page.evaluate(() => { window.__cfg.debugHitboxes = true; });
await frames(page, 70);   // one full fps window so __fps is populated

const shot = `${OUT}/screenshot.png`;
await page.screenshot({ path: shot });
writeFileSync(`${OUT}/console.json`, JSON.stringify(logs, null, 2));
const grey = await greyscaleCopy(page, shot);
const fps = await page.evaluate(() => window.__fps);
const panel = await page.evaluate(() => document.querySelectorAll('.lil-gui .controller').length);
await browser.close();

console.log(`Screenshot → ${shot}\nGreyscale  → ${grey}`);
console.log(`fps (headless) → ${fps ? `${fps.fps} fps, ${fps.msAvg} ms avg, ${fps.calls} calls, ${fps.tris} tris` : 'no sample'}`);
console.log(`tuning panel controllers → ${panel}`);
logs.forEach(m => console.log(`  [${m.type.padEnd(9)}] ${m.text}`));

// Headless Chromium's software GL emits "GPU stall due to ReadPixels" on every
// screenshot. It is the capture, not the app — the one warning that is ignored.
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
if (!panel) { console.error('FAILED — tuning panel has no controllers.'); process.exit(1); }
console.log('PASS — console clean, panel mounted.');
