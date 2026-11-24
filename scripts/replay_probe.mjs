// REPLAY vs LIVE, tick by tick. One AI-vs-AI fight is recorded in the page, then drawn twice through the human views:
// live (one drawn frame per tick) and the knockdown replay's way (SUB drawn frames per tick, fractional alpha, view dt / SUB).
// Per punch: drawn glove gap to the target's drawn head / torso at the land tick, and the glove's worst off-path pop
// (distance from the midpoint of its neighbours, per drawn frame). argv: [2] seconds, [3] seed, [4] SUB, [5] cfg JSON.
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { bootReady, until } from './waits.js';

const SECONDS = +(process.argv[2] || 40), SEED = +(process.argv[3] || 1), SUB = +(process.argv[4] || 4);
const CFG = process.argv[5] && process.argv[5] !== '-' ? JSON.parse(process.argv[5]) : null;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const logs = [];
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.text()); });
page.on('pageerror', e => logs.push(e.message));
await page.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} }; });
await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await bootReady(page);
await until(page, () => !!window.__humanFeeds?.[0]?.drive && !!window.__humanFeeds?.[1] && typeof window.__humanProbe === 'function', undefined, { label: 'human views', timeout: 150_000 });
await page.evaluate(() => { const c = window.__cfg; c.debugHitboxes = false; c.refEnabled = false; });
if (CFG) await page.evaluate(o => Object.assign(window.__cfg, o), CFG);

