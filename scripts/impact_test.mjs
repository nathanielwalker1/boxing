/** impact_test.mjs — the drawn impact layer (src/human/impact.ts): head whip, body fold, face, blocks. Pure, no browser. */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [I, C] = await load('/src/human/impact.ts', '/src/core/config.ts');
const cfg = C.createConfig();
const DT = 1 / 60, DEG = 180 / Math.PI;
// Target faces +x at yaw 0: his right is +z, his left is -z. The attacker stands at +x, so a straight travels -x.
const fs = { yaw: 0 };
const IMP = { front: { x: -1, y: 0, z: 0 }, fromLeft: { x: 0, y: 0, z: 1 }, fromRight: { x: 0, y: 0, z: -1 } };

function land(punch, part, imp, grade = 'flush', extra = {}) {
  return { type: 'punchLand', side: 0, target: 1, punch, hand: 'lead', part, at: { x: 0, y: 1.6, z: 0 }, impulse: imp, power: 1, counter: false,
    variant: 'normal', grade, combo: 1, liver: false, through: false, wrongWay: false, ...extra };
}
const ang = q => ({ x: 2 * q[0] * DEG, y: 2 * q[1] * DEG, z: 2 * q[2] * DEG });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

/** Run one event then `ticks` steps; return samples per tick (index 0 = right after the event, before any step). */
function run(ev, ticks = 60) {
  const s = I.createImpact(), out = I.makeImpactPose(), rows = [];
  I.impactOnEvents(s, 1, ev ? [ev] : [], fs, cfg);
  for (let t = 0; t <= ticks; t++) {
    if (t > 0) I.impactStep(s, DT);
    I.impactPose(s, 0, out);
    rows.push({
      head: add(ang(out.rot.Head), ang(out.rot.Neck)), sp2: ang(out.rot.Spine2), spine: ang(out.rot.Spine), spine1: ang(out.rot.Spine1),
      hipsZ: out.hips[2], face: { ...out.face }, raw: JSON.stringify([out.rot, out.hips, out.face]),
    });
  }
  return rows;
}
const peak = (rows, f) => rows.reduce((m, r) => (Math.abs(f(r)) > Math.abs(m) ? f(r) : m), 0);
const peakTick = (rows, f) => { let b = 0, bi = 0; rows.forEach((r, i) => { if (Math.abs(f(r)) > b + 1e-12) { b = Math.abs(f(r)); bi = i; } }); return bi; };

// No event: exactly neutral.
const none = run(null, 30);
check('no event: every rotation, the hips and the face are exactly neutral', none.every(r => r.raw === none[0].raw) && none[0].head.x === 0 && none[0].head.y === 0 && none[0].hipsZ === 0 && Object.values(none[0].face).every(v => v === 0));

const straight = run(land('jab', 'head', IMP.front));
const hookL = run(land('hook', 'head', IMP.fromLeft));
const hookR = run(land('hook', 'head', IMP.fromRight));
const upper = run(land('uppercut', 'head', IMP.front));
const bodyHook = run(land('bodyHook', 'body', IMP.fromLeft));
const bodyStraight = run(land('cross', 'body', IMP.front));
const block = run({ type: 'punchBlock', side: 0, target: 1, punch: 'jab', at: { x: 0, y: 1.5, z: 0 }, variant: 'normal', part: 'head', chip: 0, guard: 1, stun: 0.1 });

// Straight: head pitches back (negative about +X), not sideways.
const ps = peak(straight, r => r.head.x), ys = peak(straight, r => r.head.y), rs = peak(straight, r => r.head.z);
check('straight from the front pitches the head BACK', ps < -15 && ps > -30);
check('straight from the front does not turn or tilt the head', Math.abs(ys) < 0.5 && Math.abs(rs) < 0.5);
check('straight wince on, jaw and cheeks off', peak(straight, r => r.face.hitWince) === 1 && peak(straight, r => r.face.jawOpen) === 0 && peak(straight, r => r.face.cheekL) === 0);

// Hooks mirror.
const yL = peak(hookL, r => r.head.y), yR = peak(hookR, r => r.head.y);
check('hook from his left yaws the head to his right (negative yaw)', yL < -30);
check('hook from his right yaws the head to his left (positive yaw)', yR > 30);
check('hook mirrored magnitudes are equal', Math.abs(Math.abs(yL) - Math.abs(yR)) < 1e-9);
check('hook cheek on the struck side only', peak(hookL, r => r.face.cheekL) > 0.9 && peak(hookL, r => r.face.cheekR) === 0 && peak(hookR, r => r.face.cheekR) > 0.9);

// Uppercut.
check('uppercut pitches the chin back', peak(upper, r => r.head.x) < -25);
check('uppercut opens the jaw', peak(upper, r => r.face.jawOpen) > 0.5);

// Body hook: spine forward, toward the struck side (his left = negative roll), head yaw ~ 0.
const bf = peak(bodyHook, r => r.spine.x + r.spine1.x), br = peak(bodyHook, r => r.spine.z + r.spine1.z);
check('body hook flexes the spine forward', bf > 10);
check('body hook bends the torso toward the struck side (his left)', br < -3);
check('body hook leaves the head yaw near zero', Math.abs(peak(bodyHook, r => r.head.y)) < 1);
check('body shot shifts the hips back and opens the jaw', peak(bodyHook, r => r.hipsZ) < -0.02 && peak(bodyHook, r => r.face.jawOpen) > 0.5);
check('body straight folds forward without bending sideways much', peak(bodyStraight, r => r.spine.x) > 5 && Math.abs(peak(bodyStraight, r => r.spine.z)) < 0.5);

