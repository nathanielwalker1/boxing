/**
 * flow_look.mjs — every screen of the flow (src/ui/flow.ts), captured for a
 * person to look at: docs/overhaul/ui_*.png. Not a test (no assertions beyond
 * "it got there"); flow_check / gym_check / flow_input_check / replay_check
 * are the tests. Three passes:
 *   1. desktop, 1280 × 720, the high quality tier: every menu, the ring walk,
 *      a fight with a knockdown replay, both corner cards, results, ladder
 *   2. the gym, drill by drill, each played by its scripted player
 *      (scripts/lib/drill_bots.js) until its stat line has moved — on the
 *      tier the machine picks (headless: low), because eight drills on
 *      software GL at the high tier take a quarter of an hour
 *   3. a phone, upright and on its side
 *
 *   PORT=5194 node scripts/flow_look.mjs            everything
 *   PORT=5194 node scripts/flow_look.mjs gym        one pass (desktop | gym | phone)
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';
import { installDrillBots } from './lib/drill_bots.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'overhaul');
mkdirSync(OUT, { recursive: true });
const only = process.argv[2] ?? '';
const logs = [];
const browser = await chromium.launch();

async function open(viewport, query = '', high = true, touch = false) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch });
  const page = await ctx.newPage();
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
  await page.goto(`${DEV_URL}/?menu=1${query}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await bootReady(page);
  if (high) await page.evaluate(() => { window.__cfg.qualityTier = 2; });
  await frames(page, 6);
  return page;
}
const LONG = { timeout: 120000 };
const shot = async (page, name) => { await frames(page, 3); await page.screenshot({ path: `${OUT}/ui_${name}.png` }); console.log(`  ui_${name}.png`); };
const key = async (page, k, n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press(k); await frames(page, 1); } };
const on = (page, screen) => until(page, s => window.__flow.state().screen === s, screen, { label: `screen ${screen}`, ...LONG });
const shown = (page, id) => until(page, i => window.__flow.state().shown === i, id, { label: `${id} on the turntable`, ...LONG });
const beat = (page, b) => until(page, x => window.__flow.state().beat === x, b, { label: `beat ${b}`, ...LONG });
const clearLadder = page => page.evaluate(() => { try { localStorage.removeItem('longcount.ladder.v1'); } catch { /* no storage */ } });

// ── 1. Desktop ───────────────────────────────────────────────────────────────
if (!only || only === 'desktop') {
  const page = await open({ width: 1280, height: 720 });
  await page.evaluate(() => {
    const c = window.__cfg;
    window.__flow.rounds(3, 12);
    c.resultsDelaySeconds = 0.5; c.flowCornerSeconds = 600; c.flowWalkSeconds = 600; c.flowStareSeconds = 600;
  });
  await clearLadder(page);
  await frames(page, 30);   // the title spar: let them close on each other
  await shot(page, 'title');

  await key(page, 'Enter'); await on(page, 'select');
  await key(page, 'ArrowRight', 6); await shown(page, 'monsoon');
  await frames(page, 4);
  await shot(page, 'select');
  await key(page, 'ArrowRight', 2);
  await until(page, () => window.__flow.state().shown.startsWith('gen-'), undefined, { label: 'the random fighter', ...LONG });
  await frames(page, 2);
  await shot(page, 'select_random');
  await key(page, 'ArrowLeft', 2); await shown(page, 'monsoon');

  await key(page, 'Enter'); await on(page, 'opponent');
  await key(page, 'ArrowRight', 3);
  await key(page, 'ArrowDown');
  await until(page, () => window.__flow.state().shown !== 'monsoon', undefined, { label: 'the opponent on the turntable', ...LONG });
  await frames(page, 4);
  await shot(page, 'opponent');

  await key(page, 'Enter'); await on(page, 'walk');
  await beat(page, 'walk1');
  await frames(page, 30);
  await shot(page, 'walk_opponent');
  await key(page, 'Enter'); await beat(page, 'walk0');
  await frames(page, 30);
  await shot(page, 'walk_player');
  // A FAST skip into the two-shot: the referee and both men must already be in place on its first frames.
  await key(page, 'Enter'); await beat(page, 'stare');
  await shot(page, 'stare');
  await key(page, 'Enter'); await on(page, 'fight');

  // Round 1: a knockdown by hand (a jab worth a whole bar), for the replay.
  await until(page, () => window.__tick.simTicks > 20, undefined, { label: 'the fight running', ...LONG });
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
  await until(page, () => window.__sim.state().tick > 150, undefined, { label: 'two seconds before the punch', ...LONG });
  await page.evaluate(() => { window.__sim.input(0, null); window.__sim.script(0, [{ jab: true }]); });
  await until(page, () => window.__sim.state().round.phase === 'count', undefined, { label: 'the count', ...LONG });
  await page.evaluate(() => { window.__cfg.healthDamagePerImpulse = window.__keep; window.__sim.input(1, null); });
  await until(page, () => window.__flow.state().replay, undefined, { label: 'the replay', ...LONG });
  await shot(page, 'replay_first');   // the first frames after the cut: are the cloth and the feet settled?
  await frames(page, 12);
  await shot(page, 'replay');
  await until(page, () => !window.__flow.state().replay, undefined, { label: 'the replay to end', ...LONG });
  await shot(page, 'replay_after');   // the cut back to the live count
  await key(page, 'Escape');
  await until(page, () => window.__flow.state().paused, undefined, { label: 'pause', ...LONG });
  await shot(page, 'pause');
  await key(page, 'Escape');

  await until(page, () => window.__flow.state().card, undefined, { label: 'the corner card', ...LONG });
  await frames(page, 4);
  await shot(page, 'corner');
  await page.evaluate(() => { window.__cfg.flowShowScores = true; });
  await key(page, 'Enter');
  await until(page, () => window.__flow.state().card && window.__sim.state().round.index === 1, undefined, { label: 'the second corner card', ...LONG });
  await frames(page, 4);
  await shot(page, 'corner_scores');
  await page.evaluate(() => { window.__cfg.flowShowScores = false; });
  await key(page, 'Enter');
  await on(page, 'results');
  await frames(page, 14);   // the results shot eases in
  await shot(page, 'results');

  // Ladder: a fresh one, then one three fights in (beaten rungs), then the champion card.
  await key(page, 'Escape'); await on(page, 'title');
  await key(page, 'ArrowDown'); await key(page, 'Enter'); await on(page, 'select');
  await key(page, 'Enter'); await on(page, 'ladder');
  await until(page, () => window.__flow.state().shown !== 'monsoon', undefined, { label: 'the next opponent', ...LONG });
  await frames(page, 4);
  await shot(page, 'ladder');
  await page.evaluate(() => { try { localStorage.setItem('longcount.ladder.v1', JSON.stringify({ fighter: 'monsoon', wins: 3, losses: 1 })); } catch { /* no storage */ } });
  await key(page, 'Escape'); await on(page, 'title');
  await key(page, 'ArrowDown'); await key(page, 'Enter'); await on(page, 'ladder');
  await until(page, () => document.querySelectorAll('#flow .rung.won').length === 3, undefined, { label: 'three beaten rungs', ...LONG });
  await frames(page, 8);
  await shot(page, 'ladder_progress');
  await key(page, 'Escape'); await on(page, 'title');
  await key(page, 'ArrowDown', 2); await key(page, 'Enter'); await on(page, 'gym');
  await frames(page, 4);
  await shot(page, 'gym');
  await key(page, 'Escape'); await on(page, 'title');
  await key(page, 'ArrowDown', 3); await key(page, 'Enter'); await on(page, 'controls');
  await shot(page, 'controls');
  await key(page, 'Escape'); await on(page, 'title');
  await page.evaluate(() => { try { localStorage.setItem('longcount.ladder.v1', JSON.stringify({ fighter: 'monsoon', wins: 7, losses: 2 })); } catch { /* no storage */ } });
  await key(page, 'ArrowDown'); await key(page, 'Enter'); await on(page, 'champion');
  await shown(page, 'monsoon');
  await frames(page, 6);
  await shot(page, 'champion');
  await clearLadder(page);
  await page.close();
}

