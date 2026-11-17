// Per-clip motion stats from a mocap-raw/1 file (metres, Y up, faces +Z, character's left = +X).
// The opponent is taken to be along +Z for the whole clip (Mixamo boxing clips are authored that way);
// hipsYaw0 / yawNet report how far the body actually turns.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const deg = (r) => (r * 180) / Math.PI;
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

export function clipStats(raw) {
  const B = Object.fromEntries(raw.bones.map((n, i) => [n, i]));
  const F = raw.frames;
  const n = F.length;
  const fps = raw.fps;
  const P = (f, b) => F[f].p[B[b]];
  const restHipY = raw.rest[B.Hips].head[1];
  const armLen = (s) => raw.rest[B[s + 'Arm']].length + raw.rest[B[s + 'ForeArm']].length;

  // root travel (hips, horizontal)
  const h0 = P(0, 'Hips');
  let peakTravel = 0;
  for (let f = 0; f < n; f++) { const d = sub(P(f, 'Hips'), h0); peakTravel = Math.max(peakTravel, Math.hypot(d[0], d[2])); }
  const hN = P(n - 1, 'Hips');
  const net = [hN[0] - h0[0], hN[2] - h0[2]]; // [x(left), z(forward)]
  const netTravel = Math.hypot(net[0], net[1]);
  const dirWord = (x, z) => (Math.abs(z) >= Math.abs(x) ? (z > 0 ? 'forward' : 'back') : x > 0 ? 'left' : 'right');

  // hips yaw from the hip-joint line (0 = square to +Z)
  const yaw = (f) => { const d = sub(P(f, 'LeftUpLeg'), P(f, 'RightUpLeg')); return deg(Math.atan2(-d[2], d[0])); };
  const yaws = F.map((_, f) => yaw(f));
  let yawPeak = 0;
  for (const y of yaws) if (Math.abs(y - yaws[0]) > Math.abs(yawPeak)) yawPeak = y - yaws[0];

  // loopability: mean bone-rotation difference first vs last + hips offset
  let ang = 0;
  for (let b = 0; b < raw.bones.length; b++) {
    const a = F[0].q[b], c = F[n - 1].q[b];
    ang += deg(2 * Math.acos(Math.min(1, Math.abs(a[0] * c[0] + a[1] * c[1] + a[2] * c[2] + a[3] * c[3]))));
  }
  const loopAngle = ang / raw.bones.length;
  const loopOffset = len(sub(hN, h0));

  // stance: which foot is further along +Z
  let leftFwd = 0, rightFwd = 0;
  for (let f = 0; f < n; f++) {
    const d = P(f, 'LeftFoot')[2] - P(f, 'RightFoot')[2];
    if (d > 0.08) leftFwd++; else if (d < -0.08) rightFwd++;
  }
  const stance = leftFwd > 0.6 * n ? 'orthodox' : rightFwd > 0.6 * n ? 'southpaw' : leftFwd > rightFwd ? 'mixed (mostly orthodox)' : rightFwd > leftFwd ? 'mixed (mostly southpaw)' : 'square';

  // guard: both wrists near the head (Head bone origin = top of neck) and above the chest joint.
  // Mixamo boxing guards measure 0.27-0.44 m wrist-to-neck-top; non-guard clips 0.5+.
  let guard = 0;
  for (let f = 0; f < n; f++) {
    const h = P(f, 'Head'), c = P(f, 'Spine2')[1];
    const ok = (s) => len(sub(P(f, s), h)) < 0.46 && P(f, s)[1] > c;
    if (ok('LeftHand') && ok('RightHand')) guard++;
  }

  // punches, per hand
  const win = Math.round(0.2 * fps), back = Math.round(0.45 * fps);
  const hands = {};
  for (const s of ['Left', 'Right']) {
    const reach = F.map((_, f) => P(f, s + 'Hand')[2] - P(f, 'Spine2')[2]);
    const base = median(reach);
    const punches = [];
    for (let f = 0; f < n; f++) {
      let isMax = true;
      for (let g = Math.max(0, f - win); g <= Math.min(n - 1, f + win); g++) if (reach[g] > reach[f] || (reach[g] === reach[f] && g < f)) { isMax = false; break; }
      if (!isMax) continue;
      let s0 = f;
      for (let g = Math.max(0, f - back); g < f; g++) if (reach[g] < reach[s0]) s0 = g;
      let e0 = f;
      for (let g = f; g <= Math.min(n - 1, f + back); g++) if (reach[g] < reach[e0]) e0 = g;
      const rise = reach[f] - reach[s0];
      const fall = reach[f] - reach[e0];
      const wrist = P(f, s + 'Hand'), sh = P(f, s + 'Arm'), el = P(f, s + 'ForeArm');
      const ext = len(sub(wrist, sh)) / armLen(s);
      if (!(rise > 0.16 && fall > 0.08 && reach[f] > 0.28)) continue;
      // path shape over the throw, in the chest's frame
      let xMin = Infinity, xMax = -Infinity, yMin = Infinity;
      for (let g = s0; g <= f; g++) {
        const w = sub(P(g, s + 'Hand'), P(g, 'Spine2'));
        xMin = Math.min(xMin, w[0]); xMax = Math.max(xMax, w[0]); yMin = Math.min(yMin, w[1]);
      }
      const wy = wrist[1] - P(f, 'Spine2')[1];
      const u = sub(sh, el), v = sub(wrist, el);
      const elbow = deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v))))));
      // curve: how far the chest-relative wrist path bows away from the straight chord start -> peak,
      // in the horizontal plane (hook arc) — a straight punch stays near its chord even when it crosses the centreline
      const rel = (g) => sub(P(g, s + 'Hand'), P(g, 'Spine2'));
      const a0 = rel(s0), a1 = rel(f);
      const ch = [a1[0] - a0[0], a1[2] - a0[2]], chL = Math.hypot(ch[0], ch[1]) || 1;
      let curve = 0;
      for (let g = s0; g <= f; g++) { const w = rel(g); curve = Math.max(curve, Math.abs(((w[0] - a0[0]) * ch[1] - (w[2] - a0[2]) * ch[0]) / chL)); }
      const outSign = s === 'Left' ? 1 : -1;
      punches.push({
        t: round(f / fps), frame: f, from: s0, to: e0,
        reach: round(reach[f]), ext: round(ext), rise: round(rise),
        lateral: round(xMax - xMin), lift: round(wy - yMin), elbow: Math.round(elbow),
        vsShoulder: round(wrist[1] - sh[1]), vsHips: round(wrist[1] - P(f, 'Hips')[1]),
        wristY: round(wrist[1]), curve: round(curve), elbowUp: round(el[1] - wrist[1]), elbowOut: round((el[0] - sh[0]) * outSign),
      });
    }
    hands[s] = { baseReach: round(base), punches };
  }

  // head displacement in a feet-anchored frame (removes travel)
  const anchor = (f) => { const a = P(f, 'LeftFoot'), b = P(f, 'RightFoot'); return [(a[0] + b[0]) / 2, 0, (a[2] + b[2]) / 2]; };
  const head0 = sub(P(0, 'Head'), anchor(0));
  let hp = [0, 0, 0], hpLen = 0, hpFrame = 0;
  for (let f = 0; f < n; f++) {
    const d = sub(sub(P(f, 'Head'), anchor(f)), head0);
    if (len(d) > hpLen) { hpLen = len(d); hp = d; hpFrame = f; }
  }
  const comps = [['back', -hp[2]], ['forward', hp[2]], ['left', hp[0]], ['right', -hp[0]], ['down', -hp[1]], ['up', hp[1]]].sort((a, b) => b[1] - a[1]);

  let minHip = Infinity, minHipF = 0;
  for (let f = 0; f < n; f++) if (P(f, 'Hips')[1] < minHip) { minHip = P(f, 'Hips')[1]; minHipF = f; }

  return {
    fps, frames: n, seconds: round(n / fps),
    netTravel: round(netTravel), peakTravel: round(peakTravel), travelDir: netTravel > 0.05 ? dirWord(net[0], net[1]) : '-',
    hipsYaw0: Math.round(yaws[0]), yawNet: Math.round(yaws[n - 1] - yaws[0]), yawPeak: Math.round(yawPeak),
    loopAngle: round(loopAngle, 1), loopOffset: round(loopOffset),
    stance, leftFwdFrac: round(leftFwd / n), guardFrac: round(guard / n),
    hands,
    headPeak: round(hpLen), headPeakT: round(hpFrame / fps), headDir: comps[0][0] + (comps[1][1] > 0.5 * comps[0][1] ? '+' + comps[1][0] : ''),
    headVec: hp.map((v) => round(v)),
    hipY0: round(h0[1] / restHipY), hipYEnd: round(hN[1] / restHipY), minHip: round(minHip / restHipY), minHipT: round(minHipF / fps),
  };
}
