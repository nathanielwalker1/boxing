# Animation rebuild: source digest

Working maths for the fighter animation rebuild (rigid skeleton, key poses blended in code, additive clamped springs, inertialization on state change, two-bone IK, frame-based hit-stop). Everything is written for a deterministic 60 Hz sim: fixed `dt = 1/60`, no clocks, no `Math.random`.

## Provenance legend (read this first)

Fetching was done through a tool that summarises pages with a small model, so code in the articles was paraphrased, not copied byte for byte.

- **[READ]** = the formula came from the fetched page text.
- **[INFERRED]** = I wrote it from the maths or from memory of the author's public code. Check it before trusting it. Every INFERRED block has a test suggestion.
- **[UNSOURCED]** = a number I could not find a citation for.

| # | Source | Status |
|---|---|---|
| 1 | Holden, Dead Blending | READ (summarised page). Rotation blend code is INFERRED from the description. |
| 2 | Holden, Spring-Roll-Call | READ (formulas and function bodies reproduced). Quaternion spring is READ as description, code INFERRED. |
| 3 | Holden, Propagating Velocities | READ (summarised page). |
| 4 | Bermudez, Physics-based fighting game in Unity | READ, but the article has no gains and no ragdoll. Only the PD form. |
| 5 | Rosen GDC 2014 | NOT AVAILABLE. No transcript found. Only the talk description and forum comments. The numbered list is a claim-labelled reconstruction. |
| 6 | Bollo GDC 2017/2018 inertialization | NOT AVAILABLE. Slides PDF was compressed and unreadable by the fetcher. Quintic is INFERRED (derived from boundary conditions). |
| 7 | Sakurai, Creating Games, hit stop | Written summaries only (nintendowire, Source Gaming); SSBWiki hitlag formula READ. No frame counts from Sakurai himself. |
| 8 | three.js CCDIKSolver docs | READ. |
| 9 | Boxing biomechanics + ROM | MOSTLY UNSOURCED. See section 9. |

---

## 1. Holden: Dead Blending (theorangeduck.com/page/dead-blending)

Idea: inertialization stores an offset that decays. Dead blending instead keeps the OUTGOING pose alive by extrapolating it forward with a decaying velocity, and cross-fades from that extrapolated pose to the incoming animation over a blend time. It needs no offset state per joint beyond the extrapolated pose, and it works when the incoming animation differs a lot from the outgoing one. Cost: you must give the outgoing pose a velocity at the moment of transition.

At transition [READ]: record the current pose as `ext_x`, the current velocity as `ext_v` (angular velocity for rotations), reset timer `t = 0`, reset the rotation direction memory `d = identity`.

Per-step update, scalar [READ, shape; ordering of decay vs integrate is as the page lists it]:

```ts
// halflife: velocity decay half-life. blend: blend time. in_x/in_v: the new animation's current value and velocity.
function deadBlendStep(s, in_x, in_v, dt, halflife, blend) {
  if (s.t < blend) {
    s.ext_v *= Math.exp(-Math.LN2 * dt / halflife); // decay_factor, exact
    s.ext_x += s.ext_v * dt;
    s.t += dt;
    const a = smoothstep(s.t / Math.max(blend, 1e-5)); // 3x^2 - 2x^3 on clamped x
    return { x: lerp(s.ext_x, in_x, a), v: lerp(s.ext_v, in_v, a) };
  }
  return { x: in_x, v: in_v };
}
```

Joint version [READ]: `pos += dt*vel`; `rot = quat_from_scaled_angle_axis(dt * angvel) * rot` (new rotation multiplied on the LEFT). Blend positions with lerp, rotations with the side-safe slerp below.

Side-safe rotation blend [READ as description, code INFERRED]. Problem: extrapolated and input rotations can drift far apart so the shortest path flips (+175 deg to -175 deg). Fix: remember the chosen hemisphere in `d` and keep it for the whole blend.

```ts
function quatSlerpStable(s, ext: Quat, inp: Quat, alpha: number): Quat {
  let r = quatAbs(quatMul(inp, quatInv(ext)));          // relative rotation, shortest form
  if (quatDot(r, s.d) < 0) r = quatNeg(r);              // stay on same side as last step
  s.d = r;                                              // store back
  return quatMul(quatExp(scale(quatLog(r), alpha)), ext); // r^alpha applied to the source
}
```

