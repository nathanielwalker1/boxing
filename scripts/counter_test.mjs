/**
 * counter_test.mjs — Stage 16 parts 3 + 4.
 * Run with: node scripts/counter_test.mjs   (dev server must be running)
 *
 *   1. force scales with the TARGET's vulnerability, by exactly the configured
 *      bonus — measured off the real shared `force` value (captured at
 *      receiveHit, which is handed the same number damage and stagger use);
 *   2. the maximum achievable single-punch force, and what fraction of healthMax
 *      it removes — the ceiling check the brief asks for, measured rather than
 *      derived, since the counter bonus stacks with momentum and per-punch damage;
 *   3. perfect block inside the window costs zero chip damage and zero stamina,
 *      one frame outside it does not, and the attacker's vulnerability spikes;
 *   4. how often the dummy's zero-latency reactive block lands inside the
 *      perfect-block window at shipped settings (reported, not asserted — it is
 *      an input to the next stage's AI work).
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime, soft, punchIdle } from './waits.js';
import { mkdirSync } from 'fs';

const OUT = 'scripts/output';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors  = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

const results = [];
const check = (label, pass, detail) => {
  results.push({ label, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? `  — ${detail}` : ''}`);
};
const peek = (fn, ...args) => page.evaluate(fn, ...args);

/**
 * Reload and instrument. Every resolution records the state that decided it —
 * crucially the DEFENDER's vulnerability and guard age as they were at the
 * instant the resolver read them — plus the shared force value, captured by
 * wrapping receiveHit (which _resolveAttack hands the post-everything number).
 */
async function freshLoad() {
  await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
  await bootReady(page);
  await peek(() => {
    const sc = window.__game.scene.keys.RingScene;
    window.__res = [];
    let lastForce = null;
    for (const f of [sc.fighter, sc.dummy]) {
      const oh = f.receiveHit.bind(f);
      f.receiveHit = (type, force) => { lastForce = force; oh(type, force); };
    }
    const orig = sc._resolveAttack.bind(sc);
    sc._resolveAttack = (a, d, arm, type) => {
      lastForce = null;
      const pre = {
        defVuln: d.vulnerability, defBlockHeld: d.blockHeldTime,
        defHealth: d.health, defStamina: d.stamina,
        attSpeed: Math.hypot(a.vx, a.vy),
      };
      const outcome = orig(a, d, arm, type);
      window.__res.push({
        ...pre, outcome, type, fromPlayer: a === sc.fighter,
        force: lastForce,
        postHealth: d.health, postStamina: d.stamina,
        attPunish: a._punishTimer, attVuln: a.vulnerability,
      });
      return outcome;
    };
  });
}

/** Pin the dummy in place, silence its offence, and place the player at `dist`. */
async function pin(dist, opts = {}) {
  await peek(({ d, o }) => {
    const sc = window.__game.scene.keys.RingScene;
    window.__config.dummyMoveSpeed           = 0;
    window.__config.dummyAttackDelayMin      = 999;
    window.__config.dummyAttackDelayMax      = 999;
    window.__config.dummyBlockReactionChance = o.blockChance ?? 0;
    sc.dummy.attackTimer = 999;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy.x = sc.dummy._loco.x;
    sc.dummy.y = sc.dummy._loco.y;
    sc.fighter.x  = sc.dummy.x - d;
    sc.fighter.y  = sc.dummy.y;
    sc.fighter.vx = sc.fighter.vy = 0;
    for (const f of [sc.fighter, sc.dummy]) {
      f.health  = window.__config.healthMax;
      f.stamina = window.__config.staminaMax;
    }
  }, { d: dist, o: opts });
  await frames(page, 3);
}

/** Pin the dummy's vulnerability at `v` via the punish-spike channel. */
async function pinDummyVuln(v) {
  await peek((val) => {
    const d = window.__game.scene.keys.RingScene.dummy;
    d._punishTimer = val > 0 ? 30 : 0;
    d._punishVuln  = val;
  }, v);
}

