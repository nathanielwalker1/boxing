/**
 * hit_chain_test.mjs — hitChainV2 (anim Phase 1.5, docs/anim/LOG_HITCHAIN.md): a landed punch travels down the
 * skeleton as joint angles. Sim only. Every case is measured against a CONTROL run (same start, no punch), so idle
 * motion is subtracted. Prints the decomposition table (root / spine / neck share of the head's travel) for both
 * hitChainV2 on and off.
 *   - head group peaks before the spine, the spine before the pelvis
 *   - clean cross: head travel from joint bend 15–25 cm, root share ≤ 1/3
 *   - lead hook: head yaw ≥ 15°, a cross < 8°
 *   - body cross: the spine flexes forward, the neck does not extend
 *   - every joint inside its limits on every tick of every case
 *   - settled within 24 ticks of the hit, at most one overshoot over 10 % of the peak
 *   - toggle off: the chain slots are never written, the legacy springs move the head (the old reaction)
 */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SKJ, JOINT_COUNT, skelDef, skelLimits, fk, poseQ, jointAngles, withinLimits, skelHeadCentre, qRot } = core;
const base = { ...createConfig(), ratingsOn: false, stylesOn: false, jabHealthFloor: 0 };
const ON = { ...base, hitChainV2: true }, OFF = { ...base, hitChainV2: false };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const DEG = Math.PI / 180, cm = v => (v * 100).toFixed(1), dg = v => (v / DEG).toFixed(1);
const DIST = 0.8, TICKS = 90, PRESS = 2;

const CASES = [
  { name: 'jab head', punch: 'jab', x: 0 },
  { name: 'cross head', punch: 'cross', x: 0 },
  { name: 'lead hook head', punch: 'hook', x: -1 },
  { name: 'rear upper head', punch: 'uppercut', x: 1, dist: 0.65 },   // (out of the uppercut's reach at 0.8 m)
  { name: 'cross body', punch: 'cross', x: 0, level: true, press: 25 },   // (the level takes ~20 ticks to reach levelAt)
  { name: 'lead hook body', punch: 'hook', x: -1, level: true, press: 25 },
];

function fresh(c, dist = DIST) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], c).state;
  return s;
}
const relAng = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)));
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = v => Math.hypot(v.x, v.y, v.z);
const headYaw = r => { const f = qRot(r, { x: 1, y: 0, z: 0 }); return Math.atan2(f.z, f.x); };
const SPINE = [SKJ.spine1, SKJ.spine2, SKJ.chest];

/** Per tick: the defender's pose vs the control run's. */
function run(c, cs, punch = true) {
  let s = fresh(c, cs.dist);
  const rows = [], events = [];
  const PRESS_AT = cs.press ?? PRESS;
  let land = null, limitsOk = true, worstJoint = '';
  const d0 = s.fighters[1], def = skelDef(d0.body, d0.stance, c), lim = skelLimits(c);
  for (let i = 0; i < TICKS; i++) {
    const a = inp({ level: !!cs.level, ...(punch && i === PRESS_AT ? { [cs.punch]: true, move: { x: cs.x, y: 0 } } : {}) });
    const r = sim.step(s, [a, inp()], c); s = r.state;
    for (const e of r.events) { events.push({ ...e, tick: i }); if (!land && e.type === 'punchLand' && e.side === 0) land = { ...e, tick: i }; }
    const d = s.fighters[1];
    if (!d.skel) continue;
    const k = fk(def, d.skel);
    for (let j = 0; j < JOINT_COUNT; j++) if (!withinLimits(poseQ(d.skel, j), lim[j] ?? null, def.side[j], 1e-5)) { limitsOk = false; worstJoint = `${j}@${i}`; }
    rows.push({
      pel: { ...k.p[SKJ.pelvis] }, neck: { ...k.p[SKJ.neck] }, head: skelHeadCentre(def, k), yaw: headYaw(k.r[SKJ.head]),
      q: Array.from({ length: JOINT_COUNT }, (_, j) => poseQ(d.skel, j)),
      ext: { neck: jointAngles(poseQ(d.skel, SKJ.neck), lim[SKJ.neck], 0)[2] + jointAngles(poseQ(d.skel, SKJ.head), lim[SKJ.head], 0)[2],
        spine: SPINE.reduce((t, j) => t + jointAngles(poseQ(d.skel, j), lim[j], 0)[2], 0) },
      hist: d.moveHist.slice(50, 68), frozen: s.hitStop > 0,
    });
  }
  return { rows, events, land, limitsOk, worstJoint, state: s };
}

