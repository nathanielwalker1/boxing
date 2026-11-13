/**
 * rig/geo.ts — the mesh builder under the anatomy (overhaul 2026-11-11).
 *
 * Everything on the fighter is a GRID: `rows × cols` points from a function,
 * stitched into quads, optionally wrapped around (a loft: rings of vertices
 * along a bone chain). A grid gets smooth normals from its own neighbours
 * (the wrap seam shares them), a per-vertex ambient-occlusion tint from its
 * curvature (so a groove between two muscles is darker without a texture),
 * blended skin weights (up to 4 bones) from a function of the bind position,
 * UVs into one rect of the fighter's atlas, and a material kind.
 *
 * Vertices are authored in the BIND pose, in the rig's local frame (+x
 * forward, +y up, +z the fighter's right). The skeleton carries inverse bind
 * matrices (mesh.ts), so a vertex may follow several bones.
 */
import * as THREE from 'three';

/** A rect of the atlas, in 0..1 UV units (origin top-left, as the canvas is painted). */
export interface Rect { x: number; y: number; w: number; h: number }
/** [bone index, weight]. */
export type BW = [number, number];

/** Material kinds (the `aKind` vertex attribute; materials.ts shades by it). */
export const KIND = { skin: 0, face: 1, cloth: 2, leather: 3, hair: 4, eye: 5, rubber: 6 } as const;

export class Geo {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = [];
  si: number[] = []; sw: number[] = []; kind: number[] = []; idx: number[] = [];
  /** Sparse morph deltas: name → vertex → [dx, dy, dz]. */
  morph = new Map<string, Map<number, [number, number, number]>>();

  /** Named runs of vertices and indices (a part builder's output), for the clipping check: which vertices are the trunks, which the skin. */
  parts: { name: string; v0: number; v1: number; i0: number; i1: number }[] = [];

  /** Run a part builder and record the vertices and indices it added under `name`. */
  part(name: string, build: () => void): void {
    const v0 = this.count, i0 = this.idx.length;
    build();
    this.parts.push({ name, v0, v1: this.count, i0, i1: this.idx.length });
  }

  get count(): number { return this.pos.length / 3; }
  get triangles(): number { return this.idx.length / 3; }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: readonly [number, number, number], w: readonly BW[], kind: number): number {
    const i = this.count;
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    // Keep the 4 heaviest bones, normalised.
    const ws = w.filter(b => b[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const b of ws) sum += b[1];
    if (ws.length === 0 || sum <= 0) throw new Error('geo: a vertex has no bone');
    for (let k = 0; k < 4; k++) {
      this.si.push(k < ws.length ? ws[k]![0] : 0);
      this.sw.push(k < ws.length ? ws[k]![1] / sum : 0);
    }
    this.kind.push(kind);
    return i;
  }

  addMorph(name: string, vi: number, dx: number, dy: number, dz: number): void {
    if (dx * dx + dy * dy + dz * dz < 1e-12) return;
    let m = this.morph.get(name);
    if (!m) { m = new Map(); this.morph.set(name, m); }
    const have = m.get(vi);
    if (have) { have[0] += dx; have[1] += dy; have[2] += dz; } else m.set(vi, [dx, dy, dz]);
  }

  /** `morphNames` fixes the morph target order (missing ones are all-zero targets). */
  build(morphNames: readonly string[]): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(this.kind, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    if (morphNames.length) {
      g.morphAttributes.position = morphNames.map(name => {
        const arr = new Float32Array(this.count * 3);
        const m = this.morph.get(name);
        if (m) for (const [vi, d] of m) { arr[vi * 3] = d[0]; arr[vi * 3 + 1] = d[1]; arr[vi * 3 + 2] = d[2]; }
        const a = new THREE.Float32BufferAttribute(arr, 3);
        a.name = name;
        return a;
      });
      g.morphTargetsRelative = true;
    }
    return g;
  }
}

