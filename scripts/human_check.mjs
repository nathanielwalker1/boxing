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

await page.goto(`${DEV_URL}/human.html`, { waitUntil: 'networkidle', timeout: 30_000 });
try {
  await until(page, () => window.__human && window.__human.ready, undefined, { label: 'boxer loaded', timeout: 120_000 });
} catch (e) {
  console.error(e.message);
  logs.forEach(m => console.error(`  [${m.type}] ${m.text}`));
  await browser.close();
  process.exit(1);
}
const raf = n => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

const shots = {};
for (const [key, name] of [['1', 'human_play'], ['2', 'human_side']]) {
  await page.evaluate(k => window.__human.preset(k), key);
  await raf(6);
  shots[name] = `${OUT}/${name}.png`;
  await page.screenshot({ path: shots[name] });
}
// extra close-ups for inspection (not part of the two required shots)
if (process.env.CLOSE) {
  await page.evaluate(() => window.__human.preset('3'));
  await raf(6);
  await page.screenshot({ path: `${OUT}/human_close.png` });
}
await raf(90);
const info = await page.evaluate(() => ({ fps: window.__human.fps, tris: window.__human.tris }));
writeFileSync(`${OUT}/human_console.json`, JSON.stringify(logs, null, 2));
await browser.close();

console.log(`play camera → ${shots.human_play}\nside-on     → ${shots.human_side}`);
console.log(`fps (headless software GL, not the desktop number) → ${info.fps}; triangles in scene → ${Math.round(info.tris)}`);
logs.forEach(m => console.log(`  [${m.type.padEnd(9)}] ${m.text}`));
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
console.log('PASS — console clean.');
