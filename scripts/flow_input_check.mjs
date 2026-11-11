/**
 * flow_input_check.mjs — the flow driven by everything that is not a
 * keyboard (flow_check.mjs is the keyboard): the same path three times,
 *   title → select → opponent (a difficulty) → ring walk → fight → pause → quit
 *   1. mouse clicks                      (Easy)
 *   2. touch taps, a touch-emulating context, ?touch=1   (Hard)
 *   3. a gamepad: navigator.getGamepads stubbed in the page (Medium)
 * and with them, because each run picks a different difficulty against the
 * same opponent: the menu's choice reaches the AI — one key (aiDifficulty),
 * three different `AiState.style`s.
 * The pad run also checks that a button still held when the fight starts is
 * not a punch until it has been let go.
 * Console must be clean.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until as untilFor, frames } from './waits.js';
import { check, done } from './check.js';

// Every state wait gets three minutes: headless software GL under a parallel suite draws about a frame a second, and
// the frame clamp makes that a quarter of a second of sim, so a wait bounded in tens of seconds is a flake.
const until = (page, fn, arg = undefined, opts = {}) => untilFor(page, fn, arg, { ...opts, timeout: 180000 });
const browser = await chromium.launch();
const logs = [];
const hook = page => {
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
};
const on = (page, screen) => until(page, s => window.__flow.state().screen === s, screen, { label: `screen ${screen}`, timeout: 30000 });
const beat = (page, b) => until(page, x => window.__flow.state().beat === x, b, { label: `beat ${b}`, timeout: 30000 });
const setup = page => page.evaluate(() => { window.__flow.rounds(1, 30); window.__cfg.flowWalkSeconds = 600; window.__cfg.flowStareSeconds = 600; });
const aiProbe = page => page.evaluate(() => { const a = window.__ai.state(); return { key: window.__cfg.aiDifficulty, style: JSON.stringify(a.style), mistake: a.style?.mistake, gap: a.style?.attackDelayMin, opp: window.__flow.state().opponent }; });
const styles = {};

// ── 1. Mouse ─────────────────────────────────────────────────────────────────
console.log('\n=== Mouse ===');
{
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  hook(page);
  await page.goto(`${DEV_URL}/?menu=1`, { waitUntil: 'networkidle', timeout: 60_000 });
  await bootReady(page);
  await setup(page);
  await page.locator('#flow .title .btn', { hasText: 'Fight' }).click();
  await on(page, 'select');
  check('a click on Fight → fighter select', true);
  const plate = page.locator('#flow .select .plate').nth(3);
  await plate.click(); await frames(page, 1);
  check('a click on a plate highlights him', await page.evaluate(() => document.querySelectorAll('#flow .select .plate')[3].classList.contains('sel') && /VOSS/i.test(document.querySelector('#flow .select .fname').textContent)));
  await page.locator('#flow .select .btn', { hasText: 'Select' }).click();
  await on(page, 'opponent');
  check('a click on Select → opponent select', (await page.evaluate(() => window.__flow.state().player)) === 'lighthouse');
  await page.locator('#flow .opponent .ch', { hasText: 'Easy' }).click(); await frames(page, 1);
  await page.locator('#flow .opponent .ch', { hasText: '3 × 0:30' }).click(); await frames(page, 1);
  check('clicks set the difficulty and the rounds', await page.evaluate(() => [...document.querySelectorAll('#flow .opponent .ch.sel')].map(c => c.textContent).join('|')) === 'Easy|3 × 0:30');
  await page.locator('#flow .opponent .btn', { hasText: 'Fight' }).click();
  await on(page, 'walk'); await beat(page, 'walk1');
  await page.mouse.click(480, 300); await beat(page, 'walk0');
  await page.mouse.click(480, 300); await beat(page, 'stare');
  await page.mouse.click(480, 300); await on(page, 'fight');
  check('clicks skip the ring walk beat by beat → the fight', true);
  await until(page, () => window.__tick.simTicks > 5, undefined, { label: 'the sim running' });
  styles.easy = await aiProbe(page);
  await page.locator('#flow .pausebtn').click();
  await until(page, () => window.__flow.state().paused, undefined, { label: 'pause' });
  check('a click on the pause button pauses', true);
  await page.locator('#flow .pause .btn', { hasText: 'Quit' }).click();
  await on(page, 'title');
  check('a click on Quit → the title', true);
  await page.close();
}

// ── 2. Touch ─────────────────────────────────────────────────────────────────
console.log('\n=== Touch ===');
{
  const ctx = await browser.newContext({ viewport: { width: 900, height: 480 }, hasTouch: true });
  const page = await ctx.newPage();
  hook(page);
  await page.goto(`${DEV_URL}/?menu=1&touch=1`, { waitUntil: 'networkidle', timeout: 60_000 });
  await bootReady(page);
  await setup(page);
  check('the touch controls are hidden behind a menu', await page.evaluate(() => getComputedStyle(document.getElementById('touch-ui')).display === 'none'));
  await page.locator('#flow .title .btn', { hasText: 'Fight' }).tap();
  await on(page, 'select');
  await page.locator('#flow .select .plate').nth(3).tap(); await frames(page, 1);
  await page.locator('#flow .select .plate').nth(3).tap();   // a second tap on the highlighted plate picks him
  await on(page, 'opponent');
  check('taps: Fight → a plate, twice → opponent select', (await page.evaluate(() => window.__flow.state().player)) === 'lighthouse');
  await page.locator('#flow .opponent .ch', { hasText: 'Hard' }).tap(); await frames(page, 1);
  await page.locator('#flow .opponent .btn', { hasText: 'Fight' }).tap();
  await on(page, 'walk'); await beat(page, 'walk1');
  await page.touchscreen.tap(450, 200); await beat(page, 'walk0');
  await page.touchscreen.tap(450, 200); await beat(page, 'stare');
  await page.touchscreen.tap(450, 200); await on(page, 'fight');
  await until(page, () => window.__tick.simTicks > 5, undefined, { label: 'the sim running' });
  check('taps skip the ring walk → the fight, the touch controls back', await page.evaluate(() => getComputedStyle(document.getElementById('touch-ui')).display !== 'none'));
  styles.hard = await aiProbe(page);
  // The joystick zone covers the left half and the diamond the right: both still take a finger with the flow on top.
  const jab = await page.locator('.touch-btn.jab').boundingBox();
  // A finger held down for a few frames (a headless frame is a quarter of a second; a tap would be over between two of them).
  const cdp = await ctx.newCDPSession(page);
  const pt = [{ x: Math.round(jab.x + jab.width / 2), y: Math.round(jab.y + jab.height / 2), id: 1 }];
  const stam = await page.evaluate(() => window.__sim.state().fighters[0].stamina);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
  // A jab is over inside two headless frames, so it may never be SEEN in flight: the stamina it cost is the proof.
  let threw = true;
  try { await page.waitForFunction(s0 => window.__input.current().jab && (window.__sim.state().fighters[0].punch.type === 'jab' || window.__sim.state().fighters[0].stamina < s0 - 0.01), stam, { timeout: 180000, polling: 'raf' }); } catch { threw = false; }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await frames(page, 1);
  check('a tap on JAB throws a jab (the flow does not swallow the fight\'s touches)', threw);
  await page.locator('#flow .pausebtn').tap();
  await until(page, () => window.__flow.state().paused, undefined, { label: 'pause' });
  check('a tap on the pause button pauses', true);
  await page.locator('#flow .pause .btn', { hasText: 'Quit' }).tap();
  await on(page, 'title');
  check('a tap on Quit → the title', true);
  // The gym by touch: a drill, then its own buttons.
  await page.locator('#flow .title .btn', { hasText: 'Gym' }).tap();
  await on(page, 'gym');
  await page.locator('#flow .ditem').nth(0).tap();
  await on(page, 'fight');
  await frames(page, 2);
  const dp = await page.evaluate(() => ({ drill: window.__flow.state().drill, cols: [...document.querySelectorAll('#flow .drill .dc th')].filter(t => getComputedStyle(t).display !== 'none').map(t => t.textContent).join('|') }));
  check(`a tap starts a drill (${dp.drill}); on touch its panel shows the touch column (${dp.cols})`, dp.drill === 'jab-and-move' && dp.cols === '|Touch');
  await page.locator('#flow .drill .dbtn', { hasText: 'Next' }).tap(); await frames(page, 1);
  check('a tap on Next → the next drill', (await page.evaluate(() => window.__flow.state().drill)) === 'cut-off');
  await page.locator('#flow .drill .dbtn', { hasText: 'Gym' }).tap();
  await on(page, 'gym');
  check('a tap on Gym → the list', true);
  await ctx.close();
}

// ── 3. Gamepad (stubbed) ─────────────────────────────────────────────────────
console.log('\n=== Gamepad ===');
{
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  hook(page);
  await page.addInitScript(() => {
    window.__pad = { buttons: Array(17).fill(false), axes: [0, 0, 0, 0] };
    navigator.getGamepads = () => [{ connected: true, id: 'stub pad', index: 0, mapping: 'standard', timestamp: 0, axes: window.__pad.axes, buttons: window.__pad.buttons.map(p => ({ pressed: p, touched: p, value: p ? 1 : 0 })) }];
  });
  await page.goto(`${DEV_URL}/?menu=1`, { waitUntil: 'networkidle', timeout: 60_000 });
  await bootReady(page);
  await setup(page);
  const hold = (i, down) => page.evaluate(([i, d]) => { window.__pad.buttons[i] = d; }, [i, down]);
  const press = async i => { await hold(i, true); await frames(page, 2); await hold(i, false); await frames(page, 2); };
  const A = 0, B = 1, START = 9, DOWN = 13, RIGHT = 15;
  await press(DOWN);
  check('d-pad down moves the title cursor', await page.evaluate(() => document.querySelectorAll('#flow .title .btn')[1].classList.contains('sel')));
  await page.evaluate(() => { window.__pad.axes[1] = -1; }); await frames(page, 2);
  await page.evaluate(() => { window.__pad.axes[1] = 0; }); await frames(page, 2);
  check('the stick moves it back', await page.evaluate(() => document.querySelectorAll('#flow .title .btn')[0].classList.contains('sel')));
  await press(A); await on(page, 'select');
  await press(RIGHT); await press(RIGHT);
  check('A → select; d-pad right twice → the third plate', await page.evaluate(() => document.querySelectorAll('#flow .select .plate')[2].classList.contains('sel')));
  await press(B); await on(page, 'title');
  await press(A); await on(page, 'select');
  check('B goes back, A forward again', true);
  await press(RIGHT); await press(RIGHT); await press(A); await on(page, 'opponent');
  await press(A); await on(page, 'walk'); await beat(page, 'walk1');
  await press(A); await beat(page, 'walk0');
  await press(A); await beat(page, 'stare');
  // The last skip is HELD into the fight: A is the uppercut, and it must not be thrown until it has been let go.
  await hold(A, true);
  await on(page, 'fight');
  await until(page, () => window.__tick.simTicks > 20, undefined, { label: '20 ticks of fight' });
  const heldIn = await page.evaluate(() => ({ punch: window.__sim.state().fighters[0].punch.type, raw: window.__pad.buttons[0] }));
  check('A held through the bell is not a punch', heldIn.raw === true && heldIn.punch === null, JSON.stringify(heldIn));
  styles.medium = await aiProbe(page);
  await hold(A, false); await frames(page, 2);
  await hold(A, true);
  let threw = true;
  try { await page.waitForFunction(() => window.__sim.state().fighters[0].punch.type === 'uppercut', undefined, { timeout: 180000, polling: 'raf' }); } catch { threw = false; }
  await hold(A, false);
  check('…let go and pressed again, it is', threw);
  await press(START);
  await until(page, () => window.__flow.state().paused, undefined, { label: 'pause' });
  check('Start pauses', true);
  await press(DOWN); await press(DOWN); await press(A);
  await on(page, 'title');
  check('d-pad down twice, A → Quit → the title', true);
  await page.close();
}

// ── The difficulty reached the AI ────────────────────────────────────────────
console.log('\n=== Difficulty ===');
const { easy, medium, hard } = styles;
check(`one key: aiDifficulty was ${easy.key} / ${medium.key} / ${hard.key} for Easy / Medium / Hard, the same opponent each time (${easy.opp})`, easy.key === 0 && medium.key === 1 && hard.key === 2 && easy.opp === medium.opp && medium.opp === hard.opp);
check('the AI\'s style differs at each difficulty', easy.style !== medium.style && medium.style !== hard.style && easy.style !== hard.style);
check(`easy makes mistakes (${easy.mistake}) and leaves longer gaps (${easy.gap.toFixed(2)} s) than medium (${medium.mistake}, ${medium.gap.toFixed(2)} s); hard shorter still (${hard.gap.toFixed(2)} s)`, easy.mistake > medium.mistake && easy.gap > medium.gap && medium.gap > hard.gap);

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
