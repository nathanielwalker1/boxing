/**
 * human_check.mjs — the realistic-boxer proof page (human.html): screenshots of both camera presets,
 * console capture, fps. Render check only. Fails on any console error / warning.
 *   PORT=5195 node scripts/human_check.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));

await page.goto(`${DEV_URL}/human.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
try {
  await until(page, () => window.__human && window.__human.ready, undefined, { label: 'boxer loaded', timeout: 280_000 });
} catch (e) {
  console.error(e.message);
  logs.forEach(m => console.error(`  [${m.type}] ${m.text}`));
  await browser.close();
  process.exit(1);
}
const raf = n => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

// light (red) and dark (blue) skin are in every frame. guard + reach (stress) poses; cameras 1 play,
// 2 side, 3 upper-body close-up of the dark boxer, 4 trunks/boots close-up of the light boxer.
const shots = {};
for (const pose of ['guard', 'reach']) {
  await page.evaluate(p => window.__human.pose(p), pose);
  for (const [key, cam] of [['1', 'play'], ['2', 'side'], ['3', 'upper'], ['4', 'lower'], ...(pose === 'guard' ? [['5', 'head']] : [])]) {
    await page.evaluate(k => window.__human.preset(k), key);
    await raf(6);
    const name = pose === 'guard' && (cam === 'play' || cam === 'side') ? `human_${cam}` : `human_${pose}_${cam}`;
    shots[name] = `${OUT}/${name}.png`;
    await page.screenshot({ path: shots[name] });
  }
}
await raf(90);
const info = await page.evaluate(() => ({ fps: window.__human.fps, tris: window.__human.tris }));
writeFileSync(`${OUT}/human_console.json`, JSON.stringify(logs, null, 2));
await browser.close();

console.log(Object.values(shots).join('\n'));
console.log(`fps (headless software GL, not the desktop number) → ${info.fps}; triangles in scene → ${Math.round(info.tris)}`);
logs.forEach(m => console.log(`  [${m.type.padEnd(9)}] ${m.text}`));
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
console.log('PASS — console clean.');
