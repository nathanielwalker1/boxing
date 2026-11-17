/**
 * Baked mocap clips (public/fighter/clips/, written by `npm run mocap`, tools/mocap/bake.mjs): decode,
 * sample at a time with interpolation, mirror, crossfade. Pure TypeScript: no three.js, no DOM, so the sim
 * and Node tests can use it.
 *
 * A sampled Pose is skeleton-independent: per source bone the WORLD-space rotation delta from the source
 * T-pose (D_b = W_b(t) * inverse(W_b_rest)), plus the Hips position divided by the source hip height.
 * Axes: Y up, the character faces +Z at rest, his left is +X. retarget.ts fits a Pose onto our skeleton.
 */

export type Quat = [number, number, number, number];   // x, y, z, w
export type Vec3 = [number, number, number];

export interface PunchMark { type: string; side: 'Left' | 'Right'; from: number; to: number; peak: number }
export interface ClipInfo {
  slug: string; file: string; label: string; fps: number; frames: number; offset: number;
  loop: boolean; inPlace: boolean; stance: string;
  travel: { net: number; peak: number; dir: string };
  punches: PunchMark[]; impact: number | null;
}
export interface SourceRest {
  name: string; hipHeight: number;
  rest: { name: string; head: Vec3; tail: Vec3; q: Quat }[];
  landmarks: Record<string, Vec3>;
}
export interface BakeIndex {
  format: string; bones: string[]; parents: number[];
  quatScale: number; hipsScale: number; stride: number;
  source: SourceRest; clips: ClipInfo[];
}
/** One entry of roles.json. contact: punch full extension / block tightest guard / slip deepest point;
 *  impact: frame a hit reaction's blow lands; settle: frame a knockdown comes to rest; body: a head-punch role
 *  filled by a body-level clip; travel: net metres of a walk / step; amount: metres of a slip's head offset. */
export interface Role {
  slug: string; from: number; to: number; contact?: number; impact?: number | null;
  settle?: number; body?: boolean; travel?: number; amount?: number;
  /** A SYNTHESISED take (synthClips): the clip `slug` played through these [from, to] frame segments in order, a
   *  segment with from > to played backwards (a straight punch reversed is still a straight punch). from / to /
   *  contact then count frames of the synthesised take. */
  seq?: [number, number][];
  /** Seconds the drawn body takes to blend from the guard into this take's first frame (a trimmed take that starts
   *  mid-move, e.g. the uppercut entered at hip height: the wind-up is spent easing into it). */
  easeIn?: number;
}

/**
 * Build the synthesised takes of roles.json (roles with `seq`) as clips of their own, slug `syn_<role>`, and point
 * those roles at them. Idempotent per roles object. Call once after decode, before anything reads the roles.
 */
export function synthClips(lib: ClipLib, roles: Roles): void {
  const nb = lib.bones.length;
  for (const [name, r] of Object.entries(roles)) {
    if (!r?.seq) continue;
    const slug = 'syn_' + name;
    if (r.slug === slug && lib.clips.has(slug)) continue;
    const src = lib.clips.get(r.slug);
    if (!src) continue;
    const frames: number[] = [];
    for (const [a, b] of r.seq) {
      const d = a <= b ? 1 : -1;
      for (let f = a; d > 0 ? f <= b : f >= b; f += d) if (frames[frames.length - 1] !== f) frames.push(Math.max(0, Math.min(src.frames - 1, f)));
    }
    const rot = new Float32Array(frames.length * nb * 4), hips = new Float32Array(frames.length * 3);
    frames.forEach((f, i) => { rot.set(src.rot.subarray(f * nb * 4, (f + 1) * nb * 4), i * nb * 4); hips.set(src.hips.subarray(f * 3, f * 3 + 3), i * 3); });
    lib.clips.set(slug, { ...src, slug, label: `${src.label} (synthesised: ${name})`, frames: frames.length, punches: [], impact: null, rot, hips, duration: (frames.length - 1) / src.fps });
    r.slug = slug;
  }
}
export type Roles = Record<string, Role | null>;

export interface Clip extends ClipInfo {
  rot: Float32Array;    // frames * bones * 4
  hips: Float32Array;   // frames * 3 (normalised by source hip height)
  duration: number;     // seconds, (frames - 1) / fps
}
export interface ClipLib {
  index: BakeIndex;
  bones: string[];
  mirrorOf: number[];   // bone index of the left/right twin (self for centre bones)
  clips: Map<string, Clip>;
}
export interface Pose { rot: Float32Array; hips: Float32Array }

