/**
 * mocap_test.mjs — baked Mixamo clips (public/fighter/clips) fitted onto our body (public/fighter/boxer.glb).
 * Pure Node: parses the glb's skeleton directly, loads src/human/clip.ts + retarget.ts through load.mjs.
 *   npm run test:quick mocap
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { load } from './load.mjs';
import { check, done } from './check.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const [clipM, fitM] = await load('/src/human/clip.ts', '/src/human/retarget.ts');

// ---- our skeleton straight from the glb ----
const glb = readFileSync(resolve(ROOT, 'public/fighter/boxer.glb'));
const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
const joints = json.skins[0].joints;
const parentOf = {};
json.nodes.forEach((n, i) => (n.children || []).forEach(c => { parentOf[c] = i; }));
const skel = {
  names: joints.map(j => json.nodes[j].name),
  parents: joints.map(j => joints.indexOf(parentOf[j])),
  restPos: joints.map(j => json.nodes[j].translation || [0, 0, 0]),
  restRot: joints.map(j => json.nodes[j].rotation || [0, 0, 0, 1]),
};

// ---- baked data ----
const dir = resolve(ROOT, 'public/fighter/clips');
const index = JSON.parse(readFileSync(resolve(dir, 'index.json'), 'utf8'));
const bin = readFileSync(resolve(dir, 'clips.bin'));
const lib = clipM.decode(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const roles = JSON.parse(readFileSync(resolve(dir, 'roles.json'), 'utf8'));
const fit = fitM.buildFit(index.source, index.bones, index.parents, skel);
const B = n => index.bones.indexOf(n);
const O = n => skel.names.findIndex(x => x.replace(/^mixamorig\d*[:_]?/, '') === n);
console.log(`${lib.clips.size} clips, ${(bin.length / 1e6).toFixed(2)} MB bin; our hip height ${fit.hipHeight.toFixed(3)} m vs source ${index.source.hipHeight}`);
check('every indexed clip decodes', lib.clips.size === index.clips.length);
check('every role names a baked clip or is null', Object.values(roles).every(r => r === null || lib.clips.has(r.slug)));

// ---- 1. limb directions after the fit match the source directions ----
const LIMBS = ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftUpLeg', 'LeftLeg', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightUpLeg', 'RightLeg', 'Spine', 'Spine1', 'Spine2', 'Neck'];
// (Foot is fitted sole-flat-to-sole-flat, not by direction: our ankle-to-ball line is shallower than Y Bot's,
//  so it differs from the source direction by a constant ~10 deg pitch by design; the floor check covers it.)
const childOf = n => index.bones[index.parents.indexOf(B(n))];
const srcRestDir = n => { const a = index.source.rest[B(n)].head, b = index.source.rest[B(childOf(n))].head; return [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; };
const unit = v => { const l = Math.hypot(...v); return v.map(x => x / l); };
const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, unit(a).reduce((s, x, i) => s + x * unit(b)[i], 0)))) * 180) / Math.PI;
const pose = clipM.makePose(index.bones.length);
let sum = 0, cnt = 0, worst = { e: 0 };
for (const clip of lib.clips.values()) {
  for (let f = 0; f < clip.frames; f += 3) {
    clipM.sample(lib, clip, f / clip.fps, {}, pose);
    const out = fitM.applyFit(fit, pose);
    const wp = fitM.worldPositions(fit, out);
    for (const n of LIMBS) {
      const a = wp[O(n)], b = wp[O(childOf(n))];
      const ours = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const srcDir = clipM.qrot(clipM.poseQuat(pose, B(n)), srcRestDir(n));
      const e = angle(ours, srcDir);
      sum += e; cnt++;
      if (e > worst.e) worst = { e, bone: n, clip: clip.slug, f };
    }
  }
}
console.log(`direction error over ${cnt} bone-frames: mean ${(sum / cnt).toFixed(3)} deg, worst ${worst.e.toFixed(3)} deg (${worst.bone}, ${worst.clip} f${worst.f})`);
check('fitted limb directions follow the source (mean < 1 deg, worst < 3 deg)', sum / cnt < 1 && worst.e < 3);

// ---- 2. feet on the floor on idle clips ----
const restPos = fit.restWorldPos;
const feet = ['LeftToeBase', 'RightToeBase', 'LeftFoot', 'RightFoot'].map(O);
let floorWorst = { d: 0 }, floorSum = 0, floorN = 0;
for (const clip of lib.clips.values()) {
  if (!clip.label.startsWith('fight idle')) continue;
  for (let f = 0; f < clip.frames; f += 2) {
    clipM.sample(lib, clip, f / clip.fps, {}, pose);
    const wp = fitM.worldPositions(fit, fitM.applyFit(fit, pose));
    // lowest foot point: how far the lower of ball / ankle sits from its standing height
    const low = Math.min(...feet.map(i => wp[i][1] - restPos[i][1]));
    floorSum += Math.abs(low); floorN++;
    if (Math.abs(low) > Math.abs(floorWorst.d)) floorWorst = { d: low, clip: clip.slug, f };
  }
}
console.log(`idle lowest foot point vs floor: mean |${(floorSum / floorN * 100).toFixed(1)}| cm, worst ${(floorWorst.d * 100).toFixed(1)} cm (${floorWorst.clip} f${floorWorst.f})`);
check('idle feet within 3 cm of the floor', Math.abs(floorWorst.d) < 0.03);

// ---- 3. mirror twice = identity ----
const jab = lib.clips.get(roles.jab.slug);
clipM.sample(lib, jab, 0.37, {}, pose);
const m1 = clipM.mirrorPose(lib, pose, clipM.makePose(index.bones.length)), m2 = clipM.mirrorPose(lib, m1, clipM.makePose(index.bones.length));
let md = 0;
for (let i = 0; i < pose.rot.length; i++) md = Math.max(md, Math.abs(pose.rot[i] - m2.rot[i]));
for (let i = 0; i < 3; i++) md = Math.max(md, Math.abs(pose.hips[i] - m2.hips[i]));
console.log(`mirror twice: max component difference ${md.toExponential(2)}`);
check('mirror twice = identity', md < 1e-6);
const sm = clipM.sample(lib, jab, 0.37, { mirror: true }, clipM.makePose(index.bones.length));
let sd = 0;
for (let i = 0; i < sm.rot.length; i++) sd = Math.max(sd, Math.abs(sm.rot[i] - m1.rot[i]));
check('sample(mirror) = mirrorPose(sample)', sd < 1e-6, `diff ${sd}`);

// ---- 4. mirrored jab: right wrist reaches as far as the original left ----
const reach = (mirror, side) => {
  let best = -Infinity;
  for (let f = 0; f < jab.frames; f++) {
    clipM.sample(lib, jab, f / jab.fps, { mirror }, pose);
    const wp = fitM.worldPositions(fit, fitM.applyFit(fit, pose));
    best = Math.max(best, wp[O(side + 'Hand')][2] - wp[O('Spine2')][2]);
  }
  return best;
};
const rL = reach(false, 'Left'), rR = reach(true, 'Right');
console.log(`jab (${jab.slug}) peak wrist reach in front of the chest: left ${rL.toFixed(3)} m, mirrored right ${rR.toFixed(3)} m`);
check('mirrored jab reaches as far (within 1.5 cm)', Math.abs(rL - rR) < 0.015);
done();
