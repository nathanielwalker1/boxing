/**
 * wear_sheet.mjs — ONE picture to judge face marks from: face close-ups at set points in a fight, no fight played.
 *
 *   PORT=5199 node scripts/wear_sheet.mjs            -> scripts/output/wear_sheet.png
 *
 * Rows: fighters (a light and a dark skin). Columns: after N head punches have landed on him, from a fixed, mixed stream
 * (STREAM below: where each landed, which side, how well). The punches go through the game's own rule
 * (human/view.ts markHit, by window.__humanWear), so the sheet is what a fight with those punches would show.
 * Under each picture: the six spot levels (L eye, R eye, L brow, R brow, nose, lip; 1 = fully bruised) and the cut.
 */
import { DEV_URL } from './devUrl.js';
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

// A fight's worth of head punches, in the order they land: [zone, punch, side (0 his left, 1 his right), grade].
// Mostly jabs and crosses to the nose and eyes, hooks to the temple and jaw, a few glancing: 8 punches, repeated.
const STREAM = [
  ['nose', 'jab', 0, 'clean'], ['temple', 'hook', 1, 'clean'], ['jaw', 'cross', 0, 'clean'], ['nose', 'cross', 0, 'flush'],
  ['forehead', 'jab', 1, 'glancing'], ['chin', 'uppercut', 0, 'clean'], ['temple', 'hook', 1, 'flush'], ['nose', 'jab', 1, 'glancing'],
];   // (the heavy side is his RIGHT: the side the select screen's camera sees)
const STAGES = [0, 10, 20, 40, 60, 80];
const FIGHTERS = 2;   // the first N on the select screen

const out = new URL('./output/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const msgs = [];
const frames = (page, n) => page.waitForFunction(k => new Promise(r => { let i = 0; const f = () => (++i > k ? r(true) : requestAnimationFrame(f)); f(); }), n);
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 3 });
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') msgs.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
page.on('pageerror', e => msgs.push(`pageerror: ${String(e).slice(0, 300)}`));
await page.goto(`${DEV_URL}/?human=1&menu=1`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__flow, null, { timeout: 60000 });
for (let i = 0; i < 4; i++) {
  if ((await page.evaluate(() => window.__flow.state().screen)) === 'select') break;
  await page.keyboard.press('Enter');
  await frames(page, 20);
}
const cells = [];
for (let f = 0; f < FIGHTERS; f++) {
  // (the turntable shows a new fighter from the FRONT and then turns: shoot as soon as his arms are down)
  if (f === 0) { await page.keyboard.press('ArrowRight'); await frames(page, 30); await page.keyboard.press('ArrowLeft'); }
  if (cells.length) await page.waitForFunction(last => window.__flow.state().shown !== last, cells[cells.length - 1].name, { timeout: 15000 });
  await frames(page, 45);
  const name = await page.evaluate(() => window.__flow.state().shown);
  let landed = 0;
  for (const n of STAGES) {
    const state = await page.evaluate(([from, to, stream]) => {
      const w = window.__humanWear[0];
      if (from === 0) { w.reset(); w.prone(true); }   // (the sheet shows a fight he DOES cut in: humanCutChance of them)
      for (let i = from; i < to; i++) { const s = stream[i % stream.length]; w.hit(s[0], s[1], s[2], s[3]); w.age(1.5); }   // (about 1.5 s of fight a landed head punch: 115 of them in 180 s)
      return w.state();
    }, [landed, n, STREAM]);
    landed = n;
    await frames(page, 3);
    const png = await page.screenshot({ clip: { x: 440, y: 20, width: 150, height: 150 } });
    cells.push({ name, n, state, src: `data:image/png;base64,${png.toString('base64')}` });
    console.log(`${name} after ${n}: spots ${state.dmg.join(' ')}  cut ${state.cut < 0 ? 'none' : state.cut === 0 ? 'left brow' : 'right brow'}`);
  }
  await page.evaluate(() => window.__humanWear[0].reset());
  await page.keyboard.press('ArrowRight');
}
const sheet = await browser.newPage({ viewport: { width: STAGES.length * 330 + 20, height: FIGHTERS * 400 + 20 } });
await sheet.setContent(`<body style="margin:10px;background:#111;color:#ddd;font:13px/1.35 sans-serif"><div style="display:grid;grid-template-columns:repeat(${STAGES.length},320px);gap:10px">${
  cells.map(c => `<div><img src="${c.src}" width="320" height="320"><div><b>${c.name}</b> after ${c.n} head punches</div><div>eyes ${c.state.dmg[0]} / ${c.state.dmg[1]} · brows ${c.state.dmg[2]} / ${c.state.dmg[3]} · nose ${c.state.dmg[4]} · lip ${c.state.dmg[5]} · cut ${c.state.cut < 0 ? 'none' : c.state.cut === 0 ? 'L brow' : 'R brow'}</div></div>`).join('')
}</div></body>`);
await sheet.screenshot({ path: `${out}wear_sheet.png`, fullPage: true });
await browser.close();
console.log(msgs.length ? msgs.join('\n') : 'console clean');
console.log(`${out}wear_sheet.png`);
