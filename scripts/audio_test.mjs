/**
 * audio_test.mjs — verify combat SFX are triggered by the right outcomes.
 * Run with: node scripts/audio_test.mjs   (PORT=5176 node … for a second worktree)
 * Dev server must already be running.
 *
 * A headless browser can't be listened to, so this asserts on the layer directly
 * above the speaker: which logical sound name each resolved outcome asked for,
 * and with how much pitch variance. That is exactly the mapping this stage
 * added — the synthesis itself is a feel judgement for the human playtest.
 *
 * Setup mirrors punch_test.mjs: the dummy is pinned so distance is the only
 * variable, and impacts resolve at peak extension so each case waits for the
 * punch to actually arrive rather than reading on the press frame.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { DEV_URL } from './devUrl.js';

mkdirSync('scripts/output', { recursive: true });

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200);

// Pin the dummy: no approach, no attacks of its own, no reactive block, so
// nothing but the case under test can produce a sound.
await page.evaluate(() => {
  window.__config.dummyMoveSpeed           = 0;
  window.__config.dummyAttackDelayMin      = 999;
  window.__config.dummyAttackDelayMax      = 999;
  window.__config.dummyBlockReactionChance = 0;
  window.__game.scene.keys.RingScene.dummy.attackTimer = 999;
});

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name.padEnd(42)} ${detail}`);
}

async function standOff(px, { dummyBlocks = false } = {}) {
  await page.evaluate(({ d, dummyBlocks }) => {
    const sc = window.__game.scene.keys.RingScene;
    sc.dummy.staggerX = sc.dummy.staggerY = 0;
    sc.dummy.staggerVx = sc.dummy.staggerVy = 0;
    sc.dummy.x = sc.dummy._loco.x;
    sc.dummy.y = sc.dummy._loco.y;
    sc.fighter.x  = sc.dummy.x - d;
    sc.fighter.y  = sc.dummy.y;
    sc.fighter.vx = 0;
    sc.fighter.vy = 0;
    for (const f of [sc.fighter, sc.dummy]) {
      f.health  = window.__config.healthMax;
      f.stamina = window.__config.staminaMax;
    }
    // Hold the dummy's guard open for the whole case when the test wants a
    // blocked hit — the reactive-block roll is disabled above.
    sc.dummy.blockTimer = dummyBlocks ? 5 : 0;
  }, { d: px, dummyBlocks });
  await page.waitForTimeout(120);
}

async function tap(key, ms = 70) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

/** Throw one punch and return {outcome, sounds:[names]} produced by it. */
async function throwPunch(key, distance, opts = {}) {
  await standOff(distance, opts);
  await page.evaluate(() => {
    const sc = window.__game.scene.keys.RingScene;
    window.__audio.log.length = 0;
    window.__lastOutcome = null;
    if (!sc.__wrapped) {
      const orig = sc._resolveAttack.bind(sc);
      sc._resolveAttack = (a, d, arm, t) => (window.__lastOutcome = orig(a, d, arm, t));
      sc.__wrapped = true;
    }
  });
  if (opts.holdDir) await page.keyboard.down(opts.holdDir);
  await tap(key);
  await page.waitForTimeout(220);
  if (opts.holdDir) await page.keyboard.up(opts.holdDir);
  const r = await page.evaluate(() => ({
    outcome: window.__lastOutcome,
    sounds:  window.__audio.log.map(e => e.name),
    pitches: window.__audio.log.map(e => e.pitch),
  }));
  await page.waitForTimeout(280);   // let the animation finish before the next case
  return r;
}

const CLOSE = 30;    // inside smotherDist
const MID   = 65;    // inside every punch's reach
const FAR   = 220;   // beyond every punch's reach

console.log('\n── Outcome → sound mapping ─────────────────────────────────────────\n');

// 1. Landed unblocked — sharp for jab/cross, heavy for hook/uppercut.
// Distances differ per punch because reach is geometric (see reach_test.mjs):
// the uppercut's arc doesn't extend as far, so it only lands from close in —
// same distance punch_test.mjs uses for it.
for (const [label, key, expectSound, dist] of [
  ['jab lands',      'KeyJ', 'impactSharp', MID],
  ['cross lands',    'KeyK', 'impactSharp', MID],
  ['hook lands',     'KeyI', 'impactHeavy', MID],
  ['uppercut lands', 'KeyM', 'impactHeavy', CLOSE],
]) {
  const r = await throwPunch(key, dist);
  check(`${label} → ${expectSound}`,
        r.outcome === 'land' && r.sounds.length === 1 && r.sounds[0] === expectSound,
        `outcome=${r.outcome} sounds=[${r.sounds}]`);
}

// 2. Blocked — absorbed variant regardless of punch type (a blocked hook must
//    NOT play the heavy impact; that's the whole point of the rule).
for (const [label, key] of [['jab blocked', 'KeyJ'], ['hook blocked', 'KeyI']]) {
  const r = await throwPunch(key, MID, { dummyBlocks: true });
  check(`${label} → impactBlocked`,
        r.outcome === 'land' && r.sounds.length === 1 && r.sounds[0] === 'impactBlocked',
        `outcome=${r.outcome} sounds=[${r.sounds}]`);
}

