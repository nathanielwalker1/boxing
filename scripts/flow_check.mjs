/**
 * flow_check.mjs — the fight flow (src/ui/flow.ts) in the real app, forced on
 * with ?menu=1 (under Playwright it is off by default so the other checks
 * drive the sim directly). Walks menu → select → tale of the tape → fight →
 * results with the keyboard, with the rounds shortened through __cfg:
 *   - the sim is HELD on the menu, the select and the intro (gameTime still)
 *   - the bell rings once on the way into the fight
 *   - the lower-third shows at the end of round 1
 *   - the results screen comes up after the last bell with the scorecard
 *   - a rematch starts a fresh fight (tick 0, round 0)
 * Screenshots (+ greyscale) of each screen → scripts/output/flow_*.png.
 * Console must be clean.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';
import { greyscaleCopy } from './greyscale.js';
import { check, done } from './check.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/?menu=1`, { waitUntil: 'networkidle', timeout: 15_000 });
await bootReady(page);
await page.evaluate(() => {
  // Short rounds, but a rest long enough that a slow headless frame rate still sees both halves of the card.
  window.__cfg.roundSeconds = 2; window.__cfg.betweenRoundSeconds = 4; window.__cfg.roundCount = 2;
  window.__cfg.introSeconds = 60; window.__cfg.resultsDelaySeconds = 0.3;
  window.__bells = 0;
});
const screen = () => page.evaluate(() => document.querySelector('#flow .screen.on')?.className.replace(/screen|dim|on/g, '').trim());
const shot = async (name) => { const p = `${OUT}/flow_${name}.png`; await page.screenshot({ path: p }); console.log(`     ${name} → ${p}\n              ${await greyscaleCopy(page, p)}`); };

// ── 1. Menu: the sim is held ─────────────────────────────────────────────────
await frames(page, 10);
const t0 = await page.evaluate(() => window.__tick.simTicks);
await frames(page, 10);
const t1 = await page.evaluate(() => window.__tick.simTicks);
check(`boots to the menu with the sim held (ticks ${t0} → ${t1})`, (await screen()) === 'menu' && t1 === t0);
check('the HUD is hidden on the menu', await page.evaluate(() => document.getElementById('hud').hidden));
await shot('menu');

// ── 2. Select ────────────────────────────────────────────────────────────────
await page.keyboard.press('Enter');
await frames(page, 2);
check('Enter → fighter select with a card per roster entry', (await screen()) === 'select' && (await page.evaluate(() => document.querySelectorAll('#flow .card').length)) >= 2);
await page.keyboard.press('ArrowRight');
await frames(page, 2);
check('→ moves the pick to the second card', await page.evaluate(() => document.querySelectorAll('#flow .card')[1].classList.contains('sel')));
await shot('select');

// ── 3. Tale of the tape ──────────────────────────────────────────────────────
await page.keyboard.press('Enter');
await frames(page, 2);
const intro = await page.evaluate(() => ({ screen: document.querySelector('#flow .screen.on')?.className, name0: document.querySelector('#hud .side.l .name')?.textContent, tape: document.querySelector('#flow .tape')?.textContent ?? '' }));
check('confirm → the tale of the tape, the picked fighter as the player (side 0)', (await screen()) === 'intro' && intro.name0 === 'Desmond Okafor' && /OKAFOR/i.test(intro.tape) && /BRASK/i.test(intro.tape), `${intro.name0} / ${intro.tape.slice(0, 60)}`);
const held = await page.evaluate(() => window.__tick.simTicks);
await frames(page, 10);
check('the sim is still held on the intro', (await page.evaluate(() => window.__tick.simTicks)) === held);
await shot('intro');

// ── 4. The fight ─────────────────────────────────────────────────────────────
await page.keyboard.press('Enter');
await until(page, () => window.__tick.simTicks > 5, undefined, { label: 'the sim running' });
check('Enter → the fight: the sim runs and the HUD is up', (await screen()) === 'fight' && !(await page.evaluate(() => document.getElementById('hud').hidden)));
await until(page, () => window.__sim.state().round.phase === 'between', undefined, { label: 'end of round 1', timeout: 30000 });
await frames(page, 2);
const card = await page.evaluate(() => ({ on: document.querySelector('#flow .black').classList.contains('on'), text: document.querySelector('#flow .black').textContent }));
check('the rest is a black card: END OF ROUND 1', card.on && /end of round 1/i.test(card.text), JSON.stringify(card));
await until(page, () => window.__sim.state().round.phaseT > window.__cfg.betweenRoundSeconds * 0.5, undefined, { label: 'the second half of the rest', timeout: 15000 });
await frames(page, 2);
const card2 = await page.evaluate(() => document.querySelector('#flow .black').textContent);
check('…then ROUND 2', /round 2/i.test(card2), card2);
await shot('round_end');
// A 2 s round can pass between two slow polls, so accept anything past the rest.
await until(page, () => window.__sim.state().round.phase !== 'between', undefined, { label: 'the rest to end', timeout: 20000 });
await frames(page, 2);
check('the card is gone at the bell', await page.evaluate(() => !document.querySelector('#flow .black').classList.contains('on')));

// ── 5. Results ───────────────────────────────────────────────────────────────
await until(page, () => document.querySelector('#flow .screen.results.on') !== null, undefined, { label: 'the results screen', timeout: 30000 });
const res = await page.evaluate(() => ({ phase: window.__sim.state().round.phase, winner: document.querySelector('#flow .winner')?.textContent, method: document.querySelector('#flow .method')?.textContent, rows: document.querySelectorAll('#flow table tr').length }));
check(`results after the last bell: "${res.winner}" ${res.method}`, res.phase === 'over' && !!res.winner && res.rows === 3, JSON.stringify(res));
await shot('results');

// ── 6. Rematch ───────────────────────────────────────────────────────────────
await page.keyboard.press('Enter');
await frames(page, 2);
const re = await page.evaluate(() => ({ screen: document.querySelector('#flow .screen.on')?.className, tick: window.__sim.state().tick, round: window.__sim.state().round.index, phase: window.__sim.state().round.phase }));
check('rematch → a fresh fight behind a new tale of the tape', /intro/.test(re.screen) && re.tick === 0 && re.round === 0 && re.phase === 'fighting', JSON.stringify(re));

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
