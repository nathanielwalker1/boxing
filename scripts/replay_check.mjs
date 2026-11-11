/**
 * replay_check.mjs — the knockdown replay (main.ts + src/ui/replay.ts), in a
 * flow fight (?menu=1). A jab worth a whole bar floors the opponent; then:
 *   - the replay does not start before the referee reaches flowReplayAtCount
 *   - while it plays the sim is HELD (tick and count stand still), the HUD is
 *     off, the REPLAY bug is up, and the lens is on the reverse side, lower
 *     and closer than the live camera
 *   - what is drawn is the past: the man who is down in the sim is on his
 *     feet in the picture at the start of the clip
 *   - a button skips it; the lens goes back where it was and the count goes on
 *   - with flowReplayOn off there is none
 * Screenshot → scripts/output/replay_*.png. Console must be clean.
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
await page.goto(`${DEV_URL}/?menu=1&ai=0`, { waitUntil: 'networkidle', timeout: 15_000 });
await bootReady(page);
await page.evaluate(() => {
  const c = window.__cfg;
  window.__flow.rounds(1, 60);
  c.flowWalkOn = false; c.flowStareSeconds = 0.1;
  c.getUpCountBest = 8; c.getUpCountWorst = 8; c.getUpJitter = 0;   // an 8-count, deterministic
  c.flowReplaySpeed = 0.1;                                          // a long replay: time to look at it
});
const on = screen => until(page, s => window.__flow.state().screen === s, screen, { label: `screen ${screen}`, timeout: 30000 });
const key = async k => { await page.keyboard.press(k); await frames(page, 1); };
const deg = r => r * 180 / Math.PI;
const wrap = d => Math.abs(((d + 540) % 360) - 180);

await key('Enter'); await on('select');
await key('Enter'); await on('opponent');
await key('Enter'); await on('fight');
await until(page, () => window.__tick.simTicks > 5, undefined, { label: 'the fight running' });

const floor = () => page.evaluate(() => {
  window.__cfg.healthDamagePerImpulse = 1;
  window.__sim.place(0.9);
  window.__sim.script(0, [{ jab: true }]);
});
await floor();
await until(page, () => window.__sim.state().round.phase === 'count', undefined, { label: 'the count', timeout: 20000 });
const live = await page.evaluate(() => ({ az: window.__camAz(), replay: window.__flow.state().replay, count: window.__sim.state().round.count }));
check(`the knockdown is live first: no replay at count ${live.count}`, !live.replay && live.count < 2);
await until(page, () => window.__flow.state().replay, undefined, { label: 'the replay', timeout: 30000 });
await frames(page, 3);
const r1 = await page.evaluate(() => {
  const s = window.__sim.state();
  return { tick: s.tick, count: s.round.count, down: s.fighters[1].down, az: window.__camAz(), el: window.__camEl(), dist: window.__camDist(), hud: document.getElementById('hud').hidden,
    bug: document.querySelector('#flow .bug').classList.contains('on'), headY: window.__rig?.[1]?.head().y ?? -1 };
});
check(`the replay starts once the count is on (count ${r1.count} ≥ flowReplayAtCount)`, r1.count >= 2 && r1.down);
check('the REPLAY bug is up and the HUD is off', r1.bug && r1.hud);
check(`the lens is on the reverse side (${wrap(deg(r1.az - live.az)).toFixed(0)}° round), low (${deg(r1.el).toFixed(1)}°) and close (${r1.dist.toFixed(2)} m)`, wrap(deg(r1.az - live.az)) > 120 && deg(r1.el) < 5 && r1.dist < 3.4);
check(`the picture is the past: the downed man is drawn on his feet (head at ${r1.headY.toFixed(2)} m)`, r1.headY > 1.2);
await frames(page, 12);
const r2 = await page.evaluate(() => ({ tick: window.__sim.state().tick, count: window.__sim.state().round.count, replay: window.__flow.state().replay }));
check(`the sim is held while it plays (tick ${r1.tick} → ${r2.tick}, count ${r1.count} → ${r2.count})`, r2.replay && r2.tick === r1.tick && r2.count === r1.count);
const p = `${OUT}/replay_frame.png`; await page.screenshot({ path: p }); console.log(`     replay → ${p}\n              ${await greyscaleCopy(page, p)}`);

await key('Enter');
await until(page, () => !window.__flow.state().replay, undefined, { label: 'the skip' });
await frames(page, 2);
const r3 = await page.evaluate(() => ({ az: window.__camAz(), hud: document.getElementById('hud').hidden, bug: document.querySelector('#flow .bug').classList.contains('on') }));
check(`a button skips it: the lens is back where it was (${wrap(deg(r3.az - live.az)).toFixed(1)}° off), the HUD is back`, wrap(deg(r3.az - live.az)) < 2 && !r3.hud && !r3.bug);
await until(page, c => window.__sim.state().round.count > c || window.__sim.state().round.phase !== 'count', r2.count, { label: 'the count to go on', timeout: 20000 });
check('…and the count goes on from where it stopped', true);

// Off: a second knockdown with the toggle off plays live only.
await until(page, () => window.__sim.state().round.phase === 'fighting', undefined, { label: 'him back on his feet', timeout: 30000 });
await page.evaluate(() => { window.__cfg.flowReplayOn = false; });
await floor();
await until(page, () => window.__sim.state().round.phase === 'count' && window.__sim.state().round.count >= 4, undefined, { label: 'count 4', timeout: 30000 });
check('flowReplayOn off: no replay', !(await page.evaluate(() => window.__flow.state().replay)));

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