const runOnce = () => page.evaluate(async ({ ticks, seed, SUB, TR }) => {
  const w = window;
  const core = await import('/src/core/index.ts'), sim = await import('/src/sim/index.ts'), AI = await import('/src/ai/index.ts');
  const cfg = w.__cfg, feeds = w.__humanFeeds, DT = core.SIM_DT;
  const st0 = w.__states();
  const specs = [0, 1].map(i => core.ROSTER.find(r => r.id === st0[i].specId));
  for (const side of [0, 1]) feeds[side].freeze(true);
  // record
  let s = sim.createState(specs, cfg, seed);
  const ai = [AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg))];
  const frames = [{ s, ev: [] }];
  for (let t = 0; t < ticks; t++) {
    const d0 = AI.aiStep(ai[0], s, cfg), d1 = AI.aiStep(ai[1], s, cfg); ai[0] = d0.ai; ai[1] = d1.ai;
    const r = sim.step(s, [d0.input, d1.input], cfg);
    s = r.state; frames.push({ s, ev: r.events });
  }
  const evOf = (ev, side) => ev.filter(e => !('side' in e) || e.side === side || ('target' in e && e.target === side));
  const a3 = x => Array.isArray(x) ? x : [x.x, x.y, x.z];
  // draw a pass; rec[t] = array of SUB drawn frames, each { g: [[lead],[rear]] per side, head, drawn } per side
  const pass = sub => {
    for (let k = 0; k < 40; k++) for (const side of [0, 1]) feeds[side].feed(frames[0].s.fighters[side], frames[0].s.fighters[side], []);
    const rec = [null];
    for (let t = 1; t < frames.length; t++) {
      const fr = [];
      for (let k = 1; k <= sub; k++) {
        w.__humanStages = sub > 1 ? {} : undefined;
        if (TR && sub > 1 && t >= TR[1] && t <= TR[1] + 1) { w.__gdbg = []; } else if (w.__gdbg) { (w.__gdbgAll ??= []).push(...w.__gdbg); w.__gdbg = undefined; }
        for (const side of [0, 1]) feeds[side].drive(frames[t - 1].s.fighters[side], frames[t].s.fighters[side], k / sub, DT / sub, k === 1 ? evOf(frames[t].ev, side) : []);
        fr.push([0, 1].map(side => { const p = w.__humanProbe(side); const st = w.__humanStages?.[side]; const lL = a3(p.gloves.lead)[0] === a3(p.gloves.left)[0];
          return { st: st ? st.map(([n, l, r]) => [n, lL ? l : r, lL ? r : l]) : null, g: [a3(p.gloves.lead), a3(p.gloves.rear)], el: [p.elbows, p.shoulders], head: a3(p.head), dr: p.drawn, clip: p.clip, cf: p.conform.kind,
          ...(TR && sub > 1 && side === TR[0] && t >= TR[1] && t <= TR[2] ? { x: { w: p.conform.w, at: p.conform.at, toHit: p.toHit, reach: p.reach, arm: p.armDbg, frame: p.frame, pc: p.punchClip, lunge: p.lungeDbg, act: p.armAct } } : {}) }; }));
      }
      rec.push(fr);
    }
    return rec;
  };
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const segD = (p, a, b) => { const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]; const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2; const u = L > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0; return d3(p, [a[0] + ab[0] * u, a[1] + ab[1] * u, a[2] + ab[2] * u]); };
  const GR = 0.075;
  // punches: start tick, side, hand idx, type, end (+ land tick / part)
  const punches = [];
  const open = [null, null];
  for (let t = 1; t < frames.length; t++) {
    for (const e of frames[t].ev) {
      if (e.type === 'punchStart') { const p = { side: e.side, h: e.hand === 'lead' ? 0 : 1, type: e.punch, level: frames[t].s.fighters[e.side].punch?.level ?? null, t0: t, land: -1, part: null, out: 'none' }; punches.push(p); open[e.side] = p; }
      if ((e.type === 'punchLand' || e.type === 'punchBlock' || e.type === 'punchWhiff') && open[e.side]) { const p = open[e.side]; p.out = e.type.slice(5).toLowerCase(); if (e.type === 'punchLand') { p.land = t; p.part = e.part; } }
    }
  }
  for (const p of punches) { let t = p.t0; while (t < frames.length - 1 && frames[t].s.fighters[p.side].punch?.type) t++; p.t1 = Math.min(frames.length - 1, t + 8); }
  const analyse = (rec, sub) => punches.map(p => {
    // drawn frames from t0 to t1
    const pts = [];
    for (let t = p.t0; t <= p.t1; t++) for (let k = 0; k < sub; k++) pts.push({ t, k, g: rec[t][k][p.side].g[p.h] });
    let pop = 0, popAt = null, jump = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const m = pts[i - 1].g.map((v, j) => (v + pts[i + 1].g[j]) / 2), dv = d3(pts[i].g, m);
      if (dv > pop) { pop = dv; popAt = pts[i].t - p.t0 + pts[i].k / sub; }
    }
    for (let i = 1; i < pts.length; i++) jump = Math.max(jump, d3(pts[i].g, pts[i - 1].g) * sub);
    let gap = null;
    if (p.land > 0) {
      const f = rec[p.land][sub - 1], tgt = f[1 - p.side], g = f[p.side].g[p.h];
      if (tgt.dr) gap = p.part === 'head' ? d3(g, tgt.dr.head) - tgt.dr.headR - GR : segD(g, tgt.dr.a, tgt.dr.b) - tgt.dr.r - GR;
      // the closest the glove comes in the 3 ticks either side
      let best = 9;
      for (let t = p.land - 3; t <= p.land + 3; t++) for (let k = 0; k < sub; k++) { const F = rec[t]?.[k]; if (!F?.[1 - p.side].dr) continue; const T = F[1 - p.side].dr, G = F[p.side].g[p.h]; const d = p.part === 'head' ? d3(G, T.head) - T.headR - GR : segD(G, T.a, T.b) - T.r - GR; best = Math.min(best, d); }
      gap = [gap, best];
    }
    return { pop, popAt, jump, gap };
  });
  const live = analyse(pass(1), 1);
  const recS = pass(SUB);
  const slow = analyse(recS, SUB);
  // where in the tick do the slow pass's big glove jumps fall (k = 1 is the first drawn frame of a new tick, events fed there)?
  const byK = Array(SUB).fill(0), bigs = [], blame = {};
  for (const p of punches) for (let t = p.t0; t <= p.t1; t++) for (let k = 0; k < SUB; k++) {
    const prevF = k === 0 ? recS[t - 1]?.[SUB - 1] : recS[t][k - 1]; if (!prevF) continue;
    const d = d3(recS[t][k][p.side].g[p.h], prevF[p.side].g[p.h]);
    if (d > 0.08) {
      // which stage of the draw added the jump: per stage, its own share of the glove's move between the two frames
      const A = prevF[p.side].st, B = recS[t][k][p.side].st;
      if (A && B && A.length === B.length) {
        let prevD = [0, 0, 0], best = null, bv = 0;
        for (let i = 0; i < B.length; i++) {
          const D = B[i][1 + p.h].map((v, j) => v - A[i][1 + p.h][j]), add = d3(D, prevD);
          if (i === 0) { if (d3(D, [0, 0, 0]) > bv) { bv = d3(D, [0, 0, 0]); best = B[i][0]; } }
          else if (add > bv) { bv = add; best = B[i][0]; }
          prevD = D;
        }
        blame[best] = (blame[best] ?? 0) + 1;
        if (bigs.length < 40) bigs.push({ side: p.side, type: p.type, t, rel: t - p.t0, k, d, by: best, byCm: bv, clip: recS[t][k][p.side].clip, pclip: prevF[p.side].clip, cf: recS[t][k][p.side].cf, pcf: prevF[p.side].cf, ph: frames[t].s.fighters[p.side].punch?.phase ?? '-', ev: '' });
      } else blame['(stage count differs)'] = (blame['(stage count differs)'] ?? 0) + 1;
    }
    if (d > 0.08) byK[k]++;
  }
  const trace = [];
  if (TR) for (let t = TR[1]; t <= TR[2]; t++) for (let k = 0; k < SUB; k++) { const F = recS[t][k][TR[0]], O = recS[t][k][1 - TR[0]]; trace.push({ t, k, g: F.g, cf: F.cf, x: F.x, ph: frames[t].s.fighters[TR[0]].punch?.phase ?? '-', pt: frames[t].s.fighters[TR[0]].punch?.t ?? null, sg: frames[t].s.fighters[TR[0]].gloves.map(g => g.pos), oh: O.dr?.head }); }
  return { gdbg: w.__gdbgAll ?? [], blame, trace, specs: specs.map(x => x.id), byK, bigs, punches: punches.map((p, i) => ({ ...p, live: live[i], slow: slow[i] })) };
}, { ticks: SECONDS * 60, seed: SEED, SUB, TR: process.argv[6]?.startsWith('trace:') ? process.argv[6].slice(6).split(':').map(Number) : null });
if (process.argv[6] === 'ablate') {
  // each drawn layer off in turn (drawn only: the sim and so the fight are the same); one summary line each
  const LAYERS = [null, { humanArmClear: false }, { humanLandCorridor: false }, { humanLandGap: false }, { humanContactDrawn: false }, { humanInertia: false }, { humanBodyHandAim: false }, { humanFootPlant: false }, { humanSlipAuthored: false }, { humanRawPose: true }];
  const base = await page.evaluate(ks => Object.fromEntries(ks.map(k => [k, window.__cfg[k]])), [...new Set(LAYERS.flatMap(l => l ? Object.keys(l) : []))]);
  for (const L of LAYERS) {
    await page.evaluate(([b, l]) => Object.assign(window.__cfg, b, l ?? {}), [base, L]);
    const r = await runOnce();
    const lands = r.punches.filter(p => p.out === 'land'), S = r.punches.map(p => p.slow.jump), sl = r.byK.reduce((a, b) => a + b, 0);
    const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    console.log(`${(L ? JSON.stringify(L) : 'everything on').padEnd(30)} slow jumps >8cm ${String(sl).padStart(4)} | punches with one ${r.punches.filter(p => p.slow.jump / SUB > 0.08).length}/${r.punches.length} | worst ${(Math.max(...S) / SUB * 100).toFixed(1)} cm | land gap median ${(med(lands.map(p => p.slow.gap[0])) * 100).toFixed(1)} worst ${(Math.max(...lands.map(p => p.slow.gap[0])) * 100).toFixed(1)} | live worst jump/tick ${(Math.max(...r.punches.map(p => p.live.jump)) * 100).toFixed(1)}`);
  }
  await browser.close();
  process.exit(0);
}
const res = await runOnce();
for (const g of res.gdbg ?? []) console.log('guard', JSON.stringify(g, (k, v) => typeof v === 'number' ? +v.toFixed(3) : v));
if (res.trace.length) {
  const f = v => v == null ? '-' : Array.isArray(v) ? v.map(x => typeof x === 'number' ? x.toFixed(2) : f(x)).join(',') : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? v.toFixed(2) : String(v);
  let prev = null;
  for (const r of res.trace) {
    const g = r.g[0], jump = prev ? Math.hypot(g[0] - prev[0], g[1] - prev[1], g[2] - prev[2]) * 100 : 0; prev = g;
    console.log(`t${r.t}.${r.k} ${r.ph.padEnd(7)} pt ${f(r.pt)} lead ${f(g)} jump ${jump.toFixed(1).padStart(5)} | sim lead ${f([r.sg[0].x, r.sg[0].y, r.sg[0].z])} | cf ${r.cf} w ${f(r.x?.w)} at ${f(r.x?.at)} toHit ${f(r.x?.toHit)} | reach ${f(r.x?.reach)} | arm ${f(r.x?.arm)} | act ${f(r.x?.act)} | fr ${f(r.x?.frame)} ${r.x?.pc ?? ''}`);
  }
}

