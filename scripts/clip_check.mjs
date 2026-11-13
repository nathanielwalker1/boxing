/**
 * clip_check.mjs — does skin ever show through the trunks, the gloves or the boots? (anim Phase 1.3)
 *
 *   PORT=5195 node scripts/clip_check.mjs                 6 fighters × ~22 poses, writes docs/anim/CLIPPING.md
 *   CLIP_OUT=docs/anim/p1_2/clipping_before.md PORT=… node scripts/clip_check.mjs   write the report elsewhere
 *   PORT=5195 node scripts/clip_check.mjs red,boiler      only these builds
 *
 * Method (geometric, no pixels). The page's own fighter meshes are read through window.__rigMeshes (rig/mesh.ts): for each
 * fighter, at the BIND pose, every skin vertex (torso, arms, legs) whose outward normal ray meets the trunks, a glove or a boot within
 * 12 cm is a "must-be-covered" vertex. In each pose the skinned positions and normals are computed here from the live bone matrices
 * (the same blend the GPU does), and a must-be-covered vertex counts as EXPOSED when its outward ray no longer meets any coverer
 * triangle: the skin is outside the shell, or the shell has slid away from it. Counts only; no tolerance fudge beyond the 12 cm reach.
 *
 * Poses are the real game pipeline (the rig view draws them, so its solver, springs and cloth are in the pose): sim punch poses at
 * the tick of full extension (window.__pose), the held block, a crouch and a twisted torso through the view's state override, and
 * scripted exchanges through window.__rigReplay (slips, a roll, footsteps, the knockdown fall and get-up). Each of the six builds
 * wears a different cut so all six (short, classic, long, belt, skirt, split) are covered.
 *
 * Fails above cfg.clipMaxExposed vertices in any single fighter × pose.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { check, done } from './check.js';
import { frames } from './waits.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', process.env.CLIP_OUT ?? 'docs/anim/CLIPPING.md');
const BUILDS = [['red', 'short'], ['boiler', 'classic'], ['raffle', 'belt'], ['alambre', 'long'], ['monsoon', 'skirt'], ['grandad', 'split']];
const only = process.argv[2] ? process.argv[2].split(',') : null;
const builds = BUILDS.filter(b => !only || only.includes(b[0]));

const at = o => { const a = []; for (const [k, v] of Object.entries(o)) a[Number(k)] = v; return a; };
const flick = (x, y, t) => ({ [t]: { move: { x, y } }, [t + 1]: { move: { x, y } } });
const stick = (x, y, from, to) => { const a = []; for (let i = from; i <= to; i++) a[i] = { move: { x, y } }; return a; };
const none = [];
const KD = { healthDamagePerImpulse: 0.006 };
// name → how to set it up. look = a settled pose kind; punch = a sim punch pose; over = a state override on the rest pose; replay = a scripted run.
// The fighter under test is always side 0; side 1 does the punching in a replay.
const POSES = [
  ['guard (high)', { look: 'rest' }],
  ['block', { look: 'block' }],
  ['jab, full reach', { punch: ['jab', 'lead', -1] }],
  ['cross, full reach', { punch: ['cross', 'rear', -1] }],
  ['hook, lead, full', { punch: ['hook', 'lead', -1] }],
  ['hook, rear, full', { punch: ['hook', 'rear', -1] }],
  ['uppercut, lead, full', { punch: ['uppercut', 'lead', -1] }],
  ['uppercut, rear, full', { punch: ['uppercut', 'rear', -1] }],
  ['deep crouch', { look: 'rest', over: { crouch: 0.4, posture: 1, level: 1 } }],
  ['torso twisted', { look: 'rest', over: { torsoTwist: 0.9 } }],
  ['arms overhead', { look: 'rest', gloves: { up: 0.75 } }],
  ['slip left', { replay: [0.79, at(flick(-1, 0, 0)), none, 8] }],
  ['slip right', { replay: [0.79, at(flick(1, 0, 0)), none, 8] }],
  ['roll', { replay: [0.79, at(flick(0, 1, 0)), none, 8] }],
  ['wide step', { replay: [1.2, stick(1, 0, 2, 62), none, 40] }],
  ['mid-step', { replay: [1.5, [...stick(0, 0, 0, 1), ...stick(0, 1, 2, 24)], none, 14] }],
  ['knee (falling)', { replay: [0.79, none, at({ 2: { cross: true } }), 36], cfg: KD }],
  ['on the back / prone', { replay: [0.79, none, at({ 2: { cross: true } }), 60], cfg: KD }],
  ['down, arms out', { replay: [0.79, none, at({ 2: { cross: true } }), 84], cfg: KD }],
  ['hands and knees', { replay: [0.79, none, at({ 2: { cross: true } }), 116], cfg: KD }],
  ['seated', { replay: [0.79, none, at({ 2: { cross: true } }), 148], cfg: KD }],
  ['getting up', { replay: [0.79, none, at({ 2: { cross: true } }), 172], cfg: KD }],
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 240, height: 180 } });
const logs = [];
page.on('console', m => { if ((m.type() === 'error' || m.type() === 'warning') && !/GPU stall/.test(m.text())) logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.goto(`${DEV_URL}/?ai=0`, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForFunction(() => !!(window.__tick && window.__tick.ready && window.__tick.frames >= 5 && window.__cfg && window.__rigMeshes), null, { timeout: 120_000 });
await page.evaluate(() => {
  const c = window.__cfg;
  c.rigQuality = 1; c.debugHitboxes = false; c.debugFps = false; c.refEnabled = false; c.roundSeconds = 36000;
  window.__sim.reset(1);
  // The measurement, in the page: skinned positions and normals from the live bone matrices, then one outward ray per vertex.
  window.__clip = id => {
    const rm = [...window.__rigMeshes].reverse().find(m => m.specId === id);
    if (!rm) return null;
    rm.group.updateMatrixWorld(true);
    rm.skeleton.update();
    const g = rm.body.geometry, P = g.attributes.position, N = g.attributes.normal, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight, K = g.attributes.aKind;
    const idx = g.index.array, n = P.count, bm = rm.skeleton.boneMatrices;
    const skin = (src, trans) => {
      const out = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) {
        const x = src.getX(v), y = src.getY(v), z = src.getZ(v);
        let ox = 0, oy = 0, oz = 0;
        for (let k = 0; k < 4; k++) {
          const w = SW.getComponent(v, k); if (w === 0) continue;
          const o = SI.getComponent(v, k) * 16;
          ox += w * (bm[o] * x + bm[o + 4] * y + bm[o + 8] * z + (trans ? bm[o + 12] : 0));
          oy += w * (bm[o + 1] * x + bm[o + 5] * y + bm[o + 9] * z + (trans ? bm[o + 13] : 0));
          oz += w * (bm[o + 2] * x + bm[o + 6] * y + bm[o + 10] * z + (trans ? bm[o + 14] : 0));
        }
        out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
      }
      return out;
    };
    const part = nm => rm.parts.find(p => p.name === nm);
    const skinParts = ['torso', 'arm0', 'arm1', 'leg0', 'leg1'].map(part).filter(Boolean);
    // Rays against a triangle soup (Möller–Trumbore), nearest hit within maxT.
    // Who covers what: the torso and the legs by the trunks (and a leg by its own boot), an arm by its own glove. A glove hanging at the hip is not a cover for the hip.
    const COVER = { torso: ['trunks'], leg0: ['trunks', 'boot0'], leg1: ['trunks', 'boot1'], arm0: ['glove0'], arm1: ['glove1'] };
    const soup = (names, pos) => {
      const t = [];
      for (const nm of names) { const p = part(nm); if (!p) continue; for (let i = p.i0; i < p.i1; i += 3) for (let k = 0; k < 3; k++) { const v = idx[i + k]; t.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); } }
      return new Float32Array(t);
    };
    const soups = pos => { const o = {}; for (const k in COVER) o[k] = soup(COVER[k], pos); return o; };
    const hits = (T, ox, oy, oz, dx, dy, dz, maxT) => {
      for (let i = 0; i < T.length; i += 9) {
        const e1x = T[i + 3] - T[i], e1y = T[i + 4] - T[i + 1], e1z = T[i + 5] - T[i + 2];
        const e2x = T[i + 6] - T[i], e2y = T[i + 7] - T[i + 1], e2z = T[i + 8] - T[i + 2];
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det, tx = ox - T[i], ty = oy - T[i + 1], tz = oz - T[i + 2];
        const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const w = (dx * qx + dy * qy + dz * qz) * inv; if (w < 0 || u + w > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > 1e-5 && t < maxT) return true;
      }
      return false;
    };
    const REACH = 0.12;
    // Five rays per vertex: along its normal and four tilted 35 degrees off it. Returns how many meet the soup.
    const five = (T, pos, nrm, v) => {
      let nx = nrm[v * 3], ny = nrm[v * 3 + 1], nz = nrm[v * 3 + 2];
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
      let t1x = ay * nz, t1y = -ax * nz, t1z = ax * ny - ay * nx; const tl = Math.hypot(t1x, t1y, t1z) || 1; t1x /= tl; t1y /= tl; t1z /= tl;
      const t2x = ny * t1z - nz * t1y, t2y = nz * t1x - nx * t1z, t2z = nx * t1y - ny * t1x;
      const ox = pos[v * 3], oy = pos[v * 3 + 1], oz = pos[v * 3 + 2];
      let hit = hits(T, ox, oy, oz, nx, ny, nz, REACH) ? 1 : 0;
      for (const [s1, s2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const dx = nx + 0.7 * (s1 * t1x + s2 * t2x), dy = ny + 0.7 * (s1 * t1y + s2 * t2y), dz = nz + 0.7 * (s1 * t1z + s2 * t2z), dl = Math.hypot(dx, dy, dz);
        if (hits(T, ox, oy, oz, dx / dl, dy / dl, dz / dl, REACH)) hit++;
      }
      return hit;
    };
    if (!rm.__must) {
      // Bind: the skin vertices the shells cover robustly now (all five rays meet the cover; a vertex on the cover's rim would flicker) are the ones that must stay covered.
      const bp = new Float32Array(n * 3), bn = new Float32Array(n * 3);
      for (let v = 0; v < n; v++) { bp[v * 3] = P.getX(v); bp[v * 3 + 1] = P.getY(v); bp[v * 3 + 2] = P.getZ(v); bn[v * 3] = N.getX(v); bn[v * 3 + 1] = N.getY(v); bn[v * 3 + 2] = N.getZ(v); }
      const TS = soups(bp), must = [];
      for (const p of skinParts) for (let v = p.v0; v < p.v1; v++) {
        if (K.getX(v) !== 0) continue;   // skin kind only (the referee's cloth torso is not 'skin')
        if (five(TS[p.name], bp, bn, v) === 5) must.push([v, p.name]);
      }
      rm.__must = must;
    }
    // Posed: a must-cover vertex is EXPOSED when at least four of its five rays meet nothing (the skin is outside the shell or the shell has slid off it);
    // one or two misses is a vertex at the rim of the cover, which still has cloth over most of its outward half-space.
    const pp = skin(P, true), pn = skin(N, false), TS = soups(pp);
    const bad = {}, ex = [];
    let total = 0;
    for (const [v, name] of rm.__must) {
      if (five(TS[name], pp, pn, v) <= 1) { total++; bad[name] = (bad[name] ?? 0) + 1; if (ex.length < 60) ex.push([name, +P.getX(v).toFixed(3), +P.getY(v).toFixed(3), +P.getZ(v).toFixed(3)]); }
    }
    return { total, bad, must: rm.__must.length, ex };
  };
});

const rows = [];
let worst = { n: -1 };
for (const [id, cut] of builds) {
  await page.evaluate(([id, cut]) => { window.__rosterSpec(id).trunksStyle = cut; }, [id, cut]);
  const row = { id, cut, poses: [] };
  for (const [name, p] of POSES) {
    const restore = await page.evaluate(over => { const was = {}; for (const k in over) { was[k] = window.__cfg[k]; window.__cfg[k] = over[k]; } return was; }, p.cfg ?? {});
    await page.evaluate(([id, p]) => {
      for (const s of [0, 1]) { window.__rig?.[s]?.override?.(null); window.__rig?.[s]?.freeze?.(false); }
      window.__look(id, p.look === 'block' ? 'block' : 'rest', 0);
    }, [id, p]);
    await frames(page, 4);
    await page.evaluate(([p]) => {
      if (p.punch) window.__pose(0, p.punch[0], p.punch[1], p.punch[2]);
      if (p.over) window.__rig[0].override(p.over);
      if (p.gloves) {
        const st = window.__states()[0];
        window.__rig[0].override({ gloves: st.gloves.map(g => ({ ...g, pos: { ...g.pos, y: g.pos.y + p.gloves.up }, target: { ...g.target, y: g.target.y + p.gloves.up } })) });
      }
      if (p.replay) { const [dist, s0, s1, t] = p.replay; window.__rigReplay(dist, Array.from(s0, x => x ?? null).map(x => x ?? {}), t, Array.from(s1, x => x ?? null).map(x => x ?? {}), {}); }
    }, [p]);
    await frames(page, 5);
    const r = await page.evaluate(id => window.__clip(id), id);
    await page.evaluate(was => { Object.assign(window.__cfg, was); }, restore);
    row.poses.push({ name, ...(r ?? { total: -1, bad: {}, must: 0 }) });
    if (process.env.CLIP_EX && r && r.total > 15) console.log('     ' + JSON.stringify(r.ex.slice(0, 14)));
    if (r && r.total > worst.n) worst = { n: r.total, id, cut, pose: name };
    console.log(`  ${id.padEnd(8)} ${cut.padEnd(8)} ${name.padEnd(22)} exposed ${String(r?.total ?? '?').padStart(4)} of ${r?.must ?? '?'}  ${JSON.stringify(r?.bad ?? {})}`);
  }
  rows.push(row);
}
const limit = await page.evaluate(() => window.__cfg.clipMaxExposed);
await browser.close();

// The report.
const names = POSES.map(p => p[0]);
let md = `# Clipping check\n\nGenerated by \`scripts/clip_check.mjs\` (geometric: skin vertices the trunks, gloves and boots cover at rest, tested in each pose by an outward ray against the posed shells).\nEntries are the number of EXPOSED must-cover skin vertices (fail above ${limit}). The fighter under test is side 0, posed through the real rig view.\n\n`;
md += `| pose | ${rows.map(r => `${r.id} (${r.cut})`).join(' | ')} |\n|---|${rows.map(() => '---:').join('|')}|\n`;
for (let k = 0; k < names.length; k++) md += `| ${names[k]} | ${rows.map(r => r.poses[k].total).join(' | ')} |\n`;
md += `| must-cover vertices | ${rows.map(r => r.poses[0].must).join(' | ')} |\n\nWorst: ${worst.id} (${worst.cut}) in "${worst.pose}": ${worst.n} vertices.\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, md);
console.log(`report → ${OUT}`);
check(`worst fighter x pose (${worst.id} ${worst.cut}, ${worst.pose}) exposes ${worst.n} skin vertices, limit ${limit}`, worst.n <= limit);
check(`console clean (${logs.length} error/warning)`, logs.length === 0, logs.slice(0, 3).join(' | '));
done();
