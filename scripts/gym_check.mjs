/**
 * gym_check.mjs — the gym (src/ui/flow.ts + src/ui/drills.ts over SIM's
 * src/ai/drills.ts), drill by drill, in the real app (?menu=1). For each of
 * the seven drills and the free sparring:
 *   - it starts where the drill places the pair, hands settled
 *   - its panel names the drill, the goal, the controls for keys, pad and
 *     touch, and (when the drill has a length) a clock
 *   - the partner does what the drill says he does
 *   - a scripted player who does the drill's thing (scripts/lib/drill_bots.js,
 *     tick-exact through window.__sim.drive) moves the progress / stat line
 * and, once:
 *   - `survive` starts the player rocked, in the corner, on the first frame
 *   - a finished drill says so and starts again; N and P step through the list
 *   - a drill nobody finishes ends on its clock ("Time")
 * Console must be clean.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until as untilFor, frames } from './waits.js';
import { check, done } from './check.js';
import { installDrillBots } from './lib/drill_bots.js';

// Every state wait gets three minutes: headless software GL under a parallel suite draws about a frame a second, and
// the frame clamp makes that a quarter of a second of sim, so a wait bounded in tens of seconds is a flake.
const until = (page, fn, arg = undefined, opts = {}) => untilFor(page, fn, arg, { ...opts, timeout: 180000 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/?menu=1`, { waitUntil: 'networkidle', timeout: 60_000 });
await bootReady(page);
await installDrillBots(page);
await page.evaluate(() => { window.__cfg.flowDrillRestartSeconds = 1; });
const st = () => page.evaluate(() => window.__flow.state());

// What each drill should look like at its start, and what its partner should be seen doing.
const DRILLS = [
  { id: 'jab-and-move', dist: 1.3, partner: 'walks at you', see: () => Math.hypot(window.__sim.state().fighters[1].vel.x, window.__sim.state().fighters[1].vel.z) > 0.2 },
  { id: 'cut-off', dist: 1.4, partner: 'moves away and round', see: () => Math.hypot(window.__sim.state().fighters[1].vel.x, window.__sim.state().fighters[1].vel.z) > 0.5 },
  { id: 'get-inside', dist: 1.5, partner: 'jabs at you as you come', see: () => window.__sim.state().fighters[1].punch.type === 'jab' },
  { id: 'slip-timing', dist: 0.85, partner: 'throws one heavy punch', see: () => ['cross', 'hook'].includes(window.__sim.state().fighters[1].punch.type) },
  { id: 'slip-counter', dist: 0.85, partner: 'throws one heavy punch', see: () => ['cross', 'hook'].includes(window.__sim.state().fighters[1].punch.type) },
  { id: 'body-work', dist: 0.8, partner: 'holds his guard up', see: () => window.__sim.state().fighters[1].block },
  { id: 'survive', dist: 0.877, partner: 'comes to finish it', see: () => window.__sim.state().fighters[1].punch.type !== null },
  // Polish phase: the drills for the fixes.
  { id: 'combinations', dist: 0.8, partner: 'stands in front of you', see: () => window.__sim.state().fighters[1].punch.type === null },
  { id: 'combinations-ropes', dist: 0.8, partner: 'stands on the ropes', see: () => window.__sim.state().fighters[1].punch.type === null },
  { id: 'trading', dist: 0.8, partner: 'hits you on a beat', see: () => window.__sim.state().fighters[1].punch.type !== null },
  { id: 'stamina-pace', dist: 0.8, partner: 'blocks some of it', see: () => window.__sim.state().fighters[1].block },
  { id: 'stamina-guard', dist: 0.78, partner: 'jabs at your guard', see: () => window.__sim.state().fighters[1].punch.type === 'jab' },
  { id: 'hurt', dist: 0.85, partner: 'pokes a lazy jab', see: () => window.__sim.state().fighters[1].punch.type === 'jab' || window.__sim.state().fighters[1].hurt > 0 || window.__sim.state().fighters[1].down },
  { id: 'free-sparring', dist: 1.3, partner: 'stands there', see: () => window.__sim.state().fighters[1].punch.type === null && Math.hypot(window.__sim.state().fighters[1].vel.x, window.__sim.state().fighters[1].vel.z) < 0.05 },
];

await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
await until(page, () => window.__flow.state().screen === 'gym', undefined, { label: 'the gym' });
const list = await page.evaluate(() => [...document.querySelectorAll('#flow .ditem')].map(d => ({ t: d.querySelector('.t').firstChild.textContent, c: d.querySelector('.c').textContent, secs: d.querySelector('.t small')?.textContent ?? '' })));
check(`the gym lists fourteen drills in order, each with its length and what it trains (${list.map(l => l.t).join(' · ')})`, list.length === 14 && list[0].t === 'Stick and move' && list[6].t === 'Surviving hurt' && list[7].t === 'Combinations' && list[12].t === 'Hurting him' && list[13].t === 'Free sparring' && list.slice(0, 13).every(l => /\d+ s/.test(l.secs) && l.c.length > 8));

for (const d of DRILLS) {
  console.log(`\n--- ${d.id}`);
  // Start it, and read the very first state before a frame is drawn.
  const first = await page.evaluate(id => {
    const ok = window.__flow.drill(id);
    // A player who does the drill's thing, from the first tick (in `survive` a man who stands still is down inside a second).
    window.__sim.drive(0, window.__drillBot(id));
    const s = window.__sim.state(), [a, b] = s.fighters;
    return { ok, dist: Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z), facing: Math.cos(a.yaw) * (b.pos.x - a.pos.x) + Math.sin(a.yaw) * (b.pos.z - a.pos.z), hurt: a.hurt, hurtKind: a.hurtKind, health: a.health, ax: a.pos.x, az: a.pos.z, glove: Math.hypot(a.gloves[0].pos.x - a.pos.x, a.gloves[0].pos.z - a.pos.z), secs: window.__cfg.roundSeconds };
  }, d.id);
  check(`starts in its placement: ${first.dist.toFixed(2)} m apart (drill: ${d.dist}), facing, hands on the guard`, first.ok && Math.abs(first.dist - d.dist) < 0.03 && first.facing > 0.9 * first.dist && first.glove < 0.8 && first.secs === 180, JSON.stringify(first));
  if (d.id === 'survive') {
    check(`the player starts rocked (${first.hurt.toFixed(1)} s, ${first.hurtKind}), below ${(first.health * 100).toFixed(0)}% health, in the corner (${first.ax.toFixed(2)}, ${first.az.toFixed(2)})`, first.hurt >= 2.9 && first.hurtKind === 'head' && first.health <= 0.55 && first.ax < -2.2 && first.az < -2.2, JSON.stringify(first));
    await frames(page, 1);
    const drawn = await page.evaluate(() => ({ hurt: window.__states()[0].hurt, read: window.__read().hurt }));
    check(`…and is drawn hurt on the first frames (hurt ${drawn.hurt.toFixed(2)} s, the hurt read at ${drawn.read.toFixed(2)})`, drawn.hurt > 0.5 && drawn.read > 0, JSON.stringify(drawn));
  }
  await frames(page, 1);
  const panel = await page.evaluate(() => { const p = document.querySelector('#flow .drill'); return { on: p.classList.contains('on'), title: p.querySelector('.t').textContent, goal: p.querySelector('.g').textContent, head: [...p.querySelectorAll('.dc th')].map(t => t.textContent).join('|'), rows: p.querySelectorAll('.dc tr').length - 1, cells: [...p.querySelectorAll('.dc tr:nth-child(2) td')].map(t => t.textContent), clk: p.querySelector('.clk').textContent, ref: window.__ref() }; });
  check(`the panel: "${panel.title}", the goal, ${panel.rows} controls for keys / pad / touch (${panel.cells.join(' — ')})${panel.clk ? `, clock ${panel.clk}` : ''}`, panel.on && panel.goal.length > 20 && panel.head === '|Keys|Pad|Touch' && panel.rows >= 3 && panel.cells.every(c => c.length > 0) && (d.id === 'free-sparring' ? panel.clk === '' : /^\d+ s$/.test(panel.clk)), JSON.stringify(panel));
  let saw = true;
  try { await page.waitForFunction(d.see, undefined, { timeout: 180000, polling: 'raf' }); } catch { saw = false; }
  check(`the partner ${d.partner}`, saw);
  const want = d.id === 'survive' ? 0.3 : 0.15;
  let moved = true;
  try { await page.waitForFunction(w => window.__flow.state().drillProgress >= w || window.__flow.state().drillDone === 'Done', want, { timeout: 180000, polling: 'raf' }); } catch { moved = false; }
  const end = await st();
  check(`the stat line moves for a player who does it: "${end.drillStat}" (progress ${end.drillProgress.toFixed(2)}${end.drillDone ? `, ${end.drillDone}` : ''})`, moved && end.drill === d.id && end.drillStat.length > 3, JSON.stringify(end));
}

// ── Finishing, stepping, the clock ───────────────────────────────────────────
console.log('\n--- finishing a drill, N / P, the clock');
await page.evaluate(() => { window.__flow.drill('survive'); window.__sim.drive(0, window.__drillBot('survive')); });
await until(page, () => window.__flow.state().drillDone !== '', undefined, { label: 'the drill to end', timeout: 90000 });
const fin = await page.evaluate(() => ({ done: window.__flow.state().drillDone, text: document.querySelector('#flow .drill .s').textContent, clk: document.querySelector('#flow .drill .clk').textContent, tick: window.__sim.state().tick }));
check(`a finished drill says so ("${fin.text.slice(0, 50)}", ${fin.clk})`, fin.done.length > 0 && fin.text.startsWith(fin.done) && /again in \d/.test(fin.clk), JSON.stringify(fin));
await until(page, t => window.__flow.state().drillDone === '' && window.__sim.state().tick < t, fin.tick, { label: 'the restart', timeout: 30000 });
check('…and starts again by itself', (await st()).drill === 'survive');
await page.evaluate(() => { window.__sim.drive(0, null); });
await page.keyboard.press('KeyN'); await frames(page, 1);
const n1 = (await st()).drill;
await page.keyboard.press('KeyP'); await frames(page, 1);
await page.keyboard.press('KeyP'); await frames(page, 1);
const n2 = (await st()).drill;
check(`N goes to the next drill (${n1}), P back (${n2})`, n1 === 'combinations' && n2 === 'body-work');
// Nobody finishes this one (the player stands still while he circles): it ends on its clock.
await page.evaluate(() => { window.__flow.drill('cut-off'); });
await until(page, () => window.__flow.state().drillDone !== '', undefined, { label: 'the drill clock', timeout: 120000 });
const timed = await page.evaluate(() => ({ done: window.__flow.state().drillDone, t: window.__sim.state().time }));
check(`a drill nobody finishes ends on its clock: "${timed.done}" at ${timed.t.toFixed(1)} s (suggested 40)`, timed.done === 'Time' && timed.t > 39.5 && timed.t < 42, JSON.stringify(timed));
await page.keyboard.press('Escape');
await until(page, () => window.__flow.state().screen === 'gym', undefined, { label: 'back to the gym' });
check('Esc → the gym, the round length put back', (await page.evaluate(() => window.__cfg.roundSeconds)) !== 180);

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
