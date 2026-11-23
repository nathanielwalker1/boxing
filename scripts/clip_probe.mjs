/**
 * clip_probe.mjs — LIMBS THROUGH LIMBS, measured in LIVE AI-vs-AI fights (human mode).
 *
 * Every sim tick, from the two DRAWN skeletons (window.__humanProbe: head sphere + torso line the view keeps for the
 * other man's keep-out, elbows, shoulders, gloves), builds head sphere, torso capsule (hips to chest), two upper-arm
 * capsules (shoulder-elbow), two forearm capsules (elbow-glove centre), two glove spheres, and measures every shape of
 * one man against every shape of the other: penetration depth, cm.
 *
 *   PORT=5195 node scripts/clip_probe.mjs <tag> [opps=blue,boiler,raffle,alambre] [seconds=40] [seeds=1,2] [film=opp:seed:from:to:step]
 *
 * Radii: head r = cfg.mocapHeadR * s, torso r = cfg.mocapTorsoR * s, s = heightM / cfg.mocapBandRefHeight (what view.ts
 * keeps in drawnBodies, src/human/view.ts ~863-874); glove r = body.gloveR (src/core/body.ts:60). Upper arm 0.055 and
 * forearm 0.045 are ASSUMED (the same constants live_contact_probe.mjs uses; no config key exists for them).
 * EXEMPT: the punching glove against the part its punch scored on (head or torso; a blocked punch: against arms and
 * gloves), from 2 ticks before the sim's hit tick to 3 after (the squash).
 * After the report, films the worst episode of each of the four most frequent pair types from the play camera.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'clip_probe');
mkdirSync(OUT, { recursive: true });
const TAG = process.argv[2] ?? 'run';
const OPPS = (process.argv[3] || 'blue,boiler,raffle,alambre').split(',');
const SECONDS = +(process.argv[4] || 40);
const SEEDS = (process.argv[5] || '1,2').split(',').map(Number);
const FILM = process.argv[6] && process.argv[6] !== '-' ? process.argv[6].split(':') : null;

const browser = await chromium.launch();
const logs = [];

/** Runs in the page: one fight; every tick measured; returns the aggregate. With stopAt, runs to that tick for a film frame. */
async function pageFight({ seed, ticks, stopAt }) {
  const w = window;
  const core = await import('/src/core/index.ts'), sim = await import('/src/sim/index.ts'), AI = await import('/src/ai/index.ts');
  const cfg = w.__cfg, feeds = w.__humanFeeds;
  const st0 = w.__states();
  const specs = [0, 1].map(i => core.ROSTER.find(r => r.id === st0[i].specId));
  const K = (w.__clip ??= {});
  const fresh = K.key !== `${seed}|${specs[1].id}` || K.t > (stopAt ?? ticks);
  if (fresh) {
    K.key = `${seed}|${specs[1].id}`; K.t = 0;
    K.s = sim.createState(specs, cfg, seed);
    K.ai = [AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg))];
    K.rec = []; K.hits = [];
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // closest distance between segments p1q1 and p2q2 (Ericson), degenerate segments (spheres) allowed
  const segSeg = (p1, q1, p2, q2) => {
    const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
    let s, t;
    if (a < 1e-12 && e < 1e-12) { s = 0; t = 0; }
    else if (a < 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      const c = dot(d1, r);
      if (e < 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        const b = dot(d1, d2), den = a * e - b * b;
        s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
      }
    }
    const c1 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s], c2 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
    return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
  };
  const RANK = { glove: 0, forearm: 1, 'upper arm': 2, head: 3, torso: 4 };
  const UA = 0.055, FA = 0.045;   // ASSUMED radii (same as live_contact_probe.mjs)
  const shapesOf = (P, f) => {
    const D = P.drawn, gr = f.body.gloveR, S = [];
    if (!D) return null;
    S.push({ t: 'head', id: 'head', a: D.head, b: D.head, r: D.headR });
    S.push({ t: 'torso', id: 'torso', a: D.a, b: D.b, r: D.r });
    for (const sd of ['left', 'right']) {
      S.push({ t: 'upper arm', id: 'upper arm:' + sd, a: P.shoulders[sd], b: P.elbows[sd], r: UA });
      S.push({ t: 'forearm', id: 'forearm:' + sd, a: P.elbows[sd], b: P.gloves[sd], r: FA });
      S.push({ t: 'glove', id: 'glove:' + sd, a: P.gloves[sd], b: P.gloves[sd], r: gr });
    }
    return S;
  };
  const stateOf = f => {
    if (f.down) return 'down';
    if ((f.hitT ?? 0) > 0) return 'being hit';
    if (f.punch.type) return `${f.punch.type} ${f.punch.phase === 'cock' ? 'wind-up' : f.punch.phase}`;
    if (f.slip.active) return f.slip.dir === 2 ? 'lean back' : 'slip';
    if (f.block) return 'blocking';
    if (f.clinch?.active) return 'clinch';
    if (f.body.headY - f.headBox.y > 0.12) return 'duck';
    return 'idle';
  };
  for (const side of [0, 1]) feeds[side].freeze(true);
  const end = stopAt ?? ticks;
  for (; K.t < end; K.t++) {
    const s = K.s, t = K.t;
    const d0 = AI.aiStep(K.ai[0], s, cfg); K.ai[0] = d0.ai;
    const d1 = AI.aiStep(K.ai[1], s, cfg); K.ai[1] = d1.ai;
    const r = sim.step(s, [d0.input, d1.input], cfg);
    for (const side of [0, 1]) feeds[side].feed(s.fighters[side], r.state.fighters[side], r.events.filter(e => !('side' in e) || e.side === side || ('target' in e && e.target === side)));
    K.s = r.state;
    if (stopAt !== undefined) continue;
    const F = K.s.fighters;
    for (const e of r.events) {
      if (e.type !== 'punchLand' && e.type !== 'punchBlock') continue;
      const P = w.__humanProbe(e.side), hand = e.hand ?? s.fighters[e.side].punch.hand;
      const lead = P.gloves.lead[0] === P.gloves.left[0] && P.gloves.lead[2] === P.gloves.left[2] ? 'left' : 'right';
      K.hits.push({ t, side: e.side, ev: e.type, part: e.part ?? null, sd: hand === 'lead' ? lead : lead === 'left' ? 'right' : 'left' });
    }
    const fighting = K.s.round?.phase === 'fighting' && !F[0].down && !F[1].down;
    const P = [w.__humanProbe(0), w.__humanProbe(1)];
    const dist = Math.hypot(F[1].pos.x - F[0].pos.x, F[1].pos.z - F[0].pos.z);
    const rec = { t, fighting, dist, st: [stateOf(F[0]), stateOf(F[1])], it: [] };
    if (fighting && P[0] && P[1]) {
      const A = shapesOf(P[0], F[0]), B = shapesOf(P[1], F[1]);
      if (A && B) for (const x of A) for (const y of B) {
        const dep = (x.r + y.r - segSeg(x.a, x.b, y.a, y.b)) * 100;
        if (dep <= 0.5) continue;
        let name, atk;
        if (RANK[x.t] < RANK[y.t]) { name = `${x.t}-${y.t}`; atk = 0; }
        else if (RANK[x.t] > RANK[y.t]) { name = `${y.t}-${x.t}`; atk = 1; }
        else { name = `${x.t}-${y.t}`; atk = F[1].punch.type && !F[0].punch.type ? 1 : 0; }
        rec.it.push([name, dep, atk, x.id, y.id]);
      }
    }
    K.rec.push(rec);
  }
  w.__setPosed(K.s.fighters[0], K.s.fighters[1]);
  if (stopAt !== undefined) return { t: K.t };
  // ---- exemptions, then aggregate ----
  const ex = new Set();   // `${t}|${item index}` marked
  const exempt = (rec, it) => K.hits.some(h => rec.t >= h.t - 2 && rec.t <= h.t + 3 && (() => {
    const mine = h.side === 0 ? it[3] : it[4], theirs = h.side === 0 ? it[4] : it[3];
    if (mine !== 'glove:' + h.sd) return false;
    if (h.ev === 'punchBlock') return /^(forearm|upper arm|glove)/.test(theirs);
    return theirs === (h.part === 'body' ? 'torso' : 'head');
  })());
  const agg = { fight: 0, any2: 0, any5: 0, exemptMax: 0, types: {} };
  const open = {};   // name -> current episode
  const bin = d => Math.max(-1, Math.min(9, Math.floor((d - 0.6) / 0.1))) + 1;
  const ST = (o, k) => { o[k] = (o[k] ?? 0) + 1; };
  for (const rec of K.rec) {
    if (!rec.fighting) { for (const k of Object.keys(open)) delete open[k]; continue; }
    agg.fight++;
    const best = {};
    for (const it of rec.it) {
      if (exempt(rec, it)) { agg.exemptMax = Math.max(agg.exemptMax, it[1]); continue; }
      if (!best[it[0]] || it[1] > best[it[0]][1]) best[it[0]] = it;
    }
    const mx = Math.max(0, ...Object.values(best).map(b => b[1]));
    if (mx > 2) agg.any2++;
    if (mx > 5) agg.any5++;
    for (const k of Object.keys(open)) if (!(best[k] && best[k][1] > 2)) delete open[k];
    for (const [name, it] of Object.entries(best)) {
      if (it[1] <= 2) continue;
      const T = (agg.types[name] ??= { n2: 0, n5: 0, sum: 0, max: 0, eps: [], atk: {}, oth: {}, dh: Array(11).fill(0), dsum: 0 });
      T.n2++; if (it[1] > 5) T.n5++; T.sum += it[1]; T.max = Math.max(T.max, it[1]);
      ST(T.atk, rec.st[it[2]]); ST(T.oth, rec.st[1 - it[2]]); T.dh[bin(rec.dist)]++; T.dsum += rec.dist;
      let ep = open[name];
      if (!ep) { ep = open[name] = { t0: rec.t, len: 0, peak: 0, tp: rec.t }; T.eps.push(ep); }
      ep.len++; ep.t1 = rec.t; if (it[1] > ep.peak) { ep.peak = it[1]; ep.tp = rec.t; }
    }
  }
  return agg;
}

