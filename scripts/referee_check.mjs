/**
 * referee_check.mjs — the third man (src/ui/referee.ts) and the knockdown
 * shot (render/stage.ts CameraShot, main.ts slow motion) in the real app.
 * The player is placed in range of the frozen-guard dummy with
 * healthDamagePerImpulse 1 (one landed jab floors it, as fight_test does):
 *   - during the round the referee stands off the pair, clear of both, inside the ropes
 *   - the jab floors the dummy → the count; the referee walks to refCountDist
 *     of the fallen man and faces him; the camera drops to camCountElevationDeg
 *     and pushes in; the count ticks arrive
 *   - after the get-up the camera eases back up and the referee backs off
 *   - refEnabled 0 removes him (window.__ref() null)
 * Screenshots (+ greyscale): referee_round.png, referee_count.png.
 * Console must be clean.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames, gameTime } from './waits.js';
import { greyscaleCopy } from './greyscale.js';
import { check, done } from './check.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 15_000 });
await bootReady(page);
const shot = async (name) => { const p = `${OUT}/referee_${name}.png`; await page.screenshot({ path: p }); console.log(`     ${name} → ${p}\n              ${await greyscaleCopy(page, p)}`); };
const probe = () => page.evaluate(() => {
  const s = window.__sim.state(), r = window.__ref();
  const d = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  return r ? { ref: r.pos, yaw: r.yaw, d0: d(r.pos, s.fighters[0].pos), d1: d(r.pos, s.fighters[1].pos), phase: s.round.phase, count: s.round.count, clock: s.round.clock, clock0: window.__clockAtKd ?? s.round.clock, el: window.__camEl() * 180 / Math.PI, dist: window.__camDist(), down: s.fighters[1].down } : null;
});

// ── 1. The round ─────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__sim.place(1.0); });
await gameTime(page, 2.5);   // let him walk to his spot
const p1 = await probe();
check('the referee is on (window.__ref)', p1 !== null);
check(`during the round he stands clear of both fighters (${p1.d0.toFixed(2)} / ${p1.d1.toFixed(2)} m, refClear ${await page.evaluate(() => window.__cfg.refClear)})`, p1.d0 >= 1.6 && p1.d1 >= 1.6);
check(`…inside the ropes (${p1.ref.x.toFixed(2)}, ${p1.ref.z.toFixed(2)})`, Math.abs(p1.ref.x) < 2.9 && Math.abs(p1.ref.z) < 2.9);
check(`…at the ringside elevation (${p1.el.toFixed(1)}°)`, Math.abs(p1.el - 12) < 1);
await shot('round');

// ── 2. The knockdown and the count ───────────────────────────────────────────
await page.evaluate(() => {
  window.__cfg.healthDamagePerImpulse = 1;
  window.__cfg.getUpCountBest = 6; window.__cfg.getUpCountWorst = 6; window.__cfg.getUpJitter = 0;   // a 6-count, deterministic
  window.__counts = 0;
  window.__sim.place(0.9);
  window.__sim.script(0, [{ jab: true }]);
});
await until(page, () => window.__sim.state().round.phase === 'count', undefined, { label: 'the count', timeout: 8000 });
await page.evaluate(() => { window.__clockAtKd = window.__sim.state().round.clock; });
await until(page, () => window.__sim.state().round.count >= 3, undefined, { label: 'count 3', timeout: 15000 });
const p2 = await probe();
check(`the dummy is down and the count is on (count ${p2.count})`, p2.down && p2.phase === 'count');
check(`the referee is at the fallen man (${p2.d1.toFixed(2)} m; refCountDist ${await page.evaluate(() => window.__cfg.refCountDist)})`, p2.d1 > 1.4 && p2.d1 < 2.6);
check(`the round clock keeps running through the count (${p2.clock0.toFixed(2)} → ${p2.clock.toFixed(2)})`, p2.clock < p2.clock0 - 0.5);
const facing = await page.evaluate(() => { const s = window.__sim.state(), r = window.__ref(); const dx = s.fighters[1].pos.x - r.pos.x, dz = s.fighters[1].pos.z - r.pos.z; return (Math.cos(r.yaw) * dx + Math.sin(r.yaw) * dz) / Math.hypot(dx, dz); });
check(`…and faces him (cos ${facing.toFixed(2)})`, facing > 0.8);
check(`the camera has dropped to the count (${p2.el.toFixed(1)}°, camCountElevationDeg ${await page.evaluate(() => window.__cfg.camCountElevationDeg)}) and pushed in (${p2.dist.toFixed(2)} m)`, p2.el < 8 && p2.dist < 4.6);
await shot('count');

// ── 3. The get-up ────────────────────────────────────────────────────────────
await until(page, () => window.__sim.state().round.phase === 'fighting' && !window.__sim.state().fighters[1].down, undefined, { label: 'the get-up', timeout: 15000 });
await gameTime(page, 3);
const p3 = await probe();
check(`after the get-up the camera eases back up (${p3.el.toFixed(1)}°) and the referee backs off (${p3.d1.toFixed(2)} m)`, p3.el > 9 && p3.d1 >= 1.6);

// ── 4. Off switch ────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__cfg.refEnabled = false; });
await frames(page, 3);
check('refEnabled 0 removes him', (await page.evaluate(() => window.__ref())) === null);

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