Test (INFERRED code): blend ext = rot(Y, +175 deg) to in = rot(Y, -175 deg) over 12 frames. The angle must move monotonically through 180 deg, never jump.

Recommended numbers [READ]: about 0.2 s blend is "normal" and heuristics can still jitter at that length; keep heuristic blend times very short. The page gives NO half-life recommendation ("tune it per project"). Joint limits on the extrapolated pose (clamp, or add a bounce-back velocity) look better; optional. For this project, suggested start (my estimate, UNSOURCED): extrapolation half-life 0.05 to 0.1 s, blend 0.1 to 0.2 s (6 to 12 frames). Root is not extrapolated [READ in Propagating Velocities].

Why we may prefer it or not: dead blending does not need the outgoing animation to keep playing and handles big pose jumps. Offset inertialization (section 2) is cheaper and preserves the incoming motion's detail exactly after the decay, so for a skeleton with few key poses either works; pick inertialization as the default and use dead blending where the outgoing and incoming poses are very far apart (knockdown, KO).

## 2. Holden: Spring-Roll-Call (theorangeduck.com/page/spring-roll-call)

Idea: everything is parameterised by HALF-LIFE (time to close half the gap), so behaviour is independent of dt and cannot blow up like explicit Euler. Critical damping is the default (no oscillation, fewest parameters).

Constants [READ]: `ln2 = 0.69314718056`, `eps = 1e-5`.

Exact damper (position only, no velocity) [READ: `damper_exact`]:

```ts
const fastNegexp = (x) => 1 / (1 + x + 0.48*x*x + 0.235*x*x*x); // approx e^-x; use Math.exp if you want exact
function damperExact(x, g, halflife, dt) {
  const k = LN2 * dt / (halflife + EPS);
  return g + (x - g) * fastNegexp(k);          // = lerp(x, g, 1 - e^-k)
}
```

Critically damped spring, velocity-carrying, moving goal velocity [READ: `critical_spring_damper_exact`]:

```ts
function criticalSpring(s: {x, v}, goal, goalV, halflife, dt) {
  const y = 2 * LN2 / (halflife + EPS);        // y = d/2 where d = 4 ln2 / halflife
  const c = goal + 2 * goalV / y;              // note: goalV term; d*q/s with s = d^2/4 gives 2q/y... as the page writes it
  const j0 = s.x - c;
  const j1 = s.v + j0 * y;
  const e = fastNegexp(y * dt);
  s.x = e * (j0 + j1 * dt) + c;
  s.v = e * (s.v - j1 * y * dt);
}
```

Simple spring (goal velocity = 0) [READ: `simple_spring_damper_exact`]: identical with `c = goal`.

```ts
function simpleSpring(s, goal, halflife, dt) {
  const y = 2 * LN2 / (halflife + EPS);
  const j0 = s.x - goal;
  const j1 = s.v + j0 * y;
  const e = fastNegexp(y * dt);
  s.x = e * (j0 + j1 * dt) + goal;
  s.v = e * (s.v - j1 * y * dt);
}
```

Decay spring (goal = 0, goal velocity = 0; this is the inertializer core) [READ: `decay_spring_damper_exact`]:

```ts
function decaySpring(s, halflife, dt) {
  const y = 2 * LN2 / (halflife + EPS);
  const j1 = s.v + s.x * y;
  const e = fastNegexp(y * dt);
  s.x = e * (s.x + j1 * dt);
  s.v = e * (s.v - j1 * y * dt);
}
```

Cost note: precompute `y` and `e` if many springs share halflife and dt. In a fixed 60 Hz sim, `e` is a per-config constant.

Determinism note [INFERRED]: `Math.exp` is not guaranteed bit-identical across JS engines. `fastNegexp` is pure arithmetic and IS reproducible, so prefer it inside `src/sim`.

Under and over damped exact spring (when you want a bouncy spring, e.g. head wobble) [READ as summary]. `d = 4 ln2 / halflife`, stiffness `s = (2 pi f)^2` (or from damping ratio r: `s = (d/(2r))^2`), `c = g + d*q/s`, `y = d/2`.
- Underdamped (`s - d^2/4 > 0`): `w = sqrt(s - d^2/4)`, `j = sign(x-c) * sqrt((v + (x-c) y)^2 / w^2 + (x-c)^2)`, `p = atan((v + (x-c) y) / (-(x-c) w))`; `x' = j e^(-y t) cos(w t + p) + c`; `v' = -y j e^(-y t) cos(w t + p) - w j e^(-y t) sin(w t + p)`.
- Overdamped (`s - d^2/4 < 0`): `y0 = (d + sqrt(d^2 - 4s))/2`, `y1 = (d - sqrt(d^2 - 4s))/2`, `j1 = (c y0 - x y0 - v)/(y1 - y0)`, `j0 = x - j1 - c`; `x' = j0 e^(-y0 dt) + j1 e^(-y1 dt) + c`; `v' = -y0 j0 e^(-y0 dt) - y1 j1 e^(-y1 dt)`.

