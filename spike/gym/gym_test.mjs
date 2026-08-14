/**
 * gym_test.mjs — the whole test surface for the spike.
 *
 *   node spike/gym/gym_test.mjs        (npm run gym must already be up)
 *
 * Everything here asserts against object.getWorldPosition() and
 * object.getWorldQuaternion(), because in a scene graph those ARE the answer.
 *
 * Compare with scripts/glove_test.mjs, which answers the much smaller question
 * "where is the glove drawn" and needs ~60 lines of Phaser Graphics opcode table
 * plus a hand-maintained TRANSLATE/SAVE/RESTORE stack to do it — and carries a
 * comment explaining that it deliberately does NOT track ROTATE and will
 * silently drift if the rig ever rotates inside a draw call. None of that
 * machinery exists here. There is no second space to reconcile.
 *
 * The three assertions:
 *   a) at rest the rear glove is on the FAR side of the head from the camera —
 *      the thing the 2D rig gets wrong by drawing it over the fighter's face
 *   b) through a full hook the forearm axis never enters the torso volume
 *   c) the stance is geometrically identical facing the other way
 */
import { chromium } from 'playwright';

const PORT = process.env.PORT || 5174;
const results = [];
const pass = m => results.push({ ok: true, m });
const fail = m => results.push({ ok: false, m });
const chk = (ok, m) => (ok ? pass(m) : fail(m));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle', timeout: 20000 });
await page.waitForFunction(() => window.__gym && window.__gym.ready, null, { timeout: 15000 });
await page.evaluate(() => { window.__gym.config.gym.paused = true; });

// ── (a) the rear glove lives behind the head, not on top of it ───────────────
{
  const a = await page.evaluate(() => {
    const g = window.__gym;
    g.api.rest();
    const L = g.api.localSkeleton();      // fighter-root frame: +z forward, +x lead side
    const out = { local: { gloveR: L.gloveR, head: L.head, gloveL: L.gloveL }, cam: {} };
    for (const p of ['SIDE', 'THREE_Q']) {
      g.api.preset(p);
      out.cam[p] = { glove: g.api.camDepth('gloveR'), head: g.api.camDepth('head') };
    }
    return out;
  });

  const dz = a.local.gloveR[2] - a.local.head[2];
  const dx = a.local.gloveR[0] - a.local.head[0];
  chk(dz < 0, `(a) rear glove is BEHIND the head on the depth axis  (Δz ${dz.toFixed(3)} m)`);
  chk(dx < -0.06, `(a) rear glove is on the rear-side cheek, not over the face  (Δx ${dx.toFixed(3)} m)`);
  chk(a.local.gloveL[2] > a.local.head[2] + 0.2,
    `(a) lead glove is well IN FRONT of the head  (Δz +${(a.local.gloveL[2] - a.local.head[2]).toFixed(3)} m)`);

  for (const [p, v] of Object.entries(a.cam)) {
    const d = v.glove - v.head;
    chk(d > 0.02,
      `(a) ${p}: rear glove renders behind the head — camera distance +${d.toFixed(3)} m further than the head`);
  }
}

// ── (b) the hook's forearm never enters the torso ────────────────────────────
{
  const b = await page.evaluate(() => {
    const T = window.__THREE, g = window.__gym;

    /**
     * Signed clearance from a world point to an oriented box.
     * Positive = outside by that much; negative = that deep inside.
     */
    const clearance = (p, box) => {
      const m = new T.Matrix4().fromArray(box.matrix).invert();
      const q = p.clone().applyMatrix4(m);
      const dx = Math.abs(q.x) - box.half[0];
      const dy = Math.abs(q.y) - box.half[1];
      const dz = Math.abs(q.z) - box.half[2];
      if (dx <= 0 && dy <= 0 && dz <= 0) return Math.max(dx, dy, dz);   // inside: negative
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
    };

    const SAMPLES = 61, ALONG = 21;
    let worst = { c: Infinity };
    for (let i = 0; i < SAMPLES; i++) {
      const p = i / (SAMPLES - 1);
      g.api.poseAt('hook', p);
      const boxes = g.api.torsoBoxes();
      const e = new T.Vector3(...g.api.world('forearmL'));   // elbow
      const w = new T.Vector3(...g.api.world('gloveL'));     // wrist
      for (let s = 0; s < ALONG; s++) {
        const pt = e.clone().lerp(w, s / (ALONG - 1));
        for (const box of boxes) {
          const c = clearance(pt, box);
          if (c < worst.c) worst = { c, p, s: s / (ALONG - 1) };
        }
      }
    }
    return { worst, forearmR: g.api.forearmR() };
  });

  chk(b.worst.c > 0,
    `(b) hook forearm axis stays outside the torso at all 61 phases — worst clearance ${b.worst.c.toFixed(4)} m ` +
    `at p ${b.worst.p.toFixed(2)}, ${(b.worst.s * 100).toFixed(0)}% along the forearm`);
  chk(b.worst.c > b.forearmR * 0.4,
    `(b) that clearance also leaves room for the forearm's own radius (${b.forearmR} m): ` +
    `${(b.worst.c / b.forearmR).toFixed(2)}× radius`);
}