// 3. Whiff.
{
  const r = await throwPunch('KeyJ', FAR);
  check('jab whiffs → whiff',
        r.outcome === 'whiff' && r.sounds.length === 1 && r.sounds[0] === 'whiff',
        `outcome=${r.outcome} sounds=[${r.sounds}]`);
}

// 4. Smother — the outcome the brief didn't name; borrows the absorbed variant.
{
  const r = await throwPunch('KeyJ', CLOSE);
  check('jab smothered → impactBlocked',
        r.outcome === 'smother' && r.sounds.length === 1 && r.sounds[0] === 'impactBlocked',
        `outcome=${r.outcome} sounds=[${r.sounds}]`);
}

console.log('\n── Dummy side (symmetry) ───────────────────────────────────────────\n');

// The dummy routes through the same _resolveAttack, so it should sound the same.
// Force an attack with the player in range and unguarded.
{
  const r = await page.evaluate(async () => {
    const sc = window.__game.scene.keys.RingScene;
    sc.fighter.x = sc.dummy.x - 70;
    sc.fighter.y = sc.dummy.y;
    sc.dummy.blockTimer = 0;
    window.__audio.log.length = 0;
    window.__lastOutcome = null;
    sc.dummy.forceAttack();
    await new Promise(res => setTimeout(res, 1600));   // windup + impact
    return { outcome: window.__lastOutcome, sounds: window.__audio.log.map(e => e.name) };
  });
  check('dummy jab lands → impactSharp',
        r.outcome === 'land' && r.sounds.includes('impactSharp'),
        `outcome=${r.outcome} sounds=[${r.sounds}]`);
}

console.log('\n── Pitch variance ──────────────────────────────────────────────────\n');

// 5. Repeated identical punches must not be bit-identical plays.
{
  const stats = await page.evaluate(() => {
    window.__audio.log.length = 0;
    for (let i = 0; i < 24; i++) window.__audio.play('impactSharp');
    const p = window.__audio.log.map(e => e.pitch);
    return { n: p.length, min: Math.min(...p), max: Math.max(...p), unique: new Set(p).size };
  });
  const jitter = await page.evaluate(() => window.__config.audioPitchJitter);
  const inBand = stats.min >= 1 - jitter - 1e-3 && stats.max <= 1 + jitter + 1e-3;
  // Not "every value distinct" — the log rounds to 4 dp, so a couple of
  // collisions across 24 draws is expected and says nothing. The claim being
  // tested is "these aren't all the same value", plus real spread.
  const varies = stats.unique >= stats.n * 0.8 && (stats.max - stats.min) > jitter * 0.5;
  check('pitch varies per play',   varies, `${stats.unique}/${stats.n} unique, range ${stats.min}–${stats.max}`);
  check(`pitch stays within ±${jitter}`, inBand, `min ${stats.min}, max ${stats.max}`);
}

console.log('\n── Synthesis (offline render of the real node graph) ───────────────\n');

