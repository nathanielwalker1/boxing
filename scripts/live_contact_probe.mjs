/**
 * live_contact_probe.mjs — PHANTOM PUNCHES, measured in LIVE fights (human mode).
 *
 * The continuity probe only ever hits a standing or scripted man. This one runs real fights in the page (the sim and
 * the AI modules the game itself uses, the page's own human-mode config), feeds every tick through the two drawn
 * bodies (window.__humanFeeds) and, for every punch the sim SCORES (punchLand) or calls blocked / missed, measures
 * where the drawn glove actually was against the other man's drawn head, torso, arms and gloves.
 *
 *   PORT=5195 node scripts/live_contact_probe.mjs <tag> [opps=blue,boiler,raffle,alambre] [seconds=40] [seeds=1,2] [player=ai|bot|wait] ['<cfg json>'] [film=opp:seed:from:to:step]
 *
 * player: ai = the red corner is its own style's AI; bot = a seeded scripted "human" (walks to range, throws singles
 * and twos and threes at head and body, sometimes circling); wait = stands on the spot and blocks nothing (item 3).
 * A land is PHANTOM when the glove surface is more than PHANTOM_CM from the scored part at the hit tick and for the
 * three ticks after.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'live_contact');
mkdirSync(OUT, { recursive: true });
const TAG = process.argv[2] ?? 'run';
const OPPS = (process.argv[3] || 'blue,boiler,raffle,alambre').split(',');
const SECONDS = +(process.argv[4] || 40);
const SEEDS = (process.argv[5] || '1,2').split(',').map(Number);
const PLAYER = process.argv[6] || 'ai';
const CFG = process.argv[7] && process.argv[7] !== '-' ? JSON.parse(process.argv[7]) : null;
const FILM = process.argv[8] && process.argv[8] !== '-' ? process.argv[8].split(':') : null;   // opp:seed:from:to:step
const TRACE = process.argv[9] && process.argv[9] !== '-' ? process.argv[9].split(':') : null;   // opp:seed:from:to:side prints that side's punch, hand weight and gap per tick
const BRIEF = process.argv[10] === 'brief';
const PHANTOM_CM = 4;

const browser = await chromium.launch();
const logs = [];
const all = [];
const stats = [];
const model = {};

/** Runs in the page: one fight, every tick through the views; returns the per-punch records. With `shots`, stops at each listed tick (film). */
async function pageFight({ seed, ticks, player, stopAt, trace }) {
  const w = window;
  const core = await import('/src/core/index.ts'), sim = await import('/src/sim/index.ts'), AI = await import('/src/ai/index.ts'), mocap = await import('/src/core/mocap.ts'), outcome = await import('/src/sim/outcome.ts');
  const cfg = w.__cfg, feeds = w.__humanFeeds;
  const st0 = w.__states();
  const specs = [0, 1].map(i => core.ROSTER.find(r => r.id === st0[i].specId));
  const K = (w.__live ??= {});
  const fresh = K.key !== `${seed}|${player}|${specs[1].id}` || K.t > (stopAt ?? ticks);
  if (fresh) {
    K.key = `${seed}|${player}|${specs[1].id}`; K.t = 0;
    K.s = sim.createState(specs, cfg, seed);
    K.ai = [AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg))];
    K.rng = (seed * 2654435761) >>> 0; K.plan = []; K.next = 60; K.circle = 0; K.lvl = 0; K.want = 1.0;
    K.rk = []; K.hist = []; K.open = []; K.recs = []; K.model = {}; K.tr = []; K.tally = { thrown: [{}, {}], kinds: [{}, {}], firstThrow: [null, null], distSum: 0, n: 0, slips: [0, 0], slipDodged: [0, 0], counters: [0, 0] };
  }
  const rnd = () => { K.rng = (Math.imul(K.rng, 1664525) + 1013904223) >>> 0; return K.rng / 4294967296; };
  const inp = (o = {}) => ({ ...core.cloneInput(core.NULL_INPUT), ...o });
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], len = v => Math.hypot(v[0], v[1], v[2]);
  const segD = (p, a, b) => { const ab = sub(b, a), ap = sub(p, a); const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2; const t = L ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0; return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])); };
  let F_ = null;
  const segSegD = (p1, q1, p2, q2) => {
    const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dt(d1, d1), e = dt(d2, d2), f = dt(d2, r);
    let s, t;
    if (a < 1e-12 && e < 1e-12) { s = 0; t = 0; }
    else if (a < 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else {
      const c = dt(d1, r);
      if (e < 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else {
        const b = dt(d1, d2), den = a * e - b * b;
        s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
      }
    }
    return Math.hypot(p1[0] + d1[0] * s - p2[0] - d2[0] * t, p1[1] + d1[1] * s - p2[1] - d2[1] * t, p1[2] + d1[2] * s - p2[2] - d2[2] * t);
  };
  // CLEAN-SHOT look-back: the punching arm (glove sphere + forearm capsule) against the target's gloves, forearms, upper arms; returns the deepest gap (cm, negative = inside)
  const cleanScan = (a, hand) => {
    const rows = K.hist.slice(-11), n = rows.length;
    let best = { gap: 99, pair: '-', off: 0 };
    rows.forEach((rw, i) => {
      const off = i - (n - 1), A = rw[a], T = rw[1 - a];
      const sd = (A.gl.lead[0] === A.gl.left[0] && A.gl.lead[2] === A.gl.left[2]) ? (hand === 'lead' ? 'left' : 'right') : (hand === 'lead' ? 'right' : 'left');
      const g = A.gl[hand], el = A.el[sd], gr = F_[a].body.gloveR, tgr = F_[1 - a].body.gloveR;
      for (const ts of ['left', 'right']) {
        const cands = [
          ['glove>glove:' + ts, len(sub(g, T.gl[ts])) - gr - tgr],
          ['glove>forearm:' + ts, segD(g, T.el[ts], T.gl[ts]) - gr - 0.045],
          ['glove>upperarm:' + ts, segD(g, T.sh[ts], T.el[ts]) - gr - 0.055],
          ['forearm>glove:' + ts, segD(T.gl[ts], el, g) - 0.045 - tgr],
          ['forearm>forearm:' + ts, segSegD(el, g, T.el[ts], T.gl[ts]) - 0.09],
          ['forearm>upperarm:' + ts, segSegD(el, g, T.sh[ts], T.el[ts]) - 0.045 - 0.055],
        ];
        for (const [nm, d] of cands) if (d * 100 < best.gap) best = { gap: d * 100, pair: nm, off };
      }
    });
    return best;
  };
  const bot = s => {
    // a scripted "human": hold a working distance, throw ones / twos / threes, head and body, sometimes circling
    const a = s.fighters[0], b = s.fighters[1];
    const d = Math.hypot(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    const o = inp({ move: { x: K.circle, y: Math.max(-1, Math.min(1, (d - K.want) * 4)) } });
    if (K.t >= K.next && !K.plan.length) {
      const n = 1 + Math.floor(rnd() * 3), body = rnd() < 0.3;
      K.want = 0.85 + rnd() * 0.45; K.circle = rnd() < 0.3 ? (rnd() < 0.5 ? -0.6 : 0.6) : 0;
      let t = K.t;
      for (let i = 0; i < n; i++) { const r = rnd(); K.plan.push({ t, btn: i === 0 && r < 0.6 ? 'jab' : r < 0.35 ? 'jab' : r < 0.65 ? 'cross' : r < 0.87 ? 'hook' : 'uppercut', body }); t += 10 + Math.floor(rnd() * 12); }
      K.next = t + 30 + Math.floor(rnd() * 70);
    }
    if (K.plan.length && K.plan[0].body) o.level = true;
    while (K.plan.length && K.plan[0].t <= K.t - 2) K.plan.shift();
    if (K.plan.length && K.plan[0].t <= K.t) { o[K.plan[0].btn] = true; if (K.plan[0].body) o.level = true; }
    return o;
  };
  K.want ??= 1.0;
  for (const side of [0, 1]) feeds[side].freeze(true);
  const end = stopAt ?? ticks;
  for (; K.t < end; K.t++) {
    const s = K.s, t = K.t;
    let in0;
    if (player === 'ai') { const d0 = AI.aiStep(K.ai[0], s, cfg); K.ai[0] = d0.ai; in0 = d0.input; }
    else if (player === 'wait') in0 = inp();
    else in0 = bot(s);
    const d1 = AI.aiStep(K.ai[1], s, cfg); K.ai[1] = d1.ai;
    const r = sim.step(s, [in0, d1.input], cfg);
    for (const side of [0, 1]) feeds[side].feed(s.fighters[side], r.state.fighters[side], r.events.filter(e => !('side' in e) || e.side === side || ('target' in e && e.target === side)));
    K.s = r.state;
    if (stopAt !== undefined) continue;   // film pass: no measuring
    const F = K.s.fighters, P = [w.__humanProbe(0), w.__humanProbe(1)];
    F_ = F;
    const row = [0, 1].map(i => ({ aw: P[i].conform.w, gl: P[i].gloves, el: P[i].elbows, sh: P[i].shoulders, dr: P[i].drawn, head: P[i].head, cf: P[i].conform.kind, lb: P[i].label }));
    K.hist.push(row); if (K.hist.length > 12) K.hist.shift();
    const dist = Math.hypot(F[1].pos.x - F[0].pos.x, F[1].pos.z - F[0].pos.z);
    K.tally.distSum += dist; K.tally.n++;
    // every measure of one glove against the other man's drawn shapes this tick, cm (negative = inside)
    const measure = (row, a, hand) => {
      const g = row[a].gl[hand], T = row[1 - a], D = T.dr, gr = F[a].body.gloveR;
      if (!D) return null;
      const head = len(sub(g, D.head)) - D.headR - gr, body = segD(g, D.a, D.b) - D.r - gr;
      let arm = 9, glove = 9;
      for (const sd of ['left', 'right']) {
        arm = Math.min(arm, segD(g, T.el[sd], T.gl[sd]) - 0.045 - gr, segD(g, T.sh[sd], T.el[sd]) - 0.055 - gr);
        glove = Math.min(glove, len(sub(g, T.gl[sd])) - F[1 - a].body.gloveR - gr);
      }
      return { head: head * 100, body: body * 100, arm: arm * 100, glove: glove * 100, dy: (g[1] - D.head[1]) * 100, gy: g[1] * 100 };
    };
    // THE TARGET MODEL: the head the sim's rule aims at (core/mocap mocapDrawnTargets) against the head that is drawn, his frame, cm
    const mErr = [0, 1].map(i => {
      const f = F[i], D = row[i].dr;
      if (!D || f.down) return null;
      const M = mocap.mocapDrawnTargets(mocap.mocapLib(), cfg, f, core.GUARDS[cfg.stylesOn ? f.guardShape : 'high'].crouch, K.TG ??= mocap.makeDrawnTargets());
      const ex = D.head[0] - M.head.x, ey = D.head[1] - M.head.y, ez = D.head[2] - M.head.z, c = Math.cos(f.yaw), sn = Math.sin(f.yaw);
      const cat = (f.hitT ?? 0) > 0 ? 'reeling' : f.punch.type ? `punch ${f.punch.type}${sim.VARIANTS?.[f.punch.variant]?.body ? ' body' : ''}` : f.slip.active ? 'slipping' : f.block ? 'blocking' : f.body.headY - f.headBox.y > 0.12 ? 'crouched' : 'idle';
      const o = { fwd: (ex * c + ez * sn) * 100, lat: (-ex * sn + ez * c) * 100, up: ey * 100, abs: Math.hypot(ex, ey, ez) * 100, cat };
      if (t > 40) { const q = (K.model[cat] ??= { n: 0, fwd: 0, lat: 0, up: 0, abs: [] }); q.n++; q.fwd += o.fwd; q.lat += o.lat; q.up += o.up; if (q.n % 3 === 0) q.abs.push(+o.abs.toFixed(1)); }
      return o;
    });
    if (trace &&t >= trace[0] && t <= trace[1]) {
      const a = trace[2], A = F[a], hand = A.punch.hand ?? 'lead', m = A.punch.type ? measure(row, a, hand) : null, o = A.punch.type ? outcome.predictOutcome(A, F[1 - a], cfg) : null;
      K.tr.push(`t${t} d ${dist.toFixed(2)} | atk ${A.punch.type ?? '-'} ${A.punch.phase ?? ''} p${(A.punch.progress ?? 0).toFixed(2)} res ${A.punch.resolved ? 1 : 0} reel ${(A.hitT ?? 0).toFixed(2)} "${row[a].lb}" cf ${P[a].conform.kind} w ${P[a].conform.w.toFixed(2)} ik ${(P[a].ikMax * 100).toFixed(0)} reach ${P[a].reach.map(v => v.toFixed(2)).join('/')} lunge ${P[a].lungeDbg.map(v => v.toFixed(2)).join('/')} rule ${o ? o.kind + ' far ' + o.far.toFixed(2) : '-'} | glove→head ${m ? m.head.toFixed(0) : '-'} body ${m ? m.body.toFixed(0) : '-'} | tgt ${F[1 - a].punch.type ?? '-'} reel ${(F[1 - a].hitT ?? 0).toFixed(2)} slip ${F[1 - a].slip.active ? F[1 - a].slip.dir : 0} blk ${F[1 - a].block ? 1 : 0} "${row[1 - a].lb}" | ev ${r.events.map(e => e.type + (e.side ?? '') + (e.type === 'punchStart' ? `(${e.punch} ${e.variant} tell ${e.tell.toFixed(3)} nerf ${(e.nerf ?? 0).toFixed(2)})` : '')).join(',')} | in1 ${JSON.stringify(d1.input)} stop ${(K.s.hitStop ?? 0).toFixed(3)} tell ${(A.punch.tell ?? 0).toFixed(3)}`);
    }
    for (const e of r.events) {
      if (e.type === 'rocked' || e.type === 'knockdown') {
        (K.rk ??= []).push({ t, side: e.side, fl: e.type === 'rocked' ? 'rocked' : 'kd' });
      }
      if (e.type === 'punchStart') { K.tally.thrown[e.side][e.punch] = (K.tally.thrown[e.side][e.punch] ?? 0) + 1; if (K.tally.firstThrow[e.side] === null) K.tally.firstThrow[e.side] = t; }
      if (e.type === 'slip') { K.tally.slips[e.side]++; if (e.dodged) K.tally.slipDodged[e.side]++; }
      if (e.type === 'punchLand' && e.counter) K.tally.counters[e.side]++;
      if (e.type !== 'punchLand' && e.type !== 'punchBlock' && e.type !== 'punchWhiff') continue;
      const a = e.side, A = F[a], B = F[1 - a], Bp = s.fighters[1 - a], Ap = s.fighters[a];
      const hand = e.hand ?? Ap.punch.hand ?? A.punch.hand;
      K.tally.kinds[a][e.type] = (K.tally.kinds[a][e.type] ?? 0) + 1;
      // the window before the hit tick, from the history
      const pre = K.hist.slice(-4, -1).map(rw => measure(rw, a, hand));
      const imp = e.impulse ? Math.hypot(e.impulse.x, e.impulse.y, e.impulse.z) : 0;
      const clean = e.type === 'punchLand' ? cleanScan(a, hand) : null;
      const tstate = (Bp.hitT ?? 0) > 0 ? 'reeling' : Bp.punch.type ? 'punching' : Bp.slip.active ? 'slipping' : Bp.block ? 'blocking' : 'idle';
      K.open.push({ left: 4, rec: { t, side: a, tgt: 1 - a, imp, grade: e.grade ?? null, clean, tstate, ev: e.type.replace('punch', '').toLowerCase(), punch: e.punch, hand, part: e.part ?? null, variant: e.variant, counter: !!e.counter, dist: +dist.toFixed(3),
        ctx: { tgtPunch: Bp.punch.type, tgtPhase: Bp.punch.phase ?? null, tgtSlip: Bp.slip.active ? Bp.slip.dir : 0, tgtBlock: !!Bp.block, tgtCrouch: +(Bp.body.headY - Bp.headBox.y).toFixed(3), tgtReel: +(Bp.hitT ?? 0).toFixed(2),
          atkCrouch: +(Ap.body.headY - Ap.headBox.y).toFixed(3), combo: e.combo ?? 0, tgtH: B.body.heightM, atkH: A.body.heightM,
          rel: +(Math.hypot(Bp.vel?.x ?? 0, Bp.vel?.z ?? 0)).toFixed(2), cf: row[a].cf, lb: row[a].lb, tlb: row[1 - a].lb },
        // the two halves of a disagreement: how far the drawn head is from the head the rule aimed at, and how far the drawn glove is from the rule's contact point
        tErr: mErr[1 - a] ? { fwd: +mErr[1 - a].fwd.toFixed(1), lat: +mErr[1 - a].lat.toFixed(1), up: +mErr[1 - a].up.toFixed(1), abs: +mErr[1 - a].abs.toFixed(1), cat: mErr[1 - a].cat } : null,
        hErr: A.punch.contact ? +(len(sub(row[a].gl[hand], [A.punch.contact.x, A.punch.contact.y, A.punch.contact.z])) * 100).toFixed(1) : null,
        pre, m: [measure(row, a, hand)] } });
    }
    for (const o of K.open) { if (o.rec.t !== t) { o.rec.m.push(measure(row, o.rec.side, o.rec.hand)); o.left--; } }
    K.recs.push(...K.open.filter(o => o.left <= 0).map(o => o.rec)); K.open = K.open.filter(o => o.left > 0);
  }
  w.__setPosed(K.s.fighters[0], K.s.fighters[1]);
  if (stopAt !== undefined) return { t: K.t };
  const T = K.tally;
  return { rk: K.rk, recs: K.recs, tr: K.tr, model: K.model, tally: { ...T, meanDist: T.distSum / T.n }, health: K.s.fighters.map(f => f.health), phase: K.s.round?.phase };
}

for (const opp of OPPS) {
  if (FILM && FILM[0] !== opp) continue;
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
  await page.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} }; });
  // BODY=3|4|5: which body file the fighters wear (read once at load, so it must ride in the URL, not in CFG)
  await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1&opp=${opp}${process.env.BODY ? `&body=${process.env.BODY}` : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bootReady(page);
  await until(page, () => typeof window.__rigReplay === 'function' && typeof window.__humanProbe === 'function' && !!window.__humanFeeds, undefined, { label: 'human views', timeout: 150_000 });
  await page.evaluate(() => { const c = window.__cfg; c.debugHitboxes = false; c.refEnabled = false; });
  if (CFG) await page.evaluate(o => Object.assign(window.__cfg, o), CFG);
  await until(page, () => { window.__rigReplay(1.0, [], 1, []); return !!window.__humanProbe(0) && !!window.__humanProbe(0).drawn; }, undefined, { label: 'probe', timeout: 60_000 });
  if (FILM) {
    const [, seed, a, b, st] = FILM;
    const shots = [];
    for (let t = +a; t <= +b; t += +st) {
      await page.evaluate(pageFight, { seed: +seed, ticks: 0, player: PLAYER, stopAt: t });
      await frames(page, 2);
      let buf = null;
      for (let k = 0; k < 6 && !buf; k++) { try { buf = await page.screenshot({ clip: { x: 120, y: 60, width: 400, height: 300 } }); } catch { await frames(page, 4); } }
      if (buf) shots.push({ t, b64: buf.toString('base64') }); else console.log('film: frame t' + t + ' could not be captured');
    }
    const sheet = await browser.newPage({ viewport: { width: 1600, height: Math.ceil(shots.length / 4) * 300 } });
    await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(4,400px);font:14px monospace;color:#fff">${shots.map(s => `<div style="position:relative"><img src="data:image/png;base64,${s.b64}" style="display:block"><span style="position:absolute;left:4px;top:2px;background:#000a">t${s.t}</span></div>`).join('')}</body>`);
    const path = `${OUT}/${TAG}_${opp}_${seed}_${a}.png`;
    let done = false;
    for (let k = 0; k < 5 && !done; k++) { try { await sheet.screenshot({ path }); done = true; } catch { await sheet.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); } }
    console.log(done ? `film: ${path} (${shots.length} frames)` : 'film: sheet failed');
    await sheet.close();
  } else {
    for (const seed of SEEDS) {
      const r = await page.evaluate(pageFight, { seed, ticks: SECONDS * 60, player: PLAYER, trace: TRACE && TRACE[0] === opp && +TRACE[1] === seed ? [+TRACE[2], +TRACE[3], +TRACE[4]] : null });
      if (r.tr.length) console.log(`TRACE ${opp} seed ${seed}\n  ` + r.tr.join('\n  '));
      for (const x of r.recs) {
        const hit = fl => r.rk.some(q => q.fl === fl && q.side === x.tgt && q.t >= x.t && q.t <= x.t + 2);
        all.push({ opp, seed, ...x, rocked: hit('rocked'), kd: hit('kd') });
      }
      stats.push({ opp, seed, ...r.tally, health: r.health });
      for (const [k, q] of Object.entries(r.model)) { const g = (model[k] ??= { n: 0, fwd: 0, lat: 0, up: 0, abs: [] }); g.n += q.n; g.fwd += q.fwd; g.lat += q.lat; g.up += q.up; g.abs.push(...q.abs); }
    }
  }
  await page.close();
}
await browser.close();

