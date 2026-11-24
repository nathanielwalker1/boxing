/**
 * paint_ablate.mjs — why the proof page's skin and facets vanish in the ring (paintAblate, render/paint.ts).
 *   PORT=5199 node scripts/paint_ablate.mjs
 * One browser session. Freezes one moment (sim posed, camera still), captures one still per paintAblate step, measures
 * the skin inside the fighters' mask (paintDebugMask): mean HSL saturation and lightness, luminance std-dev and a
 * high-pass facet number. Then the final look (play camera), the same still with paintLook off, a contact sheet,
 * triangles with the outline on / off, fps for the old and final looks, a 5 s clip, and the console check.
 * Writes docs/art/step2b/.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, renameSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, gameTime } from './waits.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = `${ROOT}/docs/art/step2b`;
mkdirSync(OUT, { recursive: true });
const VIEW = { width: 1280, height: 720 };
const gpu = ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const logs = [];
const hook = page => {
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
};
const STEPS = ['proof', 'bands', 'desat', 'fog', 'post', 'lights'];

const browser = await chromium.launch({ args: gpu });
const page = await browser.newPage({ viewport: VIEW });
hook(page);
await page.goto(`${DEV_URL}/?human=1`, { waitUntil: 'networkidle', timeout: 30_000 });
await bootReady(page, { frames: 10 });
await frames(page, 200);
await gameTime(page, 9);

// fps + triangles of the old look and the shipped look (outline on), live play, before anything is frozen
const fpsOf = async () => { await gameTime(page, 3); return page.evaluate(() => ({ ...window.__fps })); };
await page.evaluate(() => { window.__cfg.paintLook = false; });
const fpsOld = await fpsOf();
await page.evaluate(() => { Object.assign(window.__cfg, { paintLook: true, paintOutline: true, paintBandMix: 1, paintCamTighten: 0, paintRimStr: 0 }); });
const fpsShipped = await fpsOf();

// freeze: sim posed on the current states, still camera
await page.evaluate(() => {
  const c = window.__cfg;
  Object.assign(c, { camFollow: 0, camFollowLambda: 0, camDollyLambda: 0, camDriftAmp: 0, camShake: 0, camPunchInMax: 0, camCounterPunchIn: 0, camRockedPunchIn: 0, camKoPunchIn: 0, camFinisherPunchIn: 0, camFinisherShake: 0, camJolt: 0, camFinisherJolt: 0, crowdSway: 0 });
  const s = window.__states();
  window.__setPosed(structuredClone(s[0]), structuredClone(s[1]));
});
await frames(page, 60);

const tris = async patch => { await page.evaluate(p => Object.assign(window.__cfg, p), patch); await frames(page, 10); return page.evaluate(() => window.__show.info()); };
const triOld = await tris({ paintLook: false });
const triOutline = await tris({ paintLook: true, paintOutline: true, paintAblate: 5 });
const triNoOutline = await tris({ paintOutline: false });
console.log(`triangles (frozen frame, renderer.info incl. shadow + post passes): old look ${triOld.triangles} (${triOld.calls} calls), paint + outline ${triOutline.triangles} (${triOutline.calls}), paint no outline ${triNoOutline.triangles} (${triNoOutline.calls})`);

// metrics in the page: skin = pure green in the mask capture
const measure = (img, mask) => page.evaluate(async ([x, m]) => {
  const load = async b64 => { const im = new Image(); await new Promise(r => { im.onload = r; im.src = 'data:image/png;base64,' + b64; }); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
  const A = await load(x), M = await load(m), W = A.width, H = A.height;
  const Y = new Float32Array(W * H), skin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const k = i * 4;
    Y[i] = (0.2126 * A.data[k] + 0.7152 * A.data[k + 1] + 0.0722 * A.data[k + 2]) / 255;
    skin[i] = M.data[k + 1] > 200 && M.data[k] < 60 && M.data[k + 2] < 60 ? 1 : 0;
  }
  let n = 0, sS = 0, sL = 0, sY = 0, sYY = 0, hp = 0, hpN = 0, white = 0, rr = 0, gg = 0, bb = 0;
  for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
    const p = j * W + i;
    if (!skin[p]) continue;
    const k = p * 4, r = A.data[k] / 255, g = A.data[k + 1] / 255, b = A.data[k + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), L = (mx + mn) / 2, d = mx - mn;
    const S = d === 0 ? 0 : d / (1 - Math.abs(2 * L - 1));
    n++; sS += S; sL += L; sY += Y[p]; sYY += Y[p] * Y[p]; rr += r; gg += g; bb += b;
    if (L > 0.85) white++;
    // high-pass: |Y - mean of the 8 neighbours|, only where all neighbours are skin (planes, not silhouette edges)
    let all = 1, s8 = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { if (!di && !dj) continue; const q = p + dj * W + di; all &= skin[q]; s8 += Y[q]; }
    if (all) { hp += Math.abs(Y[p] - s8 / 8); hpN++; }
  }
  const mY = sY / n;
  return { px: n, sat: sS / n, light: sL / n, lumStd: Math.sqrt(Math.max(0, sYY / n - mY * mY)), facet: hpN ? hp / hpN : 0, whiteFrac: white / n, rgb: [rr / n, gg / n, bb / n].map(v => Math.round(v * 255)) };
}, [img.toString('base64'), mask.toString('base64')]);

const shoot = async (patch, name) => {
  await page.evaluate(p => Object.assign(window.__cfg, p), patch);
  await frames(page, 20);
  const img = await page.screenshot({ path: `${OUT}/${name}.png` });
  await page.evaluate(() => { window.__cfg.paintDebugMask = true; });
  await frames(page, 5);
  const mask = await page.screenshot();
  await page.evaluate(() => { window.__cfg.paintDebugMask = false; });
  await frames(page, 5);
  return measure(img, mask);
};

const rows = [];
const sheet = [];
for (let n = 0; n < STEPS.length; n++) {
  const name = `ablate_${n}_${STEPS[n]}`;
  const r = await shoot({ paintLook: true, paintAblate: n, paintBandMix: 1, paintRimStr: 0, paintSkinDesat: 0.5, paintOutline: false, paintCamTighten: 0 }, name);
  rows.push({ step: name, ...r }); sheet.push(name);
}
const r6 = await shoot({ paintAblate: 5, paintOutline: true }, 'ablate_6_outline');
rows.push({ step: 'ablate_6_outline (shipped)', ...r6 }); sheet.push('ablate_6_outline');
const fix = { paintOutline: false, paintBandMix: 0.35, paintRimStr: 0.55, paintCamTighten: 0, paintSkinDesat: 0.1 };
const r7 = await shoot({ ...fix, ...(globalThis.FINAL ?? {}) }, 'ablate_7_fix_same_cam');
rows.push({ step: 'ablate_7_fix (same camera)', ...r7 }); sheet.push('ablate_7_fix_same_cam');
for (const r of rows) console.log(`${r.step.padEnd(28)} skin px ${String(r.px).padStart(6)}  sat ${r.sat.toFixed(3)}  L ${r.light.toFixed(3)}  lumStd ${r.lumStd.toFixed(3)}  facet ${(r.facet * 1000).toFixed(1)}e-3  white ${(r.whiteFrac * 100).toFixed(1)}%  rgb ${r.rgb.join(',')}`);

// final: the shipped defaults with the tighter play framing (config defaults for the paint keys)
const defaults = await page.evaluate(() => { const d = window.__cfgDefaults?.() ?? null; return d; });
await page.evaluate(() => { Object.assign(window.__cfg, { paintCamTighten: 0.25, paintAblate: 5, paintOutline: false, paintBandMix: 0.35, paintRimStr: 0.55 }); });
await frames(page, 90);
const rf = await shoot({}, 'final_1280');
console.log(`final_1280                   skin px ${rf.px} sat ${rf.sat.toFixed(3)} L ${rf.light.toFixed(3)} lumStd ${rf.lumStd.toFixed(3)} facet ${(rf.facet * 1000).toFixed(1)}e-3 white ${(rf.whiteFrac * 100).toFixed(1)}%`);
await page.evaluate(() => { window.__cfg.paintLook = false; });
await frames(page, 30);
await page.screenshot({ path: `${OUT}/final_paintoff_1280.png` });
await page.evaluate(() => { window.__cfg.paintLook = true; });
void defaults;

// contact sheet: 4 x 2 tiles at 640x360, labelled
const tiles = sheet.map(n => `${OUT}/${n}.png`);
const b64 = tiles.map(f => execFileSync('base64', ['-i', f]).toString().replace(/\s/g, ''));
const png = await page.evaluate(async ([imgs, names]) => {
  const cv = document.createElement('canvas'); cv.width = 640 * 4; cv.height = 360 * 2;
  const g = cv.getContext('2d');
  for (let i = 0; i < imgs.length; i++) {
    const im = new Image(); await new Promise(r => { im.onload = r; im.src = 'data:image/png;base64,' + imgs[i]; });
    const x = (i % 4) * 640, y = Math.floor(i / 4) * 360;
    g.drawImage(im, x, y, 640, 360);
    g.fillStyle = 'rgba(0,0,0,0.7)'; g.fillRect(x, y + 330, 640, 30);
    g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(names[i], x + 10, y + 352);
  }
  return cv.toDataURL('image/png').split(',')[1];
}, [b64, sheet]);
writeFileSync(`${OUT}/ablate_sheet.png`, Buffer.from(png, 'base64'));

// fps of the final look, live
await page.evaluate(() => { window.__setPosed(null, null); });
const fpsFinal = await fpsOf();
console.log(`fps (overlay, 1280x720 real GPU headless): old look ${fpsOld.fps} (${fpsOld.tris} tris, ${fpsOld.calls} calls), shipped paint+outline ${fpsShipped.fps} (${fpsShipped.tris} tris), final ${fpsFinal.fps} (${fpsFinal.tris} tris, ${fpsFinal.calls} calls)`);

// the clip: a new context in the same browser, recordVideo, 5 s of play with the final look (config defaults)
const vdir = `${OUT}/_video`;
const ctx = await browser.newContext({ viewport: VIEW, recordVideo: { dir: vdir, size: VIEW } });
const p2 = await ctx.newPage();
hook(p2);
await p2.goto(`${DEV_URL}/?human=1`, { waitUntil: 'networkidle', timeout: 30_000 });
await bootReady(p2, { frames: 10 });
await frames(p2, 120);
await gameTime(p2, 5);
await ctx.close();
await browser.close();
const webm = readdirSync(vdir).find(f => f.endsWith('.webm'));
renameSync(`${vdir}/${webm}`, `${OUT}/final_clip.webm`);
try {
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-loglevel', 'error', '-sseof', '-5', '-i', `${OUT}/final_clip.webm`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', `${OUT}/final_clip.mp4`]);
  console.log('clip: final_clip.mp4');
} catch (e) { console.log('clip: ffmpeg failed, kept the .webm', String(e.message).slice(0, 120)); }
execFileSync('sips', ['-Z', '360', `${OUT}/final_1280.png`, '--out', `${OUT}/final_360.png`]);

writeFileSync(`${OUT}/_console.json`, JSON.stringify(logs, null, 2));
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => ['error', 'pageerror', 'warning'].includes(m.type) && !benign(m.text));
console.log(bad.length ? `console problems: ${bad.length}\n${bad.slice(0, 5).map(m => m.text).join('\n')}` : 'console clean');