// ── 2. The gym, drill by drill ───────────────────────────────────────────────
if (!only || only === 'gym') {
  const page = await open({ width: 1280, height: 720 }, '', false);
  await installDrillBots(page);
  const ids = ['jab-and-move', 'cut-off', 'get-inside', 'slip-timing', 'slip-counter', 'body-work', 'survive', 'free-sparring'];
  for (const id of ids) {
    await page.evaluate(i => { window.__flow.drill(i); window.__sim.drive(0, window.__drillBot(i)); }, id);
    if (id === 'survive') await shot(page, 'drill_survive_start');   // the first frames: rocked, in the corner
    const want = id === 'survive' ? 0.45 : id === 'cut-off' ? 0.5 : 0.3;
    try { await page.waitForFunction(w => window.__flow.state().drillProgress >= w || window.__flow.state().drillDone !== '', want, { timeout: 90000, polling: 'raf' }); } catch { console.log(`  (${id}: its progress did not reach ${want})`); }
    const st = await page.evaluate(() => window.__flow.state());
    console.log(`  ${id}: "${st.drillStat}" progress ${st.drillProgress.toFixed(2)} ${st.drillDone}`);
    await shot(page, `drill_${id}`);
  }
  await page.evaluate(() => { window.__sim.drive(0, null); });
  await page.close();
}

// ── 3. A phone, upright and on its side ──────────────────────────────────────
if (!only || only === 'phone') {
  for (const [name, viewport] of [['phone', { width: 390, height: 844 }], ['phoneland', { width: 844, height: 390 }]]) {
    const p = await open(viewport, '&touch=1', true, true);
    await installDrillBots(p);
    await frames(p, 16);
    await shot(p, `${name}_title`);
    await key(p, 'Enter'); await on(p, 'select');
    await key(p, 'ArrowRight', 6); await shown(p, 'monsoon');
    await frames(p, 4);
    await shot(p, `${name}_select`);
    await key(p, 'Escape'); await on(p, 'title');
    await p.evaluate(() => { window.__flow.drill('body-work'); window.__sim.drive(0, window.__drillBot('body-work')); });
    await frames(p, 16);
    await shot(p, `${name}_drill`);
    await p.evaluate(() => { window.__sim.drive(0, null); });
    await p.close();
  }
}

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
console.log(`console: ${bad.length} error/warning`);
await browser.close();
