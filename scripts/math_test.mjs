/** math_test.mjs — the fighter frame convention, springs, and angle helpers. */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [m] = await load('/src/core/math.ts');

// Frame: facing +x, the fighter's right is +z (toward a camera on +z).
const f0 = m.frameOf(0);
check('yaw 0 → forward +x', near(f0.fwd.x, 1) && near(f0.fwd.z, 0));
check('yaw 0 → right is +z', near(f0.right.x, 0) && near(f0.right.z, 1));
const fpi = m.frameOf(Math.PI);
check('yaw π → forward -x, right -z', near(fpi.fwd.x, -1) && near(fpi.right.z, -1));

// Local ↔ world round trip at an arbitrary yaw.
const yaw = 0.7, pos = { x: 1.3, z: -0.4 }, fr = m.frameOf(yaw);
const w = m.localToWorld(pos, fr, 0.5, 1.2, -0.3);
const l = m.worldToLocal(pos, fr, w);
check('localToWorld ∘ worldToLocal is identity', near(l.forward, 0.5, 1e-9) && near(l.up, 1.2) && near(l.lateral, -0.3, 1e-9));

// Hands: orthodox lead = left = negative lateral.
check('orthodox lead is -lateral', m.handLateralSign('lead', 'orthodox') === -1);
check('orthodox rear is +lateral', m.handLateralSign('rear', 'orthodox') === 1);
check('southpaw lead is +lateral', m.handLateralSign('lead', 'southpaw') === 1);

// Angles
check('wrapAngle(3π) = π', near(m.wrapAngle(3 * Math.PI), Math.PI));
check('angleDelta crosses ±π the short way', near(m.angleDelta(3.0, -3.0), 2 * Math.PI - 6));
check('turnToward is clamped', near(m.turnToward(0, 1, 0.25), 0.25));
check('turnToward reaches target', near(m.turnToward(0, 0.1, 0.25), 0.1));

// Springs: critically damped settles without overshoot; underdamped overshoots.
const dt = 1 / 60;
let s = m.spring1(0);
const k = 400, c = 2 * Math.sqrt(k);
let maxX = 0;
for (let i = 0; i < 120; i++) { m.stepSpring1(s, 1, k, c, dt); maxX = Math.max(maxX, s.x); }
check('critically damped spring settles at target', near(s.x, 1, 1e-3), `x=${s.x}`);
check('critically damped spring does not overshoot', maxX <= 1 + 1e-6, `max ${maxX}`);
s = m.spring1(0); maxX = 0;
for (let i = 0; i < 120; i++) { m.stepSpring1(s, 1, k, c * 0.2, dt); maxX = Math.max(maxX, s.x); }
check('underdamped spring overshoots', maxX > 1.2, `max ${maxX}`);
const s3 = m.spring3();
for (let i = 0; i < 200; i++) m.stepSpring3(s3, 1, -2, 0.5, k, c, dt);
check('spring3 settles on all axes', near(s3.x, 1, 1e-3) && near(s3.y, -2, 1e-3) && near(s3.z, 0.5, 1e-3));

// Determinism: the same spring run twice is bit-identical.
const r1 = m.spring1(0), r2 = m.spring1(0);
for (let i = 0; i < 500; i++) { m.stepSpring1(r1, Math.sin(i), 300, 20, dt); m.stepSpring1(r2, Math.sin(i), 300, 20, dt); }
check('spring run is bit-identical', r1.x === r2.x && r1.v === r2.v);

// Geometry
check('sphere overlap', m.sphereOverlap({ x: 0, y: 0, z: 0, r: 1 }, { x: 1.5, y: 0, z: 0, r: 0.6 }));
check('sphere no overlap', !m.sphereOverlap({ x: 0, y: 0, z: 0, r: 1 }, { x: 2, y: 0, z: 0, r: 0.6 }));
const cap = { a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 2, z: 0 }, r: 0.3 };
check('sphere hits capsule mid-segment', m.sphereCapsuleOverlap({ x: 0.5, y: 1, z: 0, r: 0.25 }, cap));
check('sphere misses capsule', !m.sphereCapsuleOverlap({ x: 0.5, y: 3, z: 0, r: 0.25 }, cap));
check('triangle peak', near(m.triangle(0.5), 1) && near(m.triangle(0.25), 0.5) && near(m.triangle(1), 0));

done();