const cm = v => v == null ? '   -' : (v * 100).toFixed(1).padStart(5);
console.log(`${res.specs.join(' v ')} seed ${SEED}, ${res.punches.length} punches, replay at 1/${SUB}`);
console.log('side type      lvl  out     | LIVE gap@hit best pop(cm) @t  jump/tick | SLOW gap@hit best pop(cm) @t  jump/tick');
const lands = res.punches.filter(p => p.out === 'land');
for (const p of res.punches) {
  if (process.argv[6] !== 'all') continue;
  const L = p.live, S = p.slow;
  console.log(`${p.side}    ${(p.type + (p.h ? 'R' : 'L')).padEnd(9)} ${String(p.part ?? '').padEnd(4)} ${p.out.padEnd(7)} | ${cm(L.gap?.[0])} ${cm(L.gap?.[1])} ${cm(L.pop)} ${L.popAt?.toFixed(2).padStart(5)} ${cm(L.jump)} | ${cm(S.gap?.[0])} ${cm(S.gap?.[1])} ${cm(S.pop)} ${S.popAt?.toFixed(2).padStart(5)} ${cm(S.jump)}`);
}
const med = a => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const sum = (k, f) => `${k}: median ${cm(med(lands.map(f)))}, worst ${cm(Math.max(...lands.map(f)))}`;
console.log('LANDS', lands.length, `| glove more than 5 cm off the part at the hit: live ${lands.filter(p => p.live.gap[0] > 0.05).length}, slow ${lands.filter(p => p.slow.gap[0] > 0.05).length}`);
console.log(sum('live gap at hit', p => p.live.gap[0]), '|', sum('slow gap at hit', p => p.slow.gap[0]));
console.log(sum('live best gap +-3', p => p.live.gap[1]), '|', sum('slow best gap +-3', p => p.slow.gap[1]));
const all = res.punches;
console.log(`pop > 3 cm per drawn frame: live ${all.filter(p => p.live.pop > 0.03).length}/${all.length}, slow ${all.filter(p => p.slow.pop > 0.03).length}/${all.length}; pop > 1.5 cm in slow (a visible jump at 1/${SUB}): ${all.filter(p => p.slow.pop > 0.015).length}`);
console.log(`slow-pass glove jumps > 8 cm in one drawn frame, by sub-frame (k=0 is the first drawn frame of a new tick): ${res.byK.join(' / ')}`);
console.log('which stage of the draw added each jump:', JSON.stringify(res.blame));
for (const b of res.bigs) console.log(`  side ${b.side} ${b.type.padEnd(8)} t${b.t} (+${b.rel}) k${b.k} ${(b.d * 100).toFixed(1)} cm  by ${b.by} (${(b.byCm * 100).toFixed(1)})  clip ${b.pclip} -> ${b.clip}  conform ${b.pcf} -> ${b.cf}  phase ${b.ph}`);
console.log(`console errors/warnings: ${logs.filter(l => !/GPU stall/.test(l)).length} (GPU-stall readback notes excluded)`);
for (const l of [...new Set(logs)].slice(0, 8)) console.log('  ' + l.slice(0, 200));
await browser.close();