export interface GridSpec {
  rows: number;
  /** Segments around (wrap) or vertex columns (open). */
  cols: number;
  wrap: boolean;
  /** Bind-pose point for row i, column j (j < cols). */
  point: (i: number, j: number, out: THREE.Vector3) => void;
  weights: (p: THREE.Vector3, i: number, j: number) => readonly BW[];
  rect: Rect;
  kind: number;
  /** Per-vertex kind, where one grid crosses two materials (a sleeve ending on an arm). */
  kindAt?: (p: THREE.Vector3, i: number, j: number) => number;
  /** UV inside the rect, 0..1 each (default: u = j / cols, v = i / (rows − 1)). */
  uv?: (i: number, j: number) => readonly [number, number];
  /** Colour multiplier on top of the atlas (default white). */
  tint?: (p: THREE.Vector3, i: number, j: number) => readonly [number, number, number];
  /** Curvature AO strength (0 = none). */
  ao?: number;
  /** Reflect every point through z = 0 (the other side's limb). */
  mirror?: boolean;
  /** Morph deltas for a vertex, by name. */
  morph?: (p: THREE.Vector3, i: number, j: number) => Readonly<Record<string, readonly [number, number, number]>> | null;
  /** Approximate outward direction at a point, for surfaces that are not a tube round their own rows (default: away from the row's centroid). */
  outward?: (p: THREE.Vector3, out: THREE.Vector3) => void;
  /** Draw both faces (open cloth edges): adds the reversed triangles too. */
  doubleSided?: boolean;
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
const WHITE: readonly [number, number, number] = [1, 1, 1];

/** Add a grid; returns the vertex index of (i, j). */
export function addGrid(g: Geo, s: GridSpec): (i: number, j: number) => number {
  const R = s.rows, C = s.cols, VC = s.wrap ? C + 1 : C;
  const P: THREE.Vector3[] = new Array(R * C);
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    const p = new THREE.Vector3();
    s.point(i, j, p);
    if (s.mirror) p.z = -p.z;
    P[i * C + j] = p;
  }
  const at = (i: number, j: number): THREE.Vector3 => P[i * C + (s.wrap ? ((j % C) + C) % C : Math.min(C - 1, Math.max(0, j)))]!;
  // Row centroids (for orientation and pole normals).
  const cen: THREE.Vector3[] = [];
  const ext: number[] = [];
  for (let i = 0; i < R; i++) {
    const c = new THREE.Vector3();
    for (let j = 0; j < C; j++) c.add(P[i * C + j]!);
    c.divideScalar(C);
    let e = 0;
    for (let j = 0; j < C; j++) e = Math.max(e, c.distanceToSquared(P[i * C + j]!));
    cen.push(c); ext.push(Math.sqrt(e));
  }
  // Normals from the grid's own neighbours.
  const N: THREE.Vector3[] = new Array(R * C);
  const pole = new Uint8Array(R * C);
  let orient = 0;
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) {
    const p = P[i * C + j]!;
    _a.subVectors(at(i, j + 1), at(i, j - 1));
    _b.subVectors(at(Math.min(R - 1, i + 1), j), at(Math.max(0, i - 1), j));
    const n = new THREE.Vector3().crossVectors(_a, _b);
    if (n.lengthSq() < 1e-16) {
      // A collapsed row (a pole): along the chain, away from the neighbouring row.
      const k = i === 0 ? 1 : i === R - 1 ? R - 2 : (ext[i - 1]! > ext[i + 1]! ? i - 1 : i + 1);
      n.subVectors(cen[i]!, cen[k]!);
      if (n.lengthSq() < 1e-16) n.set(0, 1, 0);
      n.normalize();
      pole[i * C + j] = 1;   // already oriented: never flipped
    } else {
      n.normalize();
      if (s.outward) { s.outward(p, _c); orient += n.dot(_c); }
      else if (ext[i]! > 1e-6) orient += n.dot(_c.subVectors(p, cen[i]!));
    }
    N[i * C + j] = n;
  }
  const flip = orient < 0;
  if (flip) for (let k = 0; k < N.length; k++) if (!pole[k]) N[k]!.negate();
  // Curvature AO.
  const ao = s.ao ?? 0;
  const first = g.count;
  const vi = (i: number, j: number): number => first + i * VC + j;
  for (let i = 0; i < R; i++) for (let j = 0; j < VC; j++) {
    const jj = j % C;
    const p = P[i * C + jj]!, n = N[i * C + jj]!;
    let shade = 1;
    if (ao > 0 && ext[i]! > 1e-6) {
      _a.copy(at(i, jj + 1)).add(at(i, jj - 1)).add(at(Math.min(R - 1, i + 1), jj)).add(at(Math.max(0, i - 1), jj)).multiplyScalar(0.25);
      const scale = 0.5 * (at(i, jj + 1).distanceTo(at(i, jj - 1)) + at(Math.min(R - 1, i + 1), jj).distanceTo(at(Math.max(0, i - 1), jj))) + 1e-6;
      const curv = n.dot(_b.subVectors(_a, p)) / scale;     // > 0: the neighbours stand above this vertex (a groove)
      shade = 1 - Math.max(-0.12, Math.min(0.42, curv * ao));
    }
    const t = s.tint ? s.tint(p, i, jj) : WHITE;
    const uvw = s.uv ? s.uv(i, j) : [j / (s.wrap ? C : C - 1), i / (R - 1)] as const;
    const idx = g.vert(p, n, s.rect.x + uvw[0] * s.rect.w, 1 - (s.rect.y + uvw[1] * s.rect.h), [t[0] * shade, t[1] * shade, t[2] * shade], s.weights(p, i, jj), s.kindAt ? s.kindAt(p, i, jj) : s.kind);
    if (s.morph) {
      const m = s.morph(p, i, jj);
      if (m) for (const name in m) { const d = m[name]!; g.addMorph(name, idx, d[0], d[1], s.mirror ? -d[2] : d[2]); }
    }
  }
  // Triangles, wound to agree with the normals.
  const quad = (a: number, b: number, c: number, d: number, rev: boolean): void => {
    if (rev) { g.idx.push(a, c, b, a, d, c); } else { g.idx.push(a, b, c, a, c, d); }
  };
  // Decide the winding once from a quad with area.
  let rev = false, decided = false;
  for (let i = 0; i < R - 1 && !decided; i++) for (let j = 0; j < VC - 1 && !decided; j++) {
    const pa = at(i, j), pb = at(i, j + 1), pc = at(i + 1, j + 1);
    _n.crossVectors(_a.subVectors(pb, pa), _b.subVectors(pc, pa));
    if (_n.lengthSq() < 1e-14) continue;
    const vn = N[i * C + (j % C)]!;
    if (pole[i * C + (j % C)]) continue;
    rev = _n.dot(vn) < 0;
    decided = true;
  }
  for (let i = 0; i < R - 1; i++) {
    const upper = ext[i]! < 1e-7, lower = ext[i + 1]! < 1e-7;
    if (upper && lower) continue;
    for (let j = 0; j < VC - 1; j++) {
      const a = vi(i, j), b = vi(i, j + 1), c = vi(i + 1, j + 1), d = vi(i + 1, j);
      if (upper) { if (rev) g.idx.push(a, d, c); else g.idx.push(a, c, d); if (s.doubleSided) { if (rev) g.idx.push(a, c, d); else g.idx.push(a, d, c); } }
      else if (lower) { if (rev) g.idx.push(a, d, b); else g.idx.push(a, b, d); if (s.doubleSided) { if (rev) g.idx.push(a, b, d); else g.idx.push(a, d, b); } }
      else { quad(a, b, c, d, rev); if (s.doubleSided) quad(a, b, c, d, !rev); }
    }
  }
  return vi;
}