Other variants worth knowing [READ as summary]:
- Double spring (S-curve): spring an intermediate `xi` toward goal, spring `x` toward `xi`, each with `halflife/2`.
- Timed spring: `lag = halflife / ln2`; intermediate `xi` moves linearly to goal over `t_goal`; spring aims at `xi + v_goal*lag` when `lag < t_goal`. Gives "arrive at time T".
- Extrapolation with decaying velocity: with `y = ln2/halflife`, `x' = x + (v/y)(1 - e^(-y dt))`, `v' = v e^(-y dt)`.

### Applying springs to angles and quaternions

Scalar angle [INFERRED, trivial]: spring the error, not the angle. `s.x = wrap(s.x)` relative to the goal: `err = wrapPi(x - goal)`, run the spring with `x = err, goal = 0`, then `x = goal + s.x`. This keeps it on the short path.

Quaternion spring [READ as description: error is `x * inverse(goal)`, difference taken relative to the goal; code INFERRED]:

```ts
function quatSimpleSpring(s: {x: Quat, v: Vec3}, goal: Quat, halflife, dt) {
  const y = 2 * LN2 / (halflife + EPS);
  const j0 = quatToScaledAngleAxis(quatAbs(quatMul(s.x, quatInv(goal)))); // shortest path
  const j1 = vAdd(s.v, vScale(j0, y));
  const e = fastNegexp(y * dt);
  s.x = quatMul(quatFromScaledAngleAxis(vScale(vAdd(j0, vScale(j1, dt)), e)), goal);
  s.v = vScale(vSub(s.v, vScale(j1, y * dt)), e);   // angular velocity vector
}
```

Test: spring from rot(Y,170deg) to rot(Y,-170deg): it should take the 20 degree path.

Inertialization with these springs [READ: transition rule `off = (src + off) - dst` for position and velocity; then decaySpring on the offset; output `in + off`]:

```ts
// position/scalar, per channel
function inertTransition(o, srcX, srcV, dstX, dstV) {
  o.x = (srcX + o.x) - dstX;
  o.v = (srcV + o.v) - dstV;
}
function inertUpdate(o, inX, inV, halflife, dt) {
  decaySpring(o, halflife, dt);
  return { x: inX + o.x, v: inV + o.v };
}
```