async function openPage(opp) {
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
  await page.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} }; });
  await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1&opp=${opp}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bootReady(page);
  await until(page, () => typeof window.__rigReplay === 'function' && typeof window.__humanProbe === 'function' && !!window.__humanFeeds, undefined, { label: 'human views', timeout: 150_000 });
  await page.evaluate(() => { const c = window.__cfg; c.debugHitboxes = false; c.refEnabled = false; });
  await until(page, () => { window.__rigReplay(1.0, [], 1, []); return !!window.__humanProbe(0) && !!window.__humanProbe(0).drawn; }, undefined, { label: 'probe', timeout: 60_000 });
  return page;
}

async function film(page, opp, seed, a, b, st, name) {
  const shots = [];
  for (let t = a; t <= b; t += st) {
    await page.evaluate(pageFight, { seed, ticks: 0, stopAt: t });
    await frames(page, 2);
    let buf = null;
    for (let k = 0; k < 6 && !buf; k++) { try { buf = await page.screenshot({ clip: { x: 120, y: 60, width: 400, height: 300 } }); } catch { await frames(page, 4); } }
    if (buf) shots.push({ t, b64: buf.toString('base64') }); else console.log('film: frame t' + t + ' could not be captured');
  }
  const sheet = await browser.newPage({ viewport: { width: 1600, height: Math.ceil(shots.length / 4) * 300 } });
  await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(4,400px);font:14px monospace;color:#fff">${shots.map(s => `<div style="position:relative"><img src="data:image/png;base64,${s.b64}" style="display:block"><span style="position:absolute;left:4px;top:2px;background:#000a">t${s.t}</span></div>`).join('')}</body>`);
  const path = `${OUT}/${TAG}_${name}_${opp}_${seed}_${a}.png`;
  let done = false;
  for (let k = 0; k < 5 && !done; k++) { try { await sheet.screenshot({ path }); done = true; } catch { await sheet.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); } }
  console.log(done ? `film: ${path} (${shots.length} frames)` : 'film: sheet failed');
  await sheet.close();
}