// Timing.
check('head peak within 2 ticks (straight, hook, uppercut)', [straight, hookL, upper].every(r => peakTick(r, x => x.head.x + x.head.y) <= 2 && peakTick(r, x => Math.hypot(x.head.x, x.head.y)) <= 2));
check('body peak takes about 3 ticks', peakTick(bodyHook, r => r.spine.x) >= 3 && peakTick(bodyHook, r => r.spine.x) <= 5);
const neutral = rows => rows.slice(36).every(r => Math.hypot(r.head.x, r.head.y, r.head.z, r.sp2.x, r.spine.x, r.spine1.x, r.spine.z) < 0.5 && Math.abs(r.hipsZ) < 0.001);
check('every case is back within 0.5 degrees of neutral by 0.6 s', [straight, hookL, hookR, upper, bodyHook, bodyStraight, block].every(neutral));
check('head recovers faster than the body (share left at 0.3 s)', Math.abs(straight[18].head.x) / Math.abs(ps) < Math.abs(bodyHook[18].spine.x) / Math.abs(peak(bodyHook, r => r.spine.x)));
check('the flush peaks are the configured angles (straight 25, hook 45, uppercut 35)', Math.abs(Math.abs(ps) - 25) < 1.5 && Math.abs(Math.abs(yL) - 45) < 2 && Math.abs(Math.abs(peak(upper, r => r.head.x)) - 35) < 2);

// Grades.
const flush = Math.abs(ps), clean = Math.abs(peak(run(land('jab', 'head', IMP.front, 'clean')), r => r.head.x)), glance = Math.abs(peak(run(land('jab', 'head', IMP.front, 'glancing')), r => r.head.x));
check('flush > clean > glancing', flush > clean && clean > glance && glance > 0);
const ctr = Math.abs(peak(run(land('jab', 'head', IMP.front, 'clean', { counter: true })), r => r.head.x));
check('a counter is larger than the same clean punch', ctr > clean);
check('glancing head shot has no wince', peak(run(land('jab', 'head', IMP.front, 'glancing')), r => r.face.hitWince) === 0);

// Shoulders follow, delayed.
check('Spine2 follows the head about 20%, later', Math.abs(peak(straight, r => r.sp2.x)) > 0.1 * flush && Math.abs(peak(straight, r => r.sp2.x)) < 0.3 * flush && straight[1].sp2.x === 0);

// Stacking: a second hit during recovery adds, not resets.
{
  const s = I.createImpact(), out = I.makeImpactPose();
  I.impactOnEvents(s, 1, [land('jab', 'head', IMP.front)], fs, cfg);
  for (let t = 0; t < 4; t++) I.impactStep(s, DT);
  I.impactPose(s, 0, out); const before = ang(out.rot.Head).x + ang(out.rot.Neck).x;
  I.impactOnEvents(s, 1, [land('jab', 'head', IMP.front)], fs, cfg);
  for (let t = 0; t < 3; t++) I.impactStep(s, DT);
  I.impactPose(s, 0, out); const after = ang(out.rot.Head).x + ang(out.rot.Neck).x;
  check('a second hit during recovery adds to the current state', after < before - 5);
}

// Block: small shove, no face. A hit on the other side does nothing.
check('block shoves Spine2 and the head back a few degrees, no face', peak(block, r => r.sp2.x) < -2 && peak(block, r => r.sp2.x) > -6 && Object.values(block[3].face).every(v => v === 0));
{
  const s = I.createImpact(), out = I.makeImpactPose();
  I.impactOnEvents(s, 0, [land('jab', 'head', IMP.front)], fs, cfg); // target is side 1; this is side 0's state
  I.impactStep(s, DT); I.impactPose(s, 0, out);
  check('an event aimed at the other fighter does nothing', out.rot.Head[0] === 0 && out.face.hitWince === 0);
}

// Determinism.
check('two runs give identical numbers', run(land('hook', 'head', IMP.fromLeft)).map(r => r.raw).join() === hookL.map(r => r.raw).join());

// Table.
const f = v => v.toFixed(1).padStart(7);
console.log('case              headX   headY   headZ  spineX  spineZ  hipsZ(cm) jaw  wince cheekL');
for (const [n, r] of [['straight', straight], ['hook from left', hookL], ['hook from right', hookR], ['uppercut', upper], ['body hook', bodyHook], ['body straight', bodyStraight], ['block', block]]) {
  const sp = peak(r, x => x.spine.x + x.spine1.x), sz = peak(r, x => x.spine.z + x.spine1.z);
  console.log(n.padEnd(16), f(peak(r, x => x.head.x)), f(peak(r, x => x.head.y)), f(peak(r, x => x.head.z)), f(sp), f(sz), f(peak(r, x => x.hipsZ) * 100), peak(r, x => x.face.jawOpen).toFixed(2).padStart(5), peak(r, x => x.face.hitWince).toFixed(1).padStart(5), peak(r, x => x.face.cheekL).toFixed(2).padStart(6));
}
done();
