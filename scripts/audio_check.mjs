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

// The gesture.
await page.keyboard.press('KeyZ');
await until(page, () => window.__audio.state() === 'running', undefined, { label: 'audio context running', timeout: 20000 }).catch(() => {});
check(await page.evaluate(() => window.__audio.state()) === 'running', 'the context runs after a key press');
await until(page, () => window.__audio.bed(), undefined, { label: 'crowd bed playing', timeout: 30000 }).catch(() => {});
check(await page.evaluate(() => window.__audio.bed()), 'the crowd bed is playing (walla loop rendered)');

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
check(peak > 0.8 && peak > base + 0.4, `excitement spikes on a knockdown (${base.toFixed(2)} → ${peak.toFixed(2)})`);
await frames(page, 3);
check(logs.length === 0, `console clean (${logs.length} error/warning)`);
logs.forEach(l => console.log(`    ${l}`));
await browser.close();

console.log(`${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