const results = [];   // { opp, seed, agg }
if (FILM) {
  const [opp, seed, a, b, st] = FILM;
  const page = await openPage(opp);
  await film(page, opp, +seed, +a, +b, +st, 'manual');
  await page.close();
} else {
  for (const opp of OPPS) {
    const page = await openPage(opp);
    for (const seed of SEEDS) results.push({ opp, seed, agg: await page.evaluate(pageFight, { seed, ticks: SECONDS * 60 }) });
    await page.close();
  }
  // ---------- report ----------
  const merge = rs => {
    const o = { fight: 0, any2: 0, any5: 0, types: {} };
    for (const { agg } of rs) {
      o.fight += agg.fight; o.any2 += agg.any2; o.any5 += agg.any5;
      for (const [k, T] of Object.entries(agg.types)) {
        const m = (o.types[k] ??= { n2: 0, n5: 0, sum: 0, max: 0, eps: [], atk: {}, oth: {}, dh: Array(11).fill(0), dsum: 0 });
        m.n2 += T.n2; m.n5 += T.n5; m.sum += T.sum; m.max = Math.max(m.max, T.max); m.dsum += T.dsum;
        m.eps.push(...T.eps); T.dh.forEach((v, i) => { m.dh[i] += v; });
        for (const f of ['atk', 'oth']) for (const [s, n] of Object.entries(T[f])) m[f][s] = (m[f][s] ?? 0) + n;
      }
    }
    return o;
  };
  const pc = (n, d) => (100 * n / Math.max(1, d)).toFixed(1) + '%';
  const top = (o, n, k = 4) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, k).map(([s, v]) => `${s} ${pc(v, n)}`).join(', ');
  const table = (M, ranked = 99) => {
    console.log(`  fighting ticks ${M.fight}; any pair > 2 cm: ${pc(M.any2, M.fight)}; > 5 cm: ${pc(M.any5, M.fight)}`);
    console.log('  pair type              >2cm    >5cm   mean   max  episodes  mean len');
    const names = ['glove-head', 'glove-torso', 'glove-glove', 'glove-forearm', 'glove-upper arm', 'forearm-head', 'forearm-torso', 'forearm-forearm', 'upper arm-head', 'upper arm-torso', 'head-head', 'head-torso', 'torso-torso', 'forearm-upper arm', 'upper arm-upper arm'];
    for (const nm of names.slice(0, ranked)) {
      const T = M.types[nm];
      if (!T) { console.log(`  ${nm.padEnd(20)}  0.0%   0.0%      -     -         0        -`); continue; }
      console.log(`  ${nm.padEnd(20)} ${pc(T.n2, M.fight).padStart(6)} ${pc(T.n5, M.fight).padStart(7)} ${(T.sum / T.n2).toFixed(1).padStart(6)} ${T.max.toFixed(1).padStart(5)} ${String(T.eps.length).padStart(9)} ${(T.n2 / T.eps.length).toFixed(1).padStart(9)}`);
    }
  };
  const all = merge(results);
  console.log(`CLIP PROBE ${TAG}: ${OPPS.join(',')} x seeds ${SEEDS.join(',')} x ${SECONDS} s (AI vs AI, human=1)`);
  console.log('\n1+2. OVERALL AND BY PAIR TYPE (depth > 2 cm; episode = consecutive ticks)');
  table(all);
  const ranked = Object.entries(all.types).sort((a, b) => b[1].n2 - a[1].n2);
  console.log('\n3. TOP SIX PAIR TYPES BY TICKS: what both men were doing (attacker = owner of the first-named part), and centre distance');
  for (const [nm, T] of ranked.slice(0, 6)) {
    console.log(` ${nm} (${T.n2} ticks)`);
    console.log(`   attacker: ${top(T.atk, T.n2, 5)}`);
    console.log(`   other:    ${top(T.oth, T.n2, 5)}`);
    console.log(`   dist mean ${(T.dsum / T.n2).toFixed(2)} m; bins <0.6,0.6-0.7,...,1.4-1.5,>1.5: ${T.dh.map(v => Math.round(100 * v / T.n2)).join(' ')} (%)`);
  }
  console.log('\n4. BY OPPONENT');
  for (const opp of OPPS) {
    const M = merge(results.filter(r => r.opp === opp));
    console.log(` -- ${opp}`);
    table(M, 13);
  }
  writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify(results));
  // ---------- films: worst episode of the top four ----------
  console.log('\nFILMS');
  const plan = [];
  for (const [nm] of ranked.slice(0, 4)) {
    let worst = null;
    for (const r of results) for (const ep of r.agg.types[nm]?.eps ?? []) if (!worst || ep.peak > worst.ep.peak) worst = { ...r, ep };
    if (worst) plan.push({ nm, ...worst });
  }
  for (const opp of OPPS) {
    const mine = plan.filter(p => p.opp === opp);
    if (!mine.length) continue;
    const page = await openPage(opp);
    for (const p of mine) {
      const a = Math.max(0, p.ep.t0 - 6), b = p.ep.t1 + 6, st = Math.max(2, Math.ceil((b - a) / 23 / 2) * 2);
      console.log(`${p.nm}: ${p.opp} seed ${p.seed} ticks ${p.ep.t0}-${p.ep.t1} (len ${p.ep.len}) peak ${p.ep.peak.toFixed(1)} cm at t${p.ep.tp}`);
      await film(page, p.opp, +p.seed, a, b, st, p.nm.replace(/ /g, '_'));
    }
    await page.close();
  }
}
await browser.close();
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !/GPU stall/.test(m.text));
console.log(`\n5. console errors/warnings: ${bad.length}`);
bad.slice(0, 5).forEach(m => console.log(`  [${m.type}] ${m.text.slice(0, 300)}`));
