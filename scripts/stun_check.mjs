/**
 * stun_check.mjs — the ROCKED reads (ui/read.ts, rig wobble, HUD ghost bar,
 * host slow motion) in the real app, frozen-guard dummy (?ai=0).
 *   - the dummy at low health takes a cross → rocked1 in the read log, the
 *     scene is in slow motion for the beat, his health ghost stays lit
 *   - the player at low health takes the dummy's scripted cross → rocked0,
 *     the red edge is on the frame (opacity > 0, blur set), it fades, and
 *     it is gone once the hurt state clears
 *   - the player's slip opens the window → timeScale = readWindowSlowMo;
 *     closed → 1
 *   - readEnabled 0 shows none of it
 * Screenshots (+ greyscale): stun_dummy.png, stun_player.png. Console clean.
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
await page.evaluate(() => { window.__cfg.healthDamagePerImpulse = 0.00002; window.__cfg.healthRegen = 0; });
const shot = async (name) => { const p = `${OUT}/stun_${name}.png`; await page.screenshot({ path: p }); console.log(`     ${name} → ${p}\n              ${await greyscaleCopy(page, p)}`); };
const read = () => page.evaluate(() => window.__read());

// ── 1. The dummy is rocked ───────────────────────────────────────────────────
await page.evaluate(() => { window.__sim.place(0.79); window.__sim.state().fighters[1].health = 0.05; window.__sim.script(0, [{ cross: true }]); });
// Headless frames are long (up to the 0.25 s clamp each), so everything is read in ONE evaluate right after the wait.
await until(page, () => window.__read().log.includes('rocked1'), undefined, { label: 'the dummy rocked', timeout: 8000 });
const d1 = await page.evaluate(() => ({ hurt: window.__sim.state().fighters[1].hurt, ghost: document.querySelector('#hud .side.r .ghost').style.transform, fill: document.querySelector('#hud .side.r .fill').style.transform, wall: performance.now(), game: window.__tick.gameTime }));
await frames(page, 2);
const t1 = await page.evaluate(() => ({ wall: performance.now(), game: window.__tick.gameTime }));
const rate = (t1.game - d1.game) / ((t1.wall - d1.wall) / 1000);
check(`the dummy is rocked (hurt ${d1.hurt.toFixed(2)} s)`, d1.hurt > 0);
check(`…and the scene is in slow motion for the beat (game/wall ${rate.toFixed(2)})`, rate < 0.85);
check(`the health just lost stays lit as a ghost (${d1.ghost} vs ${d1.fill})`, d1.ghost !== d1.fill);
await shot('dummy');

// ── 2. The player is rocked ──────────────────────────────────────────────────
await page.evaluate(() => { window.__sim.place(0.79); window.__sim.state().fighters[0].health = 0.05; window.__sim.script(1, [{ cross: true }]); });
await until(page, () => window.__read().log.includes('rocked0'), undefined, { label: 'the player rocked', timeout: 8000 });
const el2 = await page.evaluate(() => { const e = document.getElementById('read-hurt'); return { hurt: window.__read().hurt, hidden: e.hidden, opacity: parseFloat(e.style.opacity), blur: e.style.backdropFilter }; });
const r2 = { hurt: el2.hurt };
check(`you are rocked: the red edge is on (hurt ${r2.hurt.toFixed(2)}, opacity ${el2.opacity.toFixed(2)}, ${el2.blur || 'no blur'})`, r2.hurt > 0.2 && !el2.hidden && el2.opacity > 0.05 && /blur/.test(el2.blur));
await shot('player');
await gameTime(page, 0.8);
const r3 = await read();
check(`…and it fades as the hurt state clears (${r2.hurt.toFixed(2)} → ${r3.hurt.toFixed(2)})`, r3.hurt < r2.hurt - 0.2);
await until(page, () => window.__sim.state().fighters[0].hurt === 0, undefined, { label: 'the hurt state to clear', timeout: 10000 });
await frames(page, 2);
check('…and is gone when it has', await page.evaluate(() => document.getElementById('read-hurt').hidden && window.__read().hurt === 0));

// ── 3. The window slows the scene ────────────────────────────────────────────
await page.evaluate(() => {
  window.__sim.place(0.79);
  window.__sim.script(1, [{ jab: true }]);
  window.__sim.script(0, [{ move: { x: -1, y: 0 } }, { move: { x: -1, y: 0 } }]);
});
await until(page, () => window.__read().glow[1] > 0.3, undefined, { label: 'the window open', timeout: 8000 });
const r4 = await read();
check(`the player's slip opens the window: timeScale = readWindowSlowMo (${r4.timeScale} vs ${await page.evaluate(() => window.__cfg.readWindowSlowMo)})`, r4.timeScale === await page.evaluate(() => window.__cfg.readWindowSlowMo));
await until(page, () => window.__read().glow[1] === 0, undefined, { label: 'the window closed', timeout: 10000 });
check('closed: real time again', (await read()).timeScale === 1);

// ── 4. Off switch ────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__cfg.readEnabled = false; window.__sim.place(0.79); window.__sim.state().fighters[0].health = 0.05; window.__sim.script(1, [{ cross: true }]); });
await until(page, () => window.__read().log.filter(l => l === 'rocked0').length >= 2, undefined, { label: 'rocked again', timeout: 8000 });
await frames(page, 2);
check('readEnabled 0: rocked, but no red edge and real time', await page.evaluate(() => document.getElementById('read-hurt').hidden && window.__read().hurt === 0 && window.__read().timeScale === 1));

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
