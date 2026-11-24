/**
 * anim_film.mjs — the animation rebuild's fixed set of filmstrips, from the PLAY camera.
 *
 *   PORT=5191 node scripts/anim_film.mjs docs/anim/baseline                 every scenario
 *   PORT=5191 node scripts/anim_film.mjs docs/anim/after1 jab_mid hit_head  only these
 *   PORT=5191 node scripts/anim_film.mjs docs/anim/after1 --noside          skip the second (side-on) angle
 *   PORT=5191 node scripts/anim_film.mjs docs/anim/after1 list              print scenario names
 *
 * Per scenario it writes <outDir>/<name>.png (contact sheet, ticks labelled) and full-size frames
 * <outDir>/frames/<name>_tNNN.png; the side-on angle is <name>_side. Deterministic: every frame is a fresh
 * seeded sim through window.__rigReplay (fighters `dist` apart, 30 idle settle ticks, then script[i] per
 * tick), so a before/after pair shows the same ticks. Waits are rendered frames, never sleeps. One-tick
 * presses only: holding the stick through a punch walks the fighter through it.
 * Side 0 (red) is the player; the play camera sits behind his shoulder, so side 1 (blue) is the man whose
 * face is seen. Hand picking: jab = lead and cross = rear regardless of stick; hook/uppercut take the sign of
 * stick x at the press (-1 lead, +1 rear).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';

const at = o => { const a = []; for (const [k, v] of Object.entries(o)) a[Number(k)] = v; return a; };
const hold = (a, key, from, to) => { for (let i = from; i <= to; i++) a[i] = { ...(a[i] ?? {}), [key]: true }; return a; };
const flick = (x, t) => ({ [t]: { move: { x, y: 0 } }, [t + 1]: { move: { x, y: 0 } } });
const stick = (x, y, from, to) => { const a = []; for (let i = from; i <= to; i++) a[i] = { move: { x, y } }; return a; };

export const SCENARIOS = {};
// Punches: press at tick 2, filmed every 2 ticks until the hand is home. jab = lead only, cross = rear only (stick ignored).
const LAST = { jab: 22, cross: 34, hook: 38, upper: 40 };
for (const [tag, dist] of [['mid', 0.84], ['in', 0.55]]) {
  for (const [name, key, punch, x] of [['jab', 'jab', 'jab', 0], ['cross', 'cross', 'cross', 0], ['hook_lead', 'hook', 'hook', -1], ['hook_rear', 'hook', 'hook', 1], ['upper_lead', 'uppercut', 'upper', -1], ['upper_rear', 'uppercut', 'upper', 1]]) {
    SCENARIOS[`${name}_${tag}`] = { dist, s0: at({ 2: { [key]: true, move: { x, y: 0 } } }), s1: [], from: 2, to: LAST[punch], step: 2 };
  }
}
// Every tick of the hooks and uppercuts, with the inertia smoothing on (default) and off: for judging one-tick pops.
for (const [name, key, punch, x] of [['hook_lead', 'hook', 'hook', -1], ['hook_rear', 'hook', 'hook', 1], ['upper_lead', 'uppercut', 'upper', -1], ['upper_rear', 'uppercut', 'upper', 1]]) {
  SCENARIOS[`${name}_tick`] = { dist: 0.84, s0: at({ 2: { [key]: true, move: { x, y: 0 } } }), s1: [], from: 2, to: LAST[punch], step: 1 };
  SCENARIOS[`${name}_tick_off`] = { ...SCENARIOS[`${name}_tick`], cfg: { inertiaOn: false } };
}
// 1-2-hook as fast as the sim accepts a press after a press (the timing fight_film/filmstrip's c_123 uses).
SCENARIOS.combo_12hook = { dist: 0.8, s0: at({ 2: { jab: true }, 10: { cross: true }, 22: { hook: true, move: { x: -1, y: 0 } } }), s1: [], from: 2, to: 50, step: 3 };
// The man hit. Side 1 (blue, face toward the camera) takes it; *_p is the player's own fighter (side 0, seen from behind).
const bodyHook = (x = -1) => hold(at({ 12: { hook: true, move: { x, y: 0 } } }), 'level', 0, 30);
SCENARIOS.hit_head = { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], from: 10, to: 34, step: 2 };
SCENARIOS.hit_head_p = { dist: 0.79, s0: [], s1: at({ 2: { cross: true } }), from: 10, to: 34, step: 2 };
SCENARIOS.hit_body = { dist: 0.7, s0: bodyHook(), s1: [], from: 22, to: 58, step: 3 };
SCENARIOS.hit_body_p = { dist: 0.7, s0: [], s1: bodyHook(), from: 22, to: 58, step: 3 };
// Slip then cross into the window of his jab: a counter.
SCENARIOS.counter = { dist: 0.79, s0: at({ ...flick(-1, 0), 12: { cross: true } }), s1: at({ 0: { jab: true } }), from: 0, to: 46, step: 2 };
// His cross on a held block.
SCENARIOS.block = { dist: 0.79, s0: hold([], 'block', 0, 60), s1: at({ 12: { cross: true } }), from: 8, to: 50, step: 2 };
// blockFeelV2: side 1 (blue, face to camera) holds a high guard and takes the shot; side 0 throws it.
SCENARIOS.block_cross = { dist: 0.8, s0: at({ 12: { cross: true } }), s1: hold([], 'block', 0, 60), from: 10, to: 40, step: 2 };
SCENARIOS.block_hook = { dist: 0.8, s0: at({ 12: { hook: true, move: { x: 1, y: 0 } } }), s1: hold([], 'block', 0, 60), from: 10, to: 44, step: 2 };
// guardReadV2: side 1 holds the guard, side 0 throws (jab, head hook, 1-2-1-2 on a wearing guard, uppercut, body hook).
const GB = hold([], 'block', 0, 90);
SCENARIOS.gr_jab = { dist: 0.8, s0: at({ 12: { jab: true } }), s1: GB, from: 10, to: 30, step: 2 };
SCENARIOS.gr_hook = { dist: 0.8, s0: at({ 12: { hook: true, move: { x: 1, y: 0 } } }), s1: GB, from: 10, to: 44, step: 2 };
SCENARIOS.gr_combo = { dist: 0.8, s0: at({ 12: { jab: true }, 24: { cross: true }, 38: { jab: true }, 50: { cross: true } }), s1: GB, from: 34, to: 72, step: 2 };
SCENARIOS.gr_upper = { dist: 0.65, s0: at({ 12: { uppercut: true, move: { x: 1, y: 0 } } }), s1: GB, from: 10, to: 46, step: 2 };
SCENARIOS.gr_body = { dist: 0.7, s0: hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 40), s1: GB, from: 18, to: 56, step: 3 };
// Footwork: the stick held sideways about a second (60 ticks), and a step in then out.
SCENARIOS.footwork_lateral = { dist: 1.2, s0: stick(1, 0, 2, 62), s1: [], from: 0, to: 84, step: 6 };
SCENARIOS.footwork_in_out = { dist: 1.5, s0: [...stick(0, 0, 0, 1), ...stick(0, 1, 2, 24), ...stick(0, 0, 25, 29), ...stick(0, -1, 30, 52)], s1: [], from: 0, to: 80, step: 5 };
// stanceV2: no input for 60 ticks, every 5 (the idle stance and its life: bounce, breath, weave); *_off is stanceV2 off.
SCENARIOS.idle = { dist: 1.0, s0: [], s1: [], from: 0, to: 60, step: 5 };
SCENARIOS.idle_off = { ...SCENARIOS.idle, cfg: { stanceV2: false } };
SCENARIOS.footwork_in_out_off = { ...SCENARIOS.footwork_in_out, cfg: { stanceV2: false } };
// rhythmV2 (rig/rhythm.ts): 3 s of two men standing at fighting distance, and a walk in then back; *_off is rhythmV2 off.
SCENARIOS.rhythm_idle = { dist: 0.85, s0: [], s1: [], from: 0, to: 180, step: 6 };
SCENARIOS.rhythm_idle_off = { ...SCENARIOS.rhythm_idle, cfg: { rhythmV2: false } };
SCENARIOS.rhythm_walk = { dist: 1.3, s0: [...stick(0, 0, 0, 1), ...stick(0, 1, 2, 40), ...stick(0, 0, 41, 60), ...stick(0, -1, 61, 100)], s1: [], from: 0, to: 120, step: 6 };
SCENARIOS.rhythm_walk_off = { ...SCENARIOS.rhythm_walk, cfg: { rhythmV2: false } };
// One cross that floors him (damage per impulse turned up for the strip: the one existing mechanism, no hook forces a knockdown), the fall, the get-up.
SCENARIOS.knockdown = { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], cfg: { healthDamagePerImpulse: 0.006, camLookY: 0.75, camDistMin: 3.3 }, from: 12, to: 204, step: 8 };
// knockdownV2 falls by what dropped him (fall only: 12 to 100, every 4 ticks).
const KD = { healthDamagePerImpulse: 0.006, camLookY: 0.75, camDistMin: 3.3 };
SCENARIOS.kd_cross = { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], cfg: KD, from: 12, to: 100, step: 4 };
SCENARIOS.kd_hook = { dist: 0.79, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], cfg: KD, from: 12, to: 100, step: 4 };
// The whole fall AND get-up with the lens held on the DOWNED man (focus 1 = side 1's position, the film camera only): 12 to 204 every 8 ticks.
SCENARIOS.kd_cross_full = { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], cfg: KD, from: 12, to: 204, step: 8, focus: 1 };
SCENARIOS.kd_hook_full = { dist: 0.79, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], cfg: KD, from: 12, to: 204, step: 8, focus: 1 };
SCENARIOS.kd_upper ={ dist: 0.65, s0: at({ 2: { uppercut: true, move: { x: 1, y: 0 } } }), s1: [], cfg: KD, from: 12, to: 100, step: 4 };

// The level held (crouch) for a second at fighting distance.
SCENARIOS.crouch = { dist: 1.0, s0: hold([], 'level', 0, 60), s1: [], from: 0, to: 60, step: 6 };
SCENARIOS.crouch_full = { ...SCENARIOS.crouch, cfg: { humanCrouchClip: 1, humanCrouchUpper: 0 } };   // the old full-duck legs, for the on / off pair
// Outcome first (human mode): a cross on a held block, a jab slipped, a 1-2, a body hook, an exchange at the separation.
SCENARIOS.block_cross_h = { dist: 1.0, s0: at({ 2: { cross: true } }), s1: hold([], 'block', 0, 60), from: 2, to: 40, step: 2 };
SCENARIOS.slip_jab = { dist: 1.0, s0: at({ 2: { jab: true } }), s1: at({ ...flick(-1, 5) }), from: 2, to: 30, step: 2 };
SCENARIOS.jab_cross = { dist: 1.0, s0: at({ 2: { jab: true }, 10: { cross: true } }), s1: [], from: 2, to: 46, step: 2 };
SCENARIOS.body_hook_h = { dist: 0.9, s0: hold(at({ 4: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], from: 2, to: 44, step: 3 };
// 2026-11-23 (Nate's list on 3541d22): body straights, the rear uppercut, slips each way, mashed hooks
SCENARIOS.n_body_cross = { dist: 1.0, s0: hold(at({ 4: { cross: true } }), 'level', 0, 30), s1: [], from: 4, to: 34, step: 2 };
SCENARIOS.n_body_jab_cross = { dist: 0.95, s0: hold(at({ 4: { jab: true }, 14: { cross: true } }), 'level', 0, 40), s1: [], from: 4, to: 44, step: 2 };
SCENARIOS.n_rear_upper = { dist: 0.75, s0: at({ 4: { uppercut: true, move: { x: 1, y: 0 } } }), s1: [], from: 4, to: 34, step: 2 };
SCENARIOS.n_slip_left = { dist: 1.2, s0: at({ ...flick(-1, 4) }), s1: [], from: 4, to: 28, step: 2 };
SCENARIOS.n_slip_right = { dist: 1.2, s0: at({ ...flick(1, 4) }), s1: [], from: 4, to: 28, step: 2 };
SCENARIOS.n_mash_hooks = { dist: 0.85, s0: at({ 4: { hook: true, move: { x: -1, y: 0 } }, 8: { hook: true, move: { x: 1, y: 0 } }, 12: { hook: true, move: { x: -1, y: 0 } }, 16: { hook: true, move: { x: 1, y: 0 } } }), s1: [], from: 4, to: 40, step: 2 };
SCENARIOS.close_exchange ={ dist: 0.7, s0: at({ 2: { jab: true }, 22: { hook: true, move: { x: -1, y: 0 } } }), s1: at({ 10: { cross: true }, 30: { uppercut: true, move: { x: 1, y: 0 } } }), from: 2, to: 60, step: 3 };

// outcome_v2 (human mode): the set at the AI's distance (1.2) and close (0.9). Side 0 (red, back to camera) throws at
// side 1 (blue, face to camera); blue holds the block / crouch so his front is seen.
const V2 = { jab: 22, cross: 34, hook: 38, upper: 40 };
for (const D of [1.2, 0.9]) {
  const tag = `_${String(D).replace('.', '')}`;
  SCENARIOS[`v2_idle${tag}`] = { dist: D, s0: [], s1: [], from: 0, to: 30, step: 15 };
  SCENARIOS[`v2_block${tag}`] = { dist: D, s0: [], s1: hold([], 'block', 0, 60), from: 6, to: 30, step: 12 };
  SCENARIOS[`v2_crouch${tag}`] = { dist: D, s0: [], s1: hold([], 'level', 0, 60), from: 0, to: 40, step: 8 };
  for (const [name, key, punch, x] of [['jab', 'jab', 'jab', 0], ['cross', 'cross', 'cross', 0], ['hook_lead', 'hook', 'hook', -1], ['hook_rear', 'hook', 'hook', 1], ['upper_lead', 'uppercut', 'upper', -1], ['upper_rear', 'uppercut', 'upper', 1]]) {
    SCENARIOS[`v2_${name}${tag}`] = { dist: D, s0: at({ 2: { [key]: true, move: { x, y: 0 } } }), s1: [], from: 2, to: V2[punch], step: 4 };
  }
  SCENARIOS[`v2_body_hook${tag}`] = { dist: D, s0: hold(at({ 4: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], from: 4, to: 44, step: 4 };
  SCENARIOS[`v2_jab_cross${tag}`] = { dist: D, s0: at({ 2: { jab: true }, 10: { cross: true } }), s1: [], from: 2, to: 46, step: 4 };
  SCENARIOS[`v2_blocked_cross${tag}`] = { dist: D, s0: at({ 2: { cross: true } }), s1: hold([], 'block', 0, 60), from: 2, to: 38, step: 4 };
  SCENARIOS[`v2_slipped_jab${tag}`] = { dist: D, s0: at({ 2: { jab: true } }), s1: at({ ...flick(-1, 5) }), from: 2, to: 30, step: 4 };
}
// the struck head, closer: a clean cross landing, every tick round the contact
SCENARIOS.v2_cross_head_close = { dist: 1.0, s0: at({ 2: { cross: true } }), s1: [], from: 18, to: 28, step: 1, cfg: { camDistMin: 1.3, camLookY: 1.55 } };
SCENARIOS.v2_cross_head_close_off = { ...SCENARIOS.v2_cross_head_close, cfg: { ...SCENARIOS.v2_cross_head_close.cfg, impactOn: false } };   // the impact layer off: the on / off pair

// outcome_v3 (m1 body): 1.1 m and 0.85 m; plus the cross whiff from just outside its measured band and the close head
for (const D of [1.1, 0.85]) {
  const tag = `_${String(D).replace('.', '')}`;
  SCENARIOS[`v3_idle${tag}`] = { dist: D, s0: [], s1: [], from: 0, to: 30, step: 15 };
  SCENARIOS[`v3_block${tag}`] = { dist: D, s0: [], s1: hold([], 'block', 0, 60), from: 6, to: 30, step: 12 };
  SCENARIOS[`v3_crouch${tag}`] = { dist: D, s0: [], s1: hold([], 'level', 0, 60), from: 0, to: 40, step: 10 };
  for (const [name, key, punch, x] of [['jab', 'jab', 'jab', 0], ['cross', 'cross', 'cross', 0], ['hook_lead', 'hook', 'hook', -1], ['hook_rear', 'hook', 'hook', 1], ['upper_lead', 'uppercut', 'upper', -1], ['upper_rear', 'uppercut', 'upper', 1]]) {
    SCENARIOS[`v3_${name}${tag}`] = { dist: D, s0: at({ 2: { [key]: true, move: { x, y: 0 } } }), s1: [], from: 2, to: V2[punch], step: 4 };
  }
  SCENARIOS[`v3_body_hook${tag}`] = { dist: D, s0: hold(at({ 4: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], from: 4, to: 40, step: 4 };
  SCENARIOS[`v3_jab_cross${tag}`] = { dist: D, s0: at({ 2: { jab: true }, 10: { cross: true } }), s1: [], from: 2, to: 46, step: 4 };
  SCENARIOS[`v3_blocked_cross${tag}`] = { dist: D, s0: at({ 2: { cross: true } }), s1: hold([], 'block', 0, 60), from: 2, to: 34, step: 4 };
  SCENARIOS[`v3_slipped_jab${tag}`] = { dist: D, s0: at({ 2: { jab: true } }), s1: at({ ...flick(-1, 5) }), from: 2, to: 26, step: 4 };
}
SCENARIOS.v3_cross_whiff = { dist: 1.2, s0: at({ 2: { cross: true } }), s1: [], from: 10, to: 30, step: 2 };   // band far end 1.14 m
SCENARIOS.v3_cross_head_close = { dist: 1.0, s0: at({ 2: { cross: true } }), s1: [], from: 20, to: 26, step: 1, cfg: { camDistMin: 1.3, camLookY: 1.55 } };
SCENARIOS.v3_cross_head_close_off = { ...SCENARIOS.v3_cross_head_close, cfg: { ...SCENARIOS.v3_cross_head_close.cfg, impactOn: false } };

// outcome_v4: the procedural slips (blue defends an incoming jab at 1.1 m) and the trimmed uppercuts
{
  const J = at({ 2: { jab: true } }), back = { 5: { move: { x: 0, y: -1 } }, 6: { move: { x: 0, y: -1 } } };
  SCENARIOS.v4_slip_left = { dist: 1.1, s0: J, s1: at({ ...flick(-1, 5) }), from: 4, to: 28, step: 3 };
  SCENARIOS.v4_slip_right = { dist: 1.1, s0: J, s1: at({ ...flick(1, 5) }), from: 4, to: 28, step: 3 };
  SCENARIOS.v4_pull = { dist: 1.1, s0: J, s1: at(back), from: 4, to: 28, step: 3 };
  SCENARIOS.v4_roll = { dist: 1.1, s0: J, s1: hold(at({ ...flick(-1, 5) }), 'level', 0, 9), from: 4, to: 28, step: 3 };
  SCENARIOS.v4_upper_lead = { dist: 0.85, s0: at({ 2: { uppercut: true, move: { x: -1, y: 0 } } }), s1: [], from: 2, to: 40, step: 3 };
  SCENARIOS.v4_upper_rear = { dist: 0.85, s0: at({ 2: { uppercut: true, move: { x: 1, y: 0 } } }), s1: [], from: 2, to: 40, step: 3 };
  SCENARIOS.v4_jab_cross = { dist: 1.1, s0: at({ 2: { jab: true }, 10: { cross: true } }), s1: [], from: 2, to: 46, step: 4 };
}

const SIDE = { camFollow: 0, camAzimuthDeg: 90, camElevationDeg: 12, camDistMin: 2.6, camLookY: 1.05 };

const args = process.argv.slice(2);
const noSide = args.includes('--noside'), sideOnly = args.includes('--sideonly');
const plain = args.filter(a => !a.startsWith('--'));
const outDir = resolve(plain[0] ?? 'docs/anim/baseline');
const names = plain.slice(1);
if (names.includes('list')) { console.log(Object.keys(SCENARIOS).join(' ')); process.exit(0); }
for (const n of names) if (!SCENARIOS[n]) { console.error(`no scenario '${n}' (${Object.keys(SCENARIOS).join(' ')})`); process.exit(2); }
const run = names.length ? names : Object.keys(SCENARIOS);
const FRAMES = resolve(outDir, 'frames');
mkdirSync(FRAMES, { recursive: true });

const W = 640, H = 400, COLS = 5;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
// --human: the mocap fighters (?human=1); --raw: with cfg.humanRawPose (the pure clips, the "natural" reference)
const HUMAN = args.includes('--human');
await page.goto(`${DEV_URL}/?ai=0${HUMAN ? '&human=1&menu=0' : ''}`, { waitUntil: HUMAN ? 'domcontentloaded' : 'networkidle', timeout: 60_000 });
await bootReady(page);
if (HUMAN) await page.waitForFunction(() => typeof window.__humanProbe === 'function', undefined, { timeout: 150_000 });
if (args.includes('--raw')) await page.evaluate(() => { window.__cfg.humanRawPose = true; });

// fps: headless software GL, reported not asserted.
await page.evaluate(() => { window.__cfg.debugFps = true; });
await frames(page, 70);
const fps = await page.evaluate(() => window.__fps ?? null);
console.log(`fps (headless software GL, ${W}x${H} @2x; NOT the desktop number) → ${fps ? `${fps.fps} fps, ${fps.msAvg} ms avg, ${fps.calls} calls, ${fps.tris} tris` : 'no sample'}`);

await page.evaluate(() => {
  const c = window.__cfg;
  c.rigQuality = 1; c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false;
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;   // the lens placed, not chasing
  c.camDistMin = 2.4; c.camLookY = 1.25;   // the play camera, as Nate fights from
  window.__focus = -1;
});

async function shoot(file, sc, camCfg) {
  const files = [], ticks = [];
  const restore = await page.evaluate(over => { const was = {}; for (const k in over) { was[k] = window.__cfg[k]; window.__cfg[k] = over[k]; } return was; }, { ...(sc.cfg ?? {}), ...(camCfg ?? {}) });
  await page.evaluate(() => { window.__look('red', 'rest', 0); });
  await frames(page, 4);
  await page.evaluate(fo => { window.__cfg.rigQuality = 1; window.__focus = fo; }, sc.focus ?? -1);
  for (let t = sc.from; t <= sc.to; t += sc.step) {
    await page.evaluate(([dist, s0, s1, t]) => (window.__rigReplay ?? window.__replay)(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {}), {}), [sc.dist, Array.from(sc.s0, x => x ?? null), Array.from(sc.s1, x => x ?? null), t]);
    await frames(page, 3);
    const f = `${FRAMES}/${file}_t${String(t).padStart(3, '0')}.png`;
    await page.screenshot({ path: f }).catch(() => page.screenshot({ path: f, timeout: 120_000 }));
    files.push(f); ticks.push(t);
  }
  await page.evaluate(was => { Object.assign(window.__cfg, was); window.__focus = -1; for (const s of [0, 1]) { window.__rig?.[s]?.override?.(null); window.__rig?.[s]?.freeze?.(false); } }, restore);
  return { files, ticks };
}

async function sheet(files, labels, path) {
  const data = await page.evaluate(async ({ imgs, labels, w, h, cols }) => {
    const rows = Math.ceil(imgs.length / cols);
    const canvas = document.createElement('canvas'); canvas.width = w * cols; canvas.height = h * rows;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height); g.font = '15px monospace';
    for (let i = 0; i < imgs.length; i++) {
      const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = imgs[i]; });
      const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(img, x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, g.measureText(labels[i]).width + 12, 22);
      g.fillStyle = '#fff'; g.fillText(labels[i], x + 6, y + 16);
    }
    return canvas.toDataURL('image/png');
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), labels, w: W, h: H, cols: COLS });
  writeFileSync(path, Buffer.from(data.split(',')[1], 'base64'));
}

for (const name of run) {
  const sc = SCENARIOS[name];
  for (const [suffix, cam] of noSide ? [['', null]] : sideOnly ? [['_side', SIDE]] : [['', null], ['_side', SIDE]]) {
    const file = name + suffix;
    const { files, ticks } = await shoot(file, sc, cam);
    await sheet(files, ticks.map(t => `${file} t=${t}`), `${outDir}/${file}.png`);
    console.log(`${file} → ${outDir}/${file}.png (${files.length} frames, ticks ${ticks[0]}–${ticks[ticks.length - 1]} every ${sc.step})`);
  }
}
await browser.close();
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
console.log('console clean');