Rotation version [INFERRED from Holden's Motion-Matching code, not fetched]: offset is a quaternion decaying to identity, angular velocity vector alongside.

```ts
function inertTransitionRot(o, srcX, srcV, dstX, dstV) {
  o.x = quatAbs(quatMul(quatMul(o.x, srcX), quatInv(dstX)));  // o.x * src * dst^-1
  o.v = vSub(vAdd(o.v, srcV), dstV);
}
function inertUpdateRot(o, inX, inV, halflife, dt) {
  quatSimpleSpring(o, QUAT_IDENTITY, halflife, dt);           // decay offset toward identity
  return { x: quatMul(o.x, inX), v: vAdd(quatRotate(o.x, inV), o.v) };
}
```

Half-life guidance: the page gives no value for inertialization. UNSOURCED starting points: 0.05 to 0.1 s for attack starts, 0.1 to 0.15 s for locomotion, which is roughly where a spring is 95 percent settled at 4.3 half-lives, so about 0.2 to 0.45 s of tail. Tune by filmstrip.

## 3. Holden: Propagating Velocities (theorangeduck.com/page/propagating-velocities-through-animation-systems)

Idea: keep a velocity next to every pose value and carry it through every operation, so that at any frame (including a reset or teleport with no history) you have a correct velocity for inertialization and extrapolation. Finite-differencing needs history and is wrong on a reset frame; assuming zero velocity pops when you reset into a fast motion.

Rules [READ, formulas as summarised]:
- Static-weight blend: output velocity = lerp of the two input velocities by alpha. Same for angular and scalar velocity.
- Changing weight: add `(rhs.pos - lhs.pos) * (alpha_vel / dt)`; angular: `scaledAngleAxis(rhs.rot * inv(lhs.rot)) * (alpha_vel / dt)`; scalar: `log(rhs/lhs) * (alpha_vel/dt)`.
- Smoothstep weight: `x = clamp(t / duration, 0, 1)`, alpha rate = `(6x - 6x^2)` times `blend_dt / duration`.
- You may drop the blend-induced velocity term when feeding physics; fast blends between distant poses make huge unstable velocities. Keep it when feeding an inertializer so the visible motion matches.
- Cubic inertialization weights [READ]: `t = clamp(time/duration,0,1)`; `w0 = 2t^3 - 3t^2 + 1`; `w1 = (t^3 - 2t^2 + t) * duration`; `w2 = (6t^2 - 6t)/duration`; `w3 = 3t^2 - 4t + 1`. Offset pos = `w0*off.pos + w1*off.vel`; offset vel = `w2*off.pos + w3*off.vel`. Output = input + offset (rotation: offset applied on the left).
- Dead blending extrapolation [READ]: `y = ln2/h`; position advance factor `(1 - e^(-y dt))/y`; velocity decay factor `e^(-y dt)`. Root is not extrapolated.
- Additive layers: velocity adds the additive's velocity times weight; with a changing weight also add the additive pose offset times `alpha_vel/dt`.
- Procedural adjustments with no analytic derivative (e.g. IK): no history needed; extrapolate inputs by a small delta (page uses 0.01 s) using their velocities, run the adjustment twice, difference the results.
- The page has no dedicated "reset" procedure. Practical rule [INFERRED]: on a state switch, set the new pose's velocity from the evaluated key-pose blend velocity, never zero; on a hard reset (round start, knockdown get-up) zero all spring offsets and velocities AND set `o.x = 0, o.v = 0`.

## 4. Bermudez: Physics-based fighting game in Unity (gamedeveloper.com)

Idea: each rotation is a torsional spring-damper (PD controller). Punch force drives the head's rotation; the springs return it to rest. Targets can come from keyframes. When the fist is close, switch the arm to IK aimed at the opponent's head, randomising between temple and chin. The article is thin: NO gain values, NO ragdoll, its code is described by the fetch as broken pseudocode.

PD form [READ]: `torque = q * angleError + p * angularVelocityError`, where `q` = stiffness (the article's name for the spring constant) and `p` = damping. Spring axis and velocity axis are applied separately. With `p = 0` it is a pure spring. Rotate about one axis then the other each step ("first do one rotation, then the next").

Gain guidance: none in the source. For us [INFERRED], skip torque integration and use the exact critical spring of section 2 (it IS this PD controller at critical damping, solved in closed form). Map: `halflife = ln2 / sqrt(q)` approximately for critical damping, `p = 2 sqrt(q)`; this relation is derived, not from the article.

## 5. Rosen, GDC 2014 "An Indie Approach to Procedural Animation"

STATUS: could not obtain a transcript or slides. Only: the GDC Vault description (simple procedural techniques with very few keyframes, examples from Overgrowth, Receiver, Black Shades), a Polycount comment that Overgrowth animation is driven by keyed poses, and Rosen's own quoted comment that fully procedural animation "doesn't give us enough control". The list below is what I know of the talk from general knowledge and is NOT verified against the source. Treat as design hints.

1. [UNVERIFIED] Few key poses per action (a handful, not a clip). A pose is a set of joint targets.
2. [UNVERIFIED] Each joint is driven toward the interpolated pose target by a spring, so overshoot and lag come for free.
3. [UNVERIFIED] Locomotion uses a "wheel" (a foot cycle driven by distance travelled) rather than a clip.
4. [UNVERIFIED] Blend to ragdoll on big impacts and blend out, with a partial (active) ragdoll for hit reactions where joints keep a weak pull toward the animation.
5. [UNVERIFIED] Keep procedural layers on top of poses, because the pure procedural approach lost artist control (this one is supported by Rosen's quoted comment).

To obtain the real thing: GDC Vault 1020583 and 1020049 (video, paywalled or free-video only).

## 6. Bollo: Inertialization (GDC 2018 / SIGGRAPH 2017 "High Performance Animation in Gears of War 4")

STATUS: could not read the slides; the PDF text streams were compressed. Confirmed by search abstracts: it replaces cross-fades with a post-process; a quintic polynomial matches the pose difference and velocity at the start of the transition and converges to zero by its end; works for vectors and quaternions.

Quintic [INFERRED: derived from boundary conditions, matches the standard minimum-jerk result]. Offset `x0`, velocity `v0`, acceleration `a0` at t = 0; want `x = v = a = 0` at `T`.

```ts
// x(t) = A t^5 + B t^4 + C t^3 + (a0/2) t^2 + v0 t + x0
const A = -(a0*T*T + 6*v0*T + 12*x0) / (2*T**5);
const B =  (3*a0*T*T + 16*v0*T + 30*x0) / (2*T**4);
const C = -(3*a0*T*T + 12*v0*T + 20*x0) / (2*T**3);
// evaluate offset at time t in [0,T]; after T the offset is 0
```

Bollo's clamp [recollection plus abstract, NOT verified]: choose `T` so the curve does not overshoot, with the heuristic `T = min(T, -5*x0/v0)` when `v0` points away from zero... and a related paper says Bollo sets the projected velocity to zero if it would move the value further from the target. Treat the exact condition as unknown.

Why the dead-blend / decay-spring route is simpler: the decay spring needs only `(x, v)` per channel, no coefficients, no duration, no overshoot clamp, and it is exactly frame-rate independent. The quintic needs a fixed `T`, tracks `a0`, and needs the clamp. Quintic's advantage is that it reaches exactly zero at `T` (no infinite tail); with a spring you can snap to zero once `|x| < eps` and `|v| < eps`.

Test (INFERRED): with `x0 = 1, v0 = 0, a0 = 0, T = 1`, check `x(1) = v(1) = a(1) = 0` numerically.

## 7. Sakurai, Creating Games: hit stop

STATUS: no transcript. Sources: nintendowire "This Week in Sakurai" summary of the video; Source Gaming translation of his Famitsu column (fan translation); SSBWiki Hitlag page (community measurements, not Sakurai's words).

The video's eight techniques [READ in summary, no numbers given by the summary]:
1. Control the amount (duration) of hit stop.
2. Blend in-between frames into the damage pose.
3. Keep the attacker moving a little during the freeze.
4. Shake the target more than the attacker.
5. Do not move the hitbox with the shake (the Famitsu column: if the body really vibrated, hurtboxes would move and attacks that should connect would miss, so shake the visual only).
6. Shake horizontally on the ground, vertically in the air.
7. Gradually lessen the shake.
8. Vary shake with camera distance.

Concrete numbers we do have [READ, SSBWiki; these are Smash numbers, not Sakurai's design rule]. Ultimate hitlag frames = `floor(floor((damage*0.65 + 6) * h * e * s) * p) * c` capped at 30 frames (20 for crouch cancel). Older: Brawl `floor((damage*0.3846154 + 5) * h * e)`; Melee `floor(damage/3 + 3)` capped 20. So a 10 damage hit is about 12 frames in Ultimate (`10*0.65+6 = 12.5`), about 8 frames in Melee. Electric attacks x1.5. Both fighters get the same freeze length; the victim freezes on the first flinch frame while shaking, the attacker freezes on the contact frame.

Suggested mapping for us [UNSOURCED, my estimate]: `hitstopFrames = clamp(round(2 + damageFrac * 8), 2, 12)` at 60 Hz, jab about 3 to 4, cross about 5 to 6, hook and uppercut 6 to 8, knockdown or KO up to 12. Target shake amplitude about 1 to 3 cm, 2 to 3 frames per swing, linear decay to zero over the freeze, visual only (do not touch hit geometry). Attacker keeps moving at about 5 to 10 percent of animation speed.

Determinism: hit-stop is a counter of frames; during it the sim does not step animation time, springs, or physics for frozen bodies (or steps them at the reduced rate), but the shake offset is a pure function of the remaining counter, e.g. `offset = amp * (remaining / total) * ((remaining & 1) ? 1 : -1)`.

## 8. three.js CCDIKSolver (threejs.org/docs/pages/CCDIKSolver.html)

[READ] Needs a `SkinnedMesh` with a `Skeleton`; an array of IK objects `{ target: boneIndex, effector: boneIndex, links: [{index, limitation?, rotationMin?, rotationMax?, enabled?}], iteration (default 1), minAngle, maxAngle (radians per step), blendFactor }`. Bones must be indexed into `skeleton.bones`; the target is itself a bone.

Verdict [INFERRED]: for a 2-bone arm or leg, analytic two-bone IK is simpler and better. It is closed form (no iterations, so deterministic and cheap), gives an explicit pole vector for the elbow or knee direction (CCD gives none and can pick unstable bend directions), and joint angle limits are a trivial clamp (below). CCD needs a SkinnedMesh and `three/addons`, which would also pull three.js into code we want to keep sim-adjacent. Skip CCDIK.

Analytic two-bone IK with pole vector [INFERRED; standard law of cosines, verify with a reach test]:

```ts
// A root (shoulder/hip), T target (fist/foot), P pole point (elbow/knee hint), l1 upper, l2 lower.
function twoBoneIK(A, T, P, l1, l2, minInterior = 0.2, maxInterior = Math.PI - 0.02) {
  const AT = sub(T, A);
  const dir = normalize(AT);
  // clamp the interior (elbow/knee) angle E to its limits by clamping the reach distance
  const dRaw = clamp(len(AT), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const cosEraw = (l1*l1 + l2*l2 - dRaw*dRaw) / (2*l1*l2);
  const E = clamp(Math.acos(clamp(cosEraw, -1, 1)), minInterior, maxInterior);
  const d = Math.sqrt(l1*l1 + l2*l2 - 2*l1*l2*Math.cos(E)); // reach consistent with clamped E
  const cosA = (l1*l1 + d*d - l2*l2) / (2*l1*d);            // angle at the root between AT and upper bone
  const sinA = Math.sqrt(Math.max(0, 1 - cosA*cosA));
  const AP = sub(P, A);
  let u = sub(AP, scale(dir, dot(AP, dir)));                // pole perpendicular to the reach line
  u = len(u) < 1e-6 ? anyPerpendicular(dir) : normalize(u);
  const B = add(A, add(scale(dir, l1*cosA), scale(u, l1*sinA))); // elbow / knee
  const C = add(A, scale(dir, d));                           // end effector (falls short if E was clamped)
  return { B, C };
}
```

Then orient: upper bone points A to B, lower bone B to C. Elbow and knee only bend one way: choose `minInterior` so the arm cannot fully fold, and put `P` on the side the joint should point (elbow out and down for a punch, knee forward). If the clamp shortens `d`, the glove stops short of the target; to keep the glove on target, move the shoulder (torso lean) instead. Test: target at 0.5 `(l1 + l2)`, at `l1 + l2` and beyond it; the result must always satisfy `|AB| = l1`, `|BC| = l2`.

Dead-zone note: fully straightened arm (E near pi) is where IK flips and where a punch lands. Keep `maxInterior` about 5 to 10 degrees short of straight (an elbow at impact in elite cross is about 113 degrees, section 9, so full extension is not even needed).

## 9. Boxing biomechanics and joint range of motion

STATUS: searches returned almost no ms timing. Most of the tables below are UNSOURCED estimates. I did not find a fetchable clinical ROM table; flashcard results disagreed with each other. The ROM numbers are the commonly cited AAOS-style values from memory.

### Punch timing (ms)

Sourced facts:
- Order of the kinetic chain (secondary sources via search): foot and leg push, then hips rotate, then trunk and shoulder, then elbow extends, then the fist arrives. Proximal to distal. No ms values found.
- The jab and cross have shorter delivery times than hooks; hooks reach higher speed (Sports Biomechanics, 2011, 10 competitive boxers, 8-camera 3D mocap; abstract only, no ms).
- Mean maximal fist velocity, elite vs junior (PMC7739747, IMU study): cross 8.1 vs 8.1 m/s; hook 11.2 vs 8.9; uppercut 10.2 vs 7.3.
- Elbow angle at impact, elite (same study): cross 112.9 deg (SD 9.2), hook 116.9 (SD 22.6), uppercut 100.1 (SD 12.6). So the arm does NOT lock out straight; model about 110 to 120 degrees at contact.
- Shoulder share of fist velocity at impact, elite: cross 15.6 percent, hook 50.1, uppercut 54.8 (junior: 29.1, 71.0, 67.3). So the cross is driven by the legs and trunk; hooks and uppercuts by shoulder.

Estimates (all UNSOURCED, use as starting values, then filmstrip):

| Phase of a cross | start (ms after foot push begins) | peak or end (ms) |
|---|---|---|
| Rear foot push / heel lift | 0 | 0 to 120 |
| Hip rotation | 30 | peak about 100 to 130 |
| Trunk rotation | 50 | peak about 120 to 160 |
| Shoulder forward | 70 | peak about 140 to 180 |
| Elbow extension | 90 | peak speed about 150 to 190 |
| Fist contact | n/a | about 150 to 220 |
| Retraction after contact | n/a | about 150 to 250 (UNSOURCED; retraction is generally slower than extension, roughly 1.0 to 1.5 times the extension time) |

| Punch | total extension to contact (ms) | full cycle incl. retraction (ms) |
|---|---|---|
| Jab | about 100 to 160 | about 250 to 350 |
| Cross | about 130 to 200 | about 300 to 450 |
| Hook | about 150 to 230 | about 350 to 500 |
| Uppercut | about 150 to 230 | about 350 to 500 |

In frames at 60 Hz: jab 6 to 10, cross 8 to 12, hook and uppercut 9 to 14 frames to contact. Compare against `legacy/` timings before adopting; keep the game's feel-tested values where they differ.

### Joint ROM (degrees)

Values from memory of standard clinical (AAOS / Norkin and White style) tables, NOT fetched. Search flashcards gave conflicting numbers for cervical (e.g. rotation 60 vs the more usual 80 to 90) so verify before hard-coding limits. For a stylised boxer use a smaller range than the passive anatomical limit.

| Joint and motion | Typical full ROM (deg) | Note |
|---|---|---|
| Neck flexion | 45 to 50 | UNSOURCED-from-memory |
| Neck extension | 55 to 70 | flashcard result said 45; disagreement |
| Neck rotation (each side) | 70 to 90 | flashcard result said 60 |
| Neck lateral bend (each side) | 40 to 45 | |
| Shoulder flexion | 180 | |
| Shoulder extension | 45 to 60 | |
| Shoulder abduction | 180 | |
| Shoulder internal / external rotation | 70 to 90 / 90 | |
| Elbow flexion / extension | 140 to 150 / 0 | |
| Forearm pronation / supination | 80 / 80 | |
| Wrist flexion / extension | 60 to 80 / 60 to 70 | |
| Wrist radial / ulnar deviation | 20 / 30 | |
| Lumbar flexion / extension | 60 / 20 to 25 | |
| Lumbar lateral bend | 25 | |
| Thoracic rotation (each side) | 30 to 40 | |
| Lumbar rotation (each side) | about 5 to 10 | |
| Hip flexion / extension | 120 / 20 | |
| Hip abduction / adduction | 45 / 30 | |
| Hip internal / external rotation | 45 / 45 | |
| Knee flexion / extension | 135 to 150 / 0 | |
| Ankle dorsiflexion / plantarflexion | 20 / 40 to 50 | a general reference said 30 / 40 |

Recommendation for the rig [INFERRED]: use the "Typical" column as a hard clamp for hit reactions and springs, and about 60 to 70 percent of it for authored poses.

---

## Open items to resolve before relying on this

- Rosen talk: no source. Get the video or drop section 5 as authority.
- Bollo: quintic derived, clamp rule unverified.
- Rotation inertializer and stable slerp code: from memory of Holden's repos (`orangeduck/Motion-Matching` branch `dead_blending`, `orangeduck/Spring-It-On` `deadblending.c`). Read those files to confirm.
- Punch timings and ROM: need a targeted paper or a clinical table.
- All half-lives and hit-stop frame counts are starting values, not sourced.

## Links used

- https://theorangeduck.com/page/dead-blending
- https://theorangeduck.com/page/spring-roll-call
- https://theorangeduck.com/page/propagating-velocities-through-animation-systems
- https://gamedeveloper.com/programming/create-a-physics-based-fighting-game-in-unity
- https://threejs.org/docs/pages/CCDIKSolver.html
- https://www.ssbwiki.com/Hitlag
- https://nintendowire.com/news/2022/12/12/this-week-in-sakurai-12-5-12-11-fine-tuning-hit-stop-and-cheating-the-system/
- https://sourcegaming.info/2015/11/11/thoughts-on-hitstop-sakurais-famitsu-column-vol-490-1/ (search snippet only)
- https://pmc.ncbi.nlm.nih.gov/articles/PMC7739747
- https://history.siggraph.org/wp-content/uploads/2022/09/2017-Talks-Bollo_High-Performance-Animation-in-Gears-of-War-4.pdf (unreadable)
- https://gdcvault.com/play/1020583 and /1020049 (search snippets only)
