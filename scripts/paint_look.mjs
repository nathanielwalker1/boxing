/**
 * paint_look.mjs — captures for the Bellows x Sifu look test (src/render/paint.ts), one browser session.
 *   PORT=5199 node scripts/paint_look.mjs
 * Writes docs/art/step2/: look_new.png, look_old.png (same page, paintLook toggled), look_new_phone.png (sips),
 * look_new_clip.mp4 (5 s recordVideo -> ffmpeg; the .webm is kept if conversion fails). Prints the frame-to-frame
 * diff of two still-camera captures (camera drift and crowd sway off) so shimmer is a number, and the console check.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime } from './waits.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = `${ROOT}/docs/art/step2`;
mkdirSync(OUT, { recursive: true });
const VIEW = { width: 1280, height: 720 };
const gpu = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const logs = [];
const hook = page => {
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
};

const browser = await chromium.launch({ args: gpu });
const page = await browser.newPage({ viewport: VIEW });
hook(page);
await page.goto(`${DEV_URL}/?human=1`, { waitUntil: 'networkidle', timeout: 30_000 });
await bootReady(page, { frames: 10 });
await frames(page, 200);
await gameTime(page, 9);   // mid-fight: both fighters are trading by now

await page.evaluate(() => { window.__cfg.paintLook = true; });
await frames(page, 30);
await page.screenshot({ path: `${OUT}/look_new.png` });
await page.evaluate(() => { window.__cfg.paintLook = false; });
await frames(page, 30);
await page.screenshot({ path: `${OUT}/look_old.png` });
await page.evaluate(() => { window.__cfg.paintLook = true; });
await frames(page, 30);

// shimmer: two captures from a still camera, drift + crowd sway off; diff the room (everything outside the fighters' box)
await page.evaluate(() => {   // a truly still camera: fixed seat, no chase, no handheld drift, no hit kicks; crowd sway off
  const c = window.__cfg;
  Object.assign(c, { camFollow: 0, camFollowLambda: 0, camDollyLambda: 0, camDriftAmp: 0, camShake: 0, camPunchInMax: 0, camCounterPunchIn: 0, camRockedPunchIn: 0, camKoPunchIn: 0, camFinisherPunchIn: 0, camFinisherShake: 0, camJolt: 0, camFinisherJolt: 0, crowdSway: 0 });
});
await frames(page, 60);
const a = await page.screenshot(), b = await page.screenshot();
const diff = await page.evaluate(async ([x, y]) => {
  const load = async b64 => { const im = new Image(); await new Promise(r => { im.onload = r; im.src = 'data:image/png;base64,' + b64; }); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
  const A = await load(x), B = await load(y), W = A.width, H = A.height;
  let maxAll = 0, maxRoom = 0, sum = 0, n = 0, hot = 0; const where = [];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = (j * W + i) * 4;
    const d = Math.max(Math.abs(A.data[k] - B.data[k]), Math.abs(A.data[k + 1] - B.data[k + 1]), Math.abs(A.data[k + 2] - B.data[k + 2]));
    maxAll = Math.max(maxAll, d);
    const inFighters = i > W * 0.2 && i < W * 0.8 && j > H * 0.15 && j < H * 0.85;
    const inOverlay = i < 240 && j < 60;   // the fps readout redraws its text every frame: not the picture
    if (!inFighters && !inOverlay) { maxRoom = Math.max(maxRoom, d); sum += d; n++; if (d > 24) { hot++; if (hot <= 3) where.push(`${i},${j}:${d}`); } }
  }
  return { maxAll, maxRoom, meanRoom: sum / n, hot, where };
}, [a.toString('base64'), b.toString('base64')]);
console.log(`frame diff (still camera, ~2 frames apart): max any pixel ${diff.maxAll}, max outside the fighters' box ${diff.maxRoom}, mean outside ${diff.meanRoom.toFixed(4)} (0-255 per channel); pixels >24 outside: ${diff.hot} e.g. ${diff.where.join(' ')}`);
await browser.close();

// phone thumbnail
execFileSync('sips', ['--resampleWidth', '360', `${OUT}/look_new.png`, '--out', `${OUT}/look_new_phone.png`]);

// the clip: a fresh context with recordVideo; five seconds of game time after the arena is up
const vdir = `${OUT}/_video`;
const b2 = await chromium.launch({ args: gpu });
const ctx = await b2.newContext({ viewport: VIEW, recordVideo: { dir: vdir, size: VIEW } });
const p2 = await ctx.newPage();
hook(p2);
await p2.goto(`${DEV_URL}/?human=1`, { waitUntil: 'networkidle', timeout: 30_000 });
await bootReady(p2, { frames: 10 });
await frames(p2, 120);
await gameTime(p2, 5);
await ctx.close();
await b2.close();
const webm = readdirSync(vdir).find(f => f.endsWith('.webm'));
renameSync(`${vdir}/${webm}`, `${OUT}/look_new_clip.webm`);
try {
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error', '-i', `${OUT}/look_new_clip.webm`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', `${OUT}/look_new_clip.mp4`]);
  console.log('clip: look_new_clip.mp4');
} catch (e) { console.log('clip: ffmpeg failed, kept the .webm', String(e.message).slice(0, 120)); }

writeFileSync(`${OUT}/_console.json`, JSON.stringify(logs, null, 2));
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => ['error', 'pageerror', 'warning'].includes(m.type) && !benign(m.text));
console.log(bad.length ? `console problems: ${bad.length}\n${bad.slice(0, 5).map(m => m.text).join('\n')}` : 'console clean');
