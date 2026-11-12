/**
 * filmstrip.mjs — a scripted exchange, frame by frame, from the play camera
 * (docs/FEEL.md "how to judge a motion change", step 2).
 *
 *   node scripts/filmstrip.mjs exchange            → scripts/output/filmstrip/exchange.png
 *   node scripts/filmstrip.mjs slip_counter before → docs/overhaul/strip_slip_counter_before.png (tracked)
 *
 * Each scenario is tick-exact input for both sides fed through window.__replay
 * (a fresh deterministic sim per frame), so a strip is reproducible and a
 * before/after pair shows the same ticks. Frames also go to
 * scripts/output/filmstrip/frames/<name>_tNN.png for reading at full size.
 * Never hold the stick through a punch in a script: one-tick presses.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';

const at = (o) => { const a = []; for (const [k, v] of Object.entries(o)) a[Number(k)] = v; return a; };
const hold = (a, key, from, to) => { for (let i = from; i <= to; i++) a[i] = { ...(a[i] ?? {}), [key]: true }; return a; };
const flick = (x, t) =>({ [t]: { move: { x, y: 0 } }, [t + 1]: { move: { x, y: 0 } } });

/** dist (m), side-0 script, side-1 script, first tick, last tick, tick step, roster ids (optional). */
export const SCENARIOS = {
  // A 1-2 lands, the dummy answers and misses, a lead hook misses: the everyday exchange.
  exchange: { dist: 0.85, s0: at({ 2: { jab: true }, 10: { cross: true }, 34: { hook: true, move: { x: -1, y: 0 } } }), s1: at({ 22: { jab: true }, 44: { cross: true } }), from: 0, to: 69, step: 3 },
  // The dummy jabs, the player flicks away from it and crosses into the window: slip → counter (→ rocked).
  slip_counter: { dist: 0.79, s0: at({ ...flick(-1, 0), 12: { cross: true } }), s1: at({ 0: { jab: true } }), from: 0, to: 46, step: 2 },
  // The only body shot the baseline has: the dummy slips the wrong way and the cross finds the body.
  body: { dist: 0.79, s0: at({ 0: { cross: true } }), s1: at(flick(-1, 4)), from: 0, to: 46, step: 2 },
  // ── Overhaul scenarios (need the SIM workstream's mechanics) ──
  // The dummy jabs, the player slips to the lead side (which loads the lead hand) and hooks with it: a flush counter.
  flush_counter: { dist: 0.79, s0: at({ ...flick(-1, 0), 12: { hook: true, move: { x: -1, y: 0 } } }), s1: at({ 0: { jab: true } }), from: 0, to: 69, step: 3 },
  // Level held, lead hook: a clean liver shot at t=26; the buckle arrives about 36 ticks later.
  body_hook: { dist: 0.7, s0: hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], from: 0, to: 92, step: 4 },
  // Chest to chest: shovel hook, inside uppercut, then down for a body hook; the dummy hooks back.
  inside: { dist: 0.55, s0: hold(at({ 2: { hook: true, move: { x: -1, y: 0 } }, 14: { uppercut: true, move: { x: 1, y: 0 } }, 30: { hook: true, move: { x: -1, y: 0 } } }), 'level', 26, 44), s1: at({ 20: { hook: true, move: { x: -1, y: 0 } } }), from: 0, to: 69, step: 3 },
  // ── RIG phase 2: the reads (scenario `cfg` = config for this strip only; `over` = fields laid over a side's
  //    state in the VIEW only, RigProbe.override, for states scripted input cannot reach in a second) ──
  // One cross that floors him (damage turned up for the strip), the fall, the struggle on the canvas, the rise.
  knockdown: { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], cfg: { healthDamagePerImpulse: 0.006, camLookY: 0.75, camDistMin: 3.3 }, from: 10, to: 240, step: 10 },
  // The liver shot that drops him when the buckle comes: he folds forward onto a knee and his hands.
  body_knockdown: { dist: 0.7, s0: hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], cfg: { liverDropFrac: 0.3, camLookY: 0.75, camDistMin: 3.3 }, from: 56, to: 286, step: 10 },
  // Block + level held in range: the tie-up, until the referee breaks it.
  clinch: { dist: 0.6, s0: hold(hold([], 'block', 0, 100), 'level', 0, 100), s1: [], from: 0, to: 115, step: 5 },
  // The dummy hooks; the player holds level and flicks: the roll's U under it, then up.
  roll: { dist: 0.75, s0: hold(at(flick(1, 8)), 'level', 0, 30), s1: at({ 0: { hook: true, move: { x: -1, y: 0 } } }), from: 0, to: 46, step: 2 },
  // Block + a lateral flick: the pivot off the planted lead foot.
  pivot: { dist: 0.8, s0: hold(at(flick(1, 4)), 'block', 0, 12), s1: [], from: 0, to: 46, step: 2 },
  // A forward flick, then forward again: the burst — push-off, hop, landing.
  burst: { dist: 1.7, s0: at({ 2: { move: { x: 0, y: 1 } }, 3: { move: { x: 0, y: 1 } }, 7: { move: { x: 0, y: 1 } }, 8: { move: { x: 0, y: 1 } }, 9: { move: { x: 0, y: 1 } } }), s1: [], from: 0, to: 46, step: 2 },
  // Block + a forward flick: the push-off.
  push: { dist: 0.6, s0: hold(at({ 4: { move: { x: 0, y: 1 } }, 5: { move: { x: 0, y: 1 } } }), 'block', 0, 12), s1: [], from: 0, to: 46, step: 2 },
  // The everyday exchange with side 0 drawn spent and marked up (fatigue, flat feet, damage ledgers) against a fresh man.
  tired: { dist: 0.85, s0: at({ 2: { jab: true }, 10: { cross: true } }), s1: at({ 22: { jab: true } }), over: [{ fatigue: 1, flat: 1, stamina: 0.05, staminaCap: 0.45, wear: 0.4, damage: { head: 0.7, body: 0.5, liver: 0.25 } }, null], from: 0, to: 69, step: 3 },

  // ── RIG phase 3: everything that was wired and never filmed. Rows of the sheets below are 8 frames each. ──
  // GRADES: the same cross on the same man, re-labelled for the views (`grade`): a brush, a clean shot, a flush one.
  grade_glancing: { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], grade: 'glancing', from: 16, to: 44, step: 4 },
  grade_clean: { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], grade: 'clean', from: 16, to: 44, step: 4 },
  grade_flush: { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], grade: 'flush', from: 16, to: 44, step: 4 },
  // The same flush cross on a man who is wet (sweat ≈ 1): the spray, under the ring light.
  spray: { dist: 0.79, s0: at({ 2: { cross: true } }), s1: [], grade: 'flush', over: [null, { fatigue: 0.8, staminaCap: 0.5 }], from: 18, to: 46, step: 4 },
  // GUARD: a blocked cross and a blocked hook (block stun by weight); the same cross on a nearly spent guard; the guard broken.
  block_cross: { dist: 0.79, s0: at({ 12: { cross: true } }), s1: hold([], 'block', 0, 60), from: 22, to: 50, step: 4 },
  block_hook: { dist: 0.7, s0: at({ 12: { hook: true, move: { x: -1, y: 0 } } }), s1: hold([], 'block', 0, 60), from: 22, to: 50, step: 4 },
  guard_worn: { dist: 0.79, s0: at({ 12: { cross: true } }), s1: hold([], 'block', 0, 60), over: [null, { guardHp: 0.12 }], from: 22, to: 50, step: 4 },
  guard_break: { dist: 0.79, s0: at({ 12: { cross: true } }), s1: hold([], 'block', 0, 90), cfg: { guardWearPerImpulse: 0.008 }, from: 24, to: 80, step: 8 },
  guard_droop: { dist: 0.85, s0: [], s1: [], over: [{ guardDroop: 0.1, fatigue: 1, flat: 1, staminaCap: 0.5 }, null], from: 0, to: 56, step: 8 },
  // FOOTWORK: two styles at rest then stepping in (the swarmer's quick deep bounce, the outboxer's); flat-footed; on the ropes.
  bounce_swarmer: { dist: 1.9, ids: ['boiler'], s0: at(Object.fromEntries(Array.from({ length: 22 }, (_, i) => [28 + i, { move: { x: 0, y: 1 } }]))), s1: [], from: 0, to: 56, step: 8 },
  bounce_outboxer: { dist: 1.9, ids: ['blue'], s0: at(Object.fromEntries(Array.from({ length: 22 }, (_, i) => [28 + i, { move: { x: 0, y: 1 } }]))), s1: [], from: 0, to: 56, step: 8 },
  flat_feet: { dist: 1.9, s0: at(Object.fromEntries(Array.from({ length: 22 }, (_, i) => [28 + i, { move: { x: 0, y: 1 } }]))), s1: [], over: [{ flat: 1, fatigue: 1 }, null], from: 0, to: 56, step: 8 },
  ropes: { dist: 0.9, s0: [], s1: [], over: [{ ropes: 1, cornered: true }, null], from: 0, to: 56, step: 8 },
  // VARIANTS, attacker in frame, each beside its base punch.
  v_jab: { dist: 0.9, s0: at({ 2: { jab: true } }), s1: [], from: 2, to: 30, step: 4 },
  v_step_jab: { dist: 1.05, s0: at({ 2: { jab: true, move: { x: 0, y: 1 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_retreat_jab: { dist: 0.9, s0: at({ 2: { jab: true, move: { x: 0, y: -1 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_body_jab: { dist: 0.9, s0: hold(at({ 10: { jab: true } }), 'level', 0, 26), s1: [], from: 10, to: 38, step: 4 },
  v_cross: { dist: 0.9, s0: at({ 2: { cross: true } }), s1: [], from: 2, to: 30, step: 4 },
  v_body_cross: { dist: 0.9, s0: hold(at({ 10: { cross: true } }), 'level', 0, 30), s1: [], from: 10, to: 38, step: 4 },
  v_overhand: { dist: 0.9, s0: hold(at({ 10: { cross: true, move: { x: 0, y: 1 } } }), 'level', 0, 30), s1: [], from: 10, to: 38, step: 4 },
  v_hook: { dist: 0.75, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_check_hook: { dist: 0.75, s0: at({ 2: { hook: true, move: { x: -0.5, y: -1 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_shovel_hook: { dist: 0.55, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_rising_hook: { dist: 0.75, s0: hold(at({ 14: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 10), s1: [], from: 10, to: 38, step: 4 },
  v_uppercut: { dist: 0.7, s0: at({ 2: { uppercut: true, move: { x: 1, y: 0 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_inside_uppercut: { dist: 0.55, s0: at({ 2: { uppercut: true, move: { x: 1, y: 0 } } }), s1: [], from: 2, to: 30, step: 4 },
  v_rising_uppercut: { dist: 0.7, s0: hold(at({ 10: { uppercut: true, move: { x: 1, y: 0 } } }), 'level', 0, 18), s1: [], from: 10, to: 38, step: 4 },
  v_feint: { dist: 0.9, s0: hold(at({ 2: { cross: true } }), 'block', 5, 8), s1: [], from: 2, to: 30, step: 4 },
  // GUARD SHAPES by style, at rest (t ≤ 16) and blocking (held from t = 20).
  g_high: { dist: 1.2, ids: ['red'], s0: hold([], 'block', 20, 60), s1: [], from: 4, to: 46, step: 6 },
  g_shell: { dist: 1.2, ids: ['alambre'], s0: hold([], 'block', 20, 60), s1: [], from: 4, to: 46, step: 6 },
  g_peekaboo: { dist: 1.2, ids: ['boiler'], s0: hold([], 'block', 20, 60), s1: [], from: 4, to: 46, step: 6 },
  g_long: { dist: 1.2, ids: ['blue'], s0: hold([], 'block', 20, 60), s1: [], from: 4, to: 46, step: 6 },
  g_low: { dist: 1.2, ids: ['raffle'], s0: hold([], 'block', 20, 60), s1: [], from: 4, to: 46, step: 6 },
  // BODY-SHOT DETAIL, close on the man who takes it: the fold, the elbow dropping to cover, then the buckle; liver side marked.
  // (Side 1 throws it, so the man hit is side 0, whose right — the liver side, the arm that covers — is toward the camera.
  //  Filmed the other way round first: the covering arm and the red flank were on the far side of the body and nothing could be seen.)
  body_detail: { dist: 0.7, s0: [], s1: hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), grade: 'clean', over: [{ damage: { head: 0, body: 0.25, liver: 0.3 } }, null], cfg: { camDistMin: 1.9, camLookY: 1.2 }, focus: 0, from: 22, to: 91, step: 3 },
  // FATIGUE AND DAMAGE on the face and chest, close (lookbook distance) — and the same man from the play camera.
  // (On side 1: the play camera sits behind side 0's shoulder, so HIS face is never seen — the first cut filmed the back of a head.)
  face_close: { dist: 1.3, s0: [], s1: [], over: [null, { fatigue: 1, flat: 1, staminaCap: 0.45, wear: 0.4, damage: { head: 0.75, body: 0.4, liver: 0.2 } }], cfg: { camDistMin: 1.25, camLookY: 1.55 }, focus: 1, from: 10, to: 55, step: 15 },
  face_play: { dist: 1.3, s0: [], s1: [], over: [null, { fatigue: 1, flat: 1, staminaCap: 0.45, wear: 0.4, damage: { head: 0.75, body: 0.4, liver: 0.2 } }], from: 10, to: 55, step: 15 },
  // THE GET-UP, phase by phase, close: the view is told he is down at each phase (a slump cannot be rolled on demand).
  up_down: { dist: 1.2, s0: [], s1: [], over: [null, { down: true, downT: 3, getUp: { phase: 'down', t: 0, tries: 0, owed: true } }], cfg: { camDistMin: 2.6, camLookY: 0.6 }, focus: 1, from: 30, to: 100, step: 10 },
  up_stir: { dist: 1.2, s0: [], s1: [], over: [null, { down: true, downT: 3, getUp: { phase: 'stir', t: 0, tries: 0, owed: true } }], cfg: { camDistMin: 2.6, camLookY: 0.6 }, focus: 1, from: 30, to: 100, step: 10 },
  up_knee: { dist: 1.2, s0: [], s1: [], over: [null, { down: true, downT: 3, getUp: { phase: 'knee', t: 0, tries: 1, owed: true } }], cfg: { camDistMin: 2.6, camLookY: 0.6 }, focus: 1, from: 30, to: 100, step: 10 },
  up_slump: { dist: 1.2, s0: [], s1: [], over: [null, { down: true, downT: 3, getUp: { phase: 'slump', t: 0, tries: 1, owed: true } }], cfg: { camDistMin: 2.6, camLookY: 0.6 }, focus: 1, from: 30, to: 100, step: 10 },
  up_rise: { dist: 1.2, s0: [], s1: [], over: [null, { down: true, downT: 3, getUp: { phase: 'rise', t: 0, tries: 2, owed: true } }], cfg: { camDistMin: 2.6, camLookY: 0.6 }, focus: 1, from: 30, to: 100, step: 10 },
};

/** Sheets: several scenarios stacked as labelled rows (`node scripts/filmstrip.mjs grades after` → docs/overhaul/strip_grades_after.png). */
export const SHEETS = {
  grades: ['grade_glancing', 'grade_clean', 'grade_flush', 'spray'],
  guard: ['block_cross', 'block_hook', 'guard_worn', 'guard_break', 'guard_droop'],
  feet: ['bounce_swarmer', 'bounce_outboxer', 'flat_feet', 'ropes'],
  variants: ['v_jab', 'v_step_jab', 'v_retreat_jab', 'v_body_jab', 'v_cross', 'v_body_cross', 'v_overhand', 'v_hook', 'v_check_hook', 'v_shovel_hook', 'v_rising_hook', 'v_uppercut', 'v_inside_uppercut', 'v_rising_uppercut', 'v_feint'],
  guards: ['g_high', 'g_shell', 'g_peekaboo', 'g_long', 'g_low'],
  getup: ['up_down', 'up_stir', 'up_knee', 'up_slump', 'up_rise'],
  face: ['face_close', 'face_play'],
};

// Sheet rows are READ AT FULL SIZE, so they are short — four frames round the moment that matters — and the camera
// is on the man the row is about. (The first cut was 8 frames a row from the pair camera: at sheet size the target
// was a thumbnail behind the attacker's back and nothing about him could be judged.)
const NEAR = { camDistMin: 1.9, camLookY: 1.3 };
const tune = (names, o) => { for (const n of names) { const sc = SCENARIOS[n]; Object.assign(sc, typeof o === 'function' ? o(sc) : o, { cfg: { ...(sc.cfg ?? {}), ...((typeof o === 'function' ? o(sc) : o).cfg ?? {}) } }); } };
tune(SHEETS.grades, { from: 18, to: 33, step: 5, focus: 1, cfg: NEAR });
tune(['block_cross', 'block_hook', 'guard_worn'], { from: 24, to: 39, step: 5, focus: 1, cfg: NEAR });
tune(['guard_break'], { from: 26, to: 74, step: 16, focus: 1, cfg: NEAR });
tune(['guard_droop'], { from: 10, to: 40, step: 10, focus: 0, cfg: NEAR });
tune(SHEETS.feet, { from: 4, to: 52, step: 16, focus: 0, cfg: { camDistMin: 2.6, camLookY: 0.9 } });
tune(SHEETS.variants, sc => ({ to: sc.from + 18, step: 6, focus: 0, cfg: { camDistMin: 2.3, camLookY: 1.05 } }));
tune(SHEETS.guards, { from: 10, to: 40, step: 30, focus: 0, cfg: NEAR });
tune(SHEETS.getup, { from: 60, to: 100, step: 40 });

// ── POLISH phase (docs/POLISH_RIG.md): one punch, one hand, one range, every 2 ticks from the press to the hand home —
//    first from the play camera on the pair (as Nate sees it), then closer on the puncher, whole body in frame.
//    `node scripts/filmstrip.mjs polish_hook_lead_055 before` → docs/polish/strip_hook_lead_055_before.png
//    (rows 1–2 = the pair, rows 3–4 = the puncher). `polish_all` shoots every one.
const POLISH_LAST = { jab: 20, cross: 32, hook: 36, uppercut: 38 };   // last tick filmed (press at t=2; the hand is home by then, hit or miss)
export const POLISH = {};
for (const [punch, hands] of [['hook', ['lead', 'rear']], ['uppercut', ['lead', 'rear']], ['jab', ['lead']], ['cross', ['rear']]]) {
  for (const hand of hands) for (const [tag, dist] of [['055', 0.55], ['085', 0.85]]) {
    const press = { 2: { [punch]: true, move: { x: hand === 'lead' ? -1 : 1, y: 0 } } };
    const base = { dist, s0: at(press), s1: [], from: 2, to: POLISH_LAST[punch], step: 2 };
    const key = `${punch}_${hand}_${tag}`;
    SCENARIOS[`pp_${key}`] = { ...base };
    SCENARIOS[`pc_${key}`] = { ...base, focus: 0, cfg: { camDistMin: 2.7, camLookY: 0.88 } };
    POLISH[`polish_${key}`] = [`pp_${key}`, `pc_${key}`];
  }
}
// The clinch from the play camera and from a second angle (side-on and above, `cam`), and the variants item 4 asks for.
SCENARIOS.pp_clinch = { dist: 0.6, s0: hold(hold([], 'block', 0, 100), 'level', 0, 100), s1: [], from: 0, to: 132, step: 6 };
SCENARIOS.pc_clinch = { ...SCENARIOS.pp_clinch, cfg: { camFollow: 0, camAzimuthDeg: 90, camElevationDeg: 40, camDistMin: 2.3, camLookY: 1.3 } };   // the second angle: side-on and above (heads and arms from over the top)
POLISH.polish_clinch = ['pp_clinch', 'pc_clinch'];
SCENARIOS.pp_shovel = { dist: 0.55, s0: at({ 2: { hook: true, move: { x: -1, y: 0 } } }), s1: [], from: 2, to: 32, step: 2, focus: 0, cfg: { camDistMin: 2.7, camLookY: 0.88 } };
SCENARIOS.pp_bodyhook = { dist: 0.7, s0: hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30), s1: [], from: 12, to: 46, step: 2, focus: 0, cfg: { camDistMin: 2.7, camLookY: 0.88 } };
POLISH.polish_shovel_lead_055 = ['pp_shovel'];
POLISH.polish_bodyhook_lead_070 = ['pp_bodyhook'];

// ── POLISH phase B (docs/POLISH_RIG.md, items 3 and 2): how a man is hit, hurt, floored; the nerfed punch; the combination. ──
// Scenario fields beyond the old ones: `land` re-labels punchLand for the VIEWS (zone, vary, finisher…), `init` writes fields into
// the SIM state of a side after the settle (a man who starts rocked / winded / worn) — see rig/replay.ts.
// Sheets below go to docs/polish/strip_<sheet>_<label>.png. Before = the five toggles off:
//   PORT=5193 node scripts/filmstrip.mjs react_head before cfg:rigReactV2=false cfg:rigHurtV2=false cfg:rigDownV2=false cfg:rigNerfV2=false cfg:rigComboV2=false
const CLOSE1 = { focus: 1, cfg: { camDistMin: 1.9, camLookY: 1.3 } }, BODY1 = { focus: 1, cfg: { camDistMin: 2.4, camLookY: 1.0 } }, FLOOR = { cfg: { camLookY: 0.75, camDistMin: 3.3 } };
const crossAt = at({ 2: { cross: true } }), bodyHookAt = hold(at({ 12: { hook: true, move: { x: -1, y: 0 } } }), 'level', 0, 30);
// One clean cross (it lands at t=14), re-labelled as each head zone.
for (const z of ['chin', 'jaw', 'temple', 'nose', 'forehead']) SCENARIOS['rz_' + z] = { dist: 0.79, s0: crossAt, s1: [], grade: 'clean', land: { zone: z, vary: 0 }, from: 14, to: 29, step: 3, ...CLOSE1 };
// One clean body hook (t=27), as each body zone.
for (const z of ['solar', 'ribs', 'liver', 'belly']) SCENARIOS['rb_' + z] = { dist: 0.7, s0: bodyHookAt, s1: [], grade: 'clean', land: { zone: z, vary: 0, liver: z === 'liver' }, from: 27, to: 42, step: 3, ...BODY1 };
// The same cross on the chin at each grade and as a finisher, FROM THE PLAY CAMERA: can they be told apart at that distance?
for (const [n, land, grade] of [['glancing', {}, 'glancing'], ['clean', {}, 'clean'], ['flush', {}, 'flush'], ['finisher', { finisher: true, combo: 3 }, 'flush']]) SCENARIOS['rg_' + n] = { dist: 0.79, s0: crossAt, s1: [], grade, land: { zone: 'chin', vary: 0, ...land }, from: 14, to: 29, step: 3 };
// The same flush cross three times, differing only in the seeded vary.
for (const [n, v] of [['m1', -1], ['0', 0], ['p1', 1]]) SCENARIOS['rv_' + n] = { dist: 0.79, s0: crossAt, s1: [], grade: 'flush', land: { zone: 'chin', vary: v }, from: 14, to: 29, step: 3, ...CLOSE1 };
// Rocked and winded by sub-kind: blue starts hurt in the SIM, so what the sim does to his hands and height is in the film.
for (const st of ['legs', 'reach', 'cover']) SCENARIOS['h_' + st] = { dist: 1.3, s0: [], s1: [], init: [null, { hurt: 3, hurtMax: 3, hurtKind: 'head', hurtStyle: st }], from: 8, to: 48, step: 8, ...BODY1 };
for (const st of ['fold', 'elbow', 'knee']) SCENARIOS['h_' + st] = { dist: 1.3, s0: [], s1: [], init: [null, { hurt: 3, hurtMax: 3, hurtKind: 'body', hurtStyle: st }], from: 8, to: 48, step: 8, ...BODY1 };
// A body shot that shows a beat late: the hook lands at t=27 on a worked body, he stands, the fold comes at t=55.
SCENARIOS.h_late = { dist: 0.7, s0: hold(at({ 12: { hook: true, move: { x: 1, y: 0 } } }), 'level', 0, 30), s1: [], init: [null, { damage: { head: 0, body: 0.6, liver: 0 } }], cfg: { bodyHurtLateChance: 1, ...BODY1.cfg }, focus: 1, from: 27, to: 67, step: 8 };
// Knockdowns by kind — real ones, the sim's thresholds moved for the strip so one punch does it. The fall (every 10 ticks), then the get-up.
const KD = { k_flash: { dist: 0.79, s0: crossAt, cfg: { stunBase: 96 }, t0: 14 }, k_heavy: { dist: 0.79, s0: crossAt, cfg: { healthDamagePerImpulse: 0.006 }, t0: 14 },
  k_stiff: { dist: 0.79, s0: crossAt, cfg: { stunBase: 60 }, t0: 14 }, k_crumple: { dist: 0.6, s0: at({ 2: { uppercut: true, move: { x: 1, y: 0 } } }), cfg: { stunBase: 60 }, t0: 17 } };
for (const [n, k] of Object.entries(KD)) {
  SCENARIOS[n] = { dist: k.dist, s0: k.s0, s1: [], cfg: { ...k.cfg, ...FLOOR.cfg }, from: k.t0 + 2, to: k.t0 + 72, step: 10 };
  SCENARIOS[n + '_up'] = { ...SCENARIOS[n], from: n === 'k_flash' ? 50 : 100, to: n === 'k_flash' ? 106 : 240, step: n === 'k_flash' ? 8 : 20 };
}
// Taking a knee by choice: blue is rocked and alone, holds block + level (kneeT ramps for 0.4 s), goes down at t=26, is up at t=234.
const kneeIn = { dist: 1.4, s0: [], s1: hold(hold([], 'block', 2, 60), 'level', 2, 60), init: [null, { hurt: 2.5, hurtMax: 2.5, hurtKind: 'head', hurtStyle: 'legs' }], cfg: FLOOR.cfg, focus: 1 };
SCENARIOS.k_knee = { ...kneeIn, from: 6, to: 76, step: 10 };
SCENARIOS.k_knee_up = { ...kneeIn, from: 120, to: 260, step: 20 };
// The nerfed punch: the same cross thrown clean, and thrown 3 ticks after a jab landed on him (nerf 0.70).
SCENARIOS.n_full = { dist: 0.7, s0: at({ 8: { cross: true } }), s1: [], from: 8, to: 32, step: 4, focus: 0, cfg: { camDistMin: 2.7, camLookY: 0.88 } };
SCENARIOS.n_nerf = { dist: 0.7, s0: at({ 8: { cross: true } }), s1: at({ 0: { jab: true } }), from: 8, to: 32, step: 4, focus: 0, cfg: { camDistMin: 2.7, camLookY: 0.88 } };
// The combination: 1-2-3, the hook is the finisher (t=33). The pair from the play camera, then low on the feet.
const c123 = { dist: 0.8, s0: at({ 2: { jab: true }, 10: { cross: true }, 22: { hook: true, move: { x: -1, y: 0 } } }), s1: [] };
SCENARIOS.c_123 = { ...c123, from: 6, to: 48, step: 3 };
SCENARIOS.c_123_feet = { ...c123, from: 6, to: 48, step: 3, cfg: { camDistMin: 2.6, camLookY: 0.55 } };
POLISH.polish_combo = ['c_123', 'c_123_feet'];
export const PB_SHEETS = {
  react_head: ['rz_chin', 'rz_jaw', 'rz_temple', 'rz_nose', 'rz_forehead'],
  react_body: ['rb_solar', 'rb_ribs', 'rb_liver', 'rb_belly'],
  react_grade: ['rg_glancing', 'rg_clean', 'rg_flush', 'rg_finisher'],
  react_vary: ['rv_m1', 'rv_0', 'rv_p1'],
  react_block: ['block_cross', 'block_hook', 'guard_worn'],
  hurt_rocked: ['h_legs', 'h_reach', 'h_cover'],
  hurt_body: ['h_fold', 'h_elbow', 'h_knee', 'h_late'],
  kd_fall: ['k_flash', 'k_heavy', 'k_knee', 'k_stiff', 'k_crumple'],
  kd_up: ['k_flash_up', 'k_heavy_up', 'k_knee_up'],
  nerf: ['n_full', 'n_nerf'],
};
Object.assign(SHEETS, PB_SHEETS);

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const label = args.find(a => /^(before|after|wip)$/.test(a)) ?? null;
const cfgArgs = args.filter(a => /^cfg:/.test(a));   // `cfg:key=value` sets a config key for the whole run (A/B a toggle from the command line)
const names = args.filter(a => a !== label && !cfgArgs.includes(a)).flatMap(a => (a === 'polish_all' ? Object.keys(POLISH) : [a]));
const run = names.length ? names : Object.keys(SCENARIOS);
const POLISH_OUT = resolve(HERE, '..', 'docs', 'polish');
const FRAMES = resolve(HERE, 'output', 'filmstrip', 'frames');
const OUT = label ? resolve(HERE, '..', 'docs', 'overhaul') : resolve(HERE, 'output', 'filmstrip');
mkdirSync(FRAMES, { recursive: true }); mkdirSync(OUT, { recursive: true });
const W = 480, H = 300, COLS = 6;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 20_000 });
await bootReady(page);
await page.evaluate(() => {
  const c = window.__cfg;
  c.rigQuality = 1;   // the desktop fighter mesh, even though headless software GL picks the low tier for the arena
  c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false;
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;
  c.camDistMin = 2.4; c.camLookY = 1.25;   // close on the pair, as Nate plays it
  window.__focus = -1;
});
await page.evaluate(sets => { for (const [k, v] of sets) window.__cfg[k] = v === 'true' ? true : v === 'false' ? false : Number(v); }, cfgArgs.map(a => a.slice(4).split('=')));

/** Shoot one scenario; returns its frame files and ticks. */
async function shoot(name, sc) {
  const files = [], ticks = [];
  // The scenario's own config, for this strip only.
  const restore = await page.evaluate(over => { const was = {}; for (const k in over) { was[k] = window.__cfg[k]; window.__cfg[k] = over[k]; } return was; }, sc.cfg ?? {});
  // `ids`: the roster fighter on side 0 (the other side is whoever __look pairs him with), e.g. to film a style's guard.
  // Always (re)seat the fighters, so a scenario filmed after another fighter's is not left with him: red v blue unless `ids` says.
  await page.evaluate(id => { window.__look(id, 'rest', 0); }, sc.ids?.[0] ?? 'red');
  await frames(page, 4);   // a new fighter rebuilds his view
  await page.evaluate(focus => { window.__cfg.rigQuality = 1; window.__focus = focus; }, sc.focus ?? -1);
  for (let t = sc.from; t <= sc.to; t += sc.step) {
    // window.__rigReplay (src/rig/replay.ts) runs the same deterministic sim and ALSO feeds every tick's events
    // through the two views, so what the rig draws from events and springs (graded squash, head whip, sweat,
    // the fall, the get-up) is in the frame; then it calls __replay for the host's pose and camera.
    // `grade` re-labels landed punches for the views only, so one punch can be filmed at each grade.
    await page.evaluate(([dist, s0, s1, t, over, grade, land, init]) => (window.__rigReplay ?? window.__replay)(dist, s0.map(x => x ?? {}), t, s1.map(x => x ?? {}), { over, grade, land, init }), [sc.dist, Array.from(sc.s0, x => x ?? null), Array.from(sc.s1, x => x ?? null), t, sc.over ?? [], sc.grade ?? null, sc.land ?? null, sc.init ?? []]);
    await frames(page, 3);
    const f = `${FRAMES}/${name}_t${String(t).padStart(3, '0')}.png`;
    // A capture occasionally stalls on the first frame of a scenario on software GL (seen three times, cause not
    // found — see docs/OVERHAUL_RIG.md); one longer retry, and the stall is reported rather than hidden.
    await page.screenshot({ path: f }).catch(async e => {
      console.error(`  ${name} t=${t}: capture stalled (${String(e.message).split('\n')[0]}); retrying once`);
      await page.screenshot({ path: f, timeout: 120_000 });
    });
    files.push(f); ticks.push(t);
  }
  await page.evaluate(was => { Object.assign(window.__cfg, was); window.__focus = -1; for (const s of [0, 1]) { window.__rig?.[s]?.override?.(null); window.__rig?.[s]?.freeze?.(false); } }, restore);
  return { files, ticks };
}

/** Lay frames out as a grid; `labels[i]` is drawn on frame i. */
async function assemble(files, labels, cols, path) {
  const sheet = await page.evaluate(async ({ imgs, labels, w, h, cols }) => {
    const rows = Math.ceil(imgs.length / cols);
    const canvas = document.createElement('canvas');
    canvas.width = w * cols; canvas.height = h * rows;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.font = '13px monospace';
    for (let i = 0; i < imgs.length; i++) {
      const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = imgs[i]; });
      const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(img, x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.55)'; g.fillRect(x, y, g.measureText(labels[i]).width + 12, 20);
      g.fillStyle = '#fff'; g.fillText(labels[i], x + 6, y + 14);
    }
    return canvas.toDataURL('image/png');
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), labels, w: W, h: H, cols });
  writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
}

for (const name of run) {
  if (POLISH[name]) {
    // A polish strip: each framing laid out over two rows, the framing's name on its first frame.
    const files = [], labels = [];
    let cols = 0;
    const shots = [];
    for (const part of POLISH[name]) { const r = await shoot(part, SCENARIOS[part]); shots.push(r); cols = Math.max(cols, Math.ceil(r.files.length / 2)); }
    shots.forEach((r, k) => {
      r.files.forEach((f, i) => { files.push(f); labels.push(i === 0 ? `${k === 0 ? 'pair' : 'puncher'}  t=${r.ticks[i]}` : `t=${r.ticks[i]}`); });
      for (let i = r.files.length; i < cols * 2; i++) { files.push(r.files[r.files.length - 1]); labels.push(''); }
    });
    mkdirSync(POLISH_OUT, { recursive: true });
    const path = label ? `${POLISH_OUT}/strip_${name.replace(/^polish_/, '')}_${label}.png` : `${OUT}/${name}.png`;
    await assemble(files, labels, cols, path);
    console.log(`${name} → ${path} (${shots.length} framings × ${cols * 2})`);
    continue;
  }
  const rowsOf = SHEETS[name];
  if (rowsOf) {
    // A sheet: one row per scenario, the scenario's name on its first frame.
    const files = [], labels = [];
    let cols = 0;
    for (const rowName of rowsOf) {
      const r = await shoot(rowName, SCENARIOS[rowName]);
      cols = Math.max(cols, r.files.length);
    }
    for (const rowName of rowsOf) {
      const sc = SCENARIOS[rowName];
      let i = 0;
      for (let t = sc.from; t <= sc.to; t += sc.step, i++) { files.push(`${FRAMES}/${rowName}_t${String(t).padStart(3, '0')}.png`); labels.push(i === 0 ? `${rowName}  t=${t}` : `t=${t}`); }
      for (; i < cols; i++) { files.push(files[files.length - 1]); labels.push(''); }
    }
    if (PB_SHEETS[name]) mkdirSync(POLISH_OUT, { recursive: true });
    const path = `${PB_SHEETS[name] && label ? POLISH_OUT : OUT}/${label ? `strip_${name}_${label}` : name}.png`;
    await assemble(files, labels, cols, path);
    console.log(`${name} → ${path} (${rowsOf.length} rows × ${cols})`);
    continue;
  }
  const sc = SCENARIOS[name];
  if (!sc) { console.error(`no scenario or sheet '${name}' (scenarios: ${Object.keys(SCENARIOS).join(', ')}; sheets: ${Object.keys(SHEETS).join(', ')})`); process.exit(2); }
  const { files, ticks } = await shoot(name, sc);
  const path = `${OUT}/${label ? `strip_${name}_${label}` : name}.png`;
  await assemble(files, ticks.map(t => `t=${t}`), COLS, path);
  console.log(`${name} → ${path} (${files.length} frames)`);
}
await browser.close();
if (logs.length) { console.error(`console problems:\n  ${logs.join('\n  ')}`); process.exit(1); }
