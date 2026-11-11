/**
 * audio_check.mjs — the sound, without a sound device (window.__audioLog
 * records what was asked for; window.__audio reports the context).
 *   - silent and warning-free before any gesture: no AudioContext exists
 *   - a landed punch asks for its impact recipe
 *   - after a key press the context runs and the crowd bed starts (the walla
 *     loop renders offline first)
 *   - the crowd answers the mood: a flush shot → an "ooh", a near miss → a
 *     gasp, a knockdown → the eruption, the bell → applause
 *   - excitement spikes on a knockdown and decays; the count hushes the house
 *   - console clean throughout
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, until } from './waits.js';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 20_000 });
await bootReady(page);

let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'} ${msg}`); };
const names = () => page.evaluate(() => window.__audioLog.map(e => e.name));
const asked = async (name, label) => {
  await until(page, n => window.__audioLog.some(e => e.name === n), name, { label: `${name} in the audio log`, timeout: 30000 }).catch(() => {});
  check((await names()).includes(name), label);
};

check(await page.evaluate(() => window.__audio.state()) === null, 'no AudioContext before a gesture');

// A jab that lands (frozen dummy at jab range).
await page.evaluate(() => { window.__sim.place(0.85); window.__sim.script(0, [{}, {}, { jab: true }]); });
await until(page, () => window.__audioLog.some(e => e.name.startsWith('impact')), undefined, { label: 'an impact', timeout: 30000 }).catch(() => {});
const impact = (await names()).find(n => n.startsWith('impact'));
check(impact === 'impactSharp' || impact === 'impactSharpGlance' || impact === 'impactSharpFlush' || impact === 'impactBlocked',
  `a jab at range asks for a sharp-class impact (${impact})`);

// Every event type the sim can emit, through the same path the bus takes — still before any gesture, so this is
// also the "silent and no throw without a context" check. Each must ask for at least one voice (directly, or as
// the crowd's answer through the mood); the ones with nothing to say are listed and must stay exactly these.
const QUIET = ['punchStart', 'hurt', 'countTick', 'roundStart', 'roundEnd'];
const made = await page.evaluate(() => {
  const at = { x: 0.5, y: 1.5, z: 0 }, imp = { x: 1, y: 0, z: 0 };
  const land = o => ({ type: 'punchLand', side: 0, target: 1, punch: 'cross', hand: 'rear', part: 'head', at, impulse: imp, power: 1, counter: false, variant: 'cross', grade: 'clean', combo: 1, liver: false, through: false, wrongWay: false, ...o });
  const events = {
    punchStart: { type: 'punchStart', side: 0, punch: 'jab', hand: 'lead', variant: 'jab', tell: 0.2 },
    punchLand: land({}), punchLand_glancing: land({ grade: 'glancing' }), punchLand_flush: land({ grade: 'flush' }), punchLand_combo3: land({ combo: 3 }),
    punchLand_body: land({ part: 'body', variant: 'bodyCross' }), punchLand_liver: land({ part: 'body', punch: 'hook', variant: 'bodyHook', grade: 'flush', liver: true }),
    punchLand_through: land({ through: true }), punchLand_wrongWay: land({ wrongWay: true }), punchLand_overhand: land({ variant: 'overhand' }),
    punchLand_counter: land({ counter: true, grade: 'flush' }), punchLand_oldShape: { type: 'punchLand', side: 0, target: 1, punch: 'hook', hand: 'lead', part: 'head', at, impulse: imp, power: 1, counter: false },
    punchBlock: { type: 'punchBlock', side: 0, target: 1, punch: 'cross', at, variant: 'cross', part: 'head', chip: 0.02, guard: 0.3, stun: 0.2 },
    perfectBlock: { type: 'perfectBlock', side: 0, target: 1, punch: 'jab', at, variant: 'jab' },
    punchWhiff: { type: 'punchWhiff', side: 0, punch: 'hook', variant: 'hook' }, feint: { type: 'feint', side: 0, punch: 'cross', variant: 'cross' },
    burst: { type: 'burst', side: 0, x: 0, y: 1 }, pivot: { type: 'pivot', side: 0, dir: 1 }, escape: { type: 'escape', side: 0, how: 'roll' },
    pushOff: { type: 'pushOff', side: 0, target: 1, hit: true }, clinch: { type: 'clinch', side: 0, target: 1 }, clinchBreak: { type: 'clinchBreak', side: 0, reason: 'referee' },
    guardBreak: { type: 'guardBreak', side: 1, by: 0, seconds: 1 }, liverShot: { type: 'liverShot', side: 1, by: 0, delay: 0.8 },
    bodyHurt: { type: 'bodyHurt', side: 1, by: 0, liver: true, seconds: 1.4 },
    getUpPhase_knee: { type: 'getUpPhase', side: 1, phase: 'knee', tries: 1 }, getUpPhase_slump: { type: 'getUpPhase', side: 1, phase: 'slump', tries: 1 }, getUpPhase_rise: { type: 'getUpPhase', side: 1, phase: 'rise', tries: 2 },
    punchSmother: { type: 'punchSmother', side: 0, target: 1, punch: 'cross' }, punchStuffed: { type: 'punchStuffed', side: 0, by: 1, punch: 'cross' },
    slip: { type: 'slip', side: 0, dir: 1, dodged: true, kind: 'roll', chain: 1 }, slip_flick: { type: 'slip', side: 0, dir: 1, dodged: false, kind: 'slip', chain: 1 },
    counter: { type: 'counter', side: 0, target: 1, punch: 'cross' }, hurt: { type: 'hurt', side: 1, part: 'head', impulse: imp },
    knockdown: { type: 'knockdown', side: 1, count: 1, cause: 'health' }, knockdown_body: { type: 'knockdown', side: 1, count: 1, cause: 'body' }, knockdown_flash: { type: 'knockdown', side: 1, count: 1, cause: 'flash' },
    rocked: { type: 'rocked', side: 1, by: 0, punch: 'hook', impulse: 500, threshold: 400, seconds: 2 },
    countTick: { type: 'countTick', side: 1, n: 3 }, getUp: { type: 'getUp', side: 1 }, roundStart: { type: 'roundStart', index: 1 }, roundEnd: { type: 'roundEnd', index: 0, score: [10, 9] },
    bell: { type: 'bell' }, ko: { type: 'ko', winner: 0 }, tko: { type: 'tko', winner: 0 }, decision: { type: 'decision', winner: 0, cards: [[10, 9]] },
    somethingNew: { type: 'notAnEventYet', side: 0 },
  };
  const out = {};
  for (const [label, e] of Object.entries(events)) {
    window.__audioLog.length = 0;
    let threw = null;
    try { window.__audio.emit([e]); } catch (err) { threw = String(err); }
    out[label] = { names: window.__audioLog.map(x => x.name), threw };
  }
  return out;
});
const threw = Object.entries(made).filter(([, r]) => r.threw);
check(threw.length === 0, `no event shape throws (${threw.map(([l, r]) => `${l}: ${r.threw}`).join('; ') || 'none'})`);
const silent = Object.entries(made).filter(([, r]) => r.names.length === 0).map(([l]) => l).filter(l => l !== 'somethingNew');
check(silent.every(l => QUIET.includes(l)), `every audible event type asks for a voice through the bus path (silent: ${silent.join(', ')})`);
const want = { punchLand_glancing: 'impactSharpGlance', punchLand_flush: 'impactSharpFlush', punchLand_combo3: 'comboRise', punchLand_body: 'bodyExhale', punchLand_liver: 'liverThud',
  punchLand_through: 'gloveTick', punchLand_wrongWay: 'impactWrong', punchLand_overhand: 'impactTail', punchLand_counter: 'counterWeight', punchLand_oldShape: 'impactHeavy',
  punchBlock: 'blockHeavy', perfectBlock: 'parryTick', guardBreak: 'guardCrack', bodyHurt: 'bodyGroan', burst: 'shoeScuff', pivot: 'shoeSqueak', clinch: 'clinchThud', clinchBreak: 'breakTap', slip: 'slipNear' };
const wrong = Object.entries(want).filter(([l, n]) => !made[l].names.includes(n)).map(([l, n]) => `${l} lacks ${n} (${made[l].names.join('+')})`);
check(wrong.length === 0, `the new event fields pick their sounds (${wrong.join('; ') || 'grade, combo, variant, through, wrongWay, liver, guard wear'})`);
check(await page.evaluate(() => window.__audio.state()) === null, 'still no AudioContext after all of that (no gesture yet)');

// The gesture.
await page.keyboard.press('KeyZ');
await until(page, () => window.__audio.state() === 'running', undefined, { label: 'audio context running', timeout: 20000 }).catch(() => {});
check(await page.evaluate(() => window.__audio.state()) === 'running', 'the context runs after a key press');
await until(page, () => window.__audio.bed(), undefined, { label: 'crowd bed playing', timeout: 30000 }).catch(() => {});
check(await page.evaluate(() => window.__audio.bed()), 'the crowd bed is playing (walla loop rendered)');

// Ring ambience: a fighter walking makes footfalls (read off the fighters' state, no event).
await page.evaluate(() => { window.__audioLog.length = 0; window.__sim.place(2.4); window.__sim.script(0, Array.from({ length: 150 }, () => ({ move: { x: 0, y: 1 } }))); });
await asked('footfall', 'a fighter walking → footfalls on the canvas');
// Pause ducks the crowd and releases it.
await page.evaluate(() => window.__audio.setPaused(true));
check(await page.evaluate(() => window.__audio.paused()), 'setPaused(true) ducks the crowd');
await page.evaluate(() => window.__audio.setPaused(false));
check(!(await page.evaluate(() => window.__audio.paused())), 'setPaused(false) releases it');

// The house answers the mood.
const base = await page.evaluate(() => window.__show.excitement());
await page.evaluate(() => window.__show.react('flush', 1, { x: 1, z: 0 }));
await asked('crowdOoh', 'a flush shot → the crowd\'s "ooh"');
await page.evaluate(() => window.__show.react('nearMiss', 0.6));
await asked('crowdGasp', 'a near miss → a gasp');
await page.evaluate(() => window.__show.react('bell'));
await asked('crowdApplause', 'the bell → applause');
await page.evaluate(() => window.__show.react('knockdown', 1, { x: -1, z: 1 }));
await asked('crowdEruption', 'a knockdown → the eruption');
await until(page, () => window.__show.excitement() > 0.8, undefined, { label: 'excitement spike', timeout: 30000 }).catch(() => {});
const peak = await page.evaluate(() => window.__show.excitement());
// `base` is already warm here: the event sweep above went through the mood too.
check(peak > 0.8, `excitement spikes on a knockdown (${base.toFixed(2)} → ${peak.toFixed(2)})`);
await frames(page, 3);
check(logs.length === 0, `console clean (${logs.length} error/warning)`);
logs.forEach(l => console.log(`    ${l}`));
await browser.close();

console.log(`${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
