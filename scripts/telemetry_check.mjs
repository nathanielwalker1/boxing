/**
 * telemetry_check.mjs — the dev telemetry overlay (src/ui/telemetry.ts) in the real app.
 *   - absent by default (no #dev-telemetry element, window.__telemetry.on false)
 *   - cfg.devTelemetry on: the panel appears
 *   - a plain cross lands (not a counter); a slip-then-cross lands as a COUNTER; the overlay text and
 *     window.__telemetry both report the grade / counter flag, and the counter did more damage
 *   - the tallies agree (counters 1, avg counter damage > avg normal damage)
 *   - turned off again, the element goes away
 * Screenshot → scripts/output/telemetry.png. Console must be clean.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until } from './waits.js';
import { check, done } from './check.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 15_000 });
await bootReady(page);

const present = () => page.evaluate(() => !!document.getElementById('dev-telemetry'));
const tel = () => page.evaluate(() => JSON.parse(JSON.stringify({ on: window.__telemetry.on, f: window.__telemetry.fighters, log: window.__telemetry.log })));
const text = () => page.evaluate(() => document.getElementById('dev-telemetry')?.textContent ?? '');

// ── 1. Off by default ────────────────────────────────────────────────────────
check('off by default: no overlay element, probe off', !(await present()) && !(await tel()).on);

// ── 2. On ────────────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__cfg.devTelemetry = true; });
await until(page, () => !!document.getElementById('dev-telemetry'), undefined, { label: 'overlay appears', timeout: 8000 });
check('devTelemetry on: the overlay appears', await present());

// ── 3. A normal cross ────────────────────────────────────────────────────────
await page.evaluate(() => { window.__sim.place(0.79); window.__sim.script(0, [{ cross: true }]); });
await until(page, () => window.__telemetry.fighters[0].last !== null, undefined, { label: 'normal cross lands', timeout: 8000 });
const n = (await tel()).f[0].last;
check(`normal cross: landed, counter flag false, grade ${n.grade}, damage ${n.damage.toFixed(4)}`, n.kind === 'land' && n.punch === 'cross' && n.counter === false && n.damage > 0);

// ── 4. A counter cross (slip the dummy's jab, cross into the window) ─────────
await page.evaluate(() => {
  window.__sim.place(0.79);
  window.__sim.script(1, [{ jab: true }]);
  const s0 = [];
  for (let i = 0; i < 13; i++) s0.push(i < 2 ? { move: { x: -1, y: 0 } } : i === 12 ? { cross: true } : {});
  window.__sim.script(0, s0);
});
await until(page, () => window.__telemetry.fighters[0].tally.counters >= 1, undefined, { label: 'counter lands', timeout: 8000 });
const t = await tel();
const c = t.f[0].last;
check(`counter cross: counter flag true (${c.counterRule}), grade ${c.grade}, damage ${c.damage.toFixed(4)}`, c.kind === 'land' && c.counter === true && c.punch === 'cross');
check(`the counter did more damage than the normal cross (${c.damage.toFixed(4)} > ${n.damage.toFixed(4)})`, c.damage > n.damage);
check(`hit-stop ticks and impulse are reported (${c.hitStopTicks} t, ${c.impulse.toFixed(0)})`, c.hitStopTicks > 0 && c.impulse > 0);
const tally = t.f[0].tally;
check(`tallies: thrown ${tally.thrown} landed ${tally.landed} counters ${tally.counters}, avg counter ${tally.avgCounter.toFixed(4)} > avg normal ${tally.avgNormal.toFixed(4)}`,
  tally.landed === 2 && tally.counters === 1 && tally.avgCounter > tally.avgNormal && tally.thrown >= 2);
check('the log holds the counter with a tick number', t.log.some(l => /^t\d+ P0 cross\/\w+ LAND .*COUNTER/.test(l)), JSON.stringify(t.log));

// ── 5. The overlay says the same thing ───────────────────────────────────────
await until(page, () => /COUNTER/.test(document.getElementById('dev-telemetry')?.textContent ?? ''), undefined, { label: 'overlay shows the counter', timeout: 8000 });
const txt = await text();
check('overlay text shows grade, counter YES and the damage', txt.includes(`grade ${c.grade} counter YES`) && txt.includes(`dmg ${c.damage.toFixed(4)}`), txt.split('\n').slice(0, 3).join(' | '));
const css = await page.evaluate(() => getComputedStyle(document.getElementById('dev-telemetry')).pointerEvents);
check('pointer-events none', css === 'none');
const shot = `${OUT}/telemetry.png`;
await page.screenshot({ path: shot });
console.log(`     screenshot → ${shot}`);

// ── 6. Off again ─────────────────────────────────────────────────────────────
await page.evaluate(() => { window.__cfg.devTelemetry = false; });
await until(page, () => !document.getElementById('dev-telemetry'), undefined, { label: 'overlay removed', timeout: 8000 });
check('turned off: the overlay is gone', !(await present()));

const benign = m => /GPU stall due to ReadPixels/.test(m);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
bad.forEach(m => console.log(`  [${m.type}] ${m.text}`));
check(`console clean (${bad.length} error/warning)`, bad.length === 0);
await browser.close();
done();
