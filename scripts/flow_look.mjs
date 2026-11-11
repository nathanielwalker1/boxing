/**
 * flow_look.mjs — every screen of the flow (src/ui/flow.ts), captured for a
 * person to look at: docs/overhaul/ui_*.png. Not a test (no assertions beyond
 * "it got there"); `flow_check.mjs` is the test. Drives ?menu=1 with the
 * keyboard on the high quality tier, then a phone-sized pass.
 *
 *   PORT=5194 node scripts/flow_look.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'overhaul');
mkdirSync(OUT, { recursive: true });
const logs = [];
const browser = await chromium.launch();

async function open(viewport, query = '') {
  const page = await browser.newPage({ viewport });
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
  await page.goto(`${DEV_URL}/?menu=1${query}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await bootReady(page);
  await page.evaluate(() => { window.__cfg.qualityTier = 2; window.__cfg.debugFps = false; });
  await frames(page, 6);
  return page;
}
const state = page => page.evaluate(() => window.__flow.state());
const shot = async (page, name) => { await frames(page, 3); await page.screenshot({ path: `${OUT}/ui_${name}.png` }); console.log(`  ui_${name}.png`); };
const key = async (page, k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await frames(page, 1); } };
const on = (page, screen) => until(page, s => window.__flow.state().screen === s, screen, { label: `screen ${screen}`, timeout: 30000 });
const shown = (page, id) => until(page, i => window.__flow.state().shown === i, id, { label: `${id} on the turntable`, timeout: 30000 });

// ── Desktop ──────────────────────────────────────────────────────────────────
const page = await open({ width: 1280, height: 720 });
await page.evaluate(() => {
  const c = window.__cfg;
  window.__flow.rounds(2, 14);
  c.resultsDelaySeconds = 0.5; c.flowCornerSeconds = 600; c.flowWalkSeconds = 600; c.flowStareSeconds = 600;
  try { localStorage.removeItem('longcount.ladder.v1'); } catch { /* no storage */ }
});
await frames(page, 6);
await shot(page, 'title');

await key(page, 'Enter'); await on(page, 'select');
await key(page, 'ArrowRight', 6); await shown(page, 'monsoon');
await frames(page, 8);
await shot(page, 'select');
await key(page, 'ArrowRight', 2);
await until(page, () => window.__flow.state().shown.startsWith('gen-'), undefined, { label: 'the random fighter', timeout: 30000 });
await frames(page, 4);
await shot(page, 'select_random');
await key(page, 'ArrowLeft', 2); await shown(page, 'monsoon');

await key(page, 'Enter'); await on(page, 'opponent');
await key(page, 'ArrowRight', 3);
await key(page, 'ArrowDown');
await until(page, () => window.__flow.state().shown !== 'monsoon', undefined, { label: 'the opponent on the turntable', timeout: 30000 });
await frames(page, 6);
await shot(page, 'opponent');

await key(page, 'Enter'); await on(page, 'walk');
await until(page, () => window.__flow.state().beat === 'walk1', undefined, { label: 'the opponent walks', timeout: 60000 });
await frames(page, 30);
await shot(page, 'walk_opponent');
await key(page, 'Enter');
await until(page, () => window.__flow.state().beat === 'walk0', undefined, { label: 'the player walks', timeout: 60000 });
await frames(page, 30);
await shot(page, 'walk_player');
await key(page, 'Enter');
await until(page, () => window.__flow.state().beat === 'stare', undefined, { label: 'the stare-down', timeout: 60000 });
await frames(page, 30);
await shot(page, 'stare');
await key(page, 'Enter'); await on(page, 'fight');

