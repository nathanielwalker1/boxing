// Bake: raw extraction -> committed, skeleton-independent pose data in public/fighter/clips/.
//
//   index.json  format "mocap-bake/1": bone list + parents, the source (Y Bot) T-pose rest the fit needs,
//               and one entry per clip (slug, label, fps, frames, byte offset, loop, travel, punches, impact).
//   clips.bin   little-endian Int16. Per clip, per frame: for each of the 22 bones the world-space rotation
//               DELTA from the source T-pose, D_b(t) = W_b(t) * inverse(W_b_rest), as x,y,z,w * 32767;
//               then the Hips position / source hip height, x,y,z * 8192. Phase-1 axes: metres, Y up,
//               character faces +Z at rest, his left = +X.
//   roles.json  role -> { slug, from, to, contact | impact } or null, picked from the labels.
// Decoded and fitted onto our skeleton at load by src/human/clip.ts + src/human/retarget.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const Q = 32767, H = 8192;
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
const r4 = (v) => Math.round(v * 1e4) / 1e4;

// Every role: { slug, from, to } plus contact (punches, block: frame of full extension / tightest guard),
// impact (hits: frame the blow lands), settle (knockdowns: frame the body comes to rest), body: true when a
// head punch role had to fall back to a body-level clip, travel (walk / step: net metres). null = no clip yet.
const ROLES = {
  idle: { labels: ['fight idle'] },
  jab: { punch: 'jab' }, cross: { punch: 'cross' },
  lead_hook: { punch: 'lead hook' }, rear_hook: { punch: 'rear hook' },
  lead_uppercut: { punch: 'lead uppercut' }, rear_uppercut: { punch: 'rear uppercut' },
  body_jab: { punch: ['body jab'] }, body_cross: { punch: ['body cross'] }, body_hook: { punch: ['body lead hook', 'body rear hook'] },
  block: { labels: ['block'] }, body_block: { labels: ['block (body)'] }, block_hit: { labels: ['block reaction'] },
  hit_head_light: { labels: ['hit head light'], hit: true }, hit_head_medium: { labels: ['hit head medium'], hit: true },
  hit_head_heavy: { labels: ['hit head heavy'], hit: true }, hit_body: { labels: ['hit body'], hit: true },
  hit_uppercut: { labels: ['hit uppercut*'], hit: true, prefer: /^hit uppercut(?! \(body\))/ },
  knockdown: { labels: ['knockdown fall'], knockdown: true },
  down_idle: { labels: ['down'] }, getup: { labels: ['get up'] }, stunned: { labels: ['stagger*'] },
  walk_fwd: { walk: 'forward' }, walk_back: { walk: 'back' }, walk_left: { walk: 'left' }, walk_right: { walk: 'right' },
  step_fwd: { step: 'forward' }, step_back: { step: 'back' }, step_left: { step: 'left' }, step_right: { step: 'right' },
  slip_left: { slip: 'left' }, slip_right: { slip: 'right' }, duck: { slip: 'down' }, lean_back: { slip: 'back' },
  win: { labels: ['win'] }, lose: { labels: ['lose'] },
};

// first frame after the hips' lowest point from which they stay within 3 cm of their final height
function settleFrame(raw) {
  const y = raw.frames.map((fr) => fr.p[0][1]), end = y[y.length - 1];
  for (let f = y.indexOf(Math.min(...y)); f < y.length; f++) if (y.slice(f).every((v) => Math.abs(v - end) < 0.03)) return f;
  return y.length - 1;
}

// Slips / duck / lean back cut out of the clips labelled "slips": for each direction the frame where the head
// (feet-anchored, from frame 0) goes furthest that way, the cut is +-0.35 s around it. Left = the boxer's left (+X).
function findSlips(rows, raws) {
  const best = {};
  for (const r of rows) {
    if (r.label !== 'slips' || r.dupOf) continue;
    const raw = raws[r.slug], n = raw.frames.length;
    const B = Object.fromEntries(raw.bones.map((nm, i) => [nm, i]));
    const rel = (f) => { const p = raw.frames[f].p, a = p[B.LeftFoot], b = p[B.RightFoot], h = p[B.Head]; return [h[0] - (a[0] + b[0]) / 2, h[1], h[2] - (a[2] + b[2]) / 2]; };
    const h0 = rel(0), half = Math.round(0.35 * raw.fps);
    for (let f = 0; f < n; f++) {
      const d = rel(f), dx = d[0] - h0[0], dy = d[1] - h0[1], dz = d[2] - h0[2];
      for (const [dir, v] of [['left', dx], ['right', -dx], ['down', -dy], ['back', -dz]]) {
        if (v > 0.12 && (!best[dir] || v > best[dir].amount)) best[dir] = { slug: r.slug, from: Math.max(0, f - half), to: Math.min(n - 1, f + half), contact: f, amount: Math.round(v * 100) / 100 };
      }
    }
  }
  return best;
}