// ── (c) turning the fighter around changes nothing about the stance ──────────
{
  const c = await page.evaluate(() => {
    const T = window.__THREE, g = window.__gym;
    const snap = () => {
      const local = g.api.localSkeleton();
      const world = {}, quat = {};
      for (const n of Object.keys(local)) { world[n] = g.api.world(n); quat[n] = g.api.quat(n); }
      return { local, world, quat };
    };

    const out = {};
    for (const pose of ['rest', 'hook-peak', 'slip']) {
      g.api.clearFacing();
      if (pose === 'rest') g.api.rest();
      if (pose === 'hook-peak') g.api.poseAt('hook', 0.43);
      if (pose === 'slip') { g.api.rest(); g.api.setSlip(1, 1); }
      g.api.setFacing(0);
      const before = snap();
      g.api.setFacing(Math.PI);
      const after = snap();

      // 1. local geometry must be bit-for-bit unchanged
      let localErr = 0;
      for (const n of Object.keys(before.local)) {
        for (let i = 0; i < 3; i++) localErr = Math.max(localErr, Math.abs(before.local[n][i] - after.local[n][i]));
      }

      // 2. world positions must be exactly the 180-degree rotation of the old
      //    ones about the carrier — i.e. a rigid turn, with no term that only
      //    applies in one facing.
      const pivot = g.carrier.position.clone();
      const R = new T.Matrix4().makeRotationY(Math.PI);
      let worldErr = 0;
      for (const n of Object.keys(before.world)) {
        const v = new T.Vector3(...before.world[n]).sub(pivot).applyMatrix4(R).add(pivot);
        const a = new T.Vector3(...after.world[n]);
        worldErr = Math.max(worldErr, v.distanceTo(a));
      }

      // 3. and the orientations must follow the same rigid turn
      const qR = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI);
      let quatErr = 0;
      for (const n of Object.keys(before.quat)) {
        const want = qR.clone().multiply(new T.Quaternion(...before.quat[n]));
        const got = new T.Quaternion(...after.quat[n]);
        quatErr = Math.max(quatErr, Math.min(
          Math.hypot(want.x - got.x, want.y - got.y, want.z - got.z, want.w - got.w),
          Math.hypot(want.x + got.x, want.y + got.y, want.z + got.z, want.w + got.w)));
      }
      out[pose] = { localErr, worldErr, quatErr };
    }
    g.api.clearFacing();
    g.api.rest();
    return out;
  });

  for (const [pose, e] of Object.entries(c)) {
    chk(e.localErr < 1e-9, `(c) ${pose}: joint geometry identical in both facings (max Δ ${e.localErr.toExponential(1)} m)`);
    chk(e.worldErr < 1e-6, `(c) ${pose}: turning is a rigid 180° — no facing-only term (max Δ ${e.worldErr.toExponential(1)} m)`);
    chk(e.quatErr < 1e-6, `(c) ${pose}: joint orientations rotate rigidly too (max Δq ${e.quatErr.toExponential(1)})`);
  }
}

// ── (d) the impulse comes from measured glove speed, live ───────────────────
// Not one of the three required assertions, but the locked physics philosophy
// is only honoured if the number really is read off world-space movement.
{
  const d = await page.evaluate(async () => {
    const g = window.__gym;
    g.api.clearFacing();
    g.api.rest();
    g.reaction.reset();
    g.api.place(0, g.config.dummy.z - 0.80);
    g.api.play();
    const restHead = g.api.world('head', 'dummy');
    g.api.throw('cross');
    const t0 = performance.now();
    while (performance.now() - t0 < 2000) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.reaction.lastImpulse > 0) break;
    }
    await new Promise(r => setTimeout(r, 90));
    const hitHead = g.api.world('head', 'dummy');
    return {
      speed: g.reaction.lastSpeed,
      impulse: g.reaction.lastImpulse,
      scale: g.config.dummy.impulseScale,
      bias: g.state.lastHit.includes('head') ? g.config.dummy.headBias : g.config.dummy.bodyBias,
      headMoved: Math.hypot(hitHead[0] - restHead[0], hitHead[1] - restHead[1], hitHead[2] - restHead[2]),
      lastHit: g.state.lastHit,
    };
  });

  chk(d.speed > 1.0, `(d) glove world speed at contact ${d.speed.toFixed(2)} m/s — measured between frames, not looked up`);
  const want = d.speed * d.scale * d.bias;
  chk(Math.abs(d.impulse - want) < 1e-6,
    `(d) impulse ${d.impulse.toFixed(3)} == speed × impulseScale × bias (${want.toFixed(3)}) — ${d.lastHit}`);
  chk(d.headMoved > 0.01, `(d) the dummy's head actually moved ${d.headMoved.toFixed(3)} m after the hit`);
}

// ── (e) slip: feet planted, and the head really goes where it looks ─────────
{
  const e = await page.evaluate(() => {
    const g = window.__gym;
    g.config.gym.paused = true;
    g.api.clearFacing();
    g.api.rest();
    const f0 = { L: g.api.world('footL'), R: g.api.world('footR') };
    const h0 = g.api.world('head');
    g.api.setSlip(1, 1);
    const f1 = { L: g.api.world('footL'), R: g.api.world('footR') };
    const h1 = g.api.world('head');
    g.api.setSlip(1, 0);
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    return { footL: dist(f0.L, f1.L), footR: dist(f0.R, f1.R), head: dist(h0, h1) };
  });

  chk(e.footL < 0.005 && e.footR < 0.005,
    `(e) slip keeps both feet planted (moved ${(e.footL * 1000).toFixed(1)} / ${(e.footR * 1000).toFixed(1)} mm)`);
  chk(e.head > 0.10, `(e) slip displaces the head ${e.head.toFixed(3)} m — the head bone IS the hurtbox, so seen == moved`);
}

await browser.close();

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.m}`);
const bad = results.filter(r => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} checks passed`);
console.log('Page errors:', errors.length ? errors : 'none');
if (bad.length || errors.length) process.exit(1);