if (!FILM) {
  // ---------- analysis ----------
  const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
  const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '-').padStart(6);
  const lands = all.filter(r => r.ev === 'land' && r.m[0]);
  for (const r of lands) {
    const k = r.part === 'body' ? 'body' : 'head';
    r.gap0 = r.m[0][k];
    // (the touch may come a tick or two BEFORE the sim's hit tick: the hand is steered on early and a struck head leaves at once)
    r.best = Math.min(...r.pre.slice(-2).concat(r.m.slice(0, 4)).filter(Boolean).map(m => m[k]));
    r.phantom = r.best > PHANTOM_CM;
    const m = r.m[0];
    r.near = Object.entries({ head: m.head, body: m.body, arm: m.arm, glove: m.glove }).sort((x, y) => x[1] - y[1])[0][0];
  }
  {
    const O = console.log, DEF = 2, BR = -1;   // deflected: deepest overlap > 2 cm (gap < -2); brushed: gap within +1 cm (gap < 1)
    const cl = all.filter(r => r.ev === 'land' && r.clean);
    const head = cl.filter(r => r.part !== 'body');
    const imps = head.map(r => r.imp).sort((x, y) => x - y), q75 = imps[Math.floor(0.75 * imps.length)] ?? 0;
    const isD = r => r.clean.gap < -DEF, isB = r => r.clean.gap < 1;
    const line = (nm, g) => O(`  ${nm.padEnd(26)} n ${String(g.length).padStart(4)}  deflected ${String(g.filter(isD).length).padStart(3)} (${(100 * g.filter(isD).length / Math.max(1, g.length)).toFixed(0).padStart(3)}%)  brushed(<+1cm) ${String(g.filter(isB).length).padStart(3)} (${(100 * g.filter(isB).length / Math.max(1, g.length)).toFixed(0).padStart(3)}%)`);
    const split = (nm, g) => {
      O(`\n${nm}`);
      line('ALL', g);
      const by = (lab, fn) => { const o = {}; for (const r of g) (o[fn(r)] ??= []).push(r); for (const [k, v] of Object.entries(o).sort()) line(`${lab} ${k}`, v); };
      by('attacker side', r => 's' + r.side);
      by('punch', r => `${r.punch}/${r.hand}`);
      by('target', r => r.tstate);
    };
    O(`\nCLEAN SHOT CHECK ${TAG} (look-back t-10..t0, punching glove+forearm vs target gloves/forearms/upper arms; DEFLECTED = deeper than ${DEF} cm; lands scored ${cl.length}, head ${head.length}, impulse q75 ${q75.toFixed(0)})`);
    split('(a) all head lands', head);
    split('(b) top quarter by impulse (head lands)', head.filter(r => r.imp >= q75));
    split('(c) lands that rocked', cl.filter(r => r.rocked));
    split('(d) lands that knocked down', cl.filter(r => r.kd));
    O('\nWORST 10 rocked / knockdown (opp seed tick punch impulse grade pair depth@offset)');
    for (const r of cl.filter(r => r.rocked || r.kd).sort((a, b) => a.clean.gap - b.clean.gap).slice(0, 10)) O(`  ${r.opp} seed ${r.seed} t${r.t} s${r.side} ${r.punch}/${r.hand}/${r.part} imp ${r.imp.toFixed(0)} ${r.grade}${r.kd ? ' KD' : ' rocked'} | ${r.clean.pair} depth ${(-r.clean.gap).toFixed(1)} cm @ t${r.clean.off} | tgt ${r.tstate}`);
    O('');
  }
  if (BRIEF) { const _l = console.log; console.log = (...x) => { if (/^LIVE|^\nLANDS|^\nNOT LANDS|console errors|^  \S+ seed \d+ t\d+ s\d/.test(String(x[0]))) _l(...x); }; }
  console.log(`LIVE CONTACT ${TAG}: player=${PLAYER}, ${OPPS.join(',')} x seeds ${SEEDS.join(',')} x ${SECONDS} s`);
  console.log(`\nLANDS ${lands.length}; PHANTOM (glove surface > ${PHANTOM_CM} cm from the scored part from 2 ticks before the hit tick to 3 after):${lands.filter(r => r.phantom).length} (${(100 * lands.filter(r => r.phantom).length / Math.max(1, lands.length)).toFixed(0)}%)`);
  console.log('  by punch / part          n  phantom   gap@hit med    p90    max | best-in-4 med   p90    max | glove height vs head centre med (min..max) cm');
  const groups = {};
  for (const r of lands) (groups[`${r.punch} ${r.hand} ${r.part}`] ??= []).push(r);
  for (const [k, g] of Object.entries(groups).sort()) {
    const g0 = g.map(r => r.gap0), b = g.map(r => r.best), dy = g.map(r => r.m[0].dy);
    console.log(`  ${k.padEnd(22)} ${String(g.length).padStart(3)} ${String(g.filter(r => r.phantom).length).padStart(5)}    ${f1(pct(g0, 0.5))} ${f1(pct(g0, 0.9))} ${f1(Math.max(...g0))} |      ${f1(pct(b, 0.5))} ${f1(pct(b, 0.9))} ${f1(Math.max(...b))} | ${f1(pct(dy, 0.5))} (${f1(Math.min(...dy))}..${f1(Math.max(...dy))})`);
  }
  const ph = lands.filter(r => r.phantom);
  const by = (fn) => { const o = {}; for (const r of ph) { const k = fn(r); o[k] = (o[k] ?? 0) + 1; } return Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '); };
  const byAll = (fn) => { const o = {}; for (const r of lands) { const k = fn(r); (o[k] ??= [0, 0])[0]++; if (r.phantom) o[k][1]++; } return Object.entries(o).sort().map(([k, v]) => `${k} ${v[1]}/${v[0]}`).join(', '); };
  console.log(`\nPHANTOMS, nearest drawn thing at the hit tick: ${by(r => r.near)}`);
  console.log(`  by attacker side (0 = player): ${byAll(r => 's' + r.side)}`);
  console.log(`  by opponent: ${byAll(r => r.opp)}`);
  console.log(`  target was mid-punch: ${byAll(r => (r.ctx.tgtPunch ? 'punching' : 'not'))}`);
  console.log(`  target slipping: ${byAll(r => 'slip' + r.ctx.tgtSlip)}`);
  console.log(`  target reeling (hitT>0): ${byAll(r => (r.ctx.tgtReel > 0 ? 'reeling' : 'not'))}`);
  console.log(`  target crouched > 8 cm: ${byAll(r => (r.ctx.tgtCrouch > 0.08 ? 'crouched' : 'upright'))}`);
  console.log(`  attacker crouched > 8 cm: ${byAll(r => (r.ctx.atkCrouch > 0.08 ? 'crouched' : 'upright'))}`);
  console.log(`  in a combination (combo > 1): ${byAll(r => (r.ctx.combo > 1 ? 'chained' : 'single'))}`);
  console.log(`  by distance: ${byAll(r => (r.dist < 0.85 ? 'a <0.85' : r.dist < 1.0 ? 'b 0.85-1.0' : r.dist < 1.15 ? 'c 1.0-1.15' : r.dist < 1.3 ? 'd 1.15-1.3' : 'e >1.3'))}`);
  console.log(`  attacker hand correction at the hit tick: ${byAll(r => 'cf:' + r.ctx.cf)}`);
  // the two halves, on phantoms and on clean lands
  const half = (g, nm) => { const te = g.filter(r => r.tErr).map(r => r.tErr.abs), he = g.filter(r => r.hErr !== null).map(r => r.hErr); console.log(`  ${nm.padEnd(10)} drawn head vs the rule's head: med ${f1(pct(te, 0.5))} p90 ${f1(pct(te, 0.9))} cm | drawn glove vs the rule's contact point: med ${f1(pct(he, 0.5))} p90 ${f1(pct(he, 0.9))} cm`); };
  console.log('\nWHERE THE DISAGREEMENT IS (head lands only):');
  half(lands.filter(r => r.part === 'head' && r.phantom), 'phantoms'); half(lands.filter(r => r.part === 'head' && !r.phantom), 'clean');
  console.log('\nTARGET MODEL, every tick: drawn head minus the head the rule uses, by what the man is doing (mean fwd / side / up, then size med / p90 / max, cm)');
  for (const [k, q] of Object.entries(model).sort((a, b) => b[1].n - a[1].n)) console.log(`  ${k.padEnd(20)} ${String(q.n).padStart(6)} ticks  fwd ${f1(q.fwd / q.n)} side ${f1(q.lat / q.n)} up ${f1(q.up / q.n)} | ${f1(pct(q.abs, 0.5))} ${f1(pct(q.abs, 0.9))} ${f1(Math.max(...q.abs))}`);
  console.log('\nWORST 14 (film with: film=opp:seed:from:to:step):');
  for (const r of [...ph].sort((a, b) => b.best - a.best).slice(0, 14)) {
    const m = r.m[0];
    console.log(`  ${r.opp} seed ${r.seed} t${r.t} s${r.side} ${r.punch}/${r.hand}/${r.part}${r.counter ? ' COUNTER' : ''} d ${r.dist} | to ${r.part}: ${r.m.map(x => x ? x[r.part === 'body' ? 'body' : 'head'].toFixed(0) : '-').join(' ')} (pre ${r.pre.map(x => x ? x[r.part === 'body' ? 'body' : 'head'].toFixed(0) : '-').join(' ')}) | head ${m.head.toFixed(0)} body ${m.body.toFixed(0)} arm ${m.arm.toFixed(0)} glove ${m.glove.toFixed(0)} dy ${m.dy.toFixed(0)} | tErr ${r.tErr ? `${r.tErr.abs} (f ${r.tErr.fwd} s ${r.tErr.lat} u ${r.tErr.up})` : '-'} hErr ${r.hErr} | tgt ${r.ctx.tgtPunch ?? '-'} ${r.ctx.tgtPhase ?? ''} slip ${r.ctx.tgtSlip} crouch ${r.ctx.tgtCrouch} reel ${r.ctx.tgtReel} "${r.ctx.tlb}" | atk "${r.ctx.lb}" cf ${r.ctx.cf}`);
  }
  // the reverse: called a miss / dodge / block while the glove is drawn inside the head or body
  const nonl = all.filter(r => r.ev !== 'land' && r.m[0]);
  const touch = nonl.filter(r => Math.min(...r.m.concat(r.pre).filter(Boolean).map(m => Math.min(m.head, m.body))) < -2);
  console.log(`\nNOT LANDS ${nonl.length} (whiff ${nonl.filter(r => r.ev === 'whiff').length}, block ${nonl.filter(r => r.ev === 'block').length}); of them drawn > 2 cm INSIDE head or body: ${touch.length} (whiff ${touch.filter(r => r.ev === 'whiff').length}, block ${touch.filter(r => r.ev === 'block').length})`);
  for (const r of touch.slice(0, 12)) console.log(`  ${r.opp} seed ${r.seed} t${r.t} s${r.side} ${r.ev} ${r.punch}/${r.hand} d ${r.dist} | head ${r.pre.concat(r.m).map(x => x ? x.head.toFixed(0) : '-').join(' ')} | body ${r.pre.concat(r.m).map(x => x ? x.body.toFixed(0) : '-').join(' ')} | tgt ${r.ctx.tgtPunch ?? '-'} slip ${r.ctx.tgtSlip} crouch ${r.ctx.tgtCrouch} "${r.ctx.tlb}" | atk "${r.ctx.lb}" cf ${r.ctx.cf}`);
  console.log('\nPER FIGHT: thrown by side, results, first throw, mean distance, slips (dodged), counters');
  for (const s of stats) {
    const th = i => Object.entries(s.thrown[i]).map(([k, v]) => `${k[0]}${v}`).join(' ') || 'none';
    const kd = i => `L${s.kinds[i].punchLand ?? 0} B${s.kinds[i].punchBlock ?? 0} W${s.kinds[i].punchWhiff ?? 0}`;
    console.log(`  ${s.opp.padEnd(8)} seed ${s.seed}: me ${th(0)} (${kd(0)}) | him ${th(1)} (${kd(1)}) first at ${s.firstThrow[1] === null ? 'never' : (s.firstThrow[1] / 60).toFixed(1) + ' s'} | dist ${s.meanDist.toFixed(2)} | slips me ${s.slips[0]} (${s.slipDodged[0]}) him ${s.slips[1]} (${s.slipDodged[1]}) | counters me ${s.counters[0]} him ${s.counters[1]} | health ${s.health.map(h => h.toFixed(2)).join(' / ')}`);
  }
  writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify({ all, stats }, null, 0));
}
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !/GPU stall/.test(m.text));
console.log(`\nconsole errors/warnings: ${bad.length}`);
bad.slice(0, 5).forEach(m => console.log(`  [${m.type}] ${m.text.slice(0, 300)}`));
