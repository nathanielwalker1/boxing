/**
 * skel_probe.mjs — what the skeleton's ARM fit does through a punch, tick by tick (anim Phase 1.1b). Node, no browser.
 *
 *   node scripts/skel_probe.mjs                 every punch × hand, summary + per-tick table for the hooks
 *   node scripts/skel_probe.mjs hook lead       one punch and hand, per-tick table
 *   node scripts/skel_probe.mjs all --table     every per-tick table
 *
 * The scenario is anim_film's: ROSTER red vs blue at 0.84 m, 30 idle ticks, the press on tick 2 (hook / uppercut take the
 * hand from the stick: lead = −1, rear = +1), tick numbers as the film's. Side 0 throws; the punching arm is probed:
 *   flex       elbow flexion, degrees (0 = straight)
 *   sh x/tw/z  shoulder swing x (+ adduction, − abduction), twist (+ internal), swing z (+ flexion, − extension) — right-side convention
 *   cl x/y     clavicle x (− elevation), y (+ protraction)
 *   ON         joints of this arm sitting ON a limit (clamped), with the axis
 *   tgtErr     legacy glove TARGET (the spring's) → fitted hand, cm;  fit: glove before the fit → hand (the clamp's move), cm
 *   clr        the torso-clearance pole blend (0 punch pole … 1 clearance pole); SW = core/arms.ts would SNAP this tick
 *   dUp / dFl  per-tick change of the upper arm's direction / the elbow's flexion, degrees
 *   elbow      the elbow from the shoulder in the fighter's frame (forward, up, lateral +right), cm
 */
import { load } from './load.mjs';

const [core, sim, skel, punchesMod] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/sim/skel.ts', '/src/sim/punches.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, skelDef, skelLimits, jointAngles, poseQ, fk, skelArm, worldToLocal, frameOf, v3dist, qRot, qMul, qConj, SKJ, skelHeadCentre } = core;
const args = process.argv.slice(2);
// --set key=value (repeatable): a config override for the run, e.g. --set skelPoleTwist=0.5
const cfg = { ...createConfig(), punchKeysOn: true };   // (the keys are default off in config for now; the probe measures them — --set punchKeysOn=false for legacy)
for (let i = 0; i < args.length; i++) if (args[i] === '--set') { const [k, v] = args[i + 1].split('='); cfg[k] = v === 'true' ? true : v === 'false' ? false : Number(v); args.splice(i, 2); i--; }
// --dist m: the distance the per-tick tables are run at (default anim_film's mid, 0.84)
const di = args.indexOf('--dist');
const DIST = di >= 0 ? Number(args[di + 1]) : 0.84;
if (di >= 0) args.splice(di, 2);
const LIM = skelLimits(cfg);
const DEG = 180 / Math.PI;
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const table = args.includes('--table');
const plain = args.filter(a => !a.startsWith('--'));
const CASES = [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'], ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']];
const pick = plain.length && plain[0] !== 'all' ? CASES.filter(([p, h]) => p === plain[0] && (!plain[1] || h === plain[1])) : CASES;

/** On a limit: twist at a bound, or the swing on its elliptical cone (or a zero-width axis). Returns axis letters. */
function onLimit(q, lim, side) {
  if (!lim) return '';
  const a = jointAngles(q, lim, side);
  const t = lim.twist, [i, j] = t === 0 ? [1, 2] : t === 1 ? [0, 2] : [0, 1];
  let s = '';
  if (lim.hi[t] > lim.lo[t] && (a[t] >= lim.hi[t] - 1e-6 || a[t] <= lim.lo[t] + 1e-6)) s += 'tw';
  const A = a[i] >= 0 ? lim.hi[i] : -lim.lo[i], B = a[j] >= 0 ? lim.hi[j] : -lim.lo[j];
  if (A > 0 && B > 0 && (a[i] / A) ** 2 + (a[j] / B) ** 2 >= 1 - 1e-6) s += 'cone';
  else if (!(A > 0) && B > 0 && Math.abs(a[j]) >= B - 1e-6) s += 'xyz'[j];
  else if (!(B > 0) && A > 0 && Math.abs(a[i]) >= A - 1e-6) s += 'xyz'[i];
  return s;
}