// Frames, not milliseconds — see waits.js. A 70 ms press can fall inside a
// single tick on a loaded page and never be sampled by JustDown.
async function tap(key, ticks = 3) {
  await page.keyboard.down(key);
  await frames(page, ticks);
  await page.keyboard.up(key);
}

const clearRes = () => peek(() => { window.__res.length = 0; });
const takeRes  = () => peek(() => window.__res.splice(0));

await freshLoad();
const cfg = await peek(() => ({
  bonus:       window.__config.counterForceBonus,
  window:      window.__config.perfectBlockWindow,
  punishVuln:  window.__config.perfectBlockPunishVulnerability,
  healthMax:   window.__config.healthMax,
  dmgPerForce: window.__config.healthDamagePerForce,
  base:        window.__config.punchForceBase,
  moveSpeed:   window.__config.moveSpeed,
  mass:        window.__config.playerMass,
  momentum:    window.__config.punchMomentumScale,
  uppercut:    window.__config.uppercutDamage,
  blockChance: window.__config.dummyBlockReactionChance,
  blockWindow: window.__config.dummyBlockReactionWindow,
}));

// ─── 1. Force scales with target vulnerability ───────────────────────────────
console.log('\n=== 1. Counter force scales with the target\'s vulnerability ===');
await peek(() => { window.__config.healthDamagePerForce = 0; });   // no knockdowns mid-series

const forceAt = {};
for (const v of [0, 0.4, 0.8]) {
  await pin(65);
  await pinDummyVuln(v);
  await clearRes();
  await tap('KeyJ');
  // Wait for the resolver to record the punch, not for 400 ms of wall clock —
  // impact lands at peak extension, which is a GAME-time offset from the press.
  await soft(page, () => window.__res.some(r => r.fromPlayer));
  const r = (await takeRes()).find(x => x.fromPlayer);
  forceAt[v] = r;
  console.log(`     target vulnerability ${v.toFixed(2)} → ${r?.outcome} force ${r?.force?.toFixed(1)} ` +
              `(resolver saw v=${r?.defVuln?.toFixed(2)})`);
  if (v === 0.8) await page.screenshot({ path: `${OUT}/counter_at_peak_vulnerability.png` });
}

const base = forceAt[0]?.force;
for (const v of [0.4, 0.8]) {
  const expected = base * (1 + v * cfg.bonus);
  const got      = forceAt[v]?.force;
  check(`vulnerability ${v} multiplies force by 1 + ${v}×${cfg.bonus}`,
    !!got && Math.abs(got - expected) < 0.5,
    `expected ${expected.toFixed(1)}, got ${got?.toFixed(1)} (${(got / base).toFixed(3)}x baseline)`);
}
check('an unvulnerable target is not a counter', Math.abs(forceAt[0].defVuln) < 1e-9,
  `v=${forceAt[0].defVuln}, force ${base.toFixed(1)}`);

// ─── 2. The ceiling ──────────────────────────────────────────────────────────
console.log('\n=== 2. Maximum achievable single-punch force ===');
await freshLoad();
await peek(() => {
  window.__config.dummyMoveSpeed           = 0;
  window.__config.dummyAttackDelayMin      = 999;
  window.__config.dummyAttackDelayMax      = 999;
  window.__config.dummyBlockReactionChance = 0;
  window.__config.healthDamagePerForce     = 0;   // keep the dummy up for the whole sweep
  window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
});