// ── Shape helpers ────────────────────────────────────────────────────────────

/** Hermite interpolation through keyed rows of numbers: `keys` ascending, `vals[k]` the row at keys[k]. */
export function sampleKeys(keys: readonly number[], vals: readonly (readonly number[])[], t: number, out: number[]): number[] {
  const n = keys.length;
  let k = 0;
  while (k < n - 2 && t > keys[k + 1]!) k++;
  const t0 = keys[k]!, t1 = keys[k + 1]!;
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  const a = vals[k]!, b = vals[k + 1]!;
  const pa = vals[Math.max(0, k - 1)]!, pb = vals[Math.min(n - 1, k + 2)]!;
  const ta = keys[Math.max(0, k - 1)]!, tb = keys[Math.min(n - 1, k + 2)]!;
  const h00 = 2 * u * u * u - 3 * u * u + 1, h10 = u * u * u - 2 * u * u + u, h01 = -2 * u * u * u + 3 * u * u, h11 = u * u * u - u * u;
  for (let c = 0; c < a.length; c++) {
    // Catmull-Rom tangents on non-uniform keys, scaled to this span; clamped so the curve never overshoots a flat run.
    let m0 = k === 0 ? (b[c]! - a[c]!) / (t1 - t0) : (b[c]! - pa[c]!) / (t1 - ta);
    let m1 = k + 2 > n - 1 ? (b[c]! - a[c]!) / (t1 - t0) : (pb[c]! - a[c]!) / (tb - t0);
    const d = (b[c]! - a[c]!) / (t1 - t0);
    if (d === 0) { m0 = 0; m1 = 0; }
    else { if (m0 / d < 0) m0 = 0; else if (m0 / d > 3) m0 = 3 * d; if (m1 / d < 0) m1 = 0; else if (m1 / d > 3) m1 = 3 * d; }
    out[c] = h00 * a[c]! + h10 * (t1 - t0) * m0 + h01 * b[c]! + h11 * (t1 - t0) * m1;
  }
  return out;
}

/** Row parameters: each key span cut into `counts[k]` steps (halved on the low tier). */
export function rowParams(keys: readonly number[], counts: readonly number[], lowTier: boolean): number[] {
  const out: number[] = [];
  for (let k = 0; k < keys.length - 1; k++) {
    const n = Math.max(1, lowTier ? Math.ceil(counts[k]! / 2) : counts[k]!);
    for (let s = 0; s < n; s++) out.push(keys[k]! + (keys[k + 1]! - keys[k]!) * s / n);
  }
  out.push(keys[keys.length - 1]!);
  return out;
}

/** Superellipse coordinate: sign(c)·|c|^(2/n). n = 2 is an ellipse, higher is boxier. */
export function sgnPow(c: number, n: number): number {
  return Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
}

/** A smooth bump: 1 at 0, falling to 0 at ±1 (and flat beyond). */
export function bump(x: number): number {
  const a = Math.abs(x);
  if (a >= 1) return 0;
  const t = 1 - a * a;
  return t * t;
}

/** Angle difference wrapped to −π..π. */
export function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function smooth01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}
