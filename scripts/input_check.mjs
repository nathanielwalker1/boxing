/**
 * input_check.mjs — InputManager (src/ui/input.ts) emits the right FrameInput.
 *
 * Keyboard: WASD → opponent-relative move for the yaw-0 player (faces +x) under
 * the default camera (azimuth 90°, screen-right = +x, screen-up = −z):
 *   D → move.y ≈ +1   A → move.y ≈ −1   W → move.x ≈ −1   S → move.x ≈ +1
 * J/K/L/;/Space set jab/cross/hook/uppercut/block as levels; release clears;
 * a diagonal has magnitude ≤ 1.
 * Touch (?touch=1, CDP multi-touch): a finger on the left half spawns the
 * floating joystick; dragging right gives move.y > 0.5; a second finger on the
 * jab button sets jab while the stick is still held; releasing clears both.
 *
 * Side 0's sim input is pinned to idle so nothing moves; every assertion is on
 * window.__input, never on fighter motion.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady } from './waits.js';
import { check, near, done } from './check.js';

const browser = await chromium.launch();
const logs = [];
const attach = page => {
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
};
const cur = page => page.evaluate(() => window.__input.current());
const EPS = 1e-6;
const idle = i => !i.jab && !i.cross && !i.hook && !i.uppercut && !i.block && near(i.move.x, 0, EPS) && near(i.move.y, 0, EPS);

// ── Keyboard ─────────────────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  attach(page);
  // ai=0: the keyboard mapping is yaw-relative, and the AI's hooks shove the
  // player sideways, so the yaw would drift mid-check.
  await page.goto(`${DEV_URL}/?touch=0&ai=0`, { waitUntil: 'networkidle', timeout: 15_000 });
  await bootReady(page);
  // The mapping is yaw-relative and the real sim walks the player on every held
  // key, so pin side 0's sim input to idle: window.__input still reports the
  // keyboard, but the fighter stands still and the yaw stays at 0.
  await page.evaluate(() => window.__sim.input(0, { move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false }));

  const yaw = await page.evaluate(() => window.__sim.state().fighters[0].yaw);
  check('player starts at yaw 0 (faces +x)', near(yaw, 0, EPS), `yaw=${yaw}`);
  check('idle input is NULL', idle(await cur(page)), JSON.stringify(await cur(page)));
  check('no touch UI without ?touch=1', await page.evaluate(() => !document.getElementById('touch-ui')));

  const moves = [['KeyD', 'y', 1], ['KeyA', 'y', -1], ['KeyW', 'x', -1], ['KeyS', 'x', 1],
                 ['ArrowRight', 'y', 1], ['ArrowUp', 'x', -1]];
  for (const [key, axis, want] of moves) {
    await page.keyboard.down(key);
    const i = await cur(page);
    const other = axis === 'x' ? 'y' : 'x';
    check(`${key} → move.${axis} ≈ ${want}`, near(i.move[axis], want, EPS) && near(i.move[other], 0, EPS), JSON.stringify(i.move));
    check(`${key} appears in keys()`, (await page.evaluate(() => window.__input.keys())).includes(key));
    await page.keyboard.up(key);
    check(`${key} release clears`, idle(await cur(page)), JSON.stringify(await cur(page)));
  }

  const flags = [['KeyJ', 'jab'], ['KeyK', 'cross'], ['KeyL', 'hook'], ['Semicolon', 'uppercut'], ['Space', 'block']];
  for (const [key, flag] of flags) {
    await page.keyboard.down(key);
    const i = await cur(page);
    const others = ['jab', 'cross', 'hook', 'uppercut', 'block'].filter(f => f !== flag);
    check(`${key} → ${flag} only`, i[flag] === true && others.every(f => i[f] === false), JSON.stringify(i));
    await page.keyboard.up(key);
    check(`${key} release clears ${flag}`, (await cur(page))[flag] === false);
  }

  await page.keyboard.down('KeyW');
  await page.keyboard.down('KeyD');
  {
    const i = await cur(page);
    const mag = Math.hypot(i.move.x, i.move.y);
    check('W+D diagonal magnitude ≤ 1', mag <= 1 + EPS && mag > 0.9, `|move|=${mag}`);
    check('W+D points forward-left', i.move.y > 0.5 && i.move.x < -0.5, JSON.stringify(i.move));
  }
  await page.keyboard.up('KeyW');
  await page.keyboard.up('KeyD');

  // Blur releases everything.
  await page.keyboard.down('KeyD');
  await page.keyboard.down('KeyJ');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  check('window blur releases held keys', idle(await cur(page)), JSON.stringify(await cur(page)));
  await page.keyboard.up('KeyD');
  await page.keyboard.up('KeyJ');

  // Camera azimuth changes the mapping: at 0° the camera sits at +x looking
  // along −x, so screen-right is −z = the yaw-0 fighter's left (move.x = −1).
  await page.evaluate(() => { window.__cfg.camAzimuthDeg = 0; });
  await page.keyboard.down('KeyD');
  {
    const i = await cur(page);
    check('azimuth 0: D → move.x ≈ −1', near(i.move.x, -1, EPS) && near(i.move.y, 0, EPS), JSON.stringify(i.move));
  }
  await page.keyboard.up('KeyD');
  await page.evaluate(() => { window.__cfg.camAzimuthDeg = 90; });

  await page.close();
}

// ── Touch ────────────────────────────────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 960, height: 600 }, hasTouch: true });
  attach(page);
  await page.goto(`${DEV_URL}/?touch=1&ai=0`, { waitUntil: 'networkidle', timeout: 15_000 });
  await bootReady(page);
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  const tstate = () => page.evaluate(() => ({ joystick: window.__input.touch.joystick, buttons: window.__input.touch.buttons }));

  check('touch UI mounted with ?touch=1', await page.evaluate(() => !!document.getElementById('touch-ui')));
  check('diamond + block buttons exist', await page.evaluate(() => document.querySelectorAll('#touch-ui .touch-btn').length === 5));
  const jab = await page.evaluate(() => {
    const r = document.querySelector('#touch-ui .touch-btn.jab').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  check('jab button sits on the right half', jab.x > 480, `x=${jab.x}`);
  check('joystick absent before touch', (await tstate()).joystick === null);

  const p1 = { x: 200, y: 320, id: 1 };
  await touch('touchStart', [p1]);
  check('finger on left half creates the joystick', (await tstate()).joystick !== null);
  check('joystick base drawn under the finger', await page.evaluate(() => {
    const r = document.getElementById('touch-joy-base').getBoundingClientRect();
    return Math.abs(r.left + r.width / 2 - 200) < 1 && Math.abs(r.top + r.height / 2 - 320) < 1;
  }));
  const radius = await page.evaluate(() => window.__cfg.joyRadius);
  const p1r = { x: 200 + radius * 0.9, y: 320, id: 1 };
  await touch('touchMove', [p1r]);
  {
    const t = await tstate();
    const i = await cur(page);
    check('drag right → joystick.x > 0.5', t.joystick && t.joystick.x > 0.5, JSON.stringify(t.joystick));
    check('drag right → move.y > 0.5 (toward the opponent)', i.move.y > 0.5 && Math.abs(i.move.x) < 0.05, JSON.stringify(i.move));
  }

  const p2 = { x: jab.x, y: jab.y, id: 2 };
  await touch('touchStart', [p1r, p2]);
  {
    const t = await tstate();
    const i = await cur(page);
    check('second finger on JAB sets jab', i.jab === true && t.buttons.includes('jab'), JSON.stringify({ t, i }));
    check('joystick still held while jab is down', t.joystick !== null && i.move.y > 0.5, JSON.stringify({ t, move: i.move }));
    check('jab button shows pressed', await page.evaluate(() => document.querySelector('#touch-ui .touch-btn.jab').classList.contains('on')));
  }

  // CDP touchEnd lists the points being RELEASED (not the ones that remain).
  await touch('touchEnd', [p2]);         // lift finger 2 (jab), keep the stick
  {
    const t = await tstate();
    const i = await cur(page);
    check('lifting the button finger clears jab, keeps the stick', i.jab === false && t.joystick !== null && i.move.y > 0.5, JSON.stringify({ t, i }));
  }
  await touch('touchEnd', [p1r]);        // lift finger 1
  {
    const t = await tstate();
    check('releasing the stick clears the joystick', t.joystick === null && t.buttons.length === 0, JSON.stringify(t));
    check('touch release → input idle', idle(await cur(page)), JSON.stringify(await cur(page)));
  }

  // Dead zone: a nudge smaller than joyDeadZone × radius reads as zero.
  const dz = await page.evaluate(() => window.__cfg.joyDeadZone);
  await touch('touchStart', [{ x: 300, y: 300, id: 3 }]);
  await touch('touchMove', [{ x: 300 + radius * dz * 0.5, y: 300, id: 3 }]);
  check('nudge inside the dead zone reads as zero', idle(await cur(page)), JSON.stringify(await cur(page)));
  await touch('touchEnd', [{ x: 300 + radius * dz * 0.5, y: 300, id: 3 }]);

  await page.close();
}

await browser.close();

const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
check('console clean', bad.length === 0, bad.map(m => `[${m.type}] ${m.text}`).join(' | '));
done();
