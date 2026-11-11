/**
 * flash_probe.mjs — catch a black flash (polish run, item 1).
 *
 * Runs a fight on the REAL GPU (the desktop tier: post pass on), samples every
 * rendered frame inside the page (the WebGL canvas drawn down to 64×36 in the
 * same task as the render, so the drawing buffer is still live), and flags any
 * frame whose mean brightness drops suddenly against the median of the frames
 * just before it, or whose share of near-black pixels jumps. For each flagged
 * frame it keeps the frame, the one before it, and what the game was doing
 * (sim time, hit-stop, round phase, camera distance / elevation, post on).
 *
 *   PORT=5191 node scripts/flash_probe.mjs                 60 s, ?menu=0, scripted brawler on side 0
 *   PORT=5191 node scripts/flash_probe.mjs 180 "?menu=0&seed=3"
 *   extra config: third arg is JSON merged into window.__cfg before sampling, e.g. '{"postEnabled":false}'
 *
 * Not part of `npm test` (it is minutes long); flash_check.mjs is the short guard.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';

const SECONDS = Number(process.argv[2] ?? 60);
const QUERY = process.argv[3] ?? '?menu=0';
const CFG = process.argv[4] ? JSON.parse(process.argv[4]) : {};
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'flash');
mkdirSync(OUT, { recursive: true });

export const SAMPLER = () => {
  const small = document.createElement('canvas'); small.width = 64; small.height = 36;
  const sg = small.getContext('2d', { willReadFrequently: true });
  const keep = [document.createElement('canvas'), document.createElement('canvas')];
  for (const k of keep) { k.width = 480; k.height = 270; }
  let flip = 0;
  const F = window.__flash = { n: 0, means: [], darks: [], flags: [], on: false, maxFlags: 12, nan: 0 };
  const recent = [], recentDark = [];
  const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] ?? 0; };
  const sample = () => {
    const gl = document.querySelector('#app canvas');
    if (!gl || !F.on || !window.__sim) return;
    sg.drawImage(gl, 0, 0, 64, 36);
    const d = sg.getImageData(0, 0, 64, 36).data;
    let sum = 0, dark = 0, marks = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; if (l < 6) dark++;
      if (d[i] - d[i + 1] > 90 && d[i + 2] - d[i + 1] > 90) marks++;   // postNanGuard 2 paints bad pixels magenta
    }
    if (marks > 0) F.marked = (F.marked ?? 0) + 1;
    const mean = sum / (d.length / 4), darkFrac = dark / (d.length / 4);
    const cur = keep[flip]; flip ^= 1;
    cur.getContext('2d').drawImage(gl, 0, 0, 480, 270);
    F.n++; F.means.push(+mean.toFixed(1)); F.darks.push(+darkFrac.toFixed(3));
    if (recent.length >= 20) {
      const m = median(recent), md = median(recentDark);
      if ((mean < m * 0.7 || darkFrac > md + 0.2 || marks > 0) && F.flags.length < F.maxFlags) {
        const s = window.__sim.state();
        F.flags.push({
          frame: F.n, mean: +mean.toFixed(1), median: +m.toFixed(1), dark: +darkFrac.toFixed(3), medianDark: +md.toFixed(3),
          simTime: +s.time.toFixed(3), hitStop: +(s.hitStop ?? 0).toFixed(3), phase: s.round.phase, count: s.round.count,
          down: [s.fighters[0].down, s.fighters[1].down], hurt: [s.fighters[0].hurt, s.fighters[1].hurt],
          dist: +Math.hypot(s.fighters[0].pos.x - s.fighters[1].pos.x, s.fighters[0].pos.z - s.fighters[1].pos.z).toFixed(2),
          pos0: s.fighters[0].pos, pos1: s.fighters[1].pos,
          camDist: +window.__camDist().toFixed(2), camEl: +window.__camEl().toFixed(3), post: window.__show?.post?.() ?? null,
          img: cur.toDataURL('image/png'), before: keep[flip].toDataURL('image/png'),
        });
      }
    }
    recent.push(mean); recentDark.push(darkFrac);
    if (recent.length > 20) { recent.shift(); recentDark.shift(); }
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => raf(t => { cb(t); try { sample(); } catch (e) { F.err = String(e); } });
};

/** A crude brawler for side 0, tick-exact and deterministic: walks in, throws mixed punches, sometimes blocks or slips. */
export const BRAWLER = () => {
  let n = 0;
  window.__sim.drive(0, s => {
    n++;
    const a = s.fighters[0], b = s.fighters[1];
    const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
    const h = (n * 2654435761) >>> 0;
    const i = { move: { x: 0, y: d > 0.85 ? 1 : 0 } };
    const beat = n % 90;
    if (beat < 40 && d < 1.05) {
      if (beat % 10 === 0) { const k = ['jab', 'cross', 'hook', 'uppercut', 'jab', 'cross'][(h >>> 8) % 6]; i[k] = true; if (k === 'hook' || k === 'uppercut') i.move = { x: (h >>> 4) % 2 ? 1 : -1, y: 0 }; }
    } else if (beat >= 60 && beat < 80 && (h >>> 12) % 3 === 0) i.block = true;
    else if (beat === 85) i.move = { x: (h >>> 5) % 2 ? 1 : -1, y: 0 };
    if ((n % 400) > 330) i.move = { x: 0.6, y: -0.6 };   // circle off now and then so the camera travels
    return i;
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch({ headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
  const logs = [];
  page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall due to ReadPixels/.test(m.text())) logs.push(m.text()); });
  page.on('pageerror', e => logs.push(e.message));
  await page.addInitScript(SAMPLER);
  await page.goto(`${DEV_URL}/${QUERY}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.waitForFunction(() => window.__tick && window.__tick.frames > 30, null, { timeout: 120_000 });
  const info = await page.evaluate((cfg) => {
    Object.assign(window.__cfg, cfg);
    const gl = document.querySelector('#app canvas').getContext('webgl2');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return { renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown', tier: window.__show.tier(), post: window.__show.post() };
  }, CFG);
  await page.evaluate(BRAWLER);
  await page.evaluate(() => { window.__flash.on = true; });
  await page.waitForTimeout(SECONDS * 1000);   // wall time on purpose: the probe samples frames, not game time
  const r = await page.evaluate(() => {
    const F = window.__flash, s = [...F.means].sort((a, b) => a - b);
    return { n: F.n, err: F.err ?? null, marked: F.marked ?? 0, flags: F.flags, min: s[0], p01: s[Math.floor(s.length * 0.01)], med: s[s.length >> 1], max: s[s.length - 1], simTime: window.__sim.state().time, post: window.__show.post(), ratio: window.devicePixelRatio };
  });
  await browser.close();
  r.flags.forEach((f, i) => {
    for (const k of ['img', 'before']) { writeFileSync(`${OUT}/flag${i}_${k}.png`, Buffer.from(f[k].split(',')[1], 'base64')); delete f[k]; }
  });
  console.log(`renderer ${info.renderer} · tier ${info.tier} · post ${r.post} · ${QUERY} ${JSON.stringify(CFG)}`);
  console.log(`${r.n} frames in ${SECONDS} s wall (${(r.n / SECONDS).toFixed(1)} fps), sim time ${r.simTime.toFixed(1)} s`);
  console.log(`brightness min ${r.min} · 1st pct ${r.p01} · median ${r.med} · max ${r.max}`);
  console.log(`${r.flags.length} flagged frame(s), ${r.marked} frame(s) with a marked bad pixel${r.err ? ' · sampler error ' + r.err : ''}`);
  for (const [i, f] of r.flags.entries()) console.log(`  #${i} ${JSON.stringify(f)}`);
  if (logs.length) console.log(`console: ${logs.slice(0, 5).join(' | ')}`);
}
