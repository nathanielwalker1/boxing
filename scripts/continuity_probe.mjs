/**
 * _debug_anim.mjs (ad hoc, the transitions worker's): drives scripted fights through the human views tick by tick
 * (window.__rigReplay) and measures, per drawn frame:
 *   jumps   — hips / head / feet frame-to-frame moves beyond the sim's own floor displacement
 *   ang     — per-joint angular speed (local rotations) round every clip switch
 *   contact — on each landed punch, glove centre to the target's drawn head / torso surface at the hit tick and 4 after
 *   PORT=5195 node scripts/_debug_anim.mjs <tag> [filter]
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, until, frames } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'anim_measure');
mkdirSync(OUT, { recursive: true });
const TAG = process.argv[2] ?? 'run';
const FILTER = process.argv[3] ?? '';

const at = o => { const a = []; for (const [k, v] of Object.entries(o)) a[Number(k)] = { ...(a[Number(k)] ?? {}), ...v }; return a; };
const hold = (a, inp, from, to) => { for (let i = from; i <= to; i++) a[i] = { ...(a[i] ?? {}), ...inp }; return a; };
const P = (punch, hand, extra = {}) => ({ [punch]: true, ...(punch === 'hook' || punch === 'uppercut' ? { move: { x: hand === 'lead' ? -1 : 1, y: 0 } } : {}), ...extra });
const two = (t, inp) => ({ [t]: inp, [t + 1]: inp });

const SC = [
  { name: 'jab', dist: 1.0, s0: at(two(4, P('jab'))), n: 70 },
  { name: 'jab2_g10', dist: 1.0, s0: at({ ...two(4, P('jab')), ...two(14, P('jab')) }), n: 90 },
  { name: 'jab2_g18', dist: 1.0, s0: at({ ...two(4, P('jab')), ...two(22, P('jab')) }), n: 90 },
  { name: 'jab3', dist: 1.0, s0: at({ ...two(4, P('jab')), ...two(16, P('jab')), ...two(28, P('jab')) }), n: 100 },
  { name: 'jab_cross_hook', dist: 0.95, s0: at({ ...two(4, P('jab')), ...two(16, P('cross')), ...two(32, P('hook', 'lead')) }), n: 110 },
  { name: 'cross', dist: 1.0, s0: at(two(4, P('cross'))), n: 80 },
  { name: 'lhook', dist: 0.95, s0: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'rhook', dist: 1.0, s0: at(two(4, P('hook', 'rear'))), n: 80 },
  { name: 'lupper', dist: 0.8, s0: at(two(4, P('uppercut', 'lead'))), n: 80 },
  { name: 'rupper', dist: 0.9, s0: at(two(4, P('uppercut', 'rear'))), n: 80 },
  { name: 'body_jab', dist: 0.95, s0: hold(at(two(4, P('jab', 'lead', { level: true }))), { level: true }, 0, 6), n: 80 },
  { name: 'body_cross', dist: 1.0, s0: hold(at(two(4, P('cross', 'rear', { level: true }))), { level: true }, 0, 6), n: 80 },
  // (crouched AND walking in: this was the overhand, to the head, until 2026-11-19)
  { name: 'body_cross_walkin', dist: 1.25, s0: hold(hold(at(two(14, P('cross', 'rear', { level: true }))), { level: true }, 0, 40), { move: { x: 0, y: 1 } }, 2, 16), n: 80 },
  { name: 'body_hook', dist: 0.95, s0: hold(at(two(4, P('hook', 'lead', { level: true }))), { level: true }, 0, 6), n: 80 },
  // a body combination (level held throughout): it must not look like the head one
  { name: 'body_combo', dist: 0.95, s0: hold(at({ ...two(4, P('jab', 'lead', { level: true })), ...two(16, P('cross', 'rear', { level: true })), ...two(32, P('hook', 'lead', { level: true })) }), { level: true }, 0, 50), n: 110 },
  { name: 'walk_jab_walk', dist: 1.7, s0: hold(hold(at(two(44, P('jab'))), { move: { x: 0, y: 1 } }, 4, 40), { move: { x: 0, y: -1 } }, 62, 100), n: 130 },
  { name: 'jab_walk', dist: 1.0, s0: hold(at(two(4, P('jab'))), { move: { x: -1, y: 0 } }, 14, 50), n: 80 },
  { name: 'hit_head', dist: 1.0, s0: [], s1: at(two(4, P('cross'))), n: 90 },
  { name: 'hit_body', dist: 1.0, s0: [], s1: hold(at(two(4, P('cross', 'rear', { level: true }))), { level: true }, 0, 6), n: 90 },
  { name: 'block_jab', dist: 1.0, s0: hold([], { block: true }, 2, 50), s1: at(two(12, P('jab'))), n: 90 },
  { name: 'slip', dist: 1.0, s0: at(two(4, { move: { x: -1, y: 0 } })), n: 60 },
  // the evade formula (evadeV2): slip a jab, duck a hook, lean back from an uppercut; each starts on its press
  { name: 'evade_slip_jab', dist: 1.0, s0: hold([], { move: { x: -1, y: 0 } }, 12, 15), s1: at(two(4, P('jab'))), n: 70 },
  { name: 'evade_duck_hook', dist: 0.95, s0: hold([], { level: true }, 16, 44), s1: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'evade_lean_hook', dist: 0.95, s0: hold([], { move: { x: 0, y: -1 } }, 16, 19), s1: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'trade_hook_cross', dist: 0.95, s0: at(two(4, P('hook', 'lead'))), s1: at(two(6, P('cross'))), n: 90 },
  { name: 'evade_lean_upper', dist: 0.8, s0: hold([], { move: { x: 0, y: -1 } }, 20, 23), s1: at(two(4, P('uppercut', 'lead'))), n: 80 },
  { name: 'counter_cross', dist: 1.0, s0: at({ ...two(14, { move: { x: 1, y: 0 } }), ...two(16, { move: { x: 1, y: 0 } }), ...two(24, P('cross')) }), s1: at(two(4, P('cross'))), n: 90 },
  // the mash: one button pressed every 6 ticks, eight times
  { name: 'mash_jab', dist: 1.0, s0: at(Object.assign({}, ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => two(4 + i * 6, P('jab'))))), n: 150 },
  // (a bare hook press, no direction: lead, then rear, then lead while the last is still in flight)
  { name: 'mash_hook', dist: 1.0, s0: at(Object.assign({}, ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => two(4 + i * 6, { hook: true })))), n: 170 },
  { name: 'mash_upper', dist: 0.9, s0: at(Object.assign({}, ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => two(4 + i * 6, { uppercut: true })))), n: 170 },
  { name: 'mash_cross', dist: 1.0, s0: at(Object.assign({}, ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => two(4 + i * 6, P('cross'))))), n: 170 },
  // hooks and uppercuts at the far end of their widened range (mocapFarMinHook / Upper): the body must step in and the glove must arrive
  { name: 'lhook_far', dist: 1.17, s0: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'rhook_far', dist: 1.17, s0: at(two(4, P('hook', 'rear'))), n: 80 },
  { name: 'lupper_far', dist: 1.09, s0: at(two(4, P('uppercut', 'lead'))), n: 80 },
  { name: 'rupper_far', dist: 1.09, s0: at(two(4, P('uppercut', 'rear'))), n: 80 },
  // the LONG hook: thrown from just under jab range it reaches (Nate 2026-11-20), the arm opening and the body going with it
  { name: 'lhook_long', dist: 1.33, s0: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'rhook_long', dist: 1.33, s0: at(two(4, P('hook', 'rear'))), n: 80 },
  { name: 'jab_lhook_long', dist: 1.3, s0: at({ ...two(4, P('jab')), ...two(18, P('hook', 'lead')) }), n: 90 },
  { name: 'jab_close', dist: 0.78, s0: at(two(4, P('jab'))), n: 70 },
  { name: 'cross_close', dist: 0.78, s0: at(two(4, P('cross'))), n: 80 },
  { name: 'jab_far', dist: 1.12, s0: at(two(4, P('jab'))), n: 70 },
  { name: 'lhook_close', dist: 0.75, s0: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'cross_far', dist: 1.22, s0: at(two(4, P('cross'))), n: 80 },
  // side 0 worn out (stamina ceiling near its floor), side 1 fresh: the tired look, and a jab thrown through it
  { name: 'tired', dist: 1.0, s0: at(two(40, P('jab'))), init: [{ stamina: 0.3, wear: 0.45 }, null], n: 90 },
  { name: 'jab_miss', dist: 1.5, s0: at(two(4, P('jab'))), n: 70 },
  { name: 'cross_miss', dist: 1.55, s0: at(two(4, P('cross'))), n: 80 },
  { name: 'hook_miss', dist: 1.4, s0: at(two(4, P('hook', 'lead'))), n: 80 },
  { name: 'knockdown', dist: 0.79, s0: [], s1: at({ ...two(2, P('hook', 'rear')), ...two(40, P('hook', 'rear')), ...two(80, P('hook', 'rear')) }), n: 300, cfg: { healthDamagePerImpulse: 0.006 } },
  // counted out (the roll forced past ten): the flat falls, by a head shot and by a body shot
  { name: 'ko_head', dist: 0.79, s0: [], s1: at(two(2, P('hook', 'rear'))), n: 200, cfg: { healthDamagePerImpulse: 0.006, getUpCountBest: 12, getUpCountWorst: 12 } },
  { name: 'ko_body', dist: 0.9, s0: [], s1: hold(at(two(4, P('hook', 'lead', { level: true }))), { level: true }, 0, 6), n: 200, cfg: { healthDamagePerImpulse: 0.012, getUpCountBest: 12, getUpCountWorst: 12 } },
].filter(s => !FILTER || s.name.includes(FILTER));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
await page.addInitScript(() => { window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} }; });
await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1${process.argv[8] ? '&opp=' + process.argv[8] : ''}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await bootReady(page);
await until(page, () => typeof window.__rigReplay === 'function' && typeof window.__humanProbe === 'function', undefined, { label: 'human views', timeout: 150_000 });
await page.evaluate(() => { const c = window.__cfg; c.debugHitboxes = false; c.refEnabled = false; if (window.__ANIM_CFG) Object.assign(c, window.__ANIM_CFG); });
if (process.argv[4]) await page.evaluate(o => Object.assign(window.__cfg, o), JSON.parse(process.argv[4]));
if (process.env.ANIM_CFG) await page.evaluate(o => Object.assign(window.__cfg, o), JSON.parse(process.env.ANIM_CFG));
await until(page, () => { window.__rigReplay(1.0, [], 1, []); return !!window.__humanProbe(0); }, undefined, { label: 'probe', timeout: 60_000 });

const runs = [];
for (const sc of SC) {
  const rows = await page.evaluate(sc => {
    const w = window, was = {};
    for (const k in (sc.cfg ?? {})) { was[k] = w.__cfg[k]; w.__cfg[k] = sc.cfg[k]; }
    const s0 = Array.from(sc.s0 ?? [], x => x ?? {}), s1 = Array.from(sc.s1 ?? [], x => x ?? {});
    const out = [];
    for (let t = 0; t <= sc.n; t++) {
      w.__rigReplay(sc.dist, s0, t, s1, sc.init ? { init: sc.init } : []);
      const st = w.__states();
      out.push([0, 1].map(s => {
        const f = st[s], p = w.__humanProbe(s);
        return { ld: p.lungeDbg, hips: p.hips, head: p.head, feet: p.feet, gl: p.gloves, lq: p.lq, yaw: p.yaw, lb: p.label, clip: p.clip, org: p.origin, dr: p.drawn, cf: p.conform,
          ev: (p.events ?? []).map(e => ({ type: e.type, side: e.side, target: e.target, part: e.part })),
          pos: [f.pos.x, f.pos.z], pt: f.punch.type, hand: f.punch.hand, prog: f.punch.progress, ph: f.punch.phase, res: f.punch.resolved,
          con: f.punch.contact ? [f.punch.contact.x, f.punch.contact.y, f.punch.contact.z] : null, down: f.down, hitT: f.hitT, gr: f.body.gloveR, stop: f.hitStop ?? 0 };
      }));
    }
    Object.assign(w.__cfg, was);
    return out;
  }, sc);
  runs.push({ sc, rows });
}

// optional film: argv[6] = "scenario:from:to:step" -> scripts/output/anim_measure/<tag>_<scenario>.png (fight camera, 4 frames a row)
if (process.argv[6]) {
  const [nm, a, b, st] = process.argv[6].split(':');
  const sc = SC.find(s => s.name === nm);
  if (sc) {
    const shots = [];
    await page.evaluate(sc => { for (const k in (sc.cfg ?? {})) window.__cfg[k] = sc.cfg[k]; }, sc);
    for (let t = +a; t <= +b; t += +st) {
      await page.evaluate(([sc, t]) => window.__rigReplay(sc.dist, Array.from(sc.s0 ?? [], x => x ?? {}), t, Array.from(sc.s1 ?? [], x => x ?? {}), sc.init ? { init: sc.init } : []), [sc, t]);
      await frames(page, 2);
      // (headless WebGL readback fails now and then on this machine: retry the capture, never the run)
      let buf = null;
      for (let k = 0; k < 6 && !buf; k++) { try { buf = await page.screenshot({ clip: { x: 120, y: 60, width: 400, height: 300 } }); } catch { await frames(page, 4); } }
      if (buf) shots.push({ t, b64: buf.toString('base64') }); else console.log('film: frame t' + t + ' could not be captured');
    }
    const sheet = await browser.newPage({ viewport: { width: 1600, height: Math.ceil(shots.length / 4) * 300 } });
    await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(4,400px);font:14px monospace;color:#fff">${shots.map(s => `<div style="position:relative"><img src="data:image/png;base64,${s.b64}" style="display:block"><span style="position:absolute;left:4px;top:2px;background:#000a">t${s.t}</span></div>`).join('')}</body>`);
    let done = false;
    for (let k = 0; k < 5 && !done; k++) { try { await sheet.screenshot({ path: `${OUT}/${TAG}_${nm}.png` }); done = true; } catch { await sheet.waitForLoadState('load'); await sheet.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); } }
    if (!done) { shots.forEach(s => writeFileSync(`${OUT}/${TAG}_${nm}_t${s.t}.png`, Buffer.from(s.b64, 'base64'))); console.log('film: sheet failed, frames written singly'); }
    await sheet.close();
    console.log(`film: ${OUT}/${TAG}_${nm}.png (${shots.length} frames)`);
  }
}
// optional trace: argv[5] = "scenario:side:from:to" prints the along-ring x of sim pos / drawn origin / hips / head / feet per tick, cm
if (process.argv[5]) {
  const [nm, sd, a, b] = process.argv[5].split(':');
  const run = runs.find(r => r.sc.name === nm);
  const c = v => (v * 100).toFixed(1).padStart(7);
  if (run) for (let t = +a; t <= +b && t < run.rows.length; t++) {
    const R = run.rows[t][+sd];
    console.log(`t${String(t).padStart(3)} sim${c(R.pos[0])} org${c(R.org[0])} hips${c(R.hips[0])} hipsY${c(R.hips[1])} head${c(R.head[0])} fL${c(R.feet.left[0])} fR${c(R.feet.right[0])} fLy${c(R.feet.left[1])} fRy${c(R.feet.right[1])} L0${c(R.ld[0])} ex${c(R.ld[1])} wL ${R.ld[2].toFixed(2)} ${R.cf.kind}  ${R.lb} | ${R.ph ?? ''} p${(R.prog ?? 0).toFixed(2)}`);
  }
}
// ---------- analysis ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = v => Math.hypot(v[0], v[1], v[2]);
const qang = (a, b) => { const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]); return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI; };
const segDist = (p, a, b) => { const ab = sub(b, a), ap = sub(p, a); const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2; const t = L ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0; return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])); };
const LIM = { hips: 0.04, head: 0.08, footL: 0.08, footR: 0.08, gloveLead: 0.3, gloveRear: 0.3 };   // (a glove: 30 cm a tick = 18 m/s, above any real punch)
const flags = [], snaps = [];
const angAt = [];   // transitions: max joint speed in the window
const contacts = [];
const summary = {};
for (const { sc, rows } of runs) {
  let maxEx = { hips: 0, head: 0, foot: 0, glove: 0 };
  for (let t = 2; t < rows.length; t++) for (const s of [0, 1]) {
    const A = rows[t - 1][s], B = rows[t][s];
    const dS = [B.pos[0] - A.pos[0], 0, B.pos[1] - A.pos[1]];
    const items = { hips: [A.hips, B.hips], head: [A.head, B.head], footL: [A.feet.left, B.feet.left], footR: [A.feet.right, B.feet.right], gloveLead: [A.gl.lead, B.gl.lead], gloveRear: [A.gl.rear, B.gl.rear] };
    for (const [k, [p, q]] of Object.entries(items)) {
      const ex = len(sub(sub(q, p), dS));
      // a walking foot moves faster than the body it carries; a falling or rising head is a fall, not a jump (12 cm a tick)
      const lim = k.startsWith('foot') ? (B.down ? 0.15 : LIM[k] + len(dS)) : k === 'head' && B.down ? 0.12 : LIM[k];
      const kk = k.startsWith('foot') ? 'foot' : k.startsWith('glove') ? 'glove' : k;
      maxEx[kk] = Math.max(maxEx[kk], ex);
      // a head driven by a punch that just landed on it is meant to move fast: counted apart (up to 25 cm a tick)
      let struck = false;
      for (let u = Math.max(1, t - 5); u <= t; u++) if (rows[u][s].ev.some(e => e.type === 'punchLand' && e.target === s)) struck = true;
      if (k === 'head' && struck && ex > LIM[k] && ex < 0.25) { snaps.push(+(ex * 100).toFixed(1)); continue; }
      if (ex > lim) flags.push({ sc: sc.name, t, s, k, cm: +(ex * 100).toFixed(1), simMove: +(len(dS) * 100).toFixed(1), lb: `${A.lb} -> ${B.lb}`, st: `${B.pt ?? '-'} ${B.ph ?? ''} p${(B.prog ?? 0).toFixed(2)} down=${B.down} hitT=${(B.hitT ?? 0).toFixed(2)}` });
    }
  }
  summary[sc.name] = { hips: +(maxEx.hips * 100).toFixed(1), head: +(maxEx.head * 100).toFixed(1), foot: +(maxEx.foot * 100).toFixed(1), glove: +(maxEx.glove * 100).toFixed(1) };
  // transitions: a change in the label's first word or the clip; max joint speed over [t-1, t+4]
  let maxAll = 0, maxAt = '';
  for (let t = 2; t < rows.length; t++) for (const s of [0, 1]) {
    const A = rows[t - 1][s], B = rows[t][s];
    for (const j in B.lq) { const a = qang(A.lq[j], B.lq[j]); if (a > maxAll) { maxAll = a; maxAt = `${j}@t${t} s${s} ${B.lb}`; } }
    const key = r => `${r.lb.split(' ')[0]}`;
    if (key(A) === key(B) && !(B.pt && A.pt && B.prog < A.prog - 0.2)) continue;
    let mx = 0, mj = '';
    for (let u = t; u < Math.min(rows.length, t + 5); u++) {
      const X = rows[u - 1][s], Y = rows[u][s];
      for (const j in Y.lq) { const a = qang(X.lq[j], Y.lq[j]); if (a > mx) { mx = a; mj = `${j}@${u}`; } }
    }
    angAt.push({ sc: sc.name, s, t, from: A.lb, to: B.lb, maxDegPerTick: +mx.toFixed(1), joint: mj });
  }
  summary[sc.name].maxJointDegPerTick = `${maxAll.toFixed(1)} ${maxAt}`;
  // contacts: the attacker's landed punches
  for (let t = 1; t < rows.length; t++) for (const s of [0, 1]) {
    const R = rows[t][s];
    for (const e of R.ev) {
      if (e.side !== s || e.type !== 'punchLand') continue;
      const hand = R.hand ?? rows[t - 1][s].hand;
      const series = [];
      for (let u = t; u < Math.min(rows.length, t + 5); u++) {
        const g = hand === 'lead' ? rows[u][s].gl.lead : rows[u][s].gl.rear, D = rows[u][1 - s].dr;
        if (!D) continue;
        const gr = R.gr * (1 - 0);   // glove radius
        const head = len(sub(g, D.head)) - D.headR - gr, body = segDist(g, D.a, D.b) - D.r - gr;
        // beyond: how far the glove centre is past the target centre along the punch line (his facing), m
        series.push(e.part === 'head' ? +(head * 100).toFixed(1) : +(body * 100).toFixed(1));
      }
      contacts.push({ sc: sc.name, t, s, part: e.part, hand, gapCm: series });
    }
  }
}
// misses: every punch with no land / block event; the closest the glove surface came to the target's drawn head or torso
const misses = [], timing = [];
for (const { sc, rows } of runs) for (const s of [0, 1]) {
  let cur = null;
  for (let t = 1; t < rows.length; t++) {
    const R = rows[t][s], A = rows[t - 1][s];
    if (R.pt && (!A.pt || R.prog < A.prog - 0.2)) { if (cur && !cur.hit) misses.push(cur); cur = { sc: sc.name, s, t, pt: R.pt, hit: false, min: 9 }; }
    if (cur && R.ev.some(e => (e.type === 'punchLand' || e.type === 'punchBlock') && e.side === s)) cur.hit = true;
    if (cur && R.pt) {
      const D = rows[t][1 - s].dr, g = R.hand === 'lead' ? R.gl.lead : R.gl.rear;
      if (D) cur.min = Math.min(cur.min, len(sub(g, D.head)) - D.headR - R.gr, segDist(g, D.a, D.b) - D.r - R.gr);
    }
    if (cur && R.pt && R.res && cur.tHit === undefined) cur.tHit = t;
    if (cur && !R.pt) { timing.push(`${cur.sc}/${cur.pt}: press->hit ${((cur.tHit - cur.t + 1) / 60).toFixed(2)} s, hit->free ${((t - cur.tHit) / 60).toFixed(2)} s`); if (!cur.hit) misses.push(cur); cur = null; }
  }
}
flags.sort((a, b) => b.cm - a.cm);
const BRIEF = process.argv[7] === 'brief';
const _log = console.log; if (BRIEF) console.log = (...x) => { const l = String(x[0]); if (/press->hit|SUMMARY|JUMPS flagged|console errors|^film|^  \S+ +t ?\d+ s\d (hips|head|foot|glove)/.test(l)) _log(...x); };
console.log(`JUMPS flagged: ${flags.length} (hips > 4 cm, head / feet > 8 cm beyond the sim's own move in one frame)`);
console.log(`  (struck-head frames over 8 cm, counted apart: ${snaps.length}, max ${Math.max(0, ...snaps)} cm)`);
for (const f of flags.slice(0, 10)) console.log(`  ${f.sc.padEnd(16)} t${String(f.t).padStart(3)} s${f.s} ${f.k.padEnd(5)} ${String(f.cm).padStart(5)} cm (sim ${f.simMove})  ${f.lb}  | ${f.st}`);
if (process.env.FULL) console.log('\nper scenario max excess cm (hips / head / foot) and max joint deg per tick:');
if (process.env.FULL) for (const [k, v] of Object.entries(summary)) console.log(`  ${k.padEnd(16)} ${String(v.hips).padStart(5)} ${String(v.head).padStart(5)} ${String(v.foot).padStart(5)}   joint ${v.maxJointDegPerTick}`);
angAt.sort((a, b) => b.maxDegPerTick - a.maxDegPerTick);
console.log(`\nTRANSITIONS: ${angAt.length}; worst 25 by max joint deg/tick over the 5 ticks after:`);
for (const a of angAt.slice(0, 5)) console.log(`  ${a.sc.padEnd(16)} s${a.s} t${String(a.t).padStart(3)} ${String(a.maxDegPerTick).padStart(5)} ${a.joint.padEnd(16)} ${a.from} -> ${a.to}`);
console.log('\nCONTACTS (landed; glove surface gap to the drawn target, cm, hit tick then 4 after; negative = inside):');
for (const c of contacts) console.log(`  ${c.sc.padEnd(16)} t${c.t} s${c.s} ${c.hand}/${c.part}: ${c.gapCm.join(' ')}`);
console.log('\nMISSES (no land / block; closest glove surface to the drawn target, cm):');
for (const m of misses) console.log(`  ${m.sc.padEnd(16)} t${m.t} s${m.s} ${m.pt}: ${(m.min * 100).toFixed(1)}`);
console.log('\nTIMING (side 0 single punches):');
for (const l of timing.filter(l => /^(jab|cross|lhook|rhook|lupper|rupper|jab2_g10|jab_cross_hook)\//.test(l))) console.log('  ' + l);
const hitGaps = contacts.map(c => c.gapCm[0]);
console.log(`\nSUMMARY jumps ${flags.length} | fastest glove ${Math.max(...Object.values(summary).map(v => v.glove))} cm/tick | landed gap at hit tick: min ${Math.min(...hitGaps)} max ${Math.max(...hitGaps)} cm over ${hitGaps.length} | misses closest ${misses.length ? Math.min(...misses.map(m => m.min * 100)).toFixed(1) : '-'} cm`);
writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify({ flags, summary, angAt, contacts }, null, 1));
await browser.close();
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !/GPU stall/.test(m.text));
console.log(`console errors/warnings: ${bad.length}`);
bad.slice(0, 5).forEach(m => console.log(`  [${m.type}] ${m.text.slice(0, 200)}`));