// first frame the head (feet-anchored) has moved 3 cm from frame 0 — when the blow lands in a hit clip
function impactFrame(raw) {
  const B = Object.fromEntries(raw.bones.map((n, i) => [n, i]));
  const rel = (f) => { const p = raw.frames[f].p, a = p[B.LeftFoot], b = p[B.RightFoot], h = p[B.Head]; return [h[0] - (a[0] + b[0]) / 2, h[1], h[2] - (a[2] + b[2]) / 2]; };
  const h0 = rel(0);
  for (let f = 1; f < raw.frames.length; f++) { const d = rel(f); if (Math.hypot(d[0] - h0[0], d[1] - h0[1], d[2] - h0[2]) > 0.03) return f; }
  return 0;
}
// frame where the hand (chest-relative) is furthest from where it started in the guard: a contact estimate for
// a punch clip whose punch the reach detector missed (label set by override, e.g. wide hooks)
function farthestHandFrame(raw, side) {
  const B = Object.fromEntries(raw.bones.map((n, i) => [n, i]));
  const rel = (fr) => { const h = fr.p[B[side + 'Hand']], c = fr.p[B.Spine2]; return [h[0] - c[0], h[1] - c[1], h[2] - c[2]]; };
  const r0 = rel(raw.frames[0]);
  let best = 0, bf = 0;
  raw.frames.forEach((fr, f) => { const r = rel(fr); const d = Math.hypot(r[0] - r0[0], r[1] - r0[1], r[2] - r0[2]); if (d > best) { best = d; bf = f; } });
  return bf;
}

// frame where both gloves are closest to the head: the middle of a block's hold
function tightestGuardFrame(raw) {
  const B = Object.fromEntries(raw.bones.map((n, i) => [n, i]));
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let best = Infinity, bf = 0;
  raw.frames.forEach((fr, f) => { const h = fr.p[B.Head]; const m = Math.max(d(fr.p[B.LeftHand], h), d(fr.p[B.RightHand], h)); if (m < best) { best = m; bf = f; } });
  return bf;
}

