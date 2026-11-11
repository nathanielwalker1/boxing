/**
 * fight_film.mjs — filmstrips of REAL exchanges from a seeded bot fight (polish run, the audit).
 *
 * The scenario strips (filmstrip.mjs) film what somebody scripted. This films
 * what actually happens: a scripted player bot against the AI as a style, run
 * headless in Node with every tick's input recorded, then the same fight
 * stepped in the browser (window.__filmFight) and photographed from the play
 * camera around the moments worth looking at.
 *
 *   PORT=5191 node scripts/fight_film.mjs inside-fighter swarmer 3 exchange
 *   PORT=5191 node scripts/fight_film.mjs jab-and-move slugger 1 knockdown 2      (the first 2 of them)
 *   PORT=5191 node scripts/fight_film.mjs counter-puncher pressure 2 list         (no browser: print the moments)
 *   … roundSeconds=60 aiDifficulty=2                                              (config overrides, both sides)
 *
 * kinds: exchange (≥ 4 punches landed or blocked inside 1.5 s), knockdown,
 * hurt (rocked / body hurt / liver), clinch, combo (3+ clean lands by one man
 * inside 1 s), block (3+ blocked inside 1 s), whiff (3+ misses inside 1.5 s),
 * list. Sheets go to scripts/output/fight_film/, or docs/polish/ with `keep`.
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames } from './waits.js';
import { kit } from './bots/kit.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';

const BOTS = [jabAndMove, insideFighter, counterPuncher, turtle, masher];
const BODY = { pressure: 'monsoon', outboxer: 'lighthouse', counter: 'alambre', swarmer: 'boiler', slugger: 'raffle' };
const args = process.argv.slice(2);
const over = {};
const plain = [];
for (const a of args) {
  const m = a.match(/^(\w+)=(.+)$/);
  if (m) over[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
  else plain.push(a);
}
const keep = plain.includes('keep');
const [botName = 'inside-fighter', style = 'pressure', seedArg = '1', kind = 'exchange', countArg = '2'] = plain.filter(a => a !== 'keep');
const seed = Number(seedArg), COUNT = Number(countArg);
const bot = BOTS.find(b => b.name === botName);
if (!bot || !BODY[style]) { console.error(`usage: fight_film.mjs <${BOTS.map(b => b.name).join('|')}> <${Object.keys(BODY).join('|')}> <seed> <kind> [count]`); process.exit(2); }

// ── The fight, in Node ───────────────────────────────────────────────────────
const k = await kit({ rated: true });
const cfg = { ...k.cfg, ...over };
const ids = [seed % 2 ? 'blue' : 'red', BODY[style]];
const specs = ids.map(id => k.core.ROSTER.find(f => f.id === id));
const pack = i => [i.move.x, i.move.y, (i.jab ? 1 : 0) | (i.cross ? 2 : 0) | (i.hook ? 4 : 0) | (i.uppercut ? 8 : 0) | (i.block ? 16 : 0) | (i.level ? 32 : 0)];
let s = k.sim.createState(specs, cfg, seed);
let ai = k.ai.createAi(1, seed, cfg, k.ai.styleFor(specs[1], cfg));
const player = bot.create(k, seed, cfg);
const in0 = [], in1 = [], events = [], marks = [];
const maxTicks = Math.round((cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds) + 60) / k.SIM_DT) * 2;
for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
  const d = k.ai.aiStep(ai, s, cfg); ai = d.ai;
  const mine = { ...k.NONE, ...player.step(s) };
  in0.push(pack(mine)); in1.push(pack(d.input));
  const r = k.sim.step(s, [mine, d.input], cfg); s = r.state;
  for (const e of r.events) events.push({ ...e, tick: i + 1 });
  marks.push({ time: s.time, x0: s.fighters[0].pos.x, z0: s.fighters[0].pos.z, x1: s.fighters[1].pos.x, h1: s.fighters[1].health });
}
const end = events.find(e => e.type === 'ko' || e.type === 'tko' || e.type === 'decision');

// ── The moments ──────────────────────────────────────────────────────────────
/** Windows where at least `min` events matching `pick` fall inside `span` ticks; each event used once. */
function clusters(pick, min, span) {
  const ev = events.filter(pick), out = [];
  for (let i = 0; i < ev.length;) {
    let j = i;
    while (j + 1 < ev.length && ev[j + 1].tick - ev[i].tick <= span) j++;
    if (j - i + 1 >= min) { out.push({ from: ev[i].tick, to: ev[j].tick, n: j - i + 1 }); i = j + 1; } else i++;
  }
  return out;
}
const single = (types, lead, tail) => events.filter(e => types.includes(e.type)).map(e => ({ from: e.tick - lead, to: e.tick + tail, n: 1, what: e.type + (e.cause ? ':' + e.cause : '') }));
const KINDS = {
  exchange: () => clusters(e => e.type === 'punchLand' || e.type === 'punchBlock', 4, 90).map(c => ({ ...c, from: c.from - 14, to: c.to + 20 })),
  combo: () => [0, 1].flatMap(side => clusters(e => e.type === 'punchLand' && e.side === side && e.grade !== 'glancing', 3, 60)).map(c => ({ ...c, from: c.from - 14, to: c.to + 24 })),
  block: () => clusters(e => e.type === 'punchBlock' || e.type === 'perfectBlock', 3, 60).map(c => ({ ...c, from: c.from - 12, to: c.to + 16 })),
  whiff: () => clusters(e => e.type === 'punchWhiff', 3, 90).map(c => ({ ...c, from: c.from - 14, to: c.to + 14 })),
  knockdown: () => single(['knockdown'], 36, 150),
  hurt: () => single(['rocked', 'bodyHurt', 'liverShot'], 20, 100),
  clinch: () => single(['clinch'], 20, 110),
};
const count = t => events.filter(e => e.type === t).length;
console.log(`${bot.name} (${ids[0]}) v ${style} (${ids[1]}), seed ${seed}: ${in0.length} ticks, ${end ? end.type + (end.winner !== undefined ? ' → side ' + end.winner : '') : 'no result'}`);
console.log(`  lands ${count('punchLand')} · blocks ${count('punchBlock')} · whiffs ${count('punchWhiff')} · rocked ${count('rocked')} · body hurt ${count('bodyHurt')} · knockdowns ${count('knockdown')} · clinches ${count('clinch')}`);
if (kind === 'list') {
  for (const [name, f] of Object.entries(KINDS)) console.log(`  ${name}: ${f().map(m => `${m.from}–${m.to}${m.what ? ' ' + m.what : ' ×' + m.n}`).join(', ') || 'none'}`);
  process.exit(0);
}
if (!KINDS[kind]) { console.error(`unknown kind '${kind}' (${Object.keys(KINDS).join(', ')}, list)`); process.exit(2); }
const moments = KINDS[kind]().sort((a, b) => b.n - a.n || a.from - b.from).slice(0, COUNT).sort((a, b) => a.from - b.from);
if (!moments.length) { console.log(`  no '${kind}' moment in this fight`); process.exit(0); }

