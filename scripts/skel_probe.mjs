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

const [core, sim, skel] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/sim/skel.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, skelDef, skelLimits, jointAngles, poseQ, fk, skelArm, worldToLocal, frameOf, v3dist, qRot } = core;
const args = process.argv.slice(2);
// --set key=value (repeatable): a config override for the run, e.g. --set skelPoleTwist=0.5
const cfg = createConfig();
for (let i = 0; i < args.length; i++) if (args[i] === '--set') { const [k, v] = args[i + 1].split('='); cfg[k] = v === 'true' ? true : v === 'false' ? false : Number(v); args.splice(i, 2); i--; }
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
  s.fighters[0].pos = { x: -0.42, z: 0 }; s.fighters[1].pos = { x: 0.42, z: 0 };
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
for (const [punch, hand] of pick) {
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