function probe(punch, hand) {
  const x = punch === 'hook' || punch === 'uppercut' ? (hand === 'lead' ? -1 : 1) : 0;
  let s = sim.createState([ROSTER[0], ROSTER[1]], cfg, 1);
  s.fighters[0].pos = { x: -DIST / 2, z: 0 }; s.fighters[1].pos = { x: DIST / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(), inp()], cfg).state;
  const ai = hand === 'lead' ? 0 : 1, a = skelArm(ai);
  const rows = [];
  let prevUp = null, prevFl = null, prevEl = null;
  for (let t = 0; t <= 40; t++) {
    const r = sim.step(s, [inp(t === 2 ? { [punch]: true, move: { x, y: 0 } } : {}), inp()], cfg); s = r.state;
    const f = s.fighters[0];
    // Elbow travel per tick from the hit geometry (works with skelOn off too: the legacy elbow).
    const elW = f.arms[ai].elbow, dEl = prevEl ? v3dist(elW, prevEl) * 100 : 0; prevEl = { ...elW };
    if (!f.skel) {
      const shW = f.arms[ai].shoulder, gl = f.gloves[ai].pos, lf = p => worldToLocal(f.pos, frameOf(f.yaw), p);
      const e = lf(elW), sh = lf(shW), g = lf(gl);
      const fl = 180 - Math.acos(Math.max(-1, Math.min(1, ((shW.x - elW.x) * (gl.x - elW.x) + (shW.y - elW.y) * (gl.y - elW.y) + (shW.z - elW.z) * (gl.z - elW.z)) / (v3dist(shW, elW) * v3dist(gl, elW))))) * DEG;
      rows.push({ legacy: true, t, phase: f.punch.type === punch ? f.punch.phase : '-', fl, dEl, elbow: [(e.forward - sh.forward) * 100, (e.up - sh.up) * 100, (e.lateral - sh.lateral) * 100], glove: [(g.forward - sh.forward) * 100, (g.up - sh.up) * 100, (g.lateral - sh.lateral) * 100] });
      continue;
    }
    const def = skelDef(f.body, f.stance, cfg), k = fk(def, f.skel);
    const side = def.side[a.upper];
    const fl = jointAngles(poseQ(f.skel, a.fore), LIM[a.fore], side)[2] * DEG;
    const sh = jointAngles(poseQ(f.skel, a.upper), LIM[a.upper], side).map(v => v * DEG);
    const cl = jointAngles(poseQ(f.skel, a.clav), LIM[a.clav], side).map(v => v * DEG);
    const on = [['clav', a.clav], ['sh', a.upper], ['elb', a.fore], ['hand', a.hand]].map(([n, j]) => { const o = onLimit(poseQ(f.skel, j), LIM[j], side); return o ? `${n}:${o}` : ''; }).filter(Boolean);
    const up = qRot(k.r[a.upper], { x: 0, y: -1, z: 0 });
    const dUp = prevUp ? Math.acos(Math.max(-1, Math.min(1, up.x * prevUp.x + up.y * prevUp.y + up.z * prevUp.z))) * DEG : 0;
    const dFl = prevFl === null ? 0 : Math.abs(fl - prevFl);
    prevUp = up; prevFl = fl;
    const pr = skel.skelProbe.arm[`${f.specId}:${ai}`];
    const g = f.gloves[ai];
    const el = worldToLocal(f.pos, frameOf(f.yaw), k.p[a.fore]), shl = worldToLocal(f.pos, frameOf(f.yaw), k.p[a.upper]);
    rows.push({
      t, phase: f.punch.type === punch ? f.punch.phase : '-', fl, sh, cl, on, dUp, dFl, dEl,
      tgtErr: v3dist(g.target, k.p[a.hand]) * 100, fitErr: pr ? v3dist(pr.glove, pr.hand) * 100 : 0,
      clr: pr?.clear ?? 0, sw: !!pr?.oldSwitch,
      elbow: [(el.forward - shl.forward) * 100, (el.up - shl.up) * 100, (el.lateral - shl.lateral) * 100],
      ev: r.events.filter(e => e.side === 0 && /^punch/.test(e.type)).map(e => e.type.replace('punch', '') + (e.part ? ':' + e.part : '')).join(','),
    });
  }
  return rows;
}

const f1 = v => v.toFixed(1).padStart(6);

/**
 * Phase 1.4 key-pose report for one punch × hand × level × distance (exported: skel_test uses it).
 * Side 0 throws at an idle side 1; returns the outcome on the hit-test tick and the shape numbers the brief asks for.
 */