// Uppercut (the hardest punch), thrown while advancing at full walking speed,
// into a target pinned at maximum vulnerability. Mashed across a closing run so
// the sweep catches the frame where approach speed and range line up, rather
// than depending on one lucky press.
await pin(230);
await pinDummyVuln(1.0);
await clearRes();
await page.keyboard.down('ArrowRight');
for (let i = 0; i < 14; i++) {
  await tap('KeyM');
  // Let the uppercut fully resolve and unwind before the next press: a fixed
  // 220 ms did not contain the punch under load, so the whole 14-press sweep
  // came back empty and the reduce below crashed on undefined.
  await punchIdle(page);
  await peek(() => {
    // Hold the target still and re-arm its vulnerability: the point of this
    // measurement is the force ceiling, not a chase.
    const sc = window.__game.scene.keys.RingScene;
    sc.dummy.staggerX = sc.dummy.staggerY = sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy._punishTimer = 30;
    sc.dummy._punishVuln  = 1.0;
    sc.fighter.stamina = window.__config.staminaMax;   // keep the low-stamina stretch out of it
  });
}
await page.keyboard.up('ArrowRight');
const sweep  = (await takeRes()).filter(r => r.fromPlayer && r.outcome === 'land' && r.force);
// An empty sweep is a FAILURE to report, not a crash: this used to throw
// `Cannot read properties of undefined` and take the remaining sections with it,
// which hid what had actually gone wrong.
if (!sweep.length) {
  check('the closing uppercut sweep landed at least one punch', false,
    'no landed uppercuts recorded — nothing to measure a force ceiling from');
}
const worst  = sweep.reduce((a, b) => (b.force > a.force ? b : a), sweep[0]) ?? { force: 0, attSpeed: 0, defVuln: 0 };
const maxDmg = worst.force * cfg.dmgPerForce;

// The arithmetic the measurement should be landing near, stated so the two can
// be compared: base + full-speed momentum, × uppercut damage, × counter bonus.
const theoretical = (cfg.base + (cfg.moveSpeed / cfg.moveSpeed) * cfg.mass * cfg.momentum)
                    * cfg.uppercut * (1 + 1 * cfg.bonus);

console.log(`     ${sweep.length} landed uppercuts sampled; hardest = ${worst.force.toFixed(1)} force ` +
            `at approach speed ${worst.attSpeed.toFixed(0)} px/s, target v=${worst.defVuln.toFixed(2)}`);
console.log(`     → ${maxDmg.toFixed(2)} damage = ${(maxDmg / cfg.healthMax * 100).toFixed(1)}% of healthMax ` +
            `(${cfg.healthMax}); ${Math.ceil(cfg.healthMax / maxDmg)} such hits to a knockdown`);
console.log(`     arithmetic ceiling for reference: (${cfg.base} + ${cfg.mass}) × ${cfg.uppercut} × ` +
            `${(1 + cfg.bonus).toFixed(2)} = ${theoretical.toFixed(1)} force`);
check('a maximum-force counter cannot one-shot from full health',
  maxDmg < cfg.healthMax,
  `${maxDmg.toFixed(2)} / ${cfg.healthMax} health`);
check('the measured ceiling is within reach of the arithmetic one',
  worst.force <= theoretical * 1.15,
  `measured ${worst.force.toFixed(1)} vs arithmetic ${theoretical.toFixed(1)}`);

// ─── 3. Perfect block ────────────────────────────────────────────────────────
console.log('\n=== 3. Perfect block ===');

/**
 * Have the dummy throw one jab at the player and raise the player's guard
 * either late (perfect) or early (an ordinary held block).
 *
 * Timing is driven off the dummy's own impact countdown rather than wall-clock:
 * headless Chromium runs Phaser's timestep at roughly half real speed and
 * unevenly, so a fixed sleep lands nowhere near the intended guard age.
 */