export function decode(index: BakeIndex, buf: ArrayBuffer): ClipLib {
  const nb = index.bones.length;
  const clips = new Map<string, Clip>();
  const view = new DataView(buf);
  for (const info of index.clips) {
    const rot = new Float32Array(info.frames * nb * 4), hips = new Float32Array(info.frames * 3);
    let o = info.offset;
    for (let f = 0; f < info.frames; f++) {
      for (let k = 0; k < nb * 4; k++, o += 2) rot[f * nb * 4 + k] = view.getInt16(o, true) / index.quatScale;
      for (let k = 0; k < 3; k++, o += 2) hips[f * 3 + k] = view.getInt16(o, true) / index.hipsScale;
      for (let b = 0; b < nb; b++) normalize(rot, (f * nb + b) * 4);
    }
    clips.set(info.slug, { ...info, rot, hips, duration: (info.frames - 1) / info.fps });
  }
  const twin = (n: string): string => (n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n);
  return { index, bones: index.bones, mirrorOf: index.bones.map(n => index.bones.indexOf(twin(n))), clips };
}

export function makePose(nb: number): Pose { return { rot: new Float32Array(nb * 4), hips: new Float32Array(3) }; }

export interface SampleOpts {
  mirror?: boolean;           // left/right swapped, reflected across the sagittal plane
  root?: 'full' | 'inPlace';  // inPlace pins the Hips' horizontal position at the clip's first frame
  loop?: boolean;             // wrap t over the clip's duration (default: clamp)
}

/** Pose of `clip` at `t` seconds (interpolated between frames). */
export function sample(lib: ClipLib, clip: Clip, t: number, opts: SampleOpts, out: Pose): Pose {
  const nb = lib.bones.length;
  const d = clip.duration;
  const tt = opts.loop && d > 0 ? ((t % d) + d) % d : Math.max(0, Math.min(d, t));
  const ff = tt * clip.fps;
  const f0 = Math.min(clip.frames - 1, Math.floor(ff)), f1 = Math.min(clip.frames - 1, f0 + 1), w = ff - f0;
  const mirror = !!opts.mirror;
  for (let b = 0; b < nb; b++) {
    const src = mirror ? lib.mirrorOf[b]! : b;
    const a = (f0 * nb + src) * 4, c = (f1 * nb + src) * 4, o = b * 4;
    nlerpInto(clip.rot, a, clip.rot, c, w, out.rot, o);
    if (mirror) { out.rot[o + 1] = -out.rot[o + 1]!; out.rot[o + 2] = -out.rot[o + 2]!; }
  }
  for (let k = 0; k < 3; k++) out.hips[k] = clip.hips[f0 * 3 + k]! * (1 - w) + clip.hips[f1 * 3 + k]! * w;
  if (opts.root === 'inPlace') { out.hips[0] = clip.hips[0]!; out.hips[2] = clip.hips[2]!; }
  if (mirror) out.hips[0] = -out.hips[0]!;
  return out;
}

/** Mirror a pose in place-free fashion (out may not alias p). Mirror twice = identity. */
export function mirrorPose(lib: ClipLib, p: Pose, out: Pose): Pose {
  for (let b = 0; b < lib.bones.length; b++) {
    const s = lib.mirrorOf[b]! * 4, o = b * 4;
    out.rot[o] = p.rot[s]!; out.rot[o + 1] = -p.rot[s + 1]!; out.rot[o + 2] = -p.rot[s + 2]!; out.rot[o + 3] = p.rot[s + 3]!;
  }
  out.hips[0] = -p.hips[0]!; out.hips[1] = p.hips[1]!; out.hips[2] = p.hips[2]!;
  return out;
}

/** out = blend from a (w = 0) to b (w = 1). out may alias a. */
export function crossfade(a: Pose, b: Pose, w: number, out: Pose): Pose {
  for (let i = 0; i < a.rot.length; i += 4) nlerpInto(a.rot, i, b.rot, i, w, out.rot, i);
  for (let k = 0; k < 3; k++) out.hips[k] = a.hips[k]! * (1 - w) + b.hips[k]! * w;
  return out;
}

// ---- small quaternion helpers (shared with retarget.ts) ----
export function normalize(q: Float32Array | number[], o: number): void {
  const l = Math.hypot(q[o]!, q[o + 1]!, q[o + 2]!, q[o + 3]!) || 1;
  q[o] = q[o]! / l; q[o + 1] = q[o + 1]! / l; q[o + 2] = q[o + 2]! / l; q[o + 3] = q[o + 3]! / l;
}
function nlerpInto(a: Float32Array, ao: number, b: Float32Array, bo: number, w: number, out: Float32Array, o: number): void {
  const s = a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]! < 0 ? -1 : 1;
  for (let k = 0; k < 4; k++) out[o + k] = a[ao + k]! * (1 - w) + b[bo + k]! * w * s;
  normalize(out, o);
}
export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qinv = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export function qrot(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}
export const poseQuat = (p: Pose, b: number): Quat => [p.rot[b * 4]!, p.rot[b * 4 + 1]!, p.rot[b * 4 + 2]!, p.rot[b * 4 + 3]!];