// Round 1: a knockdown by hand (a jab worth a whole bar), for the replay.
await until(page, () => window.__tick.simTicks > 20, undefined, { label: 'the fight running', timeout: 60000 });
await shot(page, 'fight');
await page.evaluate(() => {
  const c = window.__cfg;
  window.__keep = c.healthDamagePerImpulse;
  c.healthDamagePerImpulse = 1; c.getUpCountBest = 6; c.getUpCountWorst = 6; c.getUpJitter = 0;
  const idle = { move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false };
  window.__sim.place(0.9);
  window.__sim.input(0, idle); window.__sim.input(1, idle);
});
// Two seconds stood in front of each other first, so the whole replay clip is this exchange (place() is a teleport).
await until(page, () => window.__sim.state().tick > 150, undefined, { label: 'two seconds before the punch', timeout: 60000 });
await page.evaluate(() => { window.__sim.input(0, null); window.__sim.script(0, [{ jab: true }]); });
await until(page, () => window.__sim.state().round.phase === 'count', undefined, { label: 'the count', timeout: 30000 });
await page.evaluate(() => { window.__cfg.healthDamagePerImpulse = window.__keep; window.__sim.input(1, null); });
await until(page, () => window.__flow.state().replay, undefined, { label: 'the replay', timeout: 60000 });
await frames(page, 14);
await shot(page, 'replay');
await frames(page, 5);
await shot(page, 'replay_late');
await until(page, () => !window.__flow.state().replay, undefined, { label: 'the replay to end', timeout: 120000 });
await frames(page, 4);
await key(page, 'Escape');
await until(page, () => window.__flow.state().paused, undefined, { label: 'pause', timeout: 60000 });
await shot(page, 'pause');
await key(page, 'Escape');

await until(page, () => window.__flow.state().card, undefined, { label: 'the corner card', timeout: 120000 });
await frames(page, 4);
await shot(page, 'corner');
await key(page, 'Enter');
await on(page, 'results');
await frames(page, 4);
await shot(page, 'results');

// Ladder (a fresh one), gym, a drill, controls.
await key(page, 'Escape'); await on(page, 'title');
await key(page, 'ArrowDown'); await key(page, 'Enter'); await on(page, 'select');
await key(page, 'Enter'); await on(page, 'ladder');
await until(page, () => window.__flow.state().shown !== 'monsoon', undefined, { label: 'the next opponent', timeout: 30000 });
await frames(page, 6);
await shot(page, 'ladder');
await key(page, 'Escape'); await on(page, 'title');
await key(page, 'ArrowDown', 2); await key(page, 'Enter'); await on(page, 'gym');
await frames(page, 4);
await shot(page, 'gym');
await key(page, 'Enter'); await on(page, 'fight');
await until(page, () => window.__tick.simTicks > 0 && window.__sim.state().tick > 60, undefined, { label: 'the drill running', timeout: 60000 });
await shot(page, 'drill');
await key(page, 'Escape'); await on(page, 'gym');
await key(page, 'Escape'); await on(page, 'title');
await key(page, 'ArrowDown', 3); await key(page, 'Enter'); await on(page, 'controls');
await shot(page, 'controls');
await key(page, 'Escape'); await on(page, 'title');

// The champion card: a finished ladder in storage.
await page.evaluate(() => { try { localStorage.setItem('longcount.ladder.v1', JSON.stringify({ fighter: 'monsoon', wins: 7, losses: 2 })); } catch { /* no storage */ } });
await key(page, 'ArrowDown'); await key(page, 'Enter'); await on(page, 'champion');
await shown(page, 'monsoon');
await frames(page, 6);
await shot(page, 'champion');
await page.evaluate(() => { try { localStorage.removeItem('longcount.ladder.v1'); } catch { /* no storage */ } });
await page.close();

// ── A phone, upright and on its side ─────────────────────────────────────────
for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['phoneland', { width: 844, height: 390 }]]) {
  const p = await open(viewport, '&touch=1');
  await frames(p, 4);
  await shot(p, `${name}_title`);
  await key(p, 'Enter'); await on(p, 'select');
  await key(p, 'ArrowRight', 6); await shown(p, 'monsoon');
  await frames(p, 6);
  await shot(p, `${name}_select`);
  await p.close();
}

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
console.log(`console: ${bad.length} error/warning`);
await browser.close();