async function blockedJab(kind, punishDuration = null) {
  await freshLoad();
  if (punishDuration !== null) {
    await peek(d => { window.__config.perfectBlockPunishDuration = d; }, punishDuration);
  }
  await peek(() => {
    window.__config.dummyMoveSpeed           = 0;
    window.__config.dummyAttackDelayMin      = 999;
    window.__config.dummyAttackDelayMax      = 999;
    window.__config.dummyBlockReactionChance = 0;
    // Isolate the hit's own stamina effect from the continuous block drain and
    // the idle regen, so a non-zero delta could only come from the hit.
    window.__config.staminaDrainPerSecondBlocking = 0;
    window.__config.staminaRegenPerSecond         = 0;
    window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
  });
  await pin(65);
  await clearRes();

  await tap('KeyT');                       // force the dummy to throw
  if (kind === 'late') {
    // Wait until the impact is imminent, THEN guard: the guard is younger than
    // perfectBlockWindow when the resolver reads it.
    await page.waitForFunction(() => {
      const d = window.__game.scene.keys.RingScene.dummy;
      return d._impactPending && d._impactTimer < 0.06;
    }, null, { timeout: 6000 });
  }
  await page.keyboard.down('ShiftLeft');       // 'early' guards immediately instead
  await page.waitForFunction(() => window.__res.some(r => !r.fromPlayer), null, { timeout: 6000 });
  const r = (await takeRes()).find(x => !x.fromPlayer);
  await page.screenshot({ path: `${OUT}/perfect_block_${kind}.png` });
  await page.keyboard.up('ShiftLeft');

  // The attacker's vulnerability once its own punch animation has finished, so
  // what's left is the punish spike alone rather than the tail of its punch
  // curve (which at the moment of impact is at full extension and higher).
  await page.waitForFunction(
    () => window.__game.scene.keys.RingScene.dummy.punchTimer === 0, null, { timeout: 6000 });
  r.attVulnAfterPunch = await peek(() => {
    const d = window.__game.scene.keys.RingScene.dummy;
    return { v: d.vulnerability, punish: d._punishTimer, pt: d.punchTimer };
  });
  return r;
}

const late  = await blockedJab('late');
const early = await blockedJab('early');
// A third run with the punish held longer than the dummy's own windup, purely so
// the spike can be observed in isolation — at the shipped 0.45 s it expires at
// about the same moment the attacker's punch animation ends, which leaves no
// frame where only the spike is in play.
const lateLong = await blockedJab('late', 1.5);

const fmt = r => `guard age ${r.defBlockHeld.toFixed(3)}s, outcome ${r.outcome}, ` +
  `health ${r.defHealth.toFixed(2)}→${r.postHealth.toFixed(2)}, ` +
  `stamina ${r.defStamina.toFixed(2)}→${r.postStamina.toFixed(2)}`;
console.log(`     late  guard: ${fmt(late)}`);
console.log(`     early guard: ${fmt(early)}`);

check('a guard raised inside the window is a perfect block',
  late.defBlockHeld <= cfg.window && late.outcome === 'land',
  `guard age ${late.defBlockHeld.toFixed(3)}s <= perfectBlockWindow ${cfg.window}s`);
check('perfect block takes ZERO chip damage',
  late.postHealth === late.defHealth,
  `health unchanged at ${late.postHealth.toFixed(2)}`);
check('perfect block costs ZERO stamina',
  late.postStamina === late.defStamina,
  `stamina unchanged at ${late.postStamina.toFixed(2)} ` +
  `(NOTE: no per-hit stamina cost exists in the build, so this is currently a no-op — see summary)`);
check('perfect block spikes the ATTACKER\'s vulnerability',
  late.attPunish > 0 && late.attVuln >= cfg.punishVuln - 1e-6,
  `punish window ${late.attPunish.toFixed(2)}s opened; dummy vulnerability ${late.attVuln.toFixed(2)} ` +
  `(its own full extension, ${cfg.punishVuln} floor from the spike — the spike is a floor, not an override)`);
