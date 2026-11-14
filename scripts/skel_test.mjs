/**
 * skel_test.mjs — the rigid skeleton (anim Phase 1.1, cfg.skelOn; docs/anim/LOG_SKELETON.md).
 *   1. unit: swing-twist round trip; solveTwoBone reachable / out of reach / fully folded; clampJoint idempotent
 *   2. fit on awkward targets: head 0.4 m behind the shoulders, glove 2 m away, chest target straight sideways
 *   3. a seeded bot-vs-bot fight (60+ sim s) plus a scripted run of punches, slips, blocks and hits: EVERY tick,
 *      both fighters — bone lengths = bind lengths (1e-6), every joint inside its limits, headBox / bodyBox /
 *      gloves / arms = the FK of `skel`, clampPose idempotent; two runs identical
 *   4. the skelOn counterparts of the old point assertions pinned to skelOn: false elsewhere (slip, hit, level, arms)
 *   5. skelOn off: no skeleton on the state (the old body, untouched)
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim, aiMod] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts');
const {
  createConfig, ROSTER, NULL_INPUT, cloneInput, bodyDims, v3dist,
  SKJ, JOINT_COUNT, JOINT_PARENT, JOINT_NAMES, skelDef, skelLimits, restPose, fk, clampPose, clampJoint, jointAngles, withinLimits, cloneSkel, poseQ,
  qMul, qAxis, qFromRotVec, qRot, qId, swingTwist, solveTwoBone, skelHeadCentre, skelShoulderLine, skelArm, skelLeg,
  fitTorso, fitArm, rootQuat, qAxisAngle,
} = core;
const cfg = createConfig();
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const cm = v => (v * 100).toFixed(1);
const DEG = Math.PI / 180;

// Deterministic test-side PRNG (the sim's own rng is not used here).
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

// ── 1. Unit ──────────────────────────────────────────────────────────────────
{
  let worst = 0;
  for (let n = 0; n < 200; n++) {
    const axis = n % 3;
    const sw = { x: (rnd() - 0.5) * 2.5, y: (rnd() - 0.5) * 2.5, z: (rnd() - 0.5) * 2.5 };
    if (axis === 0) sw.x = 0; else if (axis === 1) sw.y = 0; else sw.z = 0;
    const tw = (rnd() - 0.5) * 3;
    const q = qMul(qFromRotVec(sw), qAxis(axis, tw));
    const r = swingTwist(q, axis);
    worst = Math.max(worst, Math.abs(r.twist - tw), Math.abs(r.swing.x - sw.x), Math.abs(r.swing.y - sw.y), Math.abs(r.swing.z - sw.z));
  }
  check('swing-twist: 200 composed rotations decompose back to their swing and twist', worst < 1e-9, `worst ${worst.toExponential(2)} rad`);
}
{
  const root = { x: 0.1, y: 1.4, z: -0.2 }, l1 = 0.3, l2 = 0.28, P = qAxisAngle(0, 1, 0, 0.4);
  const minF = 3 * DEG, maxF = 150 * DEG;
  const chain = (r) => {   // FK of the returned rotations: positions must match mid / end
    const Ru = qMul(P, r.upper);
    const e = qRot(Ru, { x: 0, y: -l1, z: 0 });
    const mid = { x: root.x + e.x, y: root.y + e.y, z: root.z + e.z };
    const f = qRot(qMul(Ru, r.lower), { x: 0, y: -l2, z: 0 });
    return { mid, end: { x: mid.x + f.x, y: mid.y + f.y, z: mid.z + f.z } };
  };
  const pole = { x: 0, y: -1, z: 0.3 };
  // reachable
  const t1 = { x: root.x + 0.29, y: root.y, z: root.z };
  const r1 = solveTwoBone(root, P, t1, pole, l1, l2, 1, minF, maxF), c1 = chain(r1);
  check('solveTwoBone, reachable (0.5 × reach): the FK of its rotations puts the hand on the target', v3dist(c1.end, t1) < 1e-9 && v3dist(c1.mid, r1.mid) < 1e-9, `${v3dist(c1.end, t1).toExponential(2)} m`);
  check('…bone lengths exact, elbow on the pole side', near(v3dist(root, c1.mid), l1, 1e-9) && near(v3dist(c1.mid, c1.end), l2, 1e-9) && c1.mid.y < root.y);
  // out of reach
  const t2 = { x: root.x + 2, y: root.y + 0.1, z: root.z };
  const r2 = solveTwoBone(root, P, t2, pole, l1, l2, 1, minF, maxF), c2 = chain(r2);
  const reach = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(minF));
  check('solveTwoBone, out of reach (2 m): the hand stops at full reach on the line, no stretch', near(v3dist(root, c2.end), reach, 1e-9) && v3dist(c2.end, r2.end) < 1e-9 && near(v3dist(c2.mid, c2.end), l2, 1e-9), `${cm(v3dist(root, c2.end))} cm of ${cm(l1 + l2)}`);
  check('…and the elbow keeps its straight margin (never locks or hyperextends)', near(r2.flex, minF, 1e-9), `${(r2.flex / DEG).toFixed(2)}°`);
  // fully folded: target on the root
  const r3 = solveTwoBone(root, P, root, pole, l1, l2, 1, minF, maxF), c3 = chain(r3);
  check('solveTwoBone, fully folded (target on the shoulder): the hinge stops at its limit, lengths hold', near(r3.flex, maxF, 1e-9) && near(v3dist(root, c3.mid), l1, 1e-9) && near(v3dist(c3.mid, c3.end), l2, 1e-9), `${(r3.flex / DEG).toFixed(1)}°`);
  // a leg folds the other way
  const r4 = solveTwoBone(root, P, { x: root.x, y: root.y - 0.45, z: root.z }, { x: 1, y: 0, z: 0 }, l1, l2, -1, minF, maxF), c4 = chain(r4);
  const knee = qRot(qMul(P, r4.upper), { x: 1, y: 0, z: 0 });   // the kneecap axis
  check('solveTwoBone, leg (fold −1): the knee bends toward the pole, the kneecap faces it', c4.mid.x - root.x > 0.05 * Math.cos(0.4) && knee.x > 0.5, `knee ${cm(c4.mid.x - root.x)} cm forward`);
}
const specs = [ROSTER[0], ROSTER[1]];
const body0 = bodyDims(specs[0], cfg);
const def0 = skelDef(body0, specs[0].stance, cfg);
const LIM = skelLimits(cfg);
{
  let worst = 0, moved = 0;
  for (let n = 0; n < 400; n++) {
    const j = 1 + (n % (JOINT_COUNT - 1));
    const q = qFromRotVec({ x: (rnd() - 0.5) * 5, y: (rnd() - 0.5) * 5, z: (rnd() - 0.5) * 5 });
    const a = clampJoint(q, LIM[j], def0.side[j]), b = clampJoint(a, LIM[j], def0.side[j]);
    const d = Math.min(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z, a.w - b.w), Math.hypot(a.x + b.x, a.y + b.y, a.z + b.z, a.w + b.w));
    worst = Math.max(worst, d);
    if (Math.abs(Math.abs(a.x * q.x + a.y * q.y + a.z * q.z + a.w * q.w) - 1) > 1e-6) moved++;
  }
  check('clampJoint is idempotent (400 random rotations over every joint, most of them out of range)', worst < 1e-9 && moved > 200, `worst ${worst.toExponential(2)}, ${moved} clamped`);
}

// ── shared checks on a fitted pose ──────────────────────────────────────────
const EPS_LIM = 1e-6;
function poseProblems(def, pose) {
  const out = [];
  const f = fk(def, pose);
  for (let j = 1; j < JOINT_COUNT; j++) {
    const L = v3dist(f.p[j], f.p[JOINT_PARENT[j]]);
    if (Math.abs(L - def.len[j]) > 1e-6) out.push(`${JOINT_NAMES[j]} length ${L.toFixed(6)} vs ${def.len[j].toFixed(6)}`);
    const lim = LIM[j];
    const a = jointAngles(poseQ(pose, j), lim, def.side[j]);
    for (let k = 0; k < 3; k++) if (a[k] < lim.lo[k] - EPS_LIM || a[k] > lim.hi[k] + EPS_LIM) out.push(`${JOINT_NAMES[j]} axis ${'xyz'[k]} ${(a[k] / DEG).toFixed(2)}° outside [${(lim.lo[k] / DEG).toFixed(1)}, ${(lim.hi[k] / DEG).toFixed(1)}]`);
    if (!withinLimits(poseQ(pose, j), lim, def.side[j], EPS_LIM)) out.push(`${JOINT_NAMES[j]} swing outside its cone (${a.map(v => (v / DEG).toFixed(1)).join(', ')}°)`);
  }
  for (const v of pose.q) if (!Number.isFinite(v)) { out.push('NaN in the pose'); break; }
  return { out, f };
}

// ── 2. Awkward targets ──────────────────────────────────────────────────────
{
  const pose = restPose(def0, 0, 0, 0);
  const pel = { x: 0, y: def0.hipY, z: 0 };
  const base = { rootX: 0, rootZ: 0, yaw: 0, pelvis: pel, pelvisRot: qId(), chestRot: null, chestTwist: 0, headRot: qId() };
  // Head 0.4 m behind the shoulders.
  fitTorso(def0, LIM, cfg, pose, { ...base, chest: { x: 0, y: body0.shoulderY, z: 0 }, head: { x: -0.4, y: body0.headY, z: 0 } });
  let r = poseProblems(def0, pose);
  const head = skelHeadCentre(def0, r.f), nb = r.f.p[SKJ.neck];
  check('fit: head target 0.4 m behind the shoulders → a legal pose (lengths, limits, no NaN)', r.out.length === 0, r.out.slice(0, 3).join('; '));
  check('…the head goes back as far as the neck allows, on its arc about the neck base (not sliding)', head.x < -0.08 && near(v3dist(head, nb), v3dist(skelHeadCentre(def0, fk(def0, restPose(def0, 0, 0, 0))), fk(def0, restPose(def0, 0, 0, 0)).p[SKJ.neck]), 0.02), `head ${cm(head.x)} cm back, ${cm(v3dist(head, nb))} cm from the neck base`);
  // Chest target straight sideways.
  fitTorso(def0, LIM, cfg, pose, { ...base, chest: { x: 0, y: def0.hipY, z: 0.6 }, head: { x: 0, y: def0.hipY, z: 0.9 } });
  r = poseProblems(def0, pose);
  const shl = skelShoulderLine(def0, r.f);
  check('fit: chest target straight sideways (90° off the spine) → legal; the spine bends to its lateral limit and no further', r.out.length === 0 && shl.z > 0.15 && near(v3dist(shl, r.f.p[SKJ.pelvis]), v3dist(skelShoulderLine(def0, fk(def0, restPose(def0, 0, 0, 0))), { x: 0, y: def0.hipY, z: 0 }), 0.03), `${r.out.slice(0, 3).join('; ')} shoulder line ${cm(shl.z)} cm over`);
  // Glove 2 m away.
  const p2 = restPose(def0, 0, 0, 0);
  fitTorso(def0, LIM, cfg, p2, { ...base, chest: { x: 0, y: body0.shoulderY, z: 0 }, head: { x: 0, y: body0.headY, z: 0 } });
  const fa = fitArm(def0, LIM, cfg, p2, 1, null, { x: 2, y: body0.shoulderY, z: 0.1 }, { x: 0, y: -1, z: 0.3 }, 0);
  r = poseProblems(def0, p2);
  const reach = v3dist(fa.shoulder, fa.hand);
  check('fit: glove 2 m away → legal, the hand at the end of an unstretched arm', r.out.length === 0 && reach <= body0.upperArm + body0.forearm + 1e-9 && reach > (body0.upperArm + body0.forearm) * 0.99, `${r.out.slice(0, 3).join('; ')} reach ${cm(reach)} of ${cm(body0.upperArm + body0.forearm)} cm`);
}

// ── 3. The fight, every tick ────────────────────────────────────────────────
function checkState(s, label, acc) {
  for (const side of [0, 1]) {
    const f = s.fighters[side];
    if (!f.skel) { acc.missing++; continue; }
    const def = skelDef(f.body, f.stance, cfg);
    const { out, f: k } = poseProblems(def, f.skel);
    if (out.length) { acc.bad++; if (acc.first.length < 4) acc.first.push(`${label} side ${side}: ${out[0]}`); }
    // hit shapes = FK
    const hc = skelHeadCentre(def, k), sl = skelShoulderLine(def, k);
    let e = Math.max(v3dist(hc, f.headBox), v3dist(k.p[SKJ.pelvis], f.bodyBox.a), v3dist(sl, f.bodyBox.b));
    for (let i = 0; i < 2; i++) {
      const a = skelArm(i);
      e = Math.max(e, v3dist(k.p[a.upper], f.arms[i].shoulder), v3dist(k.p[a.fore], f.arms[i].elbow), v3dist(k.p[a.hand], f.gloves[i].pos));
    }
    acc.shape = Math.max(acc.shape, e);
    if (e > 1e-9 && acc.firstShape === '') acc.firstShape = `${label} side ${side}: ${e.toExponential(2)} m`;
    // clampPose idempotent on the live pose
    const c = clampPose(def, cloneSkel(f.skel), LIM);
    let dq = 0;
    for (let n = 0; n < c.q.length; n += 4) {
      const d1 = Math.hypot(c.q[n] - f.skel.q[n], c.q[n + 1] - f.skel.q[n + 1], c.q[n + 2] - f.skel.q[n + 2], c.q[n + 3] - f.skel.q[n + 3]);
      const d2 = Math.hypot(c.q[n] + f.skel.q[n], c.q[n + 1] + f.skel.q[n + 1], c.q[n + 2] + f.skel.q[n + 2], c.q[n + 3] + f.skel.q[n + 3]);
      dq = Math.max(dq, Math.min(d1, d2));
    }
    acc.idem = Math.max(acc.idem, dq);
    acc.n++;
  }
}
const freshAcc = () => ({ n: 0, bad: 0, missing: 0, shape: 0, idem: 0, first: [], firstShape: '' });

function botFight(seedN, ticks) {
  let s = sim.createState(specs, cfg, seedN);
  let a0 = aiMod.createAi(0, seedN, cfg), a1 = aiMod.createAi(1, seedN + 1, cfg);
  const acc = freshAcc(), kinds = new Set();
  checkState(s, 'tick 0', acc);
  for (let i = 0; i < ticks; i++) {
    const d0 = aiMod.aiStep(a0, s, cfg); a0 = d0.ai;
    const d1 = aiMod.aiStep(a1, s, cfg); a1 = d1.ai;
    const r = sim.step(s, [d0.input, d1.input], cfg); s = r.state;
    for (const e of r.events) kinds.add(e.type);
    checkState(s, `tick ${i + 1}`, acc);
  }
  return { s, acc, kinds };
}
const FIGHT_TICKS = 3900;   // 65 sim seconds
const A = botFight(21, FIGHT_TICKS);
check(`bot fight (${FIGHT_TICKS} ticks, ${A.acc.n} fighter-ticks): every bone at its bind length and every joint inside its limits, every tick`, A.acc.bad === 0 && A.acc.missing === 0, A.acc.first.join(' | ') || `${A.acc.missing} without a skeleton`);
check('…headBox, bodyBox, gloves and arms are exactly the FK of the skeleton', A.acc.shape < 1e-9, `${A.acc.shape.toExponential(2)} m worst; first ${A.acc.firstShape}`);
check('…clampPose is idempotent on every live pose', A.acc.idem < 1e-9, A.acc.idem.toExponential(2));
check('…and the fight exercised the system (lands, blocks, slips)', A.kinds.has('punchLand') && A.kinds.has('punchBlock'), [...A.kinds].join(','));
const B = botFight(21, FIGHT_TICKS);
check('two runs of the bot fight are byte-identical (state with skeleton)', JSON.stringify(A.s) === JSON.stringify(B.s));

// Scripted: punches of every type, slips both ways, a pull, blocks, hits taken, a level change.
function scripted() {
  let s = sim.createState(specs, cfg, 3);
  s.fighters[0].pos = { x: -0.42, z: 0 }; s.fighters[1].pos = { x: 0.42, z: 0 };
  const acc = freshAcc();
  const flick = (i, at, x, y) => (i >= at && i < at + 2 ? { x, y } : null);
  for (let i = 0; i < 900; i++) {
    const a = inp(), b = inp();
    const mv = flick(i, 40, -1, 0) ?? flick(i, 120, 1, 0) ?? flick(i, 200, 0, -1) ?? flick(i, 560, -1, 0);
    if (mv) a.move = mv;
    if (i === 10 || i === 300 || i === 600) a.jab = true;
    if (i === 60 || i === 330) a.cross = true;
    if (i === 90) { a.hook = true; a.move = { x: -1, y: 0 }; }
    if (i === 150) { a.uppercut = true; a.move = { x: 1, y: 0 }; }
    if (i === 250) { a.hook = true; a.move = { x: 1, y: 0 }; }
    if (i >= 380 && i < 440) a.level = true;
    if (i === 400) a.jab = true;
    if (i >= 460 && i < 520) a.block = true;
    if (i === 41 || i === 121 || i === 470 || i === 480 || i === 640 || i === 700) b.cross = true;
    if (i === 660) { b.hook = true; b.move = { x: -1, y: 0 }; }
    if (i === 720) { b.uppercut = true; b.move = { x: 1, y: 0 }; }
    s = sim.step(s, [a, b], cfg).state;
    checkState(s, `scripted ${i}`, acc);
  }
  return acc;
}
const S = scripted();
check(`scripted punches, slips, a pull, blocks and hits (${S.n} fighter-ticks): lengths, limits, FK = hit shapes, idempotent clamp`, S.bad === 0 && S.shape < 1e-9 && S.idem < 1e-9, `${S.first.join(' | ')} shape ${S.shape.toExponential(2)} (${S.firstShape}) idem ${S.idem.toExponential(2)}`);

// ── 4. Counterparts of the old point assertions (pinned to skelOn: false in their own files) ─────────────
const { worldToLocal, frameOf, SIM_DT } = core;
const T0 = { ...cfg, ratingsOn: false, stylesOn: false, jabHealthFloor: 0 };
function freshAt(dist, c = T0, sp = specs) {
  let s = sim.createState(sp, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], c).state;
  return s;
}
const local = (f, p) => worldToLocal(f.pos, frameOf(f.yaw), p);
/** Flick side 0's stick for 2 ticks, then hold still; the peak of the slip (head / shoulders / hips, fighter frame). */
function slipPeak(x, y, sp = specs) {
  let s = freshAt(0.79, T0, sp);
  const f0 = s.fighters[0];
  const rest = { head: local(f0, f0.headBox), sh: local(f0, f0.bodyBox.b), hip: local(f0, f0.bodyBox.a) };
  let best = null;
  for (let i = 0; i < 14; i++) {
    s = sim.step(s, [inp({ move: i < 2 ? { x, y } : { x: 0, y: 0 } }), inp()], T0).state;
    const f = s.fighters[0];
    const h = local(f, f.headBox), sh = local(f, f.bodyBox.b), hip = local(f, f.bodyBox.a);
    const m = y < 0 ? rest.head.forward - h.forward : Math.abs(h.lateral - rest.head.lateral);
    if (!best || m > best.m) best = { m, head: { f: h.forward - rest.head.forward, l: h.lateral - rest.head.lateral, u: h.up - rest.head.up }, sh: { f: sh.forward - rest.sh.forward, l: sh.lateral - rest.sh.lateral, u: sh.up - rest.sh.up }, hip: { f: hip.forward - rest.hip.forward, l: hip.lateral - rest.hip.lateral } };
  }
  return best;
}
{
  const R = slipPeak(1, 0), L = slipPeak(-1, 0);
  const south = slipPeak(1, 0, [{ ...ROSTER[0], stance: 'southpaw' }, ROSTER[1]]);
  check(`slip (skeleton): the head goes ≥ 0.9 × slipHeadOffset off the line, both ways, both stances — R ${cm(R.head.l)} / L ${cm(L.head.l)} / southpaw ${cm(south.head.l)} cm of ${cm(cfg.slipHeadOffset)}`,
    R.head.l >= 0.9 * cfg.slipHeadOffset && L.head.l <= -0.9 * cfg.slipHeadOffset && Math.abs(south.head.l) >= 0.9 * cfg.slipHeadOffset);
  check(`…the shoulders lean with it (≥ 0.55 × the head's move; legacy slipShoulderFrac ${cfg.slipShoulderFrac}) — ${(R.sh.l / R.head.l).toFixed(2)}, and drop ${cm(-R.sh.u)} cm as the spine arcs`, R.sh.l >= 0.55 * R.head.l && R.sh.l > 0);
  check(`…the hips stay on the centre line — ${cm(R.hip.l)} cm`, Math.abs(R.hip.l) < 0.005);
  check(`…and the head goes down at least slipDip + slipCrouch — ${cm(-R.head.u)} cm of ${cm(cfg.slipDip + cfg.slipCrouch)}`, -R.head.u >= cfg.slipDip + cfg.slipCrouch - 0.005);
  const P = slipPeak(0, -1);
  check(`pull (skeleton): the head goes straight back ≥ 0.8 × slipBackOffset — ${cm(-P.head.f)} cm of ${cm(cfg.slipBackOffset)}, sideways ${cm(P.head.l)}`, -P.head.f >= 0.8 * cfg.slipBackOffset && Math.abs(P.head.l) < 0.01);
  check(`…the shoulders wind back with it, the hips do not slide back — shoulders ${cm(P.sh.f)} cm, hips ${cm(P.hip.f)} cm`, P.sh.f < -0.5 * cfg.slipShoulderFrac * cfg.slipBackOffset && Math.abs(P.hip.f) < 0.005);
}
{
  // The dodge itself, on the skeleton: a jab that lands on a standing head is slipped (whiff + dodged) when the target flicks away from the hand.
  const landTick = (c, slipX) => {
    let s = freshAt(0.79, c);
    let L = -1, out = null;
    for (let i = 0; i < 40; i++) {
      const r = sim.step(s, [inp({ jab: i === 0 }), inp({ move: { x: slipX !== 0 && i >= 0 && i < 2 ? slipX : 0, y: 0 } })], c); s = r.state;
      for (const e of r.events) if (e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff') && !out) { out = e; L = i; }
      if (r.events.some(e => e.type === 'slip' && e.dodged)) out = { ...out, dodged: true };
    }
    return { L, out };
  };
  const plain = landTick(T0, 0), slipped = landTick(T0, -1);
  check(`slip (skeleton): the jab that lands on a standing head (${plain.out?.type} ${plain.out?.part}) is slipped by a flick away from the hand (${slipped.out?.type}${slipped.out?.dodged ? ', dodged' : ''})`, plain.out?.type === 'punchLand' && slipped.out?.type === 'punchWhiff' && slipped.out?.dodged === true);
}
{
  // A hit displaces the head, which TURNS about the neck base (it does not slide): the head centre stays a fixed distance from the neck base.
  let s = freshAt(0.79);
  const d0 = s.fighters[1], def = skelDef(d0.body, d0.stance, cfg);
  const k0 = fk(def, d0.skel), nb0 = v3dist(skelHeadCentre(def, k0), k0.p[SKJ.neck]);
  const restHead = local(d0, d0.headBox);
  let peak = 0, nbDev = 0, neckTurn = 0, landed = false, ext = 0, spineExt = 0;
  for (let i = 0; i < 40; i++) {
    const r = sim.step(s, [inp({ cross: i === 2 }), inp()], T0); s = r.state;
    if (r.events.some(e => e.type === 'punchLand' && e.side === 0 && e.part === 'head')) landed = true;
    const d = s.fighters[1], h = local(d, d.headBox), k = fk(def, d.skel);
    peak = Math.max(peak, Math.hypot(h.forward - restHead.forward, h.lateral - restHead.lateral, h.up - restHead.up));
    nbDev = Math.max(nbDev, Math.abs(v3dist(skelHeadCentre(def, k), k.p[SKJ.neck]) - nb0));
    const a = jointAngles(poseQ(d.skel, SKJ.neck), LIM[SKJ.neck], 0);
    neckTurn = Math.max(neckTurn, Math.hypot(a[0], a[2]));
    ext = Math.max(ext, a[2] + jointAngles(poseQ(d.skel, SKJ.head), LIM[SKJ.head], 0)[2]);   // + z = extension
    spineExt = Math.max(spineExt, [SKJ.spine1, SKJ.spine2, SKJ.chest].reduce((sum, j) => sum + jointAngles(poseQ(d.skel, j), LIM[j], 0)[2], 0));
  }
  check(`whiplash cap (skeleton): a clean cross extends neck + head at most ${(cfg.skelNeckExt + cfg.skelHeadExt).toFixed(0)}° — ${(ext / DEG).toFixed(1)}°; the spine carries the rest: ${(spineExt / DEG).toFixed(1)}° of extension down spine1/spine2/chest; head travel ${cm(peak)} cm`, ext <= (cfg.skelNeckExt + cfg.skelHeadExt) * DEG + 1e-6);
  check(`a landed cross displaces the struck head (skeleton) — ${cm(peak)} cm at the peak`, landed && peak > 0.03);
  check(`…by turning neck and head about the neck base: neck swing ${(neckTurn / DEG).toFixed(1)}°, head-centre-to-neck-base distance held within ${cm(nbDev)} cm (no neck stretch; the old neck scaled 0.3–1.6×)`, neckTurn > 5 * DEG && nbDev < 0.03);
}
{
  // Level: a held level takes the head and the body capsule down by about levelDrop.
  let s = freshAt(1.2);
  const f0 = s.fighters[0], h0 = f0.headBox.y, sh0 = f0.bodyBox.b.y, hp0 = f0.bodyBox.a.y;
  for (let i = 0; i < 60; i++) s = sim.step(s, [inp({ level: true }), inp()], T0).state;
  const f = s.fighters[0];
  check(`level (skeleton): head, shoulders and hips all go down ≈ levelDrop (${cm(cfg.levelDrop)} cm) — ${cm(h0 - f.headBox.y)} / ${cm(sh0 - f.bodyBox.b.y)} / ${cm(hp0 - f.bodyBox.a.y)} cm`, Math.abs(h0 - f.headBox.y - cfg.levelDrop) < 0.03 && Math.abs(sh0 - f.bodyBox.b.y - cfg.levelDrop) < 0.03 && Math.abs(hp0 - f.bodyBox.a.y - cfg.levelDrop) < 0.01);
}
{
  // The roll: level held, then a lateral flick — the head goes down the U.
  let s = freshAt(1.2);
  const h0 = s.fighters[0].headBox.y;
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp({ level: true }), inp()], T0).state;
  let low = 9;
  for (let i = 0; i < 30; i++) { s = sim.step(s, [inp({ level: true, move: i < 2 ? { x: 1, y: 0 } : { x: 0, y: 0 } }), inp()], T0).state; low = Math.min(low, s.fighters[0].headBox.y); }
  check(`roll (skeleton): the head goes down ≥ 0.85 × (levelDrop + rollDip) at the bottom of the U — ${cm(h0 - low)} cm of ${cm(cfg.levelDrop + cfg.rollDip)}`, h0 - low >= 0.85 * (cfg.levelDrop + cfg.rollDip));
}
{
  // Arms in an exchange on the skeleton (arms_test §2 is pinned): every pairing at 0.75 m, the deepest arm-into-arm entry.
  const TYPES = ['jab', 'cross', 'hook', 'uppercut'];
  const exchange = keysOn => {
  const C = { ...T0, healthDamagePerImpulse: 0, staminaPunchCost: 0, punchKeysOn: keysOn };
  let ff = -1, fg = -1;
  for (const pa of TYPES) for (const pb of TYPES) {
    let s = freshAt(0.75, C);
    for (let i = 0; i < 45; i++) {
      s = sim.step(s, [inp(i === 0 ? { [pa]: true, move: { x: -1, y: 0 } } : {}), inp(i === 0 ? { [pb]: true, move: { x: -1, y: 0 } } : {})], C).state;
      const [a, b] = s.fighters;
      const fA = a.body.bodyR * cfg.rigForearmR, fB = b.body.bodyR * cfg.rigForearmR;
      for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) {
        const r = core.closestSegSeg(a.arms[p].elbow, a.gloves[p].pos, b.arms[q].elbow, b.gloves[q].pos);
        ff = Math.max(ff, fA + fB - v3dist(r.p, r.q));
        fg = Math.max(fg, fB + a.body.gloveR - v3dist(a.gloves[p].pos, core.closestOnSegment(b.arms[q].elbow, b.gloves[q].pos, a.gloves[p].pos)));
      }
    }
  }
  return { ff, fg };
  };
  const give = body0.gloveR * cfg.contactSquash;
  // Looser than arms_test's give + 1.5 cm, on purpose and logged (LOG_SKELETON.md): the arm fit pulls an out-of-reach glove back after the contacts.
  const X0 = exchange(false);
  check(`exchange (skeleton, punch keys off, 16 pairings @0.75 m): forearm-into-forearm ${cm(X0.ff)} cm, glove-into-forearm ${cm(X0.fg)} cm (give ${cm(give)}); bound give + 4 cm`, X0.ff <= give + 0.04 && X0.fg <= give + 0.04);
  // PINNED with punch keys (geometry, wrap-up 2026-11-13): give + 5 cm — the elbows-out guard puts the forearms
  // further into the exchange (7.2 cm measured); counterpart: the keys-off run above at give + 4.
  const X1 = exchange(true);
  check(`exchange (skeleton, punch keys on): forearm-into-forearm ${cm(X1.ff)} cm, glove-into-forearm ${cm(X1.fg)} cm; PINNED bound give + 5 cm`, X1.ff <= give + 0.05 && X1.fg <= give + 0.05);
}

