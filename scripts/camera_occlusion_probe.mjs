/**
 * camera_occlusion_probe.mjs — how often the play camera's view of either fighter is blocked by a corner post / pad,
 * or crossed by a rope, over a seeded live fight (the AI vs a scripted circling player, so the pair swaps sides).
 *   PORT=5199 node scripts/camera_occlusion_probe.mjs [seconds] [variantsJSON]
 * variantsJSON: {"name": {cfgKey: value, ...}, ...} — each variant x each seed runs in its own page, in parallel.
 * Geometry is analytic, from the same constants ring.ts builds with: posts + cushions as a vertical cylinder at each
 * corner, ropes as horizontal lines on the four sides. Fighter points come from the drawn body (__humanProbe).
 * Per fighter it reports: % of sampled frames where any head/torso point is behind a post/pad, and % where a rope's
 * line passes across the head-to-waist span. "corner A/B" splits samples by which side of the ring the player is on
 * relative to the camera's ring diagonal, so both arrangements are covered.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, gameTime, frames } from './waits.js';

const SECONDS = Number(process.argv[2] ?? 40);
const SEEDS = [1, 2, 3];
const VARIANTS = process.argv[3] ? JSON.parse(process.argv[3]) : { current: {} };

const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const runs = [];
for (const [name, over] of Object.entries(VARIANTS)) for (const seed of SEEDS) runs.push({ name, over, seed });

async function one({ name, over, seed }) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(`${DEV_URL}/?human=1&seed=${seed}`, { waitUntil: 'networkidle', timeout: 60_000 });
  await bootReady(page, { frames: 10 });
  await page.evaluate(([over]) => {
    Object.assign(window.__cfg, { paintLook: true }, over);
    // the player: circles one way, backs up, circles the other way, steps in; a jab now and then
    let k = 0;
    window.__sim.drive(0, () => {
      k++;
      const ph = Math.floor(k / 240) % 4;
      const move = [{ x: 1, y: 0.15 }, { x: 0.3, y: -1 }, { x: -1, y: 0.15 }, { x: -0.2, y: 0.8 }][ph];
      return { move, jab: k % 47 === 0 };
    });
    const RH = 6.1 / 2, c = window.__cfg;
    const h = RH + c.postR;                                  // rope line (ring.ts: h = RING_HALF + postR)
    const pOff = RH + c.postR + 0.05;                        // post centre
    const postTop = c.ropeTopY + 0.25 + 0.07;
    const PR = Math.max(c.postR * 1.35, c.ringCushionW / 2 + 0.02);   // post + cushion footprint
    const ropeY = []; for (let i = 0; i < c.ropeCount; i++) ropeY.push(c.ropeTopY * (i + 1) / c.ropeCount);
    const corners = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(([a, b]) => [a * pOff, b * pOff]);
    const S = window.__occ = { n: 0, post: [0, 0], rope: [0, 0], ropeHead: [0, 0], byArr: { A: { n: 0, post: [0, 0], rope: [0, 0] }, B: { n: 0, post: [0, 0], rope: [0, 0] } }, inside: 0, worst: [], el: 0, dist: 0, fov: 0 };
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    function postBlocks(C, P) {
      for (const [cx, cz] of corners) {
        const dx = P[0] - C[0], dz = P[2] - C[2], fx = C[0] - cx, fz = C[2] - cz;
        const A = dx * dx + dz * dz, B = 2 * (fx * dx + fz * dz), Cc = fx * fx + fz * fz - PR * PR;
        const disc = B * B - 4 * A * Cc;
        if (disc < 0 || A < 1e-9) continue;
        const sq = Math.sqrt(disc);
        let t0 = (-B - sq) / (2 * A), t1 = (-B + sq) / (2 * A);
        t0 = Math.max(t0, 0); t1 = Math.min(t1, 0.995);
        if (t0 > t1) continue;
        const y0 = C[1] + (P[1] - C[1]) * t0, y1 = C[1] + (P[1] - C[1]) * t1;
        if (Math.min(y0, y1) < postTop) return true;
      }
      return false;
    }
    // ray C->P meets each side plane at t: its height there and its position along the side
    function planeHits(C, P) {
      const out = [];
      for (const [ax, s] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
        const d = P[ax] - C[ax]; if (Math.abs(d) < 1e-9) continue;
        const t = (s * h - C[ax]) / d; if (t <= 0 || t >= 1) continue;
        const o = ax === 0 ? 2 : 0, along = C[o] + (P[o] - C[o]) * t;
        if (Math.abs(along) > h) continue;
        out.push({ key: ax * 10 + s, y: C[1] + (P[1] - C[1]) * t });
      }
      return out;
    }
    function ropeCrosses(C, top, bot) {
      const a = planeHits(C, top), b = planeHits(C, bot);
      for (const ha of a) { const hb = b.find(x => x.key === ha.key); if (!hb) continue;
        const lo = Math.min(ha.y, hb.y) - 0.03, hi = Math.max(ha.y, hb.y) + 0.03;
        if (ropeY.some(y => y > lo && y < hi)) return true; }
      return false;
    }
    let f = 0;
    const loop = () => {
      requestAnimationFrame(loop);
      if (++f % 3) return;
      if (window.__tick.simTicks < 120) return;
      const cp = window.__camPos(), C = [cp[0], cp[1], cp[2]];
      const pr = [window.__humanProbe(0), window.__humanProbe(1)];
      if (!pr[0] || !pr[1]) return;
      S.n++; S.el += window.__camEl() * 180 / Math.PI; S.dist += window.__camDist(); S.fov += cp[3];
      if (Math.abs(C[0]) < h && Math.abs(C[2]) < h) S.inside++;
      // arrangement: which side of the camera->ring-centre line the player stands on
      const st = window.__states(), p0 = st[0].pos, p1 = st[1].pos;
      const arr = p0.x + p0.z < p1.x + p1.z ? 'A' : 'B';   // A: the player is the one nearer the blue corner; B: nearer the red
      S.byArr[arr].n++;
      const hit = [];
      for (let s = 0; s < 2; s++) {
        const q = pr[s], head = q.head, shL = q.shoulders.left, shR = q.shoulders.right, hips = q.hips;
        const chest = lerp(shL, shR, 0.5), waist = lerp(chest, hips, 0.8);
        const headTop = [head[0], head[1] + 0.1, head[2]];
        const pts = [head, headTop, shL, shR, chest, lerp(chest, hips, 0.45), waist];
        const pb = pts.some(P => postBlocks(C, P));
        const rb = ropeCrosses(C, headTop, waist);
        const rh = ropeCrosses(C, headTop, lerp(head, chest, 0.4));
        if (pb) { S.post[s]++; S.byArr[arr].post[s]++; }
        if (rb) { S.rope[s]++; S.byArr[arr].rope[s]++; }
        if (rh) S.ropeHead[s]++;
        hit.push(pb ? 'P' : rb ? 'R' : '.');
      }
      if (hit.includes('P') && S.worst.length < 400) S.worst.push(window.__tick.simTicks);
    };
    requestAnimationFrame(loop);
  }, [over]);
  await gameTime(page, SECONDS);
  const r = await page.evaluate(() => window.__occ);
  const t = await page.evaluate(() => window.__tick);
  await page.close();
  return { name, seed, r, errs, gt: t.gameTime };
}

const res = await Promise.all(runs.map(one));
const pc = (a, n) => (100 * a / Math.max(1, n)).toFixed(1).padStart(5);
for (const name of Object.keys(VARIANTS)) {
  const rs = res.filter(x => x.name === name);
  const sum = { n: 0, post: [0, 0], rope: [0, 0], ropeHead: [0, 0], inside: 0, el: 0, dist: 0, fov: 0, A: { n: 0, post: [0, 0], rope: [0, 0] }, B: { n: 0, post: [0, 0], rope: [0, 0] } };
  for (const { r } of rs) {
    sum.n += r.n; sum.inside += r.inside; sum.el += r.el; sum.dist += r.dist; sum.fov += r.fov;
    for (const s of [0, 1]) { sum.post[s] += r.post[s]; sum.rope[s] += r.rope[s]; sum.ropeHead[s] += r.ropeHead[s];
      for (const k of ['A', 'B']) { sum[k].post[s] += r.byArr[k].post[s]; sum[k].rope[s] += r.byArr[k].rope[s]; } }
    for (const k of ['A', 'B']) sum[k].n += r.byArr[k].n;
  }
  console.log(`${name.padEnd(14)} n=${sum.n}  post/pad red ${pc(sum.post[0], sum.n)}% blue ${pc(sum.post[1], sum.n)}%  | rope head-waist red ${pc(sum.rope[0], sum.n)}% blue ${pc(sum.rope[1], sum.n)}%  | rope head-neck red ${pc(sum.ropeHead[0], sum.n)}% blue ${pc(sum.ropeHead[1], sum.n)}%  | cam inside ropes ${pc(sum.inside, sum.n)}%  mean el ${(sum.el / sum.n).toFixed(1)} dist ${(sum.dist / sum.n).toFixed(2)} fov ${(sum.fov / sum.n).toFixed(1)}`);
  for (const k of ['A', 'B']) console.log(`   arrangement ${k} n=${sum[k].n}: post red ${pc(sum[k].post[0], sum[k].n)}% blue ${pc(sum[k].post[1], sum[k].n)}%  rope red ${pc(sum[k].rope[0], sum[k].n)}% blue ${pc(sum[k].rope[1], sum[k].n)}%`);
  const w = rs.find(x => x.r.worst.length); if (w) console.log(`   first post-blocked ticks (seed ${w.seed}): ${w.r.worst.slice(0, 12).join(' ')}`);
  const e = rs.flatMap(x => x.errs); if (e.length) console.log(`   page errors: ${e.slice(0, 3).join(' | ')}`);
}
await browser.close();
