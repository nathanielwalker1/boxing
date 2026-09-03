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
// deviceScaleFactor 2: a Retina display is the common case on Nate's machine and
// a canvas sized in device pixels without a CSS size shows a quarter of the frame.
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));

await page.goto(`${DEV_URL}/?tune=1`, { waitUntil: 'networkidle', timeout: 15_000 });
await bootReady(page, { frames: 10 });
await page.evaluate(() => { window.__cfg.debugHitboxes = true; });
// Headless software GL at 2× runs at a few fps, so this is a render check, not
// an fps check — the fps line below is printed only if a 60-frame window landed.
await frames(page, 20);

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