export function keyReport(punch, hand, bodyLevel, dist, c = cfg) {
  const x = punch === 'hook' || punch === 'uppercut' ? (hand === 'lead' ? -1 : 1) : 0;
  let s = sim.createState([ROSTER[0], ROSTER[1]], c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  const hold = bodyLevel ? { level: true } : {};
  for (let i = 0; i < 30; i++) s = sim.step(s, [inp(hold), inp()], c).state;
  const ai = hand === 'lead' ? 0 : 1, oi = 1 - ai, a = skelArm(ai);
  const LIMS = skelLimits(c);
  const ang = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w))) * DEG;
  const rel = (p, q) => qMul(qConj(p), q);
  const rows = [], clampNames = {};
  let prev = null, out = null, hitTick = -1, startTick = -1;
  for (let t = 0; t < 70; t++) {
    const r = sim.step(s, [inp({ ...hold, ...(t === 0 ? { [punch]: true, move: { x, y: 0 } } : {}) }), inp()], c); s = r.state;
    const f = s.fighters[0], o = s.fighters[1];
    if (t === 0) startTick = 0;
    const ev = r.events.find(e => e.side === 0 && /^punch(Land|Whiff|Block)$|perfectBlock/.test(e.type));
    if (ev && !out) { out = ev; hitTick = t; }
    const def = skelDef(f.body, f.stance, c), k = fk(def, f.skel);
    const Rc = k.r[SKJ.chest], pc = k.p[SKJ.chest];
    const local = p => qRot(qConj(Rc), { x: p.x - pc.x, y: p.y - pc.y, z: p.z - pc.z });
    const fr = frameOf(f.yaw);
    const hw = k.p[a.hand];
    const lat = (hw.x - f.pos.x) * fr.right.x + (hw.z - f.pos.z) * fr.right.z;
    let clamped = 0;
    // Upper body (pelvis..hands) — the legs are placeholders standing on the rig's stance spots until the feet move into the sim (2.3).
    for (let j = 1; j < 20; j++) { const o = onLimit(poseQ(f.skel, j), LIMS[j], def.side[j]); if (o) { if (j < 14) clamped++; if (f.punch.type !== null) clampNames[`${core.JOINT_NAMES[j]}.${o}`] = (clampNames[`${core.JOINT_NAMES[j]}.${o}`] ?? 0) + 1; } }
    const spineFlex = [SKJ.spine1, SKJ.spine2, SKJ.chest].reduce((sum, j) => sum - jointAngles(poseQ(f.skel, j), LIMS[j], 0)[2], 0) * DEG;
    const row = {
      t, phase: f.punch.phase, type: f.punch.type,
      pelvis: k.r[SKJ.pelvis], chest: k.r[SKJ.chest], spineRel: rel(k.r[SKJ.pelvis], k.r[SKJ.chest]), clRel: rel(Rc, k.r[a.clav]), shRel: rel(k.r[a.clav], k.r[a.upper]), foreRel: rel(k.r[a.upper], k.r[a.fore]),
      // (the other hand relative to the HEAD, in the fighter's frame: it should stay at the face while the chest turns under it)
      hand: { ...hw }, handLocal: local(hw), otherLocal: (() => { const oh = k.p[skelArm(oi).hand], hd = skelHeadCentre(def, k); return { x: (oh.x - hd.x) * fr.fwd.x + (oh.z - hd.z) * fr.fwd.z, y: oh.y - hd.y, z: (oh.x - hd.x) * fr.right.x + (oh.z - hd.z) * fr.right.z }; })(), lat, clamped, spineFlex, pelY: k.p[SKJ.pelvis].y,
      headGap: v3dist(hw, o.headBox) - o.headBox.r - f.body.gloveR,
    };
    if (prev) {
      row.wPelvis = ang(prev.pelvis, row.pelvis); row.wSpine = ang(prev.spineRel, row.spineRel); row.wShoulder = ang(prev.shRel, row.shRel);
      row.wClav = ang(prev.clRel, row.clRel);
      // (hand speed RELATIVE TO THE CHEST — the arm's own motion; in the world the chest's turn carries the guard hand round first)
      row.wElbow = ang(prev.foreRel, row.foreRel); row.vHand = v3dist(prev.handLocal, row.handLocal) * 100; row.wChest = ang(prev.chest, row.chest);
    } else { row.wPelvis = row.wSpine = row.wShoulder = row.wClav = row.wElbow = row.vHand = row.wChest = 0; }
    rows.push(row); prev = row;
    if (t > 8 && f.punch.type === null && t > hitTick + 4) break;
  }
  const live = rows.filter(r => r.type !== null);
  // The drive: from the load key (cock × loadAt) to the hit test — the window the chain order is judged in.
  const ph = punchesMod.PUNCHES[punch].phases(c);
  const pp = core.posePunchOf(punch, hand);
  const driveTicks = Math.round((ph.extend + ph.cock * (1 - c[`punchk_${pp}_loadAt`])) * 60);
  const drive = live.filter(r => r.t <= hitTick && r.t >= hitTick - driveTicks);
  const peakT = key => drive.reduce((b, r) => (r[key] > b[key] ? r : b), drive[0]).t;
  // Rise / fall: the hand's chest-frame distance from its guard spot, 10 % → 90 % out, 90 % → 10 % back.
  const home = rows[0].handLocal;
  const dist0 = rows.map(r => Math.hypot(r.handLocal.x - home.x, r.handLocal.y - home.y, r.handLocal.z - home.z));
  const max = Math.max(...dist0), iMax = dist0.indexOf(max);
  const firstAt = (from, to, test) => { for (let i = from; i !== to; i += Math.sign(to - from)) if (test(dist0[i])) return i; return -1; };
  const up10 = firstAt(0, iMax, d => d >= 0.1 * max), up90 = firstAt(0, iMax + 1, d => d >= 0.9 * max);
  let dn90 = -1; for (let i = iMax; i < dist0.length; i++) if (dist0[i] >= 0.9 * max) dn90 = i; else break;
  const dn10 = dn90 < 0 ? -1 : firstAt(dn90, dist0.length, d => d <= 0.1 * max);
  const otherHome = rows[0].otherLocal;
  const otherDev = Math.max(...live.map(r => Math.hypot(r.otherLocal.x - otherHome.x, r.otherLocal.y - otherHome.y, r.otherLocal.z - otherHome.z)));
  const loadTick = drive.length ? drive.reduce((b, r) => (r.wPelvis > 0 && b < 0 ? r.t : b), -1) : -1;
  const atHit = rows.find(r => r.t === hitTick);
  const loadRow = rows.find(r => r.t === Math.max(0, hitTick - 6));
  return {
    out: out ? `${out.type.replace('punch', '')}${out.part ? ':' + out.part : ''}` : 'none', hitTick, gap: atHit ? atHit.headGap : NaN,
    // Chain groups: pelvis, spine (chest on pelvis), shoulder girdle (clavicle on chest), hand speed.
    peaks: { pelvis: peakT('wPelvis'), spine: peakT('wSpine'), shoulder: peakT('wClav'), hand: peakT('vHand') },
    maxW: { pelvis: Math.max(...live.map(r => r.wPelvis)), spine: Math.max(...live.map(r => r.wSpine)), chest: Math.max(...live.map(r => r.wChest)), shoulder: Math.max(...live.map(r => r.wShoulder)), elbow: Math.max(...live.map(r => r.wElbow)), hand: Math.max(...live.map(r => r.vHand)) },
    rise: up90 - up10, fall: dn10 < 0 ? 99 : dn10 - dn90, otherDev,
    shoulderTravel: atHit && loadRow ? ang(loadRow.shRel, atHit.shRel) : NaN, chestTravel: atHit && loadRow ? ang(loadRow.chest, atHit.chest) : NaN,
    latRise: Math.max(...drive.filter(r => r.t >= hitTick - 4).map(r => Math.abs(r.lat))),
    flexMax: Math.max(...live.map(r => r.spineFlex)), drop: rows[0].pelY - Math.min(...live.map(r => r.pelY)),
    clamped: live.filter(r => r.clamped > 0).map(r => r.t), clampNames, loadTick,
  };
}

