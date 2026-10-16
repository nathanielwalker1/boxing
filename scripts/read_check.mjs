/**
 * read_check.mjs — the slip / counter READ (src/ui/read.ts + the rig's warm
 * rim) in the real app. A tick-exact script (window.__sim.script) has the
 * dummy jab and the player flick away from it, then cross into the window:
 *   - the slip takes the jab away → the dummy's rim warms (glow[1] up) while
 *     its counterWindow runs; the player's does not
 *   - the cross lands as a counter (the only kind there is: inside a slip's window)
 *   - the glow is gone once the window closes; readEnabled 0 shows nothing
 *   - nothing is drawn on the screen itself: no overlay elements exist
 * Screenshot (+ greyscale) of the window → scripts/output/read_window.png.
 * Console must be clean.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, gameTime } from './waits.js';
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

const probe = () => page.evaluate(() => window.__read());
const oppWindow = () => page.evaluate(() => window.__sim.state().fighters[1].counterWindow);

/** The exchange: dummy jabs on tick 0; the player flicks away from its lead hand (ticks 0–1, released on 2) and crosses on tick `crossAt`. */
const exchange = (crossAt) => page.evaluate(({ crossAt }) => {
  window.__sim.place(0.79);
  window.__sim.script(1, [{ jab: true }]);
  const s0 = [];
  for (let i = 0; i < crossAt + 1; i++) s0.push(i < 2 ? { move: { x: -1, y: 0 } } : i === crossAt ? { cross: true } : {});
  window.__sim.script(0, s0);
}, { crossAt });

// ── 1. The slip and the window ───────────────────────────────────────────────
await exchange(12);
const slipped = await until(page, () => window.__read().log.includes('slip0'), undefined, { label: 'the slip', timeout: 8000 }).then(() => true, () => false);
const p1 = await probe();
const w1 = await oppWindow();
check('the flick takes the dummy\'s jab away', slipped, `log ${JSON.stringify(p1.log)}`);
check(`the counter window is open on the dummy (${w1.toFixed(2)} s) and ITS rim warms (glow ${p1.glow[1].toFixed(2)}), not the player's (${p1.glow[0].toFixed(2)})`, w1 > 0 && p1.glow[1] > 0.3 && p1.glow[0] === 0);
check('nothing is drawn on the screen: no overlay elements', await page.evaluate(() => !document.getElementById('read-flash') && !document.getElementById('read-glow') && !document.getElementById('read-tag')));
const shot1 = `${OUT}/read_window.png`;
await page.screenshot({ path: shot1 });
console.log(`     window → ${shot1}\n              ${await greyscaleCopy(page, shot1)}`);

// ── 2. The counter ───────────────────────────────────────────────────────────
const countered = await until(page, () => window.__read().log.includes('counter0'), undefined, { label: 'the counter', timeout: 8000 }).then(() => true, () => false);
const p2 = await probe();
// (A counter at ×1.9 clears the dummy's stun threshold, so 'rocked1' follows — sim/stun.ts, 2026-10-15.)
check('the cross into the window lands as a counter, after the slip', countered && p2.log.slice(0, 2).join('>') === 'slip0>counter0', `log ${JSON.stringify(p2.log)}`);

// ── 3. The window closes ─────────────────────────────────────────────────────
await until(page, () => window.__sim.state().fighters[1].counterWindow === 0 && window.__read().glow[1] === 0, undefined, { label: 'window closed', timeout: 8000 });
const p3 = await probe();
check('once the window closes the rim is back to normal (glow 0 both sides)', p3.glow[0] === 0 && p3.glow[1] === 0);

// ── 4. Off switch ────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__cfg.readEnabled = false; });
await exchange(12);
await until(page, () => window.__read().log.filter(l => l === 'slip0').length >= 2, undefined, { label: 'second slip', timeout: 8000 });
const p4 = await probe();
await gameTime(page, 1.0);
check('readEnabled 0: the same slip warms nothing', p4.glow[0] === 0 && p4.glow[1] === 0, `glow ${p4.glow.join(',')}`);

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
