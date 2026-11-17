/**
 * human_audit.mjs — measures the drawn human boxers against the deterministic sim, tick by tick, across a matrix of
 * scripted scenarios, and prints a violations table. One browser session. Fixes nothing.
 *   PORT=5195 node scripts/human_audit.mjs [--quick] [--noshots] [filter-substring]
 * --quick: ~40 scenarios (every punch and hand at 1.0 / 1.25 m, body shots, the five chains, slips, crouch, block,
 * walk-in, one knockdown), a few minutes. Output: stdout table + per-check counts, audit.json (audit_quick.json),
 * shot_N.png for the five worst.
 *
 * Truth comes from the sim: land / block / whiff are the sim's own events (the probe's `events`, the ones the view was
 * fed that tick); the contact and through-the-target checks use the sim's head sphere and body capsule (headBox /
 * bodyBox). The punching hand's pop threshold is the clip's OWN glove displacement between the two frames drawn
 * (probe `legitHand`: clip speed × playback rate) × 1.3 + 3 cm, measured relative to the body origin (the lunge is
 * checked through the hips); every other part keeps the flat 12 cm (idle, guard, steps never move that fast).
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'human_audit');
mkdirSync(OUT, { recursive: true });
const ARGS = process.argv.slice(2);
const QUICK = ARGS.includes('--quick');
const SHOTS = !ARGS.includes('--noshots');
const FILTER = ARGS.find(a => !a.startsWith('--')) ?? '';
const HZ = 60;

// ---------- scenario definitions ----------
const sparse = (o, n) => { const a = new Array(n).fill(null); for (const [k, v] of Object.entries(o)) a[Number(k)] = v; return a; };
const PRESS = 4;
function press(punch, hand, t, level) {
  const o = { [punch]: true };
  if (punch === 'hook' || punch === 'uppercut') o.move = { x: hand === 'lead' ? -1 : 1, y: 0 };
  if (level) o.level = true;
  return o;
}
function build(sc) {
  // returns { s0, s1 } scripts for sides given sc.actor (side), sc.acts [{t, input}], sc.hold [{from,to,input}]
  const n = 400;
  const mine = new Array(n).fill(null);
  for (const h of sc.holds ?? []) for (let t = h.from; t <= h.to; t++) mine[t] = { ...(mine[t] ?? {}), ...h.input };
  for (const a of sc.acts ?? []) for (let t = a.t; t < a.t + (a.len ?? 2); t++) mine[t] = { ...(mine[t] ?? {}), ...a.input };
  const theirs = new Array(n).fill(null);
  for (const h of sc.oppHolds ?? []) for (let t = h.from; t <= h.to; t++) theirs[t] = { ...(theirs[t] ?? {}), ...h.input };
  for (const a of sc.oppActs ?? []) for (let t = a.t; t < a.t + (a.len ?? 2); t++) theirs[t] = { ...(theirs[t] ?? {}), ...a.input };
  const cut = Math.max(...[...mine, ...theirs].map((x, i) => (x ? i : 0))) + 1;
  const m = mine.slice(0, cut), o = theirs.slice(0, cut);
  return sc.actor === 0 ? { s0: m, s1: o } : { s0: o, s1: m };
}
const lastInput = sc => {
  let L = 0;
  for (const h of [...(sc.holds ?? []), ...(sc.oppHolds ?? [])]) L = Math.max(L, h.to);
  for (const a of [...(sc.acts ?? []), ...(sc.oppActs ?? [])]) L = Math.max(L, a.t + (a.len ?? 2) - 1);
  return L;
};

const scenarios = [];
const addSc = sc => { sc.lastInput = lastInput(sc); Object.assign(sc, build(sc)); if (!FILTER || sc.name.includes(FILTER)) scenarios.push(sc); };
const DISTS = [0.75, 1.0, 1.25, 1.6];
const PH = [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'], ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']];
const CHAINS = [['jab', 'lead', 'cross', 'rear'], ['jab', 'lead', 'jab', 'lead'], ['cross', 'rear', 'hook', 'lead'], ['hook', 'lead', 'cross', 'rear'], ['jab', 'lead', 'uppercut', 'rear']];
const punchSc = (actor, punch, hand, zone, dist, opp) => {
  const lvl = zone === 'body';
  addSc({
    name: `s${actor} ${punch}/${hand} ${zone} d${dist} vs ${opp}`, kind: 'punch', actor, dist, punch, hand, zone, opp,
    holds: lvl ? [{ from: 0, to: PRESS + 1, input: { level: true } }] : [],
    acts: [{ t: PRESS, input: press(punch, hand, PRESS, lvl) }],
    oppHolds: opp === 'block' ? [{ from: 0, to: 120, input: { block: true } }] : [],
  });
};
if (QUICK) {
  for (const [punch, hand] of PH) for (const dist of [1.0, 1.25]) punchSc(0, punch, hand, 'head', dist, 'idle');
  for (const [punch, hand] of PH) punchSc(0, punch, hand, 'body', 1.0, 'idle');
  // every punch on a held block at three distances (expect blocked, or a whiff beyond its band; never a land)
  for (const [punch, hand] of PH) for (const dist of [0.8, 1.0, 1.2]) punchSc(0, punch, hand, 'head', dist, 'block');
  // body variants (level held) at three distances (expect the body clip, landing on the body, or a whiff beyond the band)
  for (const [punch, hand] of PH.filter(([p]) => p !== 'uppercut')) for (const dist of [0.9, 1.1, 1.3]) punchSc(0, punch, hand, 'body', dist, 'idle');
  punchSc(0, 'jab', 'lead', 'head', 0.75, 'idle'); punchSc(0, 'hook', 'lead', 'head', 0.75, 'idle');
  punchSc(1, 'jab', 'lead', 'head', 1.0, 'idle'); punchSc(1, 'cross', 'rear', 'head', 1.0, 'idle');
  for (const [p1, h1, p2, h2] of CHAINS) addSc({ name: `s0 chain ${p1}-${p2} gap8 d1`, kind: 'chain', actor: 0, dist: 1.0, punch: p1, hand: h1, zone: 'head', opp: 'idle',
    acts: [{ t: PRESS, input: press(p1, h1) }, { t: PRESS + 8, input: press(p2, h2) }] });
  for (const [nm, mv] of [['slipL', { x: -1, y: 0 }], ['slipR', { x: 1, y: 0 }], ['slipBack', { x: 0, y: -1 }]]) addSc({ name: `s0 ${nm}`, kind: 'defence', actor: 0, dist: 1.0, acts: [{ t: PRESS, len: 2, input: { move: mv } }] });
  addSc({ name: 's0 slipL vs jab', kind: 'defence', actor: 0, dist: 1.0, acts: [{ t: PRESS + 3, len: 2, input: { move: { x: -1, y: 0 } } }], oppActs: [{ t: PRESS, input: { jab: true } }] });
  addSc({ name: 's0 level hold', kind: 'defence', actor: 0, dist: 1.0, holds: [{ from: 6, to: 60, input: { level: true } }] });
  addSc({ name: 's0 block hold', kind: 'defence', actor: 0, dist: 1.0, holds: [{ from: 6, to: 40, input: { block: true } }] });
  addSc({ name: 's0 block vs jab', kind: 'defence', actor: 0, dist: 1.0, holds: [{ from: 2, to: 40, input: { block: true } }], oppActs: [{ t: PRESS, input: { jab: true } }] });
  for (const [nm, mv] of [['fwd', { x: 0, y: 1 }], ['back', { x: 0, y: -1 }], ['left', { x: -1, y: 0 }]]) addSc({ name: `s0 walk ${nm}`, kind: 'walk', actor: 0, dist: 1.4, holds: [{ from: 4, to: 50, input: { move: mv } }] });
  addSc({ name: 's0 knockdown by hook', kind: 'knockdown', actor: 1, dist: 0.79, cfg: { healthDamagePerImpulse: 0.006 },
    acts: [{ t: 2, input: press('hook', 'rear') }, { t: 40, input: press('hook', 'rear') }, { t: 80, input: press('hook', 'rear') }], fixedN: 300 });
}
for (const actor of QUICK ? [] : [0, 1]) {
  for (const [punch, hand] of [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'], ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']]) {
    for (const zone of ['head', 'body']) {
      for (const dist of DISTS) {
        for (const opp of ['idle', 'block']) {
          const lvl = zone === 'body';
          addSc({
            name: `s${actor} ${punch}/${hand} ${zone} d${dist} vs ${opp}`, kind: 'punch', actor, dist, punch, hand, zone, opp,
            holds: lvl ? [{ from: 0, to: PRESS + 1, input: { level: true } }] : [],
            acts: [{ t: PRESS, input: press(punch, hand, PRESS, lvl) }],
            oppHolds: opp === 'block' ? [{ from: 0, to: 120, input: { block: true } }] : [],
          });
        }
      }
    }
  }
  const CH = [['jab', 'lead', 'cross', 'rear'], ['jab', 'lead', 'jab', 'lead'], ['cross', 'rear', 'hook', 'lead'], ['hook', 'lead', 'cross', 'rear'], ['jab', 'lead', 'uppercut', 'rear']];
  for (const [p1, h1, p2, h2] of CH) {
    for (const dist of [0.75, 1.0]) {
      for (const gap of [8, 14]) {
        addSc({ name: `s${actor} chain ${p1}-${p2} gap${gap} d${dist}`, kind: 'chain', actor, dist, punch: p1, hand: h1, zone: 'head', opp: 'idle',
          acts: [{ t: PRESS, input: press(p1, h1) }, { t: PRESS + gap, input: press(p2, h2) }] });
      }
    }
  }
  for (const [nm, mv] of [['slipL', { x: -1, y: 0 }], ['slipR', { x: 1, y: 0 }], ['slipBack', { x: 0, y: -1 }]]) {
    addSc({ name: `s${actor} ${nm}`, kind: 'defence', actor, dist: 1.0, acts: [{ t: PRESS, len: 2, input: { move: mv } }] });
    addSc({ name: `s${actor} ${nm} vs jab`, kind: 'defence', actor, dist: 1.0, acts: [{ t: PRESS + 3, len: 2, input: { move: mv } }], oppActs: [{ t: PRESS, input: { jab: true } }] });
  }
  addSc({ name: `s${actor} level hold`, kind: 'defence', actor, dist: 1.0, holds: [{ from: 6, to: 60, input: { level: true } }] });
  addSc({ name: `s${actor} block hold`, kind: 'defence', actor, dist: 1.0, holds: [{ from: 6, to: 40, input: { block: true } }] });
  addSc({ name: `s${actor} block vs jab`, kind: 'defence', actor, dist: 1.0, holds: [{ from: 2, to: 40, input: { block: true } }], oppActs: [{ t: PRESS, input: { jab: true } }] });
  for (const [nm, mv] of [['fwd', { x: 0, y: 1 }], ['back', { x: 0, y: -1 }], ['left', { x: -1, y: 0 }], ['right', { x: 1, y: 0 }]]) {
    addSc({ name: `s${actor} walk ${nm}`, kind: 'walk', actor, dist: 1.4, holds: [{ from: 4, to: 50, input: { move: mv } }] });
  }
  for (const p of ['cross', 'hook']) {
    addSc({ name: `s${actor} knockdown by ${p}`, kind: 'knockdown', actor: 1 - actor, dist: 0.79, cfg: { healthDamagePerImpulse: 0.006 },
      acts: [{ t: 2, input: press(p, 'rear') }, { t: 40, input: press(p, 'rear') }, { t: 80, input: press(p, 'rear') }], fixedN: 300 });
  }
}

// ---------- browser side ----------
const SIDE_KEYS = ['head', 'hips', 'gloves', 'feet', 'clip', 'punchClip', 'frame'];
async function runScenario(page, sc) {
  return page.evaluate(({ sc }) => {
    const w = window;
    const was = {};
    for (const k in (sc.cfg ?? {})) { was[k] = w.__cfg[k]; w.__cfg[k] = sc.cfg[k]; }
    const out = [];
    let quiet = 0, bodyDims = null;
    const cap = sc.fixedN ?? 260;
    for (let t = 0; t <= cap; t++) {
      w.__rigReplay(sc.dist, sc.s0, t, sc.s1);
      const st = w.__states();
      const row = [];
      for (const side of [0, 1]) {
        const f = st[side], p = w.__humanProbe(side);
        if (!p) throw new Error('probe null');
        if (t === 0 && side === 0) bodyDims = null;
        const hb = f.headBox, bb = f.bodyBox;
        row.push({
          p: { head: p.head, hips: p.hips, gl: p.gloves, feet: p.feet, clip: p.clip, pc: p.punchClip, fr: p.frame, org: p.origin, legit: p.legitHand, dr: p.drawn, cf: p.conform, lb: p.label, knees: p.knees, ikMax: p.ikMax,
            ev: (p.events ?? []).filter(e => /^punch/.test(e.type)).map(e => ({ type: e.type, side: e.side, target: e.target, part: e.part })) },
          hb: [hb.x, hb.y, hb.z, hb.r], bb: [[bb.a.x, bb.a.y, bb.a.z], [bb.b.x, bb.b.y, bb.b.z], bb.r],
          s: { x: f.pos.x, z: f.pos.z, yaw: f.yaw, hp: f.health, blk: f.block, down: f.down, burst: f.burstT, lvl: f.level, hurt: f.hurt,
            slip: f.slip.active, pt: f.punch.type, ph: f.punch.phase, hand: f.punch.hand, prog: f.punch.progress, res: f.punch.resolved,
            con: f.punch.contact ? [f.punch.contact.x, f.punch.contact.y, f.punch.contact.z] : null, variant: f.punch.variant,
            g: [f.gloves[0].pos, f.gloves[1].pos].map(g => [g.x, g.y, g.z]), body: { hr: f.body.headR, gr: f.body.gloveR, br: f.body.bodyR, hy: f.body.hipY, sy: f.body.shoulderY, hdy: f.body.headY } },
        });
      }
      out.push(row);
      if (sc.fixedN === undefined) {
        const act = row[0].s.pt !== null || row[1].s.pt !== null;
        quiet = act ? 0 : quiet + 1;
        if (t >= sc.lastInput + 46 && quiet >= 36) break;
      }
    }
    Object.assign(w.__cfg, was);
    const oc = !!(w.__cfg.mocapOutcome && w.__cfg.mocapGeo);
    return { out, cfg: { sep: oc ? w.__cfg.mocapSeparation : w.__cfg.separationDist, scale: oc ? 1 : w.__cfg.mocapGeo ? w.__cfg.mocapCloseScale : 1, outcome: oc, squash: w.__cfg.contactSquash } };
  }, { sc });
}

// ---------- analysis ----------
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function segDist(p, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L));
  return dist3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
}
const local = (p, hips, yaw) => {
  const d = [p[0] - hips[0], p[1] - hips[1], p[2] - hips[2]];
  return [d[0] * Math.cos(yaw) + d[2] * Math.sin(yaw), d[1], -d[0] * Math.sin(yaw) + d[2] * Math.cos(yaw)];
};
const handOf = (r, hand) => (hand === 'lead' ? r.p.gl.lead : r.p.gl.rear);
const GL = { lead: 0, rear: 1 };

function analyse(sc, run) {
  const rows = run.out;
  const OC = !!run.cfg.outcome;
  const N = rows.length;
  const V = {};   // check -> { count, worst, thr, over, tick, note }
  const flag = (check, tick, value, thr, over, note = '') => {
    const v = V[check] ??= { check, count: 0, worst: 0, thr, over: 0, tick, note };
    v.count++;
    if (over > v.over) { v.over = over; v.worst = value; v.tick = tick; v.note = note; }
  };
  const info = {};
  const a = sc.actor, d = 1 - a;
  const bothSides = [0, 1];

  // calibration at t0
  const head0 = bothSides.map(s => rows[0][s].p.head);
  const hy = bothSides.map(s => rows[0][s].s.body.hdy - rows[0][s].p.head[1]);   // sim head centre height minus drawn head bone height
  const hpy = bothSides.map(s => rows[0][s].s.body.hy - rows[0][s].p.hips[1]);
  info.headYOffset = hy.map(x => +x.toFixed(3));
  info.hipsYOffset = hpy.map(x => +x.toFixed(3));
  const floor = bothSides.map(s => Math.min(rows[0][s].p.feet.left[1], rows[0][s].p.feet.right[1]));
  const guard = bothSides.map(s => ({
    lead: local(rows[0][s].p.gl.lead, rows[0][s].p.hips, rows[0][s].s.yaw),
    rear: local(rows[0][s].p.gl.rear, rows[0][s].p.hips, rows[0][s].s.yaw),
  }));
  const guardDist = (t, s, hand) => dist3(local(handOf(rows[t][s], hand), rows[t][s].p.hips, rows[t][s].s.yaw), guard[s][hand]);

  // 2 pops
  let maxPop = 0, maxPopWhat = '';
  for (let t = 1; t < N; t++) for (const s of bothSides) {
    const A = rows[t - 1][s].p, B = rows[t][s].p, S = rows[t][s].s;
    // the punching hand while a mocapGeo clip plays: body-origin relative, against the clip's own motion this tick
    const same = (u, v) => u[0] === v[0] && u[1] === v[1] && u[2] === v[2];
    const punchHand = S.pt !== null && B.legit >= 0 ? (same(S.hand === 'lead' ? B.gl.lead : B.gl.rear, B.gl.left) ? 'handL' : 'handR') : null;
    const rel = (p, o) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const items = { head: [A.head, B.head], hips: [A.hips, B.hips], handL: [A.gl.left, B.gl.left], handR: [A.gl.right, B.gl.right], footL: [A.feet.left, B.feet.left], footR: [A.feet.right, B.feet.right] };
    for (const [k, [p, q]] of Object.entries(items)) {
      let m = dist3(p, q), thr = 0.12;
      if (k === punchHand) { m = dist3(rel(p, A.org), rel(q, B.org)); thr = Math.max(0.06, 1.3 * B.legit + 0.03); }
      if (m > maxPop) { maxPop = m; maxPopWhat = `s${s} ${k} t${t}`; }
      if (m > thr) flag(k === punchHand ? 'pop (punching hand vs clip speed)' : 'pop', t, +m.toFixed(3), +thr.toFixed(3), m / thr, `s${s} ${k} (${A.clip}->${B.clip}) p=${S.prog?.toFixed(2)} ${S.ph ?? ''}`);
    }
  }
  info.maxPop = { cm: +(maxPop * 100).toFixed(1), at: maxPopWhat };

  // 6 feet
  for (const s of bothSides) {
    for (let t = 1; t < N; t++) {
      const R = rows[t][s], P = rows[t - 1][s];
      for (const fk of ['left', 'right']) {
        const h = R.p.feet[fk][1] - floor[s], hp = P.p.feet[fk][1] - floor[s];
        if (h < -0.03) flag('foot below floor', t, +h.toFixed(3), -0.03, -h / 0.03, `s${s} ${fk}`);
        if (h < 0.03 && hp < 0.03 && !R.s.down) {
          const sl = dist2(R.p.feet[fk], P.p.feet[fk]);
          if (sl > 0.04) flag('foot slide', t, +sl.toFixed(3), 0.04, sl / 0.04, `s${s} ${fk} clip ${R.p.clip}`);
        }
      }
      if (!R.s.down && R.s.burst === 0) {
        const low = Math.min(R.p.feet.left[1], R.p.feet.right[1]) - floor[s];
        if (low > 0.06) flag('both feet off floor', t, +low.toFixed(3), 0.06, low / 0.06, `s${s} clip ${R.p.clip}`);
      }
    }
  }

  // 7 facing & overlap
  const sep = run.cfg.sep * run.cfg.scale;
  for (let t = 0; t < N; t++) {
    const R0 = rows[t][0], R1 = rows[t][1];
    const hd = dist3(R0.p.head, R1.p.head);
    if (hd < 0.20) flag('heads overlap', t, +hd.toFixed(3), 0.20, 0.20 / Math.max(hd, 0.01), '');
    const hp = dist2(R0.p.hips, R1.p.hips);
    if (hp < sep - 0.005) flag('hips closer than separation', t, +hp.toFixed(3), +sep.toFixed(3), sep / Math.max(hp, 0.01), '');
    for (const s of bothSides) {
      const R = rows[t][s], O = rows[t][1 - s];
      if (R.s.slip || R.s.down || O.s.down) continue;
      const bearing = Math.atan2(O.s.z - R.s.z, O.s.x - R.s.x);
      let df = Math.abs(Math.atan2(Math.sin(R.s.yaw - bearing), Math.cos(R.s.yaw - bearing))) * 180 / Math.PI;
      if (df > 35) flag('facing off opponent', t, +df.toFixed(1), 35, df / 35, `s${s} (sim yaw)`);
    }
  }

  // punches by the actor
  const A = rows.map(r => r[a]);
  const starts = [];
  for (let t = 1; t < N; t++) {
    const P = A[t - 1].s, C = A[t].s;
    if (C.pt !== null && (P.pt === null || C.prog < P.prog - 0.2)) starts.push(t);
  }
  info.punchStarts = starts;
  // the SIM's hit shapes (what the hit test uses)
  const bodyOf = (s, t) => { const R = rows[t][s]; return { a: R.bb[0], b: R.bb[1], r: R.bb[2] }; };
  const headOf = (s, t) => { const R = rows[t][s]; return { c: R.hb.slice(0, 3), r: R.hb[3] }; };
  const gap = (g, s, t) => {
    const R = rows[t][s], gr = R.s.body.gr;
    const H = headOf(s, t), B = bodyOf(s, t);
    const dh = dist3(g, H.c) - H.r, db = segDist(g, B.a, B.b) - B.r;
    return { head: dh - 0, body: db, hg: dh - gr, bg: db - gr };
  };

  if (starts.length) {
    // 3 picture vs hit shape
    let maxPic = 0, picWhere = '';
    for (let t = 0; t < N; t++) {
      const S = A[t].s;
      if (S.pt === null) continue;
      const dd = dist3(handOf(A[t], S.hand), S.g[GL[S.hand]]);
      if (dd > maxPic) { maxPic = dd; picWhere = `t${t} ${S.ph} p=${S.prog.toFixed(2)} ${S.pt}/${S.hand}`; }
      // (outcome first: the sim's punching glove decides nothing and is not drawn; the contact checks below are the truth)
      if (dd > 0.05 && !OC) flag('drawn glove vs sim glove', t, +dd.toFixed(3), 0.05, dd / 0.05, `phase ${S.ph} p=${S.prog.toFixed(2)} ${A[t].p.clip}`);
    }
    info.maxPic = { cm: +(maxPic * 100).toFixed(1), at: picWhere };

    // 4 contact truth, per punch resolve
    info.resolves = [];
    // the sim's own outcome events for the actor's punches; the drawn glove's surface gap to the part it hit
    const holdTicks = [];
    for (let t = 1; t < N; t++) {
      const C = A[t].s;
      for (const e of A[t].p.ev) {
        if (e.side !== a || !['punchLand', 'punchBlock', 'punchWhiff', 'punchSmother'].includes(e.type)) continue;
        const kind = e.type.slice(5).toLowerCase();
        const hand = C.hand ?? A[t - 1].s.hand;
        const g = handOf(A[t], hand), gp = gap(g, d, t);
        const part = e.part ?? (gp.hg <= gp.bg ? 'head' : 'body');
        const m = part === 'head' ? gp.hg : gp.bg;
        info.resolves.push({ t, punch: C.pt, hand, kind, part, variant: C.variant, gloveGapCm: +(m * 100).toFixed(1), simGap: C.pt ? +(dist3(g, C.g[GL[hand]]) * 100).toFixed(1) : null });
        if (OC) {
          // OUTCOME FIRST: the drawn glove ON the sim's contact point at the hit tick (land: on the drawn head / torso; block: on the guard glove)
          // (a block is steered onto the DRAWN guard glove — checked below against the drawn gloves)
          if (kind === 'land' && C.con) {
            const off = dist3(g, C.con);
            if (off > 0.04) flag('landed: drawn glove off the contact point', t, +off.toFixed(3), 0.04, off / 0.04, `${C.pt}/${hand} ${part} d${sc.dist}`);
          }
          if (kind === 'block') {
            const dg = Math.min(dist3(g, rows[t][d].p.gl.left), dist3(g, rows[t][d].p.gl.right)) - 2 * C.body.gr;
            if (dg > 0.08) flag('blocked but glove away from the guard', t, +dg.toFixed(3), 0.08, dg / 0.08, `${C.pt}/${hand} d${sc.dist}`);
          }
          if (kind === 'land') holdTicks.push(t);
          // expectations by scenario
          if (sc.opp === 'block' && kind === 'land') flag('landed through a held block', t, 1, 0, 1, `${C.pt}/${hand} ${part} d${sc.dist}`);
          if (sc.zone === 'body' && kind === 'land' && part !== 'body') flag('body punch landed on the head', t, 1, 0, 1, `${C.pt}/${hand} ${C.variant} d${sc.dist}`);
          if (sc.zone === 'body' && sc.punch !== 'uppercut' && !/body/.test(A[t].p.lb ?? '')) flag('body punch not playing a body clip', t, 1, 0, 1, `${C.pt}/${hand} ${C.variant} clip ${A[t].p.lb}`);
          continue;
        }
        if (kind === 'land') {
          if (m > 0.06) flag('landed but glove away from target', t, +m.toFixed(3), 0.06, m / 0.06, `${C.pt}/${hand} ${part} d${sc.dist}`);
          holdTicks.push(t);
        }
        if (kind === 'block') {
          // a blocked shot stops on the guard: the drawn glove within reach of either of the defender's drawn gloves
          const dg = Math.min(dist3(g, rows[t][d].p.gl.left), dist3(g, rows[t][d].p.gl.right)) - 2 * C.body.gr;
          if (dg > 0.08) flag('blocked but glove away from the guard', t, +dg.toFixed(3), 0.08, dg / 0.08, `${C.pt}/${hand} d${sc.dist}`);
        }
      }
    }
    info.punchLands = holdTicks;
    // through the head/body, any tick within punch windows + 15 ticks
    for (let t = 0; t < N; t++) {
      const inWin = starts.some(s0 => t >= s0 && t <= s0 + 70);
      if (!inWin) continue;
      for (const hk of ['left', 'right']) {
        const g = A[t].p.gl[hk];
        const D = rows[t][d].p.dr;
        if (OC && D) {
          // outcome first: the DRAWN head sphere / torso capsule; inside = the glove centre over 2 cm closer than where a landed glove rests
          const rest = A[t].s.body.gr * (1 - run.cfg.squash);
          const inH = D.headR + rest - dist3(g, D.head), inB = D.r + rest - segDist(g, D.a, D.b);
          if (inH > 0.02) flag('glove inside drawn head', t, +inH.toFixed(3), 0.02, inH / 0.02, `${hk} hand, ${A[t].s.pt}/${A[t].s.ph}`);
          if (inB > 0.02) flag('glove inside drawn torso', t, +inB.toFixed(3), 0.02, inB / 0.02, `${hk} hand, ${A[t].s.pt}/${A[t].s.ph}`);
          continue;
        }
        const H = headOf(d, t), B = bodyOf(d, t);
        const inH = H.r - dist3(g, H.c), inB = B.r - segDist(g, B.a, B.b);   // centre depth inside the surface
        // the glove CENTRE inside the sim's head sphere / body capsule (2 cm for the skin): half a glove sunk in
        if (inH > 0.02) flag('glove through head', t, +inH.toFixed(3), 0.02, inH / 0.02, `${hk} hand, ${A[t].s.pt}/${A[t].s.ph}`);
        if (inB > 0.02) flag('glove through body', t, +inB.toFixed(3), 0.02, inB / 0.02, `${hk} hand, ${A[t].s.pt}/${A[t].s.ph}`);
      }
    }
    // 5 wrong direction: straight at head height
    if (sc.zone === 'head' || sc.kind === 'chain') {
      for (const s0 of starts) {
        const S0 = A[s0].s;
        if (S0.pt !== 'jab' && S0.pt !== 'cross') continue;
        const y0 = handOf(A[s0], S0.hand)[1];
        let maxUp = -9, maxRise = -9, tUp = s0, tRise = s0;
        for (let t = s0; t < N && A[t].s.pt === S0.pt && (t === s0 || A[t].s.prog >= A[t - 1].s.prog) && A[t].s.ph !== 'recover'; t++) {
          if (A[t].s.ph !== 'extend') continue;
          const y = handOf(A[t], S0.hand)[1];
          const above = y - headOf(d, t).c[1], rise = y - y0;
          if (above > maxUp) { maxUp = above; tUp = t; }
          if (rise > maxRise) { maxRise = rise; tRise = t; }
        }
        if (maxUp > 0.15) flag('straight shoots upward (above target head)', tUp, +maxUp.toFixed(3), 0.15, maxUp / 0.15, `${S0.pt}/${S0.hand} press t${s0}`);
        if (maxRise > 0.20) flag('straight shoots upward (rise)', tRise, +maxRise.toFixed(3), 0.20, maxRise / 0.20, `${S0.pt}/${S0.hand} press t${s0}`);
        info.straightRise = Math.max(info.straightRise ?? -9, +maxRise.toFixed(3));
      }
    }
    // 1 frozen hand
    for (const hand of ['lead', 'rear']) {
      const used = A.map(r => r.s.pt !== null && r.s.hand === hand);
      if (!used.some(Boolean)) continue;
      let firstUse = used.indexOf(true), lastEnd = -1;
      for (let t = 0; t < N; t++) if (used[t]) lastEnd = t;
      let run0 = 0;
      for (let t = firstUse + 1; t < N; t++) {
        const R = A[t].s;
        if (R.down || R.hurt > 0) { run0 = 0; continue; }
        if (R.pt !== null && R.hand === hand && (R.ph === 'cock' || R.ph === 'extend')) { run0 = 0; continue; }
        const gd = guardDist(t, a, hand);
        const sp = dist3(handOf(A[t], hand), handOf(A[t - 1], hand)) * HZ;
        if (gd > 0.15 && sp < 0.2) {
          run0++;
          if (run0 > 6) flag('frozen hand', t, +gd.toFixed(3), 0.15, run0 / 6, `${hand} hand ${run0} ticks still, ${(gd * 100).toFixed(0)} cm from guard, clip ${A[t].p.clip}`);
        } else run0 = 0;
      }
      const chk = lastEnd + 30;
      if (chk < N && !A[chk].s.down && A[chk].s.hurt === 0) {
        const gd = guardDist(chk, a, hand);
        if (gd > 0.10) flag('hand not back at guard 30 ticks after punch', chk, +gd.toFixed(3), 0.10, gd / 0.10, `${hand} hand, punch ended t${lastEnd}, clip ${A[chk].p.clip}`);
        info['guardGap30_' + hand] = +(gd * 100).toFixed(1);
      }
    }
  }

  // 9 what Nate saw (2026-11-17): guard hands over the head or in his own head, a knee on the floor, the hips sunk, big IK shoves
  for (const s of bothSides) {
    const run = { left: 0, right: 0 };
    for (let t = 0; t < N; t++) {
      const R = rows[t][s];
      if (R.s.down) { run.left = 0; run.right = 0; continue; }
      const H = R.p.dr ? R.p.dr.head : [R.p.head[0], R.p.head[1] + 0.09, R.p.head[2]], hr = R.p.dr ? R.p.dr.headR : 0.11;
      const punching = R.s.pt !== null ? (R.s.hand === 'lead' ? R.p.gl.lead : R.p.gl.rear) : null;
      for (const hk of ['left', 'right']) {
        const g = R.p.gl[hk];
        const mine = punching && g[0] === punching[0] && g[1] === punching[1] && g[2] === punching[2];
        const over = g[1] - (H[1] + hr), inside = hr + R.s.body.gr - dist3(g, H);
        if (!mine && (over > 0 || inside > 0.10)) {
          run[hk]++;
          if (run[hk] > 3) flag(over > 0 ? 'guard hand above top of head' : 'hand inside own head', t, +(over > 0 ? over : inside).toFixed(3), over > 0 ? 0 : 0.1, run[hk] / 3, `s${s} ${hk} ${R.p.lb ?? R.p.clip}`);
        } else run[hk] = 0;
      }
      if (R.p.knees) {
        const k = Math.min(R.p.knees[0][1], R.p.knees[1][1]) - floor[s];
        if (k < 0.12) flag('knee near the floor', t, +k.toFixed(3), 0.12, 0.12 / Math.max(k, 0.01), `s${s} ${R.p.lb ?? R.p.clip}`);
      }
      const hipsLow = R.p.hips[1] / rows[0][s].p.hips[1];
      if (hipsLow < 0.6 && !R.s.slip) flag('hips below 60% of standing', t, +hipsLow.toFixed(3), 0.6, 0.6 / Math.max(hipsLow, 0.05), `s${s} ${R.p.lb ?? R.p.clip}`);
      if ((R.p.ikMax ?? 0) > 0.15) flag('hand IK displacement over 15 cm', t, +R.p.ikMax.toFixed(3), 0.15, R.p.ikMax / 0.15, `s${s} ${R.p.lb ?? R.p.clip}`);
    }
  }

  // 8 return to idle
  if (sc.kind !== 'knockdown') {
    const chk = sc.lastInput + 45;
    if (chk < N) for (const s of bothSides) {
      const R = rows[chk][s];
      if (R.s.down || R.s.pt !== null) continue;   // (a sim punch still in flight: the clip is right to be playing)
      if (R.p.pc) flag('not idle 45 ticks after last input', chk, 1, 0, 1, `s${s} still in punch clip ${R.p.clip}`);
      for (const hand of ['lead', 'rear']) {
        const gd = dist3(local(handOf(R, hand), R.p.hips, R.s.yaw), guard[s][hand]);
        if (gd > 0.10) flag('hands not at guard 45 ticks after last input', chk, +gd.toFixed(3), 0.10, gd / 0.10, `s${s} ${hand}, clip ${R.p.clip}`);
      }
    }
    else info.noIdleSample = true;
  } else {
    info.downSeen = rows.some(r => r[d].s.down);
  }
  return { violations: Object.values(V).map(v => ({ ...v, severity: +(v.count * v.over).toFixed(2) })), info, ticks: N };
}

// ---------- main ----------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', m => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', e => logs.push({ type: 'pageerror', text: e.message }));
page.on('crash', () => console.error('PAGE CRASHED'));
await page.addInitScript(() => {
  window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };
});
async function boot() {
  await page.goto(`${DEV_URL}/?ai=0&menu=0&human=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await bootReady(page);
  await until(page, () => typeof window.__rigReplay === 'function' && typeof window.__humanProbe === 'function', undefined, { label: 'human views and __humanProbe', timeout: 150_000 });
  await page.evaluate(() => {
    const c = window.__cfg;
    c.debugHitboxes = false; c.refEnabled = false;
    c.camDriftAmp = 0; c.camFollowLambda = 1000; c.camDollyLambda = 1000;
    c.camDistMin = 2.4; c.camLookY = 1.25;
    window.__focus = -1;
  });
  // --raw: the pure clips (cfg.humanRawPose), the reference for "natural"
  if (ARGS.includes('--raw')) await page.evaluate(() => { window.__cfg.humanRawPose = true; });
  // the probe must answer after one replay
  await until(page, () => { window.__rigReplay(1.0, [], 1, []); return !!window.__humanProbe(0) && !!window.__humanProbe(1); }, undefined, { label: 'probe answers', timeout: 60_000 });
}
await boot();

const results = [];
const t0 = Date.now();
for (const sc of scenarios) {
  let res = null;
  for (let attempt = 0; attempt < 3 && !res; attempt++) {
    try { res = await runScenario(page, sc); } catch (e) {
      console.error(`  ${sc.name}: ${String(e.message).split('\n')[0]}${attempt < 2 ? '; rebooting' : ''}`);
      if (attempt < 2) await boot();
    }
  }
  if (!res) { results.push({ sc, error: true, violations: [], info: {} }); continue; }
  results.push({ sc, ...analyse(sc, res) });
}
console.log(`ran ${scenarios.length} scenarios in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ---------- report ----------
const rows = [];
for (const r of results) for (const v of r.violations) rows.push({ scenario: r.sc.name, ...v, sc: r.sc });
rows.sort((x, y) => y.severity - x.severity);
const byCheck = {};
for (const r of rows) { byCheck[r.check] = byCheck[r.check] ?? { scenarios: 0, ticks: 0 }; byCheck[r.check].scenarios++; byCheck[r.check].ticks += r.count; }
const nViolScen = new Set(rows.map(r => r.scenario)).size;
console.log('\nSEV    CHECK                                         SCENARIO                                  TICK  VALUE  THR   CNT  NOTE');
for (const r of rows.slice(0, 45)) {
  console.log(`${String(r.severity).padStart(6)} ${r.check.padEnd(45)} ${r.scenario.padEnd(40)} ${String(r.tick).padStart(4)} ${String(r.worst).padStart(6)} ${String(r.thr).padStart(5)} ${String(r.count).padStart(4)}  ${r.note}`);
}
console.log('\nper check (scenarios failing / failing ticks):');
for (const [k, v] of Object.entries(byCheck).sort((a, b) => b[1].ticks - a[1].ticks)) console.log(`  ${k.padEnd(48)} ${v.scenarios} / ${v.ticks}`);
console.log('\nlargest pop per scenario type (top 8):');
for (const r of [...results].filter(r => r.info.maxPop).sort((a, b) => b.info.maxPop.cm - a.info.maxPop.cm).slice(0, 8)) console.log(`  ${r.info.maxPop.cm} cm  ${r.sc.name}  ${r.info.maxPop.at}`);
console.log('largest drawn-vs-sim glove gap (top 5):');
for (const r of [...results].filter(r => r.info.maxPic).sort((a, b) => b.info.maxPic.cm - a.info.maxPic.cm).slice(0, 5)) console.log(`  ${r.info.maxPic.cm} cm  ${r.sc.name}  ${r.info.maxPic.at}`);
const kinds = {};
for (const r of results) for (const x of r.info.resolves ?? []) kinds[`${x.kind}/${x.part}`] = (kinds[`${x.kind}/${x.part}`] ?? 0) + 1;
console.log('punch resolve outcomes:', JSON.stringify(kinds));
const kd = results.filter(r => r.sc.kind === 'knockdown').map(r => `${r.sc.name}: down=${r.info.downSeen}`);
console.log(kd.join('\n'));
console.log(`\n${rows.length} violations in ${nViolScen} scenarios (${results.length} scenarios run, ${results.filter(r => r.error).length} errored)`);

writeFileSync(`${OUT}/${QUICK ? 'audit_quick' : 'audit'}.json`,JSON.stringify({ total: rows.length, scenariosWithViolations: nViolScen, scenarios: results.length, byCheck, violations: rows.map(({ sc, ...r }) => r), scenarioInfo: results.map(r => ({ name: r.sc.name, ticks: r.ticks, info: r.info })) }, null, 1));

// ---------- screenshots of the five worst (distinct scenarios) ----------
const picked = [], seen = new Set();
for (const pass of SHOTS ? [0, 1] : []) for (const r of rows) {
  if (picked.length === 5) break;
  if (picked.includes(r) || picked.some(p => p.scenario === r.scenario)) continue;
  if (pass === 0 && seen.has(r.check)) continue;   // first pass: five different checks
  seen.add(r.check); picked.push(r);
}
let i = 0;
for (const r of picked) {
  i++;
  const sc = r.sc;
  await page.evaluate(over => { for (const k in over) window.__cfg[k] = over[k]; }, sc.cfg ?? {});
  await page.evaluate(([d, s0, s1, t]) => window.__rigReplay(d, s0, t, s1), [sc.dist, sc.s0, sc.s1, r.tick]);
  await frames(page, 3);
  const f = `${OUT}/shot_${i}.png`;
  await page.screenshot({ path: f });
  console.log(`shot ${i}: ${f}  <- ${r.scenario} | ${r.check} | tick ${r.tick} | value ${r.worst}`);
}
await browser.close();
const benign = t => /GPU stall due to ReadPixels/.test(t);
const bad = logs.filter(m => (m.type === 'error' || m.type === 'pageerror' || m.type === 'warning') && !benign(m.text));
console.log(`console errors/warnings: ${bad.length}`);
bad.slice(0, 10).forEach(m => console.log(`  [${m.type}] ${m.text.slice(0, 200)}`));
