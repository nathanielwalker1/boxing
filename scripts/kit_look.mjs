/**
 * kit_look.mjs: stills of the proof page (human.html) for body / kit / hair work. One page, any query, chosen shots.
 *   PORT=5210 node scripts/kit_look.mjs <tag> "<query>" <role:frame:camera,...>
 *   e.g. node scripts/kit_look.mjs hair_m3 "v=m3&hair=h1&hair2=h1" idle:0:3,idle:0:5,lead_hook:contact:c
 * Cameras are the proof page's presets (1 play, 2 side, 3 upper body, 5 scalp, 7 / 8 faces, c d e f g close-ups).
 * Writes scripts/output/<tag>_<role>_<camera>.png (never committed) and prints the console verdict.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });
const [tag = 'look', query = '', shotArg = 'idle:0:1'] = process.argv.slice(2);
const shots = shotArg.split(',').map(s => s.split(':'));
const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/human.html${query ? '?' + query : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await until(page, () => window.__human && window.__human.ready, undefined, { label: 'boxer loaded', timeout: 280_000 });
// the proof page has no game clock (waits.js frames() needs one): wait on its own animation frames
const raf = n => page.evaluate(k => new Promise(r => { let i = 0; const f = () => (++i >= k ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
for (const [role, frame = '0', cam = '1'] of shots) {
  await page.evaluate(([r, f, k]) => window.__human.clip(r, f).then(() => window.__human.preset(k)), [role, frame, cam]);
  await raf(8);
  const path = `${OUT}/${tag}_${role}_${cam}.png`;
  await page.screenshot({ path, timeout: 120_000 });
  console.log(path);
}
await browser.close();
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => ['error', 'pageerror', 'warning'].includes(m.type) && !benign(m.text));
console.log(bad.length ? `console problems: ${bad.length}\n${bad.slice(0, 5).map(m => m.text).join('\n')}` : 'console clean');