function measure(c, cs) {
  const hit = run(c, cs), ctl = run(c, cs, false);
  const L = hit.land ? hit.land.tick : -1;
  const per = hit.rows.map((h, i) => {
    const o = ctl.rows[i];
    const dHead = sub(h.head, o.head), dPel = sub(h.pel, o.pel), dNeck = sub(h.neck, o.neck);
    return {
      head: len(dHead), root: len(dPel), spine: len(sub(dNeck, dPel)), neckD: len(sub(dHead, dNeck)), joint: len(sub(dHead, dPel)),
      aHead: relAng(h.q[SKJ.neck], o.q[SKJ.neck]) + relAng(h.q[SKJ.head], o.q[SKJ.head]),
      aSpine: SPINE.reduce((t, j) => t + relAng(h.q[j], o.q[j]), 0),
      aPel: relAng(h.q[SKJ.pelvis], o.q[SKJ.pelvis]),
      yaw: Math.abs(Math.atan2(Math.sin(h.yaw - o.yaw), Math.cos(h.yaw - o.yaw))), frozen: h.frozen, extNeck: h.ext.neck - o.ext.neck, extSpine: h.ext.spine - o.ext.spine,
    };
  });
  // Ticks after the land that the sim actually advanced (hit-stop frozen ticks left out), so "tick 1" = the first moving tick.
  const after = L < 0 ? [] : per.slice(L + 1).filter(r => !r.frozen).slice(0, 40);
  const W = 20;   // peaks are searched in the first 20 live ticks (later the knockback's drift dominates the head's world travel)
  const argmax = key => after.slice(0, W).reduce((b, r, i) => (r[key] > after[b][key] ? i : b), 0) + 1;
  const pk = after.length ? after[argmax('joint') - 1] : null;
  return { cs, hit, L, per, after, pk, tHead: argmax('aHead'), tSpine: argmax('aSpine'), tPel: argmax('aPel'), tPeak: argmax('joint'),
    maxYaw: Math.max(0, ...after.map(r => r.yaw)), minSpineExt: Math.min(0, ...after.map(r => r.extSpine)), maxNeckExt: Math.max(0, ...after.map(r => r.extNeck)) };
}

function table(label, ms) {
  console.log(`\n  ${label} — head displacement at its peak, split (cm), joint angle change (deg), tick of each peak after the land`);
  console.log('  case              land   head  root  joints  spine  neck | spine°  neck°  pelvis° | peak t: joints head spine pelvis | yaw°');
  for (const m of ms) {
    if (!m.pk) { console.log(`  ${m.cs.name.padEnd(17)} (no land: ${m.hit.events.find(e => e.side === 0 && /punch/.test(e.type))?.type ?? 'none'})`); continue; }
    const p = m.pk, at = m.after[m.tPeak - 1];
    console.log(`  ${m.cs.name.padEnd(17)} ${String(m.hit.land.part).padEnd(5)} ${cm(p.head).padStart(5)} ${cm(p.root).padStart(5)} ${cm(p.joint).padStart(7)} ${cm(p.spine).padStart(6)} ${cm(p.neckD).padStart(5)} | ${dg(at.aSpine).padStart(6)} ${dg(at.aHead).padStart(6)} ${dg(at.aPel).padStart(7)} | ${String(m.tPeak).padStart(6)} ${String(m.tHead).padStart(4)} ${String(m.tSpine).padStart(5)} ${String(m.tPel).padStart(6)} | ${dg(m.maxYaw)} | imp ${Math.hypot(m.hit.land.impulse.x, m.hit.land.impulse.y, m.hit.land.impulse.z).toFixed(1)} ${m.hit.land.grade}`);
  }
}

const offM = CASES.map(cs => measure(OFF, cs));
const onM = CASES.map(cs => measure(ON, cs));
table('hitChainV2 OFF (legacy springs)', offM);
table('hitChainV2 ON', onM);

