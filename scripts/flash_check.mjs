/**
 * flash_check.mjs — no black flashes (polish run 2026-11-11, item 1).
 *
 * The bug: on a real GPU, with the post pass on, a whole frame went black
 * about every 3 s (one NaN pixel from the light beams' shader, blurred over
 * the frame by the bloom). This check runs 15 s of a scripted fight on the
 * real GPU with the post pass's guard OFF — so it is the source that stays
 * fixed, not just the guard hiding it — samples every frame in the page, and
 * asserts none drops suddenly to black. flash_probe.mjs is the long version.
 *
 * On a machine with no GPU the game picks the low tier (no post pass); the
 * check then proves only that tier, and says so.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { check, done } from './check.js';
import { SAMPLER, BRAWLER } from './flash_probe.mjs';

const SECONDS = 15;
const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(SAMPLER);
await page.goto(`${DEV_URL}/?menu=0`, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForFunction(() => window.__tick && window.__tick.frames > 30, null, { timeout: 120_000 });
const post = await page.evaluate(() => { window.__cfg.postNanGuard = 0; return window.__show.post(); });
await page.evaluate(BRAWLER);
const from = await page.evaluate(() => { window.__flash.on = true; return performance.now(); });
// Frames are what is being sampled, so the wait is on frames drawn (a slow machine draws fewer per second, not fewer in total).
await page.waitForFunction(([t0, s]) => performance.now() - t0 > s * 1000 && window.__flash.n > 200, [from, SECONDS], { timeout: 180_000 });
const r = await page.evaluate(() => {
  const F = window.__flash, s = [...F.means].sort((a, b) => a - b);
  return { n: F.n, flags: F.flags.map(f => ({ frame: f.frame, mean: f.mean, median: f.median, simTime: f.simTime, phase: f.phase })), min: s[0], med: s[s.length >> 1], err: F.err ?? null };
});
await browser.close();
console.log(`     post pass ${post ? 'ON (the desktop tier)' : 'off — software GL: this run only proves the LOW tier'}`);
check(`the sampler ran (${r.n} frames, median brightness ${r.med})`, r.n > 200 && r.err === null, r.err ?? '');
check(`no frame drops suddenly to black with the guard off (darkest frame ${r.min} against a median of ${r.med}; ${r.flags.length} flagged)`, r.flags.length === 0, JSON.stringify(r.flags.slice(0, 3)));
check(`console clean (${logs.length} error/warning)`, logs.length === 0, logs.slice(0, 5).join(' | '));
done();