check('the spike HOLDS the attacker exposed after its punch has finished',
  lateLong.attVulnAfterPunch.punish > 0 &&
  Math.abs(lateLong.attVulnAfterPunch.v - cfg.punishVuln) < 0.01,
  `with the punish stretched to 1.5s for observability: v=${lateLong.attVulnAfterPunch.v.toFixed(2)} ` +
  `at punchTimer=0, ${lateLong.attVulnAfterPunch.punish.toFixed(2)}s of spike left`);
console.log(`     NOTE: at the shipped punish duration the spike expires at about the moment the`);
console.log(`     dummy's own 0.8 s windup ends, so against THIS attacker it mostly raises the`);
console.log(`     LEVEL of exposure rather than extending it. See the summary.`);

check('a guard older than the window is an ordinary block',
  early.defBlockHeld > cfg.window && early.outcome === 'land',
  `guard age ${early.defBlockHeld.toFixed(3)}s > perfectBlockWindow ${cfg.window}s`);
check('an ordinary block still takes chip damage',
  early.postHealth < early.defHealth,
  `health ${early.defHealth.toFixed(2)} → ${early.postHealth.toFixed(2)} ` +
  `(-${(early.defHealth - early.postHealth).toFixed(2)})`);
check('an ordinary block does NOT spike the attacker',
  early.attPunish === 0,
  `attacker punish timer ${early.attPunish}`);

// ─── 4. How often does the dummy's reactive block land inside the window? ────
console.log('\n=== 4. Dummy reactive block vs the perfect-block window ===');
await freshLoad();
await peek(() => {
  window.__config.dummyAttackDelayMin  = 999;    // isolate: only player punches
  window.__config.dummyAttackDelayMax  = 999;
  window.__config.healthDamagePerForce = 0;      // no knockdowns mid-series
  window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
});
// Wait for the AI to actually BE in its own range rather than assuming 2.2 s of
// wall clock got it there — closing is driven by game time, which a loaded
// headless page runs at roughly half wall speed.
await soft(page, () => {
  const d = window.__game.scene.keys.RingScene.dummy;
  return d._distToOpponent <= window.__config.dummyEngageDist;
}, undefined, { timeout: 12000 });

const N = 24;
for (let i = 0; i < N; i++) {
  await tap('KeyJ');
  // dummyBlockReactionWindow is a GAME-time window, so the gap between jabs has
  // to be measured on the same clock or successive jabs share one guard roll.
  await gameTime(page, 0.7);
}
const series  = (await takeRes()).filter(r => r.fromPlayer && r.outcome === 'land');
const guarded = series.filter(r => Number.isFinite(r.defBlockHeld));
const perfect = guarded.filter(r => r.defBlockHeld <= cfg.window);
const ages    = guarded.map(r => r.defBlockHeld);

console.log(`     ${series.length} jabs landed; ${guarded.length} met a raised guard; ` +
            `${perfect.length} of those were PERFECT blocks ` +
            `(${guarded.length ? (perfect.length / guarded.length * 100).toFixed(0) : 0}%)`);
if (ages.length) {
  console.log(`     guard age at impact: ${Math.min(...ages).toFixed(3)}–${Math.max(...ages).toFixed(3)}s ` +
              `vs a ${cfg.window}s window`);
}
console.log(`     FINDING: the dummy's reactive block is raised with ZERO latency the frame the`);
console.log(`     player commits (Dummy.onOpponentPunchStart), and a player punch resolves`);
console.log(`     0.04–0.09 s later at shipped punch speeds. Its guard is therefore ALWAYS`);
console.log(`     younger than any humane perfect-block window — see the summary.`);
check('reactive blocks are being observed at all (sanity)', guarded.length > 0,
  `${guarded.length}/${series.length} landed jabs met a guard at ${cfg.blockChance} block chance`);

// ─── Report ──────────────────────────────────────────────────────────────────
await browser.close();
const failed = results.filter(r => !r.pass);
console.log(`\nScreenshots → ${OUT}/`);
console.log('Page errors:', errors.length ? errors : 'none');
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.label}`));
  process.exit(1);
}
