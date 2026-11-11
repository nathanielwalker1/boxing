/**
 * gpu_check.mjs — the frame a DESKTOP browser gets (overhaul 2026-11-11).
 *
 * Every other browser check runs on headless software GL, which the game
 * treats as a low-tier device: no post pass, no MSAA. So the high tier was
 * never looked at by a test, and it shipped black (MSAA on the post target).
 * This check launches Chromium on the real GPU where there is one, loads the
 * menu and the fight, and asserts the 3D frame is actually lit.
 *
 * On a machine with no GPU Chromium falls back to software and the game picks
 * the low tier; the check then only proves the low tier is lit, and says so.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { check, done } from './check.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });
const MIN_BRIGHTNESS = 25;   // mean of 0..255 over the frame; the black frame measured 4 (fight) and 14 (menu, the DOM lit), a lit one 52–62

const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const logs = [];

async function look(query, label) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(`[${label}] ${m.text()}`); });
  page.on('pageerror', e => logs.push(`[${label}] ${e.message}`));
  await page.goto(`${DEV_URL}/${query}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(() => window.__tick && window.__tick.frames > 30, null, { timeout: 120_000 });
  const info = await page.evaluate(() => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown', tier: window.__show?.info?.().tier ?? null, post: window.__cfg.postEnabled, msaa: window.__cfg.postMsaa };
  });
  const file = `${OUT}/gpu_${label}.png`;
  const buf = await page.screenshot({ path: file });
  const mean = await page.evaluate(async (b64) => {
    const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 320, 180);
    const d = g.getImageData(0, 0, 320, 180).data; let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s / (d.length / 4 * 3);
  }, buf.toString('base64'));
  await page.close();
  return { info, mean, file };
}

const fight = await look('?menu=0', 'fight');
const software = /swiftshader|llvmpipe|software/i.test(fight.info.renderer);
console.log(`     renderer: ${fight.info.renderer}${software ? '  (software: this run only proves the LOW tier)' : ''}`);
check(`the fight is lit with the default config (mean brightness ${fight.mean.toFixed(1)} > ${MIN_BRIGHTNESS}; post ${fight.info.post}, MSAA ${fight.info.msaa})`, fight.mean > MIN_BRIGHTNESS, fight.file);
const menu = await look('?menu=1', 'menu');
check(`the title's ring is lit behind the menu (mean brightness ${menu.mean.toFixed(1)} > ${MIN_BRIGHTNESS})`, menu.mean > MIN_BRIGHTNESS, menu.file);
check(`console clean (${logs.length} error/warning)`, logs.length === 0, logs.slice(0, 5).join(' | '));
await browser.close();
done();
