/**
 * human_audit.mjs — measures the drawn human boxers against the deterministic sim, tick by tick, across a matrix of
 * scripted scenarios, and prints a violations table. One browser session. Fixes nothing.
 *   PORT=5195 node scripts/human_audit.mjs [filter-substring]
 * Output: stdout table, scripts/output/human_audit/audit.json, shot_N.png for the five worst.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DEV_URL } from './devUrl.js';
import { bootReady, frames, until } from './waits.js';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), 'output', 'human_audit');
mkdirSync(OUT, { recursive: true });
const FILTER = process.argv[2] ?? '';
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
for (const actor of [0, 1]) {
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
        row.push({
          p: { head: p.head, hips: p.hips, gl: p.gloves, feet: p.feet, clip: p.clip, pc: p.punchClip, fr: p.frame },
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
    return { out, cfg: { sep: w.__cfg.separationDist, scale: w.__cfg.mocapGeo ? w.__cfg.mocapCloseScale : 1 } };
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
    const A = rows[t - 1][s].p, B = rows[t][s].p;
    const items = { head: [A.head, B.head], hips: [A.hips, B.hips], handL: [A.gl.left, B.gl.left], handR: [A.gl.right, B.gl.right], footL: [A.feet.left, B.feet.left], footR: [A.feet.right, B.feet.right] };
    for (const [k, [p, q]] of Object.entries(items)) {
      const m = dist3(p, q);
      if (m > maxPop) { maxPop = m; maxPopWhat = `s${s} ${k} t${t}`; }
      if (m > 0.12) flag('pop', t, +m.toFixed(3), 0.12, m / 0.12, `s${s} ${k} (${A.clip}->${B.clip})`);
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
  const bodyOf = (s, t, off) => {
    const R = rows[t][s], b = R.s.body;
    const base = [R.p.hips[0], R.p.hips[1] + hpy[s], R.p.hips[2]];
    return { a: base, b: [base[0], base[1] + (b.sy - b.hy), base[2]], r: b.br };
  };
  const headOf = (s, t) => { const R = rows[t][s]; return { c: [R.p.head[0], R.p.head[1] + hy[s], R.p.head[2]], r: R.s.body.hr }; };
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
      if (dd > 0.05) flag('drawn glove vs sim glove', t, +dd.toFixed(3), 0.05, dd / 0.05, `phase ${S.ph} p=${S.prog.toFixed(2)} ${A[t].p.clip}`);
    }
    info.maxPic = { cm: +(maxPic * 100).toFixed(1), at: picWhere };

    // 4 contact truth, per punch resolve
    info.resolves = [];
    for (let t = 1; t < N; t++) {
      const P = A[t - 1].s, C = A[t].s;
      if (C.pt !== null && C.res && !P.res) {
        const hpD = rows[t][d].s.hp - rows[t - 1][d].s.hp;
        const hpD2 = t + 1 < N ? rows[t + 1][d].s.hp - rows[t - 1][d].s.hp : hpD;
        const kind = (hpD < -1e-6 || hpD2 < -1e-6) ? 'land' : rows[t][d].s.blk ? 'block' : C.con ? 'contact-nodmg' : 'whiff';
        const g = handOf(A[t], C.hand);
        const gp = gap(g, d, t);
        const part = gp.hg <= gp.bg ? 'head' : 'body';
        const m = Math.min(gp.hg, gp.bg);
        info.resolves.push({ t, punch: C.pt, hand: C.hand, kind, part, gloveGapCm: +(m * 100).toFixed(1), simGap: +(dist3(g, C.g[GL[C.hand]]) * 100).toFixed(1) });
        if (kind === 'land' && m > 0.08) flag('landed but glove away from target', t, +m.toFixed(3), 0.08, m / 0.08, `${C.pt}/${C.hand} nearest ${part} d${sc.dist}`);
      }
    }
    // through the head/body, any tick within punch windows + 15 ticks
    for (let t = 0; t < N; t++) {
      const inWin = starts.some(s0 => t >= s0 && t <= s0 + 70);
      if (!inWin) continue;
      for (const hk of ['left', 'right']) {
        const g = A[t].p.gl[hk];
        const H = headOf(d, t), B = bodyOf(d, t);
        const inH = H.r - dist3(g, H.c), inB = B.r - segDist(g, B.a, B.b);   // centre depth inside the surface
        if (inH > 0.05) flag('glove through head', t, +inH.toFixed(3), 0.05, inH / 0.05, `${hk} hand, ${A[t].s.pt}/${A[t].s.ph}`);
        if (inB > 0.05) flag('glove through body', t, +inB.toFixed(3), 0.05, inB / 0.05, `${hk} hand, ${A[t].s.pt}/${A[t].s.ph}`);
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

  // 8 return to idle
  if (sc.kind !== 'knockdown') {
    const chk = sc.lastInput + 45;
    if (chk < N) for (const s of bothSides) {
      const R = rows[chk][s];
      if (R.s.down) continue;
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

writeFileSync(`${OUT}/audit.json`, JSON.stringify({ total: rows.length, scenariosWithViolations: nViolScen, scenarios: results.length, byCheck, violations: rows.map(({ sc, ...r }) => r), scenarioInfo: results.map(r => ({ name: r.sc.name, ticks: r.ticks, info: r.info })) }, null, 1));

// ---------- screenshots of the five worst (distinct scenarios) ----------
const picked = [], seen = new Set();
for (const pass of [0, 1]) for (const r of rows) {
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