// (Imported by skel_test for keyReport: the CLI below runs only when this file is the script.)
const MAIN = (process.argv[1] ?? '').endsWith('skel_probe.mjs');
if (MAIN && args.includes('--keys')) {
  const KEYS = [['jab', 'lead'], ['cross', 'rear'], ['hook', 'lead'], ['hook', 'rear'], ['uppercut', 'lead'], ['uppercut', 'rear']];
  for (const [punch, hand] of KEYS) for (const bodyLevel of [false, true]) for (const [rn, d] of [['mid', 0.84], ['in', 0.55]]) {
    const r = keyReport(punch, hand, bodyLevel, d);
    const p = r.peaks, w = r.maxW;
    const order = p.pelvis <= p.spine && p.spine <= p.shoulder && p.shoulder <= p.hand ? 'ok' : 'NO';
    console.log(`${(punch + ' ' + hand + (bodyLevel ? ' body' : '')).padEnd(20)} ${rn.padEnd(3)} ${r.out.padEnd(13)} t${r.hitTick} gap ${(r.gap * 100).toFixed(1).padStart(5)}cm | peaks p${p.pelvis} s${p.spine} sh${p.shoulder} h${p.hand} ${order} | max°/tick pel ${w.pelvis.toFixed(1)} sp ${w.spine.toFixed(1)} chest ${w.chest.toFixed(1)} sh ${w.shoulder.toFixed(1)} elb ${w.elbow.toFixed(1)} hand ${w.hand.toFixed(1)}cm | rise ${r.rise} fall ${r.fall} | other ${(r.otherDev * 100).toFixed(1)}cm | shTravel ${r.shoulderTravel.toFixed(0)}° chest ${r.chestTravel.toFixed(0)}° | lat ${(r.latRise * 100).toFixed(1)}cm | flex ${r.flexMax.toFixed(1)}° drop ${(r.drop * 100).toFixed(1)}cm | clamped ${Object.entries(r.clampNames).map(([k, n]) => `${k}×${n}`).join(' ') || '-'}`);
  }
  process.exit(0);
}