const by = (ms, n) => ms.find(m => m.cs.name === n);
// ── Landing ──
check('every case lands with the chain on, on the part it was thrown at', onM.every(m => m.L >= 0 && m.hit.land.part === (m.cs.level ? 'body' : 'head')), onM.map(m => `${m.cs.name}:${m.hit.land?.part ?? 'none'}`).join(' '));
// ── Order ──
for (const m of onM) if (m.L >= 0) check(`${m.cs.name}: the head group peaks first (t${m.tHead}), the spine after (t${m.tSpine}), the pelvis last (t${m.tPel})`, m.tHead < m.tSpine && m.tSpine < m.tPel && m.tHead <= 3);
// ── Size ──
{
  const m = by(onM, 'cross head'), p = m.pk;
  check(`clean cross: head travel from joint bend 15–25 cm (${cm(p.joint)}), root share ≤ 1/3 (${cm(p.root)} of ${cm(p.head)} cm)`, p.joint >= 0.15 && p.joint <= 0.25 && p.root <= p.head / 3);
  check(`lead hook turns the head ≥ 15° (${dg(by(onM, 'lead hook head').maxYaw)}°); the cross < 8° (${dg(m.maxYaw)}°)`, by(onM, 'lead hook head').maxYaw >= 15 * DEG && m.maxYaw < 8 * DEG);
  const b = by(onM, 'cross body');
  check(`body cross: the spine flexes forward (${dg(b.minSpineExt)}°) and the neck does not extend (${dg(b.maxNeckExt)}°)`, b.minSpineExt < -5 * DEG && b.maxNeckExt < 2 * DEG);
}
{
  const j = by(onM, 'cross head'), jb = by(onM, 'jab head'), u = by(onM, 'rear upper head');
  check(`clean jab: head travel ${cm(jb.pk.head)} cm in total (about 8–12), under half a clean cross's ${cm(j.pk.head)} cm`, jb.pk.head < j.pk.head / 2 && jb.pk.head >= 0.06 && jb.pk.head <= 0.13);
  check(`uppercut (${u.hit.land.grade}) joint travel between the jab's and the cross's by impulse: ${cm(jb.pk.joint)} < ${cm(u.pk.joint)} < ${cm(j.pk.joint)} cm`, jb.pk.joint < u.pk.joint && u.pk.joint < j.pk.joint);
}
// ── Counter (counterFeelV2 on the skeleton): the same cross as a slip counter throws the head further than a plain one ──
{
  const MID = 0.79;
  const freshM = () => { let s = sim.createState(specs, ON, 1); s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 }; for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], ON).state; return s; };
  let L = 0;
  { let s = freshM(); for (let i = 0; i < 40 && !L; i++) { const r = sim.step(s, [inp({ jab: i === 0 }), inp()], ON); s = r.state; if (r.events.some(e => e.type === 'punchLand')) L = i; } }
  const ctrl = []; { let s = freshM(); for (let i = 0; i < 40; i++) { s = sim.step(s, [inp({ jab: i === 0 }), inp()], ON).state; ctrl.push({ ...s.fighters[1].pos }); } }
  const sc = counter => {
    let s = freshM(); const d0 = s.fighters[0], def = skelDef(d0.body, d0.stance, ON);
    let peak = 0, land = null; const start = L - 8, release = start + 3, at = L + 3;
    for (let i = 0; i < 90; i++) {
      const r = sim.step(s, [counter ? inp({ jab: i === 0 }) : inp(), inp({ cross: i === at, move: { x: counter && i >= start && i < release ? -1 : 0, y: 0 } })], ON); s = r.state;
      if (counter && i >= start && i <= release + 1) { s.fighters[1].pos = { ...ctrl[i] }; s.fighters[1].vel = { x: 0, z: 0 }; }
      const e = r.events.find(e => e.type === 'punchLand' && e.side === 1); if (e) land = e;
      const k = fk(def, s.fighters[0].skel), h = skelHeadCentre(def, k), p = k.p[SKJ.pelvis];
      if (land) peak = Math.max(peak, Math.hypot(h.x - p.x, h.z - p.z));   // head off the pelvis, horizontal (the joints' share)
      else peak = 0;
    }
    return { peak, land };
  };
  const rest = (() => { const s = freshM(), d = s.fighters[0], def = skelDef(d.body, d.stance, ON), k = fk(def, d.skel), h = skelHeadCentre(def, k), p = k.p[SKJ.pelvis]; return Math.hypot(h.x - p.x, h.z - p.z); })();
  const c = sc(true), p = sc(false);
  check(`counter (skeleton, chain on): a counter cross moves the head off the hips further than a plain one — ${cm(c.peak - rest)} vs ${cm(p.peak - rest)} cm (counter ${c.land?.counter}, plain ${p.land?.counter})`, c.land?.counter === true && p.land?.counter === false && c.peak - rest > (p.peak - rest) * 1.15);
}
// ── Limits ──
check('every joint within its limits on every tick of every case (on and off)', [...onM, ...offM].every(m => m.hit.limitsOk), [...onM, ...offM].filter(m => !m.hit.limitsOk).map(m => `${m.cs.name} ${m.hit.worstJoint}`).join(' '));
// ── Return ──
for (const m of onM) {
  if (m.L < 0) continue;
  const a = m.after.map(r => r.aHead + r.aSpine + r.aPel), peak = Math.max(...a);
  const settled = a.slice(24).every(v => v < 0.1 * peak);
  // Overshoot: the primary signed channel (ext for straights / uppercuts, spine ext for body shots, chain yaw slot for hooks) crossing past zero by > 10 % of its peak.
  const sig = m.cs.level ? m.hit.rows.slice(m.L).map(r => r.hist[1 * 6 + 4] ?? 0) : m.cs.punch === 'hook' ? m.hit.rows.slice(m.L).map(r => r.hist[2] ?? 0) : m.hit.rows.slice(m.L).map(r => r.hist[4] ?? 0);
  const pk = sig.reduce((b, v) => (Math.abs(v) > Math.abs(b) ? v : b), 0);
  let lobes = 0, inLobe = false;
  for (const v of sig) { const over = Math.sign(v) === -Math.sign(pk) && Math.abs(v) > 0.1 * Math.abs(pk); if (over && !inLobe) lobes++; inLobe = over; }
  check(`${m.cs.name}: settled by 24 ticks (${(a[24] / peak * 100).toFixed(0)}% of peak at t24), overshoots over 10%: ${lobes}`, settled && lobes <= 1);
}
// ── The chain is presentation: an idle man vs the Hard AI is hurt the same with it on and off (the body-fold regression:
// folded about the hips his head came ~20 cm forward into range, a whiff became a land and the fight ended in a knockdown at 4 s) ──
{
  const { kit } = await import('./bots/kit.mjs');
  const kk = await kit({ rated: true });
  const RR = kk.core.ROSTER;
  const named = n => RR.find(f => new RegExp(n, 'i').test(f.id));
  const pairs = [[named('blue') ?? RR[0], named('boiler') ?? RR[1]], [RR[0], RR[1]], [RR[2], RR[3]]];
  const fight = (a, b, seed, over) => {
    const c = { ...kk.cfg, ...over, aiDifficulty: 2 };
    let s = kk.sim.createState([a, b], c, seed);
    let ai = kk.ai.createAi(1, seed, c, kk.ai.styleFor(b, c));
    let kd = 0;
    for (let i = 0; i < 12 * 60; i++) {
      const d = kk.ai.aiStep(ai, s, c); ai = d.ai;
      const r = kk.sim.step(s, [{ move: { x: 0, y: 0 } }, d.input], c); s = r.state;
      for (const e of r.events) if (e.type === 'knockdown' && e.side === 0) kd++;
      if (s.round.phase === 'over') break;
    }
    return { kd, health: s.fighters[0].health };
  };
  const bad = [];
  for (const [a, b] of pairs) for (let seed = 1; seed <= 4; seed++) {
    const on = fight(a, b, seed, { hitChainV2: true }), off = fight(a, b, seed, { hitChainV2: false });
    if (on.kd !== off.kd || Math.abs(on.health - off.health) > 0.08) bad.push(`${a.id}/${b.id} s${seed}: kd ${on.kd}/${off.kd} health ${on.health.toFixed(2)}/${off.health.toFixed(2)}`);
  }
  check('idle man vs Hard AI, 12 s, 3 pairs × 4 seeds: knockdowns equal and health within 0.08, chain on vs off', bad.length === 0, bad.join('; ') || 'all 12 match');
}
// ── Toggle off ──
check('toggle off: no chain slot is ever written, and the legacy head spring still moves the head', offM.every(m => m.hit.rows.every(r => r.hist.every(v => v === undefined))) && offM.some(m => Math.abs(m.hit.state.fighters[1].reaction.head.x) + Math.abs(m.hit.state.fighters[1].reaction.head.vx) >= 0) && by(offM, 'cross head').pk.head > 0.2);
check('toggle on with skelOn off: identical to toggle off (the chain is a skeleton layer)', (() => {
  const a = run({ ...ON, skelOn: false }, CASES[1]), b = run({ ...OFF, skelOn: false }, CASES[1]);
  return JSON.stringify(a.events) === JSON.stringify(b.events) && JSON.stringify(a.state) === JSON.stringify(b.state);
})());
done();