// ── The film ─────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = resolve(HERE, 'output', 'fight_film', 'frames');
const OUT = keep ? resolve(HERE, '..', 'docs', 'polish') : resolve(HERE, 'output', 'fight_film');
mkdirSync(FRAMES, { recursive: true }); mkdirSync(OUT, { recursive: true });
const W = 480, H = 300, COLS = 6, MAX_FRAMES = 30;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 20_000 });
await bootReady(page);
await page.evaluate(o => {
  const c = window.__cfg;
  Object.assign(c, o);
  c.rigQuality = 1; c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false;
  c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;   // the lens placed, not chasing, so a frame is its own tick
  window.__focus = -1;
}, over);
await page.evaluate(([i, n]) => { window.__in = [i, n]; }, [in0, in1]);

for (const [mi, m] of moments.entries()) {
  const from = Math.max(1, m.from), to = Math.min(in0.length, m.to);
  const stepBy = Math.max(2, Math.ceil((to - from) / MAX_FRAMES));
  const files = [], labels = [];
  for (let t = from; t <= to; t += stepBy) {
    const fp = await page.evaluate(([ids, seed, t]) => window.__filmFight(ids, seed, window.__in[0], window.__in[1], t), [ids, seed, t]);
    const want = marks[t - 1];
    if (Math.abs(fp.x0 - want.x0) > 1e-9 || Math.abs(fp.h1 - want.h1) > 1e-9) { console.error(`  tick ${t}: the browser's fight has left Node's (x0 ${fp.x0} v ${want.x0}, health ${fp.h1} v ${want.h1}) — a config key differs between them?`); await browser.close(); process.exit(1); }
    await frames(page, 3);
    const f = `${FRAMES}/${bot.name}_${style}_${seed}_${kind}${mi}_t${String(t).padStart(5, '0')}.png`;
    await page.screenshot({ path: f }).catch(() => page.screenshot({ path: f, timeout: 120_000 }));
    const here = events.filter(e => e.tick > t - stepBy && e.tick <= t && ['punchLand', 'punchBlock', 'perfectBlock', 'punchWhiff', 'knockdown', 'rocked', 'bodyHurt', 'liverShot', 'clinch', 'clinchBreak', 'punchStuffed', 'guardBreak', 'slip'].includes(e.type) && (e.type !== 'slip' || e.dodged))
      .map(e => (e.type === 'punchLand' ? `${e.side}:${e.variant ?? e.punch} ${e.grade}` : e.type === 'punchBlock' ? `${e.side}:blk` : e.type === 'punchWhiff' ? `${e.side}:miss` : e.type));
    files.push(f); labels.push(`t${t} ${here.join(' ')}`);
  }
  const sheet = await page.evaluate(async ({ imgs, labels, w, h, cols }) => {
    const rows = Math.ceil(imgs.length / cols);
    const canvas = document.createElement('canvas'); canvas.width = w * cols; canvas.height = h * rows;
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height); g.font = '12px monospace';
    for (let i = 0; i < imgs.length; i++) {
      const img = await new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = imgs[i]; });
      const x = (i % cols) * w, y = Math.floor(i / cols) * h;
      g.drawImage(img, x, y, w, h);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, Math.min(w, g.measureText(labels[i]).width + 12), 18);
      g.fillStyle = '#fff'; g.fillText(labels[i], x + 6, y + 13);
    }
    return canvas.toDataURL('image/png');
  }, { imgs: files.map(f => 'data:image/png;base64,' + readFileSync(f).toString('base64')), labels, w: W, h: H, cols: COLS });
  const path = `${OUT}/film_${bot.name}_${style}_${seed}_${kind}${mi}.png`;
  writeFileSync(path, Buffer.from(sheet.split(',')[1], 'base64'));
  console.log(`  ${kind} ${mi}: ticks ${from}–${to} every ${stepBy} (${files.length} frames, ${m.what ?? '×' + m.n}) → ${path}`);
}
await browser.close();
if (logs.length) console.log(`  console: ${logs.slice(0, 5).join(' | ')}`);