// 6. Measure what the recipes actually produce. Each sound is rendered through
//    the SAME playRecipe() live playback uses, then reduced to:
//      peak    — audible at all, and with headroom left at master volume 1.0
//      durMs   — where the tail drops below ≈-60 dBFS (brief: under 300 ms)
//      low/mid/high — share of energy below 300 Hz, 300 Hz–2 kHz, and above
//                2 kHz (1-pole splits; a rough proxy, but enough to prove the
//                three impact sounds occupy three different parts of the
//                spectrum rather than being the same hit at different volumes).
{
  const stats = await page.evaluate(async () => {
    const names = ['impactSharp', 'impactHeavy', 'impactBlocked', 'whiff'];
    const REPEATS = 4;   // each render draws fresh random noise; average it out
    const out = {};
    const acc = {};
    for (const n of names) {
     acc[n] = { peak: 0, durMs: 0, low: 0, mid: 0, high: 0 };
     for (let rep = 0; rep < REPEATS; rep++) {
      const buf = await window.__audio.render(n, 1, 0.5);
      const d   = buf.getChannelData(0);
      const sr  = buf.sampleRate;

      let peak = 0, last = -1;
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
        if (a > 0.001) last = i;          // ≈ -60 dBFS relative to unity
      }

      const aLo = 1 / (1 + sr / (2 * Math.PI *  300));
      const aHi = 1 / (1 + sr / (2 * Math.PI * 2000));
      let lo = 0, hi = 0, eLo = 0, eMid = 0, eHigh = 0;
      for (let i = 0; i < d.length; i++) {
        lo += aLo * (d[i] - lo);          // < 300 Hz
        hi += aHi * (d[i] - hi);          // < 2 kHz
        eLo   += lo * lo;
        eMid  += (hi - lo) * (hi - lo);
        eHigh += (d[i] - hi) * (d[i] - hi);
      }
      const tot = (eLo + eMid + eHigh) || 1e-12;
      acc[n].peak  += peak;
      acc[n].durMs += (last / sr) * 1000;
      acc[n].low   += eLo   / tot;
      acc[n].mid   += eMid  / tot;
      acc[n].high  += eHigh / tot;
     }
     out[n] = {
       peak:  +(acc[n].peak  / REPEATS).toFixed(3),
       durMs: Math.round(acc[n].durMs / REPEATS),
       low:   +(acc[n].low   / REPEATS).toFixed(3),
       mid:   +(acc[n].mid   / REPEATS).toFixed(3),
       high:  +(acc[n].high  / REPEATS).toFixed(3),
     };
    }
    return out;
  });

  for (const [n, s] of Object.entries(stats)) {
    check(`${n}: audible, <300 ms, headroom`,
          s.peak > 0.05 && s.peak < 0.95 && s.durMs > 10 && s.durMs < 300,
          `peak ${s.peak}, ${s.durMs} ms, lo/mid/hi ${s.low}/${s.mid}/${s.high}`);
  }

  // The distinctness claims this stage rests on. Each impact must OWN a band —
  // if two of them peak in the same band they'll read as the same sound.
  check('sharp is high-dominant (the crack)',
        stats.impactSharp.high > stats.impactSharp.low && stats.impactSharp.high > stats.impactSharp.mid,
        `hi ${stats.impactSharp.high} vs lo ${stats.impactSharp.low} / mid ${stats.impactSharp.mid}`);
  check('heavy is low-dominant (the thud)',
        stats.impactHeavy.low > stats.impactHeavy.mid && stats.impactHeavy.low > stats.impactHeavy.high,
        `lo ${stats.impactHeavy.low} vs mid ${stats.impactHeavy.mid} / hi ${stats.impactHeavy.high}`);
  check('blocked is mid-dominant (absorbed, no thud, no crack)',
        stats.impactBlocked.mid > stats.impactBlocked.low && stats.impactBlocked.mid > stats.impactBlocked.high,
        `mid ${stats.impactBlocked.mid} vs lo ${stats.impactBlocked.low} / hi ${stats.impactBlocked.high}`);
  check('blocked lacks the sharp crack',
        stats.impactBlocked.high < stats.impactSharp.high * 0.5,
        `blocked hi ${stats.impactBlocked.high} vs sharp hi ${stats.impactSharp.high}`);
  check('blocked lacks the heavy thud',
        stats.impactBlocked.low < stats.impactHeavy.low * 0.5,
        `blocked lo ${stats.impactBlocked.low} vs heavy lo ${stats.impactHeavy.low}`);
  check('heavy rings longer than sharp',
        stats.impactHeavy.durMs > stats.impactSharp.durMs,
        `heavy ${stats.impactHeavy.durMs} ms > sharp ${stats.impactSharp.durMs} ms`);
  check('whiff is quieter than the impacts but still audible',
        stats.whiff.peak < stats.impactSharp.peak && stats.whiff.peak < stats.impactHeavy.peak &&
        stats.whiff.peak > stats.impactSharp.peak * 0.2,
        `whiff peak ${stats.whiff.peak} vs sharp ${stats.impactSharp.peak}`);
}

console.log('\n── Graceful degradation ────────────────────────────────────────────\n');

// 6. Master volume 0 and disabled must silence without throwing.
{
  const r = await page.evaluate(() => {
    const before = { vol: window.__config.audioMasterVolume, en: window.__config.audioEnabled };
    let threw = null;
    try {
      window.__config.audioEnabled = false;
      window.__audio.play('impactHeavy');
      window.__config.audioEnabled = true;
      window.__config.audioMasterVolume = 0;
      window.__audio.play('impactHeavy');
      window.__audio.play('nonexistentSound');
    } catch (e) { threw = e.message; }
    window.__config.audioMasterVolume = before.vol;
    window.__config.audioEnabled      = before.en;
    return { threw };
  });
  check('disabled / zero-volume / unknown name are safe', r.threw === null, r.threw ? `threw: ${r.threw}` : 'no throw');
}

// 7. Autoplay policy: headless has had synthetic input, so the context should be
//    running — but a suspended context must drop sounds, not error.
{
  const state = await page.evaluate(() => {
    const sm = window.__game.sound;
    return { ctx: sm && sm.context ? sm.context.state : 'none', locked: sm ? !!sm.locked : null };
  });
  check('audio context resolved', state.ctx === 'running' || state.ctx === 'suspended', `state=${state.ctx} locked=${state.locked}`);
}

await page.screenshot({ path: 'scripts/output/audio_test.png' });
await browser.close();

const failed = results.filter(r => !r.pass);
console.log('\nPage errors:', errors.length ? errors : 'none');
console.log(`${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length || errors.length) {
  failed.forEach(f => console.error(`  FAILED: ${f.name}`));
  process.exit(1);
}
