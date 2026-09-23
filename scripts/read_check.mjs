/**
 * read_check.mjs — the slip / counter READ (src/ui/read.ts) in the real app.
 * A tick-exact script (window.__sim.script) has the dummy jab and the player
 * flick away from it, then cross into the counter window:
 *   - the slip takes the jab away → SLIPPED tag, a white wash, the amber edge
 *     glow up while the opponent's counterWindow runs
 *   - the cross lands as a counter → COUNTER! tag, the bigger wash
 *   - the glow is gone once the window closes; readEnabled 0 shows nothing
 * Screenshots (+ greyscale) of the window and of the counter flash go to
 * scripts/output/read_*.png. Console must be clean.
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
const slipped = await until(page, () => window.__read().tag === 'SLIPPED', undefined, { label: 'SLIPPED tag', timeout: 8000 }).then(() => true, () => false);
const p1 = await probe();
const w1 = await oppWindow();
check('the flick takes the dummy\'s jab away: SLIPPED is popped', slipped && p1.log.includes('SLIPPED'), `log ${JSON.stringify(p1.log)}, state ${JSON.stringify(await page.evaluate(() => { const s = window.__sim.state(); return { d: Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z), slip: s.fighters[0].slip, p1: s.fighters[1].punch.type }; }))}`);
check(`the white wash is up on the slip (alpha ${p1.flash.toFixed(3)})`, p1.flash > 0.02);
check(`the counter window is open on the opponent (${w1.toFixed(2)} s) and the edge glow reads it (${p1.glow.toFixed(2)})`, w1 > 0 && p1.glow > 0.3);
const shot1 = `${OUT}/read_window.png`;
await page.screenshot({ path: shot1 });
console.log(`     window → ${shot1}\n              ${await greyscaleCopy(page, shot1)}`);

// ── 2. The counter ───────────────────────────────────────────────────────────
const countered = await until(page, () => window.__read().tag === 'COUNTER!', undefined, { label: 'COUNTER! tag', timeout: 8000 }).then(() => true, () => false);
const p2 = await probe();
check('the cross into the window lands as a counter: COUNTER! is popped after SLIPPED', countered && p2.log.join('>') === 'SLIPPED>COUNTER!', `log ${JSON.stringify(p2.log)}`);
// (Asked-for alphas, not the live value: a headless frame outlasts the decay.)
check(`the counter wash is the bigger one (asked ${p2.alphas[1]} vs the slip's ${p2.alphas[0]})`, p2.alphas.length === 2 && p2.alphas[1] > p2.alphas[0]);
const shot2 = `${OUT}/read_counter.png`;
await page.screenshot({ path: shot2 });
console.log(`     counter → ${shot2}\n               ${await greyscaleCopy(page, shot2)}`);

// ── 3. The window closes ─────────────────────────────────────────────────────
await until(page, () => window.__sim.state().fighters[1].counterWindow === 0 && window.__read().glow === 0, undefined, { label: 'window closed', timeout: 8000 });
const p3 = await probe();
const hidden = await page.evaluate(() => ['read-flash', 'read-glow', 'read-tag'].map(id => getComputedStyle(document.getElementById(id)).display));
await gameTime(page, 0.8);
check('once the window closes the glow is 0 and every layer is display:none', p3.glow === 0 && (await page.evaluate(() => ['read-flash', 'read-glow', 'read-tag'].map(id => getComputedStyle(document.getElementById(id)).display))).every(d => d === 'none'), `${hidden.join(',')}`);

// ── 4. Off switch ────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__cfg.readEnabled = false; });
const before = (await probe()).log.length;
await exchange(12);
await gameTime(page, 1.2);
const p4 = await probe();
check('readEnabled 0: the same exchange pops nothing and draws nothing', p4.log.length === before && p4.flash === 0 && p4.glow === 0 && p4.tag === '', `log ${p4.log.length} vs ${before}`);

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