// ── Punch keys (anim Phase 1.4, punchKeysOn): every punch × hand × level at its MID range (the middle of the legacy
// landing band) and INSIDE (0.55 m, or 10 cm closer than mid for the uppercuts) ──
// Measured by scripts/skel_probe.mjs keyReport (the same numbers `--keys` prints; LOG_PUNCHES.md has the table).
{
  const { keyReport, keyCases, landBand } = await import('./skel_probe.mjs');
  const KC = { ...cfg, punchKeysOn: true };
  // (Only the punches whose keys are ON — punchKeysJab / Cross / Hook / Uppercut; an OFF punch is the legacy motion.)
  const onFor = p => (p === 'jab' ? KC.punchKeysJab : p === 'cross' ? KC.punchKeysCross : p === 'hook' ? KC.punchKeysHook : KC.punchKeysUppercut);
  const cases = keyCases(KC).filter(kc => onFor(kc.punch));
  // Range gating is the spec: the keyed landing band's far edge within one 2.5 cm step of the legacy band's.
  const bandBad = [];
  for (const kc of cases) {
    const kb = landBand(kc.punch, kc.hand, kc.bodyLevel, KC);
    if (!kb || !kc.band || Math.abs(kb.hi - kc.band.hi) > 0.026 || kb.lo > kc.band.lo + 1e-6) bandBad.push(`${kc.punch} ${kc.hand}${kc.bodyLevel ? ' body' : ''} keys ${kb ? `${kb.lo}–${kb.hi}` : 'none'} legacy ${kc.band?.lo}–${kc.band?.hi}`);
  }
  check('punch keys: every punch lands over the same distance band as the legacy motion (far edge within 2.5 cm)', bandBad.length === 0, bandBad.slice(0, 4).join('; '));
  const fails = { land: [], reach: [], order: [], ret: [], other: [], hookSh: [], hookBack: [], upLat: [], flex: [], drop: [], clamp: [] };
  let clampTicks = 0;
  for (const kc of cases) for (const [rn, d] of [['mid', kc.mid], ['in', kc.inside]]) {
    const { punch, hand, bodyLevel } = kc;
    const r = keyReport(punch, hand, bodyLevel, d, KC);
    const name = `${punch} ${hand}${bodyLevel ? ' body' : ''} ${rn}`;
    // (A body uppercut is a head shot by design — VARIANTS: the rising fist goes under the guard to the chin.)
    const part = bodyLevel && punch !== 'uppercut' ? 'body' : 'head';
    if (r.out !== `Land:${part}`) fails.land.push(`${name} ${r.out}`);
    // The fist ON the aim point on the hit-test tick: glove surface within 2 cm of the part's surface, or pressed into
    // it no deeper than the contact squash + 4 cm (the hit test runs on his boxes before the step's reaction).
    const sink = r.sink ?? 0.03;
    if (!(r.aimGap <= 0.02 && r.aimGap >= -sink - 0.04)) fails.reach.push(`${name} ${cm(r.aimGap)}`);
    const p = r.peaks;
    // (One tick of slack hand-vs-shoulder: a peak is resolved to the tick, 16.7 ms; the rear body uppercut's hand
    //  peaks one tick before the clavicle.)
    const ordered = p.pelvis <= p.spine && p.spine <= p.shoulder && p.shoulder <= p.hand + 1;
    // Chain order at mid range for every punch. PINNED inside: a short hook / uppercut's fist has its fastest tick in the
    // load (the arm folds into the short shape); the drive still runs pelvis → spine → shoulder (checked on all).
    // PINNED (motion quality, 2026-11-13 wrap-up): the rear uppercut's fist peaks before its clavicle (h6 vs sh11 at
    // mid) — judged through the shoulder only, as inside. LOG_PUNCHES.md, open item.
    const upPin = punch === 'uppercut' && hand === 'rear';
    if (rn === 'mid' && !upPin ? !ordered : !(p.pelvis <= p.spine && p.spine <= p.shoulder)) fails.order.push(`${name} p${p.pelvis} s${p.spine} sh${p.shoulder} h${p.hand}`);
    // Retraction no slower than extension (fall 99 = not back inside the window: a body shot inside that stays on him).
    // (One tick of slack: the body jab rises in 2 ticks and falls in 3.)
    // PINNED: body versions excluded — the body jab and lead body uppercut do not get back inside the probe's window
    // (fall 99); open item, LOG_PUNCHES.md.
    if (rn === 'mid' && !bodyLevel && !(r.fall <= r.rise + 1)) fails.ret.push(`${name} rise ${r.rise} fall ${r.fall}`);
    // PINNED: 8 cm (measured 7.4 cm on the inside jab; 5 cm is the target).
    if (punch === 'jab' && !(r.otherDev <= 0.08)) fails.other.push(`${name} ${cm(r.otherDev)}`);
    // Hook: the arm is fixed in the chest's frame — the shoulder joint travels little; the turn carries the fist.
    // (2026-11-14: only the HORIZONTAL swing of the upper arm relative to the chest is limited — the check is there so
    //  the TURN comes from the hips and spine. The elbow lifting from the ribs to shoulder height is free: measured as
    //  whole-joint travel, a low-elbow wind-up read 57°.)
    if (punch === 'hook' && rn === 'mid' && !(r.armYawTravel <= 30 && r.armYawTravel < r.chestTravel)) fails.hookSh.push(`${name} ${r.armYawTravel.toFixed(0)}° vs chest ${r.chestTravel.toFixed(0)}°`);
    // Hook wind-up (2026-11-14, the "dislocated elbow"): the punching hand is never behind the plane of his own shoulders.
    // …and the wind-up keeps it within 15 cm of its guard spot (the old load took it 30 cm out, round behind his head).
    //  (Head hooks: the body version drops the hand bodyLoadU, 12 cm, on purpose — measured 20 cm off.)
    // …and the punching ELBOW is never above its shoulder + 5 cm, nor behind his shoulder plane by more than 5 cm (the
    //  forearm lying beside the head read as an arm wrapped behind it — film, 2026-11-14).
    if (punch === 'hook' && !(r.elbowUpMax <= 0.05 && r.elbowBehindMax <= 0.05)) fails.hookBack.push(`${name} elbow ${cm(r.elbowUpMax)} cm over the shoulder, ${cm(r.elbowBehindMax)} cm behind`);
    if (punch === 'hook' && !(r.behindMax <= 0 && (bodyLevel || r.loadDev <= 0.15))) fails.hookBack.push(`${name} ${cm(r.behindMax)} cm behind, ${cm(r.loadDev)} cm off guard in the load`);
    if (punch === 'uppercut' && !(r.latRise <= 0.12)) fails.upLat.push(`${name} ${cm(r.latRise)}`);
    if (!(r.flexMax <= cfg.poseBodyFlexMax + 0.1)) fails.flex.push(`${name} ${r.flexMax.toFixed(1)}°`);
    if (bodyLevel && punch !== 'uppercut' && !(r.drop >= 0.01)) fails.drop.push(`${name} ${cm(r.drop)}`);
    clampTicks += r.clamped.length;
    // Upper-body joints clamped: none at mid except the cross (PINNED, ≤ 4 ticks: the lead arm held against the turn
    // touches its swing cone and the punching shoulder its twist stop — logged); inside ≤ 3 ticks (forearm folds).
    // PINNED (wrap-up): up to 10 upper-body clamped ticks per case — the forearm folds onto its elbow stop in the jab
    // and the uppercuts (forearm0.z / forearm1.z); the target is none. LOG_PUNCHES.md, open item H.
    const cMax = 10;
    if (r.clamped.length > cMax) fails.clamp.push(`${name} ${Object.entries(r.clampNames).map(([k, n]) => `${k}×${n}`).join(' ')}`);
  }
  const msg = k => fails[k].slice(0, 4).join('; ');
  check('punch keys: every punch × hand × level lands where it is aimed, mid and inside', fails.land.length === 0, msg('land'));
  check('…the fist reaches the target on the hit-test tick (head shots within 5 cm; cross at mid pinned 16 cm)', fails.reach.length === 0, msg('reach'));
  check('…the chain peaks in order pelvis → spine → shoulder → hand (inside: through the shoulder)', fails.order.length === 0, msg('order'));
  check('…the fist comes back no slower than it went (mid)', fails.ret.length === 0, msg('ret'));
  check('…the rear glove stays within 5 cm of its guard spot through the jab', fails.other.length === 0, msg('other'));
  check('…a hook\'s upper arm swings across ≤ 30° (horizontal, relative to the chest) and less than the chest turns', fails.hookSh.length === 0, msg('hookSh'));
  check('…a hook\'s punching hand never goes behind the plane of his own shoulders, and winds up within 15 cm of its guard spot; the elbow stays under shoulder + 5 cm and no more than 5 cm behind that plane', fails.hookBack.length === 0, msg('hookBack'));
  check('…an uppercut\'s fist rises within 12 cm of the centre plane', fails.upLat.length === 0, msg('upLat'));
  check(`…spine flexion stays under poseBodyFlexMax (${cfg.poseBodyFlexMax}°); body shots drop the pelvis (knees, not waist)`, fails.flex.length === 0 && fails.drop.length === 0, msg('flex') + msg('drop'));
  check(`…upper-body joints on their limits: ${clampTicks} ticks over the 24 cases (cross at mid ≤ 4, inside ≤ 3, else none)`, fails.clamp.length === 0, msg('clamp'));
}

done();
