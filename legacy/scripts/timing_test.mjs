/**
 * timing_test.mjs — punch timing is authored in milliseconds (Stage 18b part 2).
 *
 * The thing under test is the DERIVATION. cockEnd/peakAt used to be authored as
 * fractions in rig.js's PUNCHES table; they are now computed from each punch's
 * cockMs/extendMs/recoverMs. Everything downstream — the pose blend, the impact
 * schedule, the vulnerability curve — still reads those two fractions, so if the
 * derivation drifts from the milliseconds, three systems quietly disagree with
 * the punch timer without anything erroring.
 *
 * Asserts against the shipped functions through window.__rig, never against a
 * re-derivation of the same arithmetic in this file.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, punchIdle } from './waits.js';

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await bootReady(page);

const TYPES = ['jab', 'cross', 'hook', 'uppercut'];
const results = [];
function check(label, pass, detail = '') {
  results.push({ label, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
}
const peek = (fn, arg) => page.evaluate(fn, arg);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Isolate: the dummy neither moves nor throws, so nothing perturbs the player's
// punch timer while it is being measured.
await peek(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__config.dummyMoveSpeed      = 0;
  window.__config.dummyAttackDelayMin = 999;
  window.__config.dummyAttackDelayMax = 999;
  sc.dummy.attackTimer = 999;
});

// ─── 1. cockEnd / peakAt are derived from the milliseconds ───────────────────
console.log('\n=== 1. Derived phase boundaries ===');
const derived = await peek((types) => types.map(t => {
  const c  = window.__config;
  const ph = window.__rig.punchPhases(t);
  const tm = window.__rig.punchTiming(t);
  const totalMs = c[`${t}CockMs`] + c[`${t}ExtendMs`] + c[`${t}RecoverMs`];
  return {
    t, cockMs: c[`${t}CockMs`], extendMs: c[`${t}ExtendMs`], recoverMs: c[`${t}RecoverMs`],
    totalMs, phaseTotalMs: ph.total * 1000,
    cockEnd: tm.cockEnd, peakAt: tm.peakAt,
    peakProgress: window.__rig.peakProgress(t),
  };
}), TYPES);

for (const d of derived) {
  console.log(`     ${d.t.padEnd(9)} ${String(d.cockMs).padStart(3)} + ${String(d.extendMs).padStart(3)} + ` +
              `${String(d.recoverMs).padStart(3)} = ${String(d.totalMs).padStart(3)} ms  →  ` +
              `cockEnd ${d.cockEnd.toFixed(4)}  peakAt ${d.peakAt.toFixed(4)}`);
  check(`${d.t}: cockEnd = cockMs / total`,
    near(d.cockEnd, d.cockMs / d.totalMs, 1e-9),
    `${d.cockEnd} vs ${d.cockMs / d.totalMs}`);
  check(`${d.t}: peakAt = (cockMs + extendMs) / total`,
    near(d.peakAt, (d.cockMs + d.extendMs) / d.totalMs, 1e-9),
    `${d.peakAt} vs ${(d.cockMs + d.extendMs) / d.totalMs}`);
  check(`${d.t}: peakProgress() agrees with punchTiming().peakAt`,
    near(d.peakProgress, d.peakAt, 1e-12));
  check(`${d.t}: punchPhases total matches the authored sum`,
    near(d.phaseTotalMs, d.totalMs, 1e-6), `${d.phaseTotalMs.toFixed(3)} vs ${d.totalMs}`);
}

// The seeded ordering IS the spec (jab shortest telegraph → uppercut longest),
// and a short extension relative to the cock is the point of the whole change.
const cocks = Object.fromEntries(derived.map(d => [d.t, d.cockMs]));
check('cock ordering is jab < cross < hook < uppercut (the telegraph gradient)',
  cocks.jab < cocks.cross && cocks.cross < cocks.hook && cocks.hook < cocks.uppercut,
  JSON.stringify(cocks));
check('every punch cocks for longer than it extends',
  derived.every(d => d.cockMs > d.extendMs),
  derived.map(d => `${d.t} ${d.cockMs}/${d.extendMs}`).join(', '));

// ─── 2. punchTimeScale multiplies durations, not shapes ──────────────────────
console.log('\n=== 2. punchTimeScale scales time, leaves the shape alone ===');
const scaled = await peek((types) => {
  const c = window.__config;
  const at = s => {
    c.punchTimeScale = s;
    return types.map(t => ({
      t, total: window.__rig.punchTotalSeconds(t), ...window.__rig.punchTiming(t),
    }));
  };
  const one = at(1), two = at(2), half = at(0.5);
  c.punchTimeScale = 1;
  return { one, two, half };
}, TYPES);

for (let i = 0; i < TYPES.length; i++) {
  const a = scaled.one[i], b = scaled.two[i], h = scaled.half[i];
  check(`${a.t}: ×2 doubles the total duration`,
    near(b.total, a.total * 2, 1e-9), `${a.total.toFixed(4)}s → ${b.total.toFixed(4)}s`);
  check(`${a.t}: ×0.5 halves it`, near(h.total, a.total * 0.5, 1e-9));
  check(`${a.t}: the phase fractions are invariant to the scale`,
    near(b.cockEnd, a.cockEnd, 1e-12) && near(b.peakAt, a.peakAt, 1e-12) &&
    near(h.cockEnd, a.cockEnd, 1e-12) && near(h.peakAt, a.peakAt, 1e-12));
}

// ─── 3. Low stamina stretches the COCK, not the whole punch ──────────────────
// This is the part that changed meaning: "telegraphed when gassed" is a slower
// pull-back, not a strike thrown in slow motion. So the cock grows by the full
// multiplier, extension and recovery don't move at all, and both derived
// boundaries shift later as a consequence.
console.log('\n=== 3. Low-stamina windup multiplier stretches the cock only ===');
const gassed = await peek((types) => {
  const m = window.__config.lowStaminaWindupMultiplier;
  return types.map(t => {
    const base = window.__rig.punchPhases(t, 1);
    const slow = window.__rig.punchPhases(t, m);
    return {
      t, m,
      cockRatio:    slow.cock / base.cock,
      extendSame:   slow.extend === base.extend,
      recoverSame:  slow.recover === base.recover,
      totalDelta:   (slow.total - base.total) * 1000,
      expectDelta:  base.cock * (m - 1) * 1000,
      baseCockEnd:  base.cockEnd, slowCockEnd: slow.cockEnd,
      basePeakAt:   base.peakAt,  slowPeakAt:  slow.peakAt,
    };
  });
}, TYPES);

for (const g of gassed) {
  console.log(`     ${g.t.padEnd(9)} cock ×${g.cockRatio.toFixed(2)}  ` +
              `total +${g.totalDelta.toFixed(0)} ms  ` +
              `cockEnd ${g.baseCockEnd.toFixed(3)}→${g.slowCockEnd.toFixed(3)}  ` +
              `peakAt ${g.basePeakAt.toFixed(3)}→${g.slowPeakAt.toFixed(3)}`);
  check(`${g.t}: cock is stretched by exactly lowStaminaWindupMultiplier`,
    near(g.cockRatio, g.m, 1e-9), `×${g.cockRatio}`);
  check(`${g.t}: extension and recovery are untouched by low stamina`,
    g.extendSame && g.recoverSame);
  check(`${g.t}: the extra duration is exactly the extra cock`,
    near(g.totalDelta, g.expectDelta, 1e-6));
  check(`${g.t}: both derived boundaries move later when gassed`,
    g.slowCockEnd > g.baseCockEnd && g.slowPeakAt > g.basePeakAt);
}

// ─── 4. The live punch agrees with the table ─────────────────────────────────
// The derivation being right on paper is not the same as the fighter using it:
// punchTimer has to be seeded with the summed phases, and the pose has to be
// posed against the same boundaries.
console.log('\n=== 4. A thrown punch runs for its authored duration ===');
for (const t of TYPES) {
  const arm = t === 'cross' ? 'right' : 'left';
  const live = await peek(([type, a]) => {
    const sc = window.__game.scene.keys.RingScene;
    sc.fighter.stamina = window.__config.staminaMax;   // not gassed
    sc.fighter.startPunch(a, type, 0);
    return {
      timer: sc.fighter.punchTimer,
      dur:   sc.fighter._punchDuration,
      mult:  sc.fighter._windupMult,
      want:  window.__rig.punchTotalSeconds(type),
    };
  }, [t, arm]);
  check(`${t}: punchTimer is seeded with the summed phase durations`,
    near(live.timer, live.want, 1e-9) && near(live.dur, live.want, 1e-9),
    `${(live.timer * 1000).toFixed(1)} ms vs ${(live.want * 1000).toFixed(1)} ms`);
  check(`${t}: a full-stamina throw locks in windupMult 1`, live.mult === 1);
  await punchIdle(page);
}

// A gassed throw takes the stretched duration and poses against the stretched
// boundaries — the two must come from the same multiplier or the arm reaches
// full extension at a different instant than the impact is scheduled for.
const gassedThrow = await peek(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.stamina = 0;
  sc.fighter.startPunch('left', 'hook', 0);
  const st = sc.fighter._punchState(true);
  return {
    mult:  sc.fighter._windupMult,
    dur:   sc.fighter._punchDuration,
    want:  window.__rig.punchTotalSeconds('hook', window.__config.lowStaminaWindupMultiplier),
    peakP: st.p,
    wantPeak: window.__rig.peakProgress('hook', window.__config.lowStaminaWindupMultiplier),
    posedWith: st.windupMult,
  };
});
check('a gassed throw stretches only its cock (duration matches the stretched total)',
  near(gassedThrow.dur, gassedThrow.want, 1e-9),
  `${(gassedThrow.dur * 1000).toFixed(0)} ms vs ${(gassedThrow.want * 1000).toFixed(0)} ms`);
check('a gassed punch is POSED against the same stretched boundaries it is timed by',
  gassedThrow.posedWith === gassedThrow.mult && near(gassedThrow.peakP, gassedThrow.wantPeak, 1e-12),
  `posed with ×${gassedThrow.posedWith}, peak at p=${gassedThrow.peakP.toFixed(4)}`);
await peek(() => { window.__game.scene.keys.RingScene.fighter.stamina = window.__config.staminaMax; });
await punchIdle(page);

// ─── 5. Measured wall-to-wall duration of a real punch ───────────────────────
// Everything above is arithmetic. This one watches the timer actually drain, so
// a punch that is seeded correctly but stepped with the wrong dt still fails.
console.log('\n=== 5. Measured: the punch timer drains over the authored window ===');
const measured = await peek(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__t0 = window.__tick.gameTime;
  sc.fighter.startPunch('left', 'cross', 0);
  window.__watch = [];
  return window.__rig.punchTotalSeconds('cross');
});
await gameTime(page, measured * 1.4);
const elapsed = await peek(() => ({
  done: window.__game.scene.keys.RingScene.fighter.punchTimer <= 0,
}));
check('a cross has fully unwound after 1.4× its authored duration of game time',
  elapsed.done, `expected ${(measured * 1000).toFixed(0)} ms of animation`);

// ─── 6. The retired knobs are gone from the punch path ───────────────────────
console.log('\n=== 6. Retired: per-punch speed multipliers ===');
const retired = await peek((types) => {
  const c = window.__config;
  const before = types.map(t => window.__rig.punchTotalSeconds(t));
  const saved  = types.map(t => c[`${t}Speed`]);
  types.forEach(t => { c[`${t}Speed`] = 0.25; });
  const after = types.map(t => window.__rig.punchTotalSeconds(t));
  types.forEach((t, i) => { c[`${t}Speed`] = saved[i]; });
  return { before, after };
}, TYPES);
check('changing the retired <type>Speed values no longer changes any duration',
  retired.before.every((v, i) => near(v, retired.after[i], 1e-12)),
  `${retired.before.map(v => v.toFixed(3))} → ${retired.after.map(v => v.toFixed(3))}`);

// The legacy shim: scripts that stretch punches by writing punchDuration still
// stretch them. Documented as a deprecation path, so it is pinned rather than
// left to be discovered when a test silently stops stretching anything.
const shim = await peek(() => {
  const c = window.__config;
  const base = window.__rig.punchTotalSeconds('jab');
  c.punchDuration = 0.7;                       // twice the 0.35 baseline
  const stretched = window.__rig.punchTotalSeconds('jab');
  const readBack  = c.punchDuration;
  const scale     = c.punchTimeScale;
  c.punchTimeScale = 1;
  return { base, stretched, readBack, scale };
});
check('the legacy config.punchDuration shim still scales the whole system',
  near(shim.stretched, shim.base * 2, 1e-9) && near(shim.readBack, 0.7, 1e-9) && near(shim.scale, 2, 1e-9),
  `jab ${(shim.base * 1000).toFixed(0)} → ${(shim.stretched * 1000).toFixed(0)} ms at punchDuration 0.7`);

// ─── Report ──────────────────────────────────────────────────────────────────
await frames(page, 2);
await browser.close();
const failed = results.filter(r => !r.pass);
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.label}`));
  process.exit(1);
}