for (const [punch, hand] of MAIN ? pick : []) {
  const rows = probe(punch, hand);
  if (rows[0]?.legacy) {
    const live = rows.filter(r => r.t >= 2 && (r.phase !== '-' || r.t <= 3));
    console.log(`\n${punch} ${hand} (skelOn off, legacy joints): max elbow travel ${Math.max(...live.map(r => r.dEl)).toFixed(1)} cm/tick`);
    console.log('     t phase    flex  dEl(cm)  elbow(fwd,up,lat cm)  glove(fwd,up,lat cm) from the shoulder');
    for (const r of live) console.log(`  ${String(r.t).padStart(4)} ${r.phase.padEnd(7)}${f1(r.fl)}${f1(r.dEl)}   ${r.elbow.map(v => v.toFixed(0).padStart(4)).join(' ')}     ${r.glove.map(v => v.toFixed(0).padStart(4)).join(' ')}`);
    continue;
  }
  const live = rows.filter(r => r.t >= 2 && (r.phase !== '-' || r.t <= 3));
  const clamped = live.filter(r => r.on.length).map(r => `${r.t}(${r.on.join(' ')})`);
  const sw = live.filter(r => r.sw).map(r => r.t);
  const blend = live.filter(r => r.clr > 0.01).map(r => `${r.t}:${r.clr.toFixed(2)}`);
  const maxUp = Math.max(...live.map(r => r.dUp)), maxFl = Math.max(...live.map(r => r.dFl)), maxEl = Math.max(...live.map(r => r.dEl));
  console.log(`  max elbow travel ${maxEl.toFixed(1)} cm/tick`);
  const maxTgt = Math.max(...live.map(r => r.tgtErr)), maxFit = Math.max(...live.map(r => r.fitErr));
  console.log(`\n${punch} ${hand}: ticks ${live[0]?.t}–${live[live.length - 1]?.t}`);
  console.log(`  clamped ticks: ${clamped.join(', ') || 'none'}`);
  console.log(`  core/arms.ts pole switch would fire: ${sw.join(', ') || 'never'}   continuous clearance blend > 0: ${blend.join(', ') || 'never'}`);
  console.log(`  max per tick: upper-arm direction ${maxUp.toFixed(1)}°, elbow flexion ${maxFl.toFixed(1)}°   max glove error: target→hand ${maxTgt.toFixed(1)} cm, fit move ${maxFit.toFixed(2)} cm`);
  if (table || punch === 'hook' || pick.length === 1) {
    console.log('     t phase    flex   sh.x  sh.tw   sh.z   cl.x   cl.y   dUp    dFl  tgtErr fitErr  clr SW  elbow(fwd,up,lat cm)   ON / events');
    for (const r of rows) {
      if (r.t < 2 || (r.phase === '-' && r.t > 3)) continue;
      console.log(`  ${String(r.t).padStart(4)} ${r.phase.padEnd(7)}${f1(r.fl)}${f1(r.sh[0])}${f1(r.sh[1])}${f1(r.sh[2])}${f1(r.cl[0])}${f1(r.cl[1])}${f1(r.dUp)}${f1(r.dFl)}${f1(r.tgtErr)}${f1(r.fitErr)} ${r.clr.toFixed(2)} ${r.sw ? 'SW' : '  '} ${r.elbow.map(v => v.toFixed(0).padStart(4)).join(' ')}      ${r.on.join(' ')} ${r.ev}`);
    }
  }
}
