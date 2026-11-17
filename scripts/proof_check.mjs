/**
 * proof_check.mjs — the mocap proof page (proof.html): for each beat of the scripted exchange, 6 frames across
 * the beat from the play camera and 6 side-on, as one sheet per beat, plus full-size frames at each contact.
 * Seeks through window.__proofSeek (deterministic), never sleeps. Fails on any console error / warning.
 *   PORT=5195 node scripts/proof_check.mjs   -> scripts/output/proof/
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'proof');
mkdirSync(OUT, { recursive: true });
const BEATS = ['idle', 'jab', 'cross', 'hook', 'block', 'mirror_jab', 'mirror_cross', 'mirror_hook', 'mirror_block'];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/proof.html?t=0`, { waitUntil: 'networkidle', timeout: 30_000 });
try {
  await until(page, () => window.__proof && window.__proof.ready, undefined, { label: 'proof loaded', timeout: 120_000 });
} catch (e) {
  console.error(e.message);
  logs.forEach(m => console.error(`  [${m.type}] ${m.text}`));
  await browser.close();
  process.exit(1);
}
const info = await page.evaluate(() => ({ beats: window.__proof.beats, gap: window.__proof.gap, total: window.__proof.total, roles: window.__proof.roles }));
console.log(`gap ${info.gap.toFixed(3)} m, loop ${info.total.toFixed(2)} s; beats: ${info.beats.map(b => `${b.name} ${b.start.toFixed(2)}-${b.end.toFixed(2)}`).join(', ')}`);

const shot = async (cam, t, opts = {}) => {
  await page.evaluate(([k, s]) => { window.__proof.camera(k); window.__proofSeek(s); }, [cam, t]);
  return page.screenshot({ type: 'png', ...opts });
};
const sheet = await browser.newPage({ viewport: { width: 6 * 320, height: 2 * 200 + 40 } });
const written = [];
for (const name of BEATS) {
  const b = info.beats.find(x => x.name === name);
  if (!b) { console.log(`beat ${name}: not in the script (role missing)`); continue; }
  const times = Array.from({ length: 6 }, (_, i) => b.start + ((b.end - b.start) * i) / 5);
  const imgs = [];
  for (const cam of ['1', '2']) for (const t of times) imgs.push({ cam, t, src: 'data:image/png;base64,' + (await shot(cam, t)).toString('base64') });
  await sheet.setContent(`<body style="margin:0;background:#111;color:#ddd;font:12px monospace">
    <div style="height:40px;padding:4px">${name}: ${b.start.toFixed(2)}-${b.end.toFixed(2)} s, contact ${b.contact.toFixed(2)} s. Top: play camera, bottom: side-on</div>
    <div style="display:grid;grid-template-columns:repeat(6,320px)">${imgs.map(i => `<div style="position:relative"><img src="${i.src}" style="width:320px;height:200px;display:block"><span style="position:absolute;left:3px;top:2px">${i.t.toFixed(2)}</span></div>`).join('')}</div></body>`);
  await sheet.waitForFunction(() => [...document.images].every(i => i.complete));
  const p = `${OUT}/beat_${name}.png`;
  await sheet.screenshot({ path: p });
  written.push(p);
  if (name !== 'idle') for (const cam of ['1', '2']) {
    const fp = `${OUT}/contact_${name}_cam${cam}.png`;
    await shot(cam, b.contact, { path: fp });
    written.push(fp);
  }
}
// fps: let it play on the play camera for a measured second
await page.evaluate(() => { window.__proof.camera('1'); window.__proof.play(); });
await until(page, () => window.__proof.fps > 0, undefined, { label: 'fps measured', timeout: 60_000 });
const fps = await page.evaluate(() => window.__proof.fps);
writeFileSync(`${OUT}/console.json`, JSON.stringify(logs, null, 2));
await browser.close();

console.log(written.join('\n'));
console.log(`fps (headless software GL, not the desktop number) → ${fps}`);
logs.forEach(m => console.log(`  [${m.type.padEnd(9)}] ${m.text}`));
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
if (bad.length) { console.error(`FAILED — ${bad.length} console error(s)/warning(s).`); process.exit(1); }
console.log('PASS — console clean.');