export function bake(outDir, rows, raws) {
  mkdirSync(outDir, { recursive: true });
  const first = raws[rows[0].slug];
  const bones = first.bones, nb = bones.length;
  const hipH = first.rest[0].head[1];
  const parts = [], clips = [];
  let offset = 0;
  for (const r of rows) {
    const raw = raws[r.slug];
    const restInv = raw.rest.map((b) => qinv(b.q));
    const n = raw.frames.length;
    const buf = Buffer.alloc(n * (nb * 4 + 3) * 2);
    let o = 0;
    const prev = [];
    for (let f = 0; f < n; f++) {
      const fr = raw.frames[f];
      for (let b = 0; b < nb; b++) {
        let d = qnorm(qmul(fr.q[b], restInv[b]));
        if (prev[b] && d[0] * prev[b][0] + d[1] * prev[b][1] + d[2] * prev[b][2] + d[3] * prev[b][3] < 0) d = d.map((v) => -v);   // continuous sign
        prev[b] = d;
        for (let k = 0; k < 4; k++) { buf.writeInt16LE(Math.round(d[k] * Q), o); o += 2; }
      }
      for (let k = 0; k < 3; k++) { buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((fr.p[0][k] / hipH) * H))), o); o += 2; }
    }
    parts.push(buf);
    const s = r.stats;
    const lead = s.stance.includes('southpaw') ? 'Right' : 'Left';
    const isPunchClip = r.label.startsWith('combo') || r.punches.some((p) => p.type === r.label);
    const punches = isPunchClip ? r.punches.map((p) => ({ type: p.type, side: p.side, from: p.from, to: p.to, peak: p.frame })) : [];
    const punchLabel = /^(jab|cross|(body )?(lead|rear) (hook|uppercut)|body (jab|cross))$/.test(r.label);
    if (!punches.length && punchLabel) {
      const side = /^(jab|lead|body jab|body lead)/.test(r.label) ? lead : lead === 'Left' ? 'Right' : 'Left';
      punches.push({ type: r.label, side, from: 0, to: n - 1, peak: farthestHandFrame(raw, side) });
    }
    clips.push({
      slug: r.slug, file: r.file, label: r.label, fps: raw.fps, frames: n, offset, loop: r.loop, inPlace: r.inPlace,
      travel: { net: s.netTravel, peak: s.peakTravel, dir: s.travelDir }, stance: s.stance,
      punches, impact: /^hit /.test(r.label) ? impactFrame(raw) : null,
    });
    offset += buf.length;
  }
  const bin = Buffer.concat(parts);
  writeFileSync(join(outDir, 'clips.bin'), bin);
  const index = {
    format: 'mocap-bake/1',
    convention: 'world-space rotation deltas from the source T-pose, quats xyzw Int16/32767; hips / hipHeight Int16/8192; metres, Y up, faces +Z, left = +X',
    bones, parents: first.parents, quatScale: Q, hipsScale: H, stride: nb * 4 + 3,
    source: {
      name: 'Mixamo Y Bot (T-pose)', hipHeight: hipH,
      rest: first.rest.map((b) => ({ name: b.name, head: b.head, tail: b.tail, q: b.q })),
      landmarks: first.landmarks,
    },
    clips,
  };
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index));

  // roles
  const roles = {};
  const slips = findSlips(rows, raws);
  const live =rows.filter((r) => !r.dupOf).map((r) => ({ r, c: clips.find((c) => c.slug === r.slug) }));
  for (const [role, spec] of Object.entries(ROLES)) {
    let pick = null;
    if (spec.walk || spec.step) {
      // walk_*: the most cyclic guarded step clip (first/last pose closest); step_*: the shortest single step
      const dir = spec.walk || spec.step;
      const cands = live.filter(({ r }) => r.label === 'step ' + dir);
      cands.sort(spec.walk ? (a, b) => a.r.stats.loopAngle - b.r.stats.loopAngle : (a, b) => a.r.stats.seconds - b.r.stats.seconds);
      let best = cands[0];
      if (spec.step && cands.length > 1 && roles['walk_' + { forward: 'fwd', back: 'back', left: 'left', right: 'right' }[dir]]?.slug === best.c.slug) best = cands[1];
      if (best) pick = { slug: best.c.slug, from: 0, to: best.c.frames - 1, travel: best.r.stats.netTravel };
    } else if (spec.punch) {
      // head-level first: a single-punch clip (least travel), then a cut from a combo; failing both, the
      // body-level version of the same punch, flagged body: true so the game knows it lands low
      const wants = Array.isArray(spec.punch) ? spec.punch : [spec.punch, 'body ' + spec.punch];
      for (const want of wants) {
        const singles = live.filter(({ r, c }) => c.punches.length === 1 && c.punches[0].type === want && r.usable !== 'no').sort((a, b) => a.r.stats.peakTravel - b.r.stats.peakTravel);
        if (singles.length) { const { c } = singles[0]; pick = { slug: c.slug, from: 0, to: c.frames - 1, contact: c.punches[0].peak }; }
        else for (const { c } of live) { const p = c.punches.find((q) => q.type === want); if (p) { pick = { slug: c.slug, from: p.from, to: p.to, contact: p.peak }; break; } }
        if (pick) { if (want.startsWith('body ') && !role.startsWith('body_')) pick.body = true; break; }
      }
    } else if (spec.slip) {
      pick = slips[spec.slip] ?? null;
    } else {
      const cands = live.filter(({ r }) => spec.labels.some((l) => (l.endsWith('*') ? r.label.startsWith(l.slice(0, -1)) : r.label === l)));
      if (spec.knockdown) {
        // cleanest first = least travel; the others become knockdown_2, knockdown_3 ...
        cands.sort((a, b) => a.r.stats.netTravel - b.r.stats.netTravel);
        cands.forEach(({ c }, k) => { roles[k ? `knockdown_${k + 1}` : 'knockdown'] = { slug: c.slug, from: 0, to: c.frames - 1, settle: settleFrame(raws[c.slug]) }; });
        if (!cands.length) roles.knockdown = null;
        continue;
      }
      if (spec.hit) {
        if (spec.prefer) cands.sort((a, b) => (spec.prefer.test(b.r.label) ? 1 : 0) - (spec.prefer.test(a.r.label) ? 1 : 0));
        const inPlace = cands.filter(({ r }) => r.inPlace && (!spec.prefer || spec.prefer.test(r.label))).sort((a, b) => a.r.stats.headPeak - b.r.stats.headPeak);
        const m = inPlace[Math.floor((inPlace.length - 1) / 2)] || cands[0];
        if (m) pick = { slug: m.c.slug, from: 0, to: m.c.frames - 1, impact: m.c.impact };
      } else {
        const best = cands.sort((a, b) => (b.r.loop - a.r.loop) || (b.r.stats.guardFrac - a.r.stats.guardFrac) || (a.r.stats.peakTravel - b.r.stats.peakTravel))[0];
        if (best) pick = { slug: best.c.slug, from: 0, to: best.c.frames - 1 };
        if (best && role === 'block') pick.contact = tightestGuardFrame(raws[best.c.slug]);
        if (best && role === 'block_hit') pick.impact = tightestGuardFrame(raws[best.c.slug]);   // the gloves crushed onto the head = the shot arriving
      }
    }
    roles[role] = pick;
  }
  // Alternates: the other single-punch head crosses as cross_2, cross_3 ... (least travel first, as the pick);
  // the other guard-up idles as idle_2, idle_3 ... (each fighter gets a different one).
  if (roles.cross) {
    const alts = live.filter(({ r, c }) => c.punches.length === 1 && c.punches[0].type === 'cross' && c.slug !== roles.cross.slug && r.usable !== 'no').sort((a, b) => a.r.stats.peakTravel - b.r.stats.peakTravel);
    alts.forEach(({ c }, k) => { roles[`cross_${k + 2}`] = { slug: c.slug, from: 0, to: c.frames - 1, contact: c.punches[0].peak }; });
  }
  if (roles.idle) {
    const alts = live.filter(({ r, c }) => r.label.startsWith('fight idle') && c.slug !== roles.idle.slug).sort((a, b) => (b.r.loop - a.r.loop) || (b.r.stats.guardFrac - a.r.stats.guardFrac));
    alts.forEach(({ c }, k) => { roles[`idle_${k + 2}`] = { slug: c.slug, from: 0, to: c.frames - 1 }; });
  }
  // Two-punch combinations: combo_<first>_<second> (jab, cross, lead_hook, rear_hook, lead_uppercut, rear_uppercut).
  // from = where the first hand is on its way back (half way from its contact to its end, never before the second
  // punch starts winding), contact = the second punch's contact; first = the first punch's mark. body: true when
  // the combination is thrown to the body (head-level ones are preferred).
  const norm = (t) => t.replace(/^body /, '').replace(/ /g, '_');
  const combos = {};
  for (const { r, c } of live) {
    if (!r.label.startsWith('combo') || c.punches.length !== 2) continue;
    const [a, b] = c.punches;
    const name = `combo_${norm(a.type)}_${norm(b.type)}`;
    const body = a.type.startsWith('body ') || b.type.startsWith('body ');
    if (combos[name] && !(combos[name].body && !body)) continue;
    // enter as the first hand starts back (a quarter of its way home): late enough not to replay the first punch,
    // early enough that the second has a real wind-up (entering at half way left 6 frames: a frozen pose, lifted by the aim)
    const from = Math.max(b.from, Math.round(a.peak + (a.to - a.peak) * 0.25));
    combos[name] = { slug: c.slug, from: Math.min(from, b.peak - 2), to: Math.min(c.frames - 1, b.to + Math.round((b.to - b.peak) * 0.5)), contact: b.peak, first: { from: a.from, to: a.to, contact: a.peak }, ...(body ? { body: true } : {}) };
  }
  Object.assign(roles, combos);
  // HAND-SET ROLES SURVIVE A RE-BAKE (2026-11-23: a bake for four new takes wiped 145 lines of hand-set roles — the v2
  // uppercut, the combinations' trims, the knockdown get-up, the calm hits). A role already in roles.json with a value
  // is kept as it is; the picks above only fill roles that are missing or null.
  const rolesPath = join(outDir, 'roles.json');
  const kept = existsSync(rolesPath) ? JSON.parse(readFileSync(rolesPath, 'utf8')) : {};
  for (const [k, v] of Object.entries(kept)) if (v !== null) roles[k] = v;
  writeFileSync(rolesPath, JSON.stringify(roles, null, 1) + '\n');
  return { clips: clips.length, bytes: bin.length + JSON.stringify(index).length, roles: Object.entries(roles).map(([k, v]) => `${k}=${v ? v.slug : 'null'}`).join(' ') };
}
