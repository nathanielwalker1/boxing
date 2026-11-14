/**
 * rig/kit.ts — what the fighter wears: gloves (a thumb, a cuff; laces and seams
 * are painted), trunks (a waistband, a body and two leg panels whose hems hang
 * on sprung bones; six cuts), boots (sole, toe, a shaft at three heights,
 * tassels), and the referee's bare hands and bow tie (overhaul 2026-11-11).
 *
 * The glove's main body is the sim's glove hit sphere (radius gloveR at the
 * glove bone): it fills it, a little longer along the forearm (rigGloveElongate).
 */
import * as THREE from 'three';
import { addGrid, bump, KIND, rowParams, sampleKeys, sgnPow, smooth01, type BW } from './geo';
import { BONE, armBones, legBones, type Ctx } from './skeleton';
import { legBumps, legSkinWeights, legStations, limbPoint, type TorsoShape } from './anatomy';

const TAU = Math.PI * 2;

// ── Gloves ───────────────────────────────────────────────────────────────────

export function buildGlove(c: Ctx, i: number): void {
  const { body: b, cfg } = c;
  const bones = armBones(i);
  const G = c.bind[bones.glove]!;
  const R = b.gloveR;
  const mirror = c.lat[i]! < 0;
  const rect = c.rect(mirror ? 'gloveL' : 'gloveR');
  const e = cfg.rigGloveElongate;
  const cuffLen = R * cfg.rigCuffLen;
  const wristY = R * 0.66;
  if (c.spec.outfit) {
    // A bare hand: a loose fist.
    const hr = R * cfg.rigHandScale;
    const rows = c.low ? 6 : 8, cols = c.low ? 8 : 12;
    addGrid(c.g, {
      rows, cols, wrap: true, mirror,
      point: (r, j, out) => {
        const phi = -Math.PI / 2 + Math.PI * r / (rows - 1), th = j / cols * TAU;
        out.set(G.x + hr * 0.82 * Math.cos(phi) * Math.cos(th), G.y + hr * 1.2 * Math.sin(phi), Math.abs(G.z) + hr * 0.62 * Math.cos(phi) * Math.sin(th));
      },
      weights: () => [[bones.glove, 1]], rect: c.rect('hand'), kind: KIND.skin, ao: cfg.rigAoStrength * 0.5,
    });
    return;
  }
  // Main body: from the wrist opening (top) round to the knuckles. y/R, rx (thumb axis), rz (palm ↔ back), cz.
  const st: number[][] = [
    [wristY / R, 0.63, 0.6, 0],
    [0.42, 0.84, 0.76, -0.02],
    [0.1, 0.99, 0.9, -0.03],
    [-0.3 * e, 1.0, 0.93, -0.02],
    [-0.68 * e, 0.9, 0.84, 0],
    [-0.92 * e, 0.62, 0.58, 0],
    [-1.0 * e, 0, 0, 0],
  ];
  const keys = st.map(s => -s[0]!), vals = st.map(s => s.slice(1));        // ascending down the glove
  const ts = rowParams(keys, [2, 3, 3, 3, 2, 2], c.low);
  const cols = c.low ? 10 : 16;
  const row = [0, 0, 0];
  const vCuff = 0.3;
  addGrid(c.g, {
    rows: ts.length, cols, wrap: true, mirror,
    point: (r, j, out) => {
      sampleKeys(keys, vals, ts[r]!, row);
      // φ = 0 is the thumb side (+x, u = 0.5); the palm is −z on the right hand (u = 0.25).
      const phi = (j / cols - 0.5) * TAU;
      out.set(G.x + R * row[0]! * sgnPow(Math.cos(phi), 2.3), G.y - ts[r]! * R, Math.abs(G.z) + R * (row[2]! + row[1]! * sgnPow(Math.sin(phi), 2.3)));
    },
    weights: () => [[bones.glove, 1]],
    rect, kind: KIND.leather,
    uv: (r, j) => [j / cols, vCuff + (1 - vCuff) * (ts[r]! - keys[0]!) / (keys[keys.length - 1]! - keys[0]!)],
    ao: cfg.rigAoStrength * 0.5,
  });
  // Thumb: a bent pad down the thumb side, toward the palm.
  {
    const rows = c.low ? 5 : 8, tc = c.low ? 6 : 10;
    addGrid(c.g, {
      rows, cols: tc, wrap: true, mirror,
      point: (r, j, out) => {
        const t = r / (rows - 1);
        const a = j / tc * TAU;
        const rad = R * 0.3 * Math.pow(Math.max(0, Math.sin(Math.PI * t)), 0.55);
        // The pad's centre line: starts by the wrist on the thumb side, runs down and tucks in at the tip.
        const cx = R * (0.74 + 0.2 * Math.sin(Math.PI * t * 0.9)), cy = R * (0.4 - 1.0 * t), cz = -R * (0.36 + 0.12 * t);
        out.set(G.x + cx + rad * 0.85 * Math.cos(a), G.y + cy, Math.abs(G.z) + cz + rad * Math.sin(a));
      },
      weights: () => [[bones.glove, 1]],
      rect: c.rect('thumb'), kind: KIND.leather, ao: cfg.rigAoStrength * 0.4,
      outward: (p, o) => { o.set(p.x - G.x, 0, Math.abs(p.z) - Math.abs(G.z) + R * 0.4); },
    });
  }
  // Cuff: up the wrist, a rolled top that turns in to the forearm.
  {
    const cs = [0, 0.12, 0.5, 0.86, 1.0, 1.03, 0.98];
    const cr = [0.62, 0.66, 0.67, 0.7, 0.71, 0.6, 0.42];
    addGrid(c.g, {
      rows: cs.length, cols, wrap: true, mirror,
      point: (r, j, out) => {
        const phi = (j / cols - 0.5) * TAU;
        out.set(G.x + R * cr[r]! * Math.cos(phi), G.y + wristY - R * 0.04 + cs[r]! * cuffLen, Math.abs(G.z) + R * cr[r]! * 0.94 * Math.sin(phi));
      },
      // The cuff rides the wrist: mostly the glove, easing onto the forearm at its top.
      weights: (p) => { const t = smooth01((p.y - G.y - wristY) / cuffLen); return [[bones.glove, 1 - 0.5 * t], [bones.fore, 0.5 * t]]; },
      rect, kind: KIND.leather,
      uv: (r, j) => [j / cols, vCuff * (1 - Math.min(1, cs[r]!))],
      ao: cfg.rigAoStrength * 0.3,
    });
  }
}

// ── Trunks ───────────────────────────────────────────────────────────────────

export function buildTrunks(c: Ctx, torso: TorsoShape): void {
  const { body: b, d, cfg, spec } = c;
  const hy = b.hipY, sp = b.spineLen, R = b.bodyR;
  const outfit = !!spec.outfit;
  const cut = spec.trunksStyle;
  const bandH = outfit ? R * 0.22 : R * (cut === 'belt' ? 0.9 : 0.5);
  const top = torso.waistY + (outfit ? -sp * 0.1 : sp * 0.1) + (cut === 'belt' ? R * 0.22 : 0);
  const gap = cfg.rigTrunkGap;
  const leg = legStations(c);
  const bumps = legBumps(c);
  // Where the panel ends and the two leg shells begin: at the crotch, a little below the hip joint. The panel's lower rim is the OUTER OUTLINE
  // of the two leg shells' top rings, so the shell is closed all the way round from the waistband to the hem and nothing can show between.
  const sRim = d.thighR * 0.85;
  const rimY = hy - sRim;
  const bottom = outfit ? hy - R * 0.6 : rimY;
  const keys = outfit ? [top, top - bandH, hy + sp * 0.05, hy - R * 0.3, bottom] : [top, top - bandH, hy + sp * 0.05, hy - R * 0.1, bottom];
  const ys = rowParams(keys.map(k => -k), [outfit ? 1 : 3, 4, 3, outfit ? 3 : 4], c.low).map(k => -k);
  const cols = c.low ? 20 : 36;
  const skirt = cut === 'skirt' && !outfit;
  const vBand = 0.26;
  const row = [0, 0, 0, 0];
  let len = Math.max(d.trunkLen, sRim + 0.05);
  const mirrorOf = (i: number): boolean => c.lat[i]! < 0;
  /** Phase 1.3: leg i's shell surface at depth sh and angle phi: the leg's own surface (muscle bumps and all) pushed OUT by gapAt along its own radial. Pre-mirror, local to the joint. */
  const legSurf = (i: number, sh: number, phi: number, gapAt: number, out: THREE.Vector3): void => {
    const J = c.bind[legBones(i).thigh]!;
    limbPoint(leg.keys, leg.vals, bumps, sh, phi, row, out);
    let ex = out.x - row[2]!, ez = out.z - row[3]!;
    const el = Math.hypot(ex, ez) || 1;
    ex /= el; ez /= el;
    out.set(J.x + out.x + ex * gapAt, J.y - sh, Math.abs(J.z) + out.z + ez * gapAt);
  };
  // The union of the two legs' outlines at depth s, as a polygon each (rig-local x, z, post-mirror), for the panel's rim.
  const NP = 48;
  const polyCache = new Map<number, number[][]>();
  const polys = (s: number): number[][] => {
    const hit = polyCache.get(s);
    if (hit) return hit;
    const out: number[][] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      const pts: number[] = [];
      for (let k = 0; k < NP; k++) {
        legSurf(i, s, (k / NP) * TAU, gap, p);
        pts.push(p.x, mirrorOf(i) ? -p.z : p.z);
      }
      out.push(pts);
    }
    polyCache.set(s, out);
    return out;
  };
  /** Farthest distance from the centre line at which the ray at polar angle psi leaves any of the polygons (0 if it hits none). */
  const rayReach = (pl: number[][], psi: number): number => {
    const dx = Math.cos(psi), dz = Math.sin(psi);
    let best = 0;
    for (const pts of pl) {
      for (let k = 0; k < NP; k++) {
        const ax = pts[2 * k]!, az = pts[2 * k + 1]!, bx = pts[2 * ((k + 1) % NP)]!, bz = pts[2 * ((k + 1) % NP) + 1]!;
        // ray O + t d = A + u (B − A): t = cross(A, e) / cross(d, e), u = cross(A, d) / cross(d, e)
        const ex = bx - ax, ez = bz - az;
        const den = dx * ez - dz * ex;
        if (Math.abs(den) < 1e-12) continue;
        const t = (ax * ez - az * ex) / den, u = (ax * dz - az * dx) / den;
        if (u >= 0 && u <= 1 && t > best) best = t;
      }
    }
    return best;
  };
  // Body: the torso's own surface, pushed out — a thick waistband, then cloth that hangs off the hips — widening at the hips to the outline of the
  // thigh tops (the pelvis alone is narrower than the two thighs it hangs from).
  const blendTop = hy + R * 0.45;
  addGrid(c.g, {
    rows: ys.length, cols, wrap: true,
    point: (r, j, out) => {
      const y = ys[r]!;
      const band = y >= top - bandH;
      const sag = smooth01((top - bandH - y) / (R * 0.8));
      // Cloth hangs off the hips at the sides and front; behind, it follows the buttock (no bag): the sag fades out round the back.
      const rear = smooth01((Math.cos((0.5 - j / cols) * TAU) + 0.7) / 0.9);
      const lift = outfit ? 0.02 : band ? gap * 0.9 : gap * 0.6 + 0.022 * sag * rear;
      torso.point(y, (0.5 - j / cols) * TAU, out, lift);
      if (band && !outfit) { const edge = bump((y - (top - bandH / 2)) / (bandH * 0.62)); out.x *= 1 + 0.012 * edge; out.z *= 1 + 0.012 * edge; }
      if (!outfit && y < blendTop) {
        const w = smooth01((blendTop - y) / (blendTop - rimY));
        const r0 = Math.hypot(out.x, out.z), psi = Math.atan2(out.z, out.x);
        const ru = rayReach(polys(hy - y), psi);
        const rr = r0 + (Math.max(r0, ru) - r0) * w;
        if (r0 > 1e-6) { out.x *= rr / r0; out.z *= rr / r0; }
      }
    },
    weights: p => torso.weights(p),
    rect: c.rect('trunks'), kind: KIND.cloth,
    uv: (r, j) => {
      const y = ys[r]!;
      const v = y >= top - bandH ? vBand * (top - y) / bandH : vBand + (1 - vBand) * (top - bandH - y) / (top - bandH - bottom);
      return [j / cols, v];
    },
    ao: cfg.rigAoStrength * 0.5,
  });
  if (outfit) return;

  if (skirt) {
    // One flared skirt of panels round both legs; each half follows its own leg's hem bone.
    const rows = c.low ? 5 : 8;
    addGrid(c.g, {
      rows, cols, wrap: true, doubleSided: true,
      point: (r, j, out) => {
        const t = r / (rows - 1);
        const th = (0.5 - j / cols) * TAU;
        torso.point(hy + sp * 0.2, th, out, 0.03);
        // Pleated, and flared most fore and aft: in the stance one thigh is well forward of the hips and the other well back.
        const flare = 1 + t * (0.5 + 0.06 * Math.cos(th * 9));
        out.x *= flare * (1 + 0.4 * t); out.z *= flare;
        out.y = hy + sp * 0.2 - t * (len + sp * 0.2);
      },
      weights: (p) => {
        const t = smooth01((hy - p.y) / len);
        const side = p.z * c.lat[0]! > 0 ? 0 : 1;
        // Mostly the hips': a half that went all the way with its leg stood out like a wing. The legs wear short panels under it.
        return [[BONE.hips, 1 - 0.3 * t], [legBones(side).hem, 0.3 * t]];
      },
      rect: c.rect('trunkLegL'), kind: KIND.cloth,
      uv: (r, j) => [j / cols, r / (rows - 1)],
      ao: cfg.rigAoStrength * 0.4,
    });
    // Short leg panels under the skirt, in the same cloth: a thigh that lifts shows trunks at its root, not skin.
    len = Math.max(len * 0.62, sRim + 0.05);
  }
  for (let i = 0; i < 2; i++) {
    const bones = legBones(i);
    const J = c.bind[bones.thigh]!;
    const mirror = c.lat[i]! < 0;
    const lc = c.low ? 12 : 16;
    const s0 = sRim;   // starts where the panel's rim is: the rim is the outline of these top rings
    const sKeys = [s0, s0 + (len - s0) * 0.3, s0 + (len - s0) * 0.7, len];
    const ss = rowParams(sKeys, [2, 3, 3], c.low);
    const hemAt = (phi: number): number => cut === 'split' ? 1 - 0.42 * bump((phi - Math.PI / 2) / 0.75) : 1;
    const ring = (s: number, phi: number, gapAt: number, out: THREE.Vector3): void => {
      const sh = Math.max(s0, s * hemAt(phi));
      // The thigh's own surface, muscle bumps and all, pushed OUT by the gap, which opens a little toward the hem (cloth hangs, it does not
      // cling) with a few folds.
      const t = Math.max(0, sh - s0) / (len - s0);
      legSurf(i, sh, phi, gapAt + 0.022 * t + 0.006 * t * Math.cos(phi * 5 + i), out);
    };
    const weights = (p: THREE.Vector3): BW[] => {
      // The skin's own weight field (pelvis → thigh → knee helper → shin), so the shell and the thigh under it move as one, including over a bending
      // knee (a long cut reaches it); the hem takes a share toward the cloth's lower edge, except where the knee is bending the skin.
      const s = J.y - p.y;
      const t = Math.min(1, Math.max(0, (s - s0) / (len - s0)));
      const base = legSkinWeights(c, i, p);
      let kneeShare = 0;
      for (const e of base) if (e[0] !== BONE.hips && e[0] !== bones.thigh) kneeShare += e[1];
      // At most 0.45 × cfg.rigClothMax of cloth swing at the hem, which the hem flare below (gap + 2.2 cm) can absorb: a swinging hem never uncovers the thigh.
      const wHem = 0.45 * smooth01((t - 0.15) / 0.85) * (1 - kneeShare);
      const w: BW[] = base.map(e => [e[0], e[1] * (1 - wHem)] as BW);
      w.push([bones.hem, wHem]);
      return w;
    };
    addGrid(c.g, {
      rows: ss.length, cols: lc, wrap: true, mirror,
      point: (r, j, out) => ring(ss[r]!, (j / lc) * TAU - Math.PI / 2, gap, out),
      weights,
      rect: c.rect(mirror ? 'trunkLegL' : 'trunkLegR'), kind: KIND.cloth,
      uv: (r, j) => [j / lc, (ss[r]! - s0) / (len - s0)],
      ao: cfg.rigAoStrength * 0.4,
    });
    // The hem turns in to the thigh so the leg hole is closed.
    addGrid(c.g, {
      rows: 2, cols: lc, wrap: true, mirror,
      point: (r, j, out) => {
        const phi = (j / lc) * TAU - Math.PI / 2;
        // The lining: from the outer lip in to just off the skin, so the leg opening reads as a hem, not a hole (never inside the skin).
        if (r === 0) ring(len, phi, gap, out); else ring(len - 0.03, phi, -0.008, out);
      },
      weights,
      outward: (_p, o) => { o.set(0, -1, 0); },
      rect: c.rect('lining'), kind: KIND.cloth,
    });
  }
}

// ── Boots ────────────────────────────────────────────────────────────────────

export function buildBoot(c: Ctx, i: number): void {
  const { body: b, d, cfg, spec } = c;
  const bones = legBones(i);
  const A = c.bind[bones.boot]!;
  const mirror = c.lat[i]! < 0;
  const rect = c.rect(mirror ? 'bootL' : 'bootR');
  const H = b.bootH, L = d.footLen, Wd = d.footW;
  const cols = c.low ? 10 : 16;
  // The foot: heel → toe along +x. x/L, top height / H, half-width / Wd.
  const st: number[][] = [
    // Phase 2: a heel counter that stands up, an instep that falls to a low, long toe box.
    [-0.3, 0.0, 0.0],
    [-0.285, 0.8, 0.3],
    [-0.18, 1.1, 0.42],
    [0.0, 1.2, 0.46],
    [0.18, 0.96, 0.49],
    [0.4, 0.62, 0.54],
    [0.6, 0.47, 0.5],
    [0.7, 0.36, 0.34],
    [0.735, 0.0, 0.0],
  ];
  const keys = st.map(s => s[0]!), vals = st.map(s => s.slice(1));
  const xs = rowParams(keys, [1, 2, 2, 2, 2, 2, 2, 1], c.low);
  const row = [0, 0];
  addGrid(c.g, {
    rows: xs.length, cols, wrap: true, mirror,
    point: (r, j, out) => {
      sampleKeys(keys, vals, xs[r]!, row);
      const a = (j / cols) * TAU;          // a = π/2 is the top of the foot (u = 0.25), 3π/2 the sole (u = 0.75)
      const h = row[0]! * H, w = row[1]! * Wd;
      const sn = Math.sin(a);
      // Rounded on top, flat underneath.
      const y = -H + (sn >= 0 ? h * (0.34 + 0.66 * sgnPow(sn, 2.2)) : h * 0.34 * (1 + sgnPow(sn, 5)));
      out.set(A.x + xs[r]! * L, A.y + y, Math.abs(A.z) + w * sgnPow(Math.cos(a), 2.6));
    },
    weights: () => [[bones.boot, 1]],
    rect, kind: KIND.leather,
    uv: (r, j) => [j / cols, 0.5 + 0.5 * (xs[r]! - keys[0]!) / (keys[keys.length - 1]! - keys[0]!)],
    ao: cfg.rigAoStrength * 0.5,
  });
  // The sole: a slab a welt wider than the upper, thicker under the heel — the line that makes it a boot, not a sock.
  {
    const sc = c.low ? 6 : 10;
    addGrid(c.g, {
      rows: xs.length, cols: sc, wrap: true, mirror,
      point: (r, j, out) => {
        sampleKeys(keys, vals, xs[r]!, row);
        const a = (j / sc) * TAU;
        const w = row[1]! * Wd + (row[1]! > 0.01 ? 0.006 : 0);
        const heel = smooth01((-0.04 - xs[r]!) / 0.06);
        const th = H * (0.2 + 0.16 * heel) * (row[1]! > 0.01 ? 1 : 0);
        out.set(A.x + xs[r]! * L * 1.015, A.y - H + th * (0.5 + 0.5 * sgnPow(Math.sin(a), 7)), Math.abs(A.z) + w * sgnPow(Math.cos(a), 5));
      },
      weights: () => [[bones.boot, 1]],
      rect: c.rect('sole'), kind: KIND.rubber,
    });
  }
  // The shaft: up the shin, fitted to it, blending from the boot to the shin so the ankle bends.
  const leg = legStations(c);
  const lr = [0, 0, 0, 0];
  const sAnk = b.thigh + b.shin;                      // the ankle, measured down the leg
  const hs = [-0.35 * H, 0, 0.5 * H, d.shaftH * 0.5, d.shaftH * 0.86, d.shaftH, d.shaftH * 1.02, d.shaftH * 0.97];
  const gap = [0.012, 0.014, 0.012, 0.009, 0.009, 0.012, 0.006, -0.004];
  addGrid(c.g, {
    rows: hs.length, cols, wrap: true, mirror,
    point: (r, j, out) => {
      const phi = (j / cols) * TAU - Math.PI / 2;
      sampleKeys(leg.keys, leg.vals, sAnk - Math.max(0, hs[r]!), lr);
      const g = gap[r]!;
      out.set(A.x + lr[2]! + (lr[0]! + g) * Math.cos(phi), A.y + hs[r]!, Math.abs(A.z) + lr[3]! + (lr[1]! + g) * Math.sin(phi));
    },
    weights: (p) => { const t = smooth01((p.y - A.y + 0.1 * H) / (0.9 * H)); return [[bones.boot, 1 - t], [bones.shin, t]]; },
    rect, kind: KIND.leather,
    uv: (r, j) => [j / cols, 0.5 * (1 - Math.min(1, Math.max(0, hs[r]! / d.shaftH)))],
    ao: cfg.rigAoStrength * 0.4,
  });
  if (spec.bootTassels && !spec.outfit) {
    // Tassels: a fringe of strands hanging off the top of the shaft at the front and outside.
    const n = c.low ? 3 : 5;
    for (let k = 0; k < n; k++) {
      const phi = -0.5 + (k / (n - 1)) * 1.9;
      sampleKeys(leg.keys, leg.vals, sAnk - d.shaftH, lr);
      const bx = A.x + lr[2]! + (lr[0]! + 0.02) * Math.cos(phi), bz = Math.abs(A.z) + lr[3]! + (lr[1]! + 0.02) * Math.sin(phi);
      const rows = 4, tc = 5, tl = Math.min(0.11, d.shaftH * 0.6);
      addGrid(c.g, {
        rows, cols: tc, wrap: true, mirror,
        point: (r, j, out) => {
          const t = r / (rows - 1), a = j / tc * TAU;
          const rr = 0.011 * (r === rows - 1 ? 0.05 : 0.6 + 0.6 * t);
          out.set(bx + Math.cos(phi) * 0.012 * t + rr * Math.cos(a), A.y + d.shaftH * 0.98 - tl * t, bz + Math.sin(phi) * 0.012 * t + rr * Math.sin(a));
        },
        weights: () => [[bones.shin, 1]],
        rect: c.rect('tassel'), kind: KIND.cloth,
      });
    }
  }
}

// ── The referee's bow tie ────────────────────────────────────────────────────

export function buildBowTie(c: Ctx, torso: TorsoShape): void {
  const R = c.body.headR;
  const y = c.body.shoulderY + c.body.chestLen * 0.2;
  const front = new THREE.Vector3();
  torso.point(y, 0, front, 0.012);
  for (const s of [-1, 0, 1]) {
    const rows = 5, cols = 8;
    const w = s === 0 ? 0.09 : 0.2, h = s === 0 ? 0.11 : 0.16;
    addGrid(c.g, {
      rows, cols, wrap: true,
      point: (r, j, out) => {
        const phi = -Math.PI / 2 + Math.PI * r / (rows - 1), th = j / cols * TAU;
        // Wings pinch toward the knot.
        const zz = Math.cos(phi) * Math.sin(th);
        const pinch = s === 0 ? 1 : 0.45 + 0.55 * Math.abs(zz * 0.5 + 0.5 * s) * 1.4;
        out.set(front.x + R * 0.06 * Math.cos(phi) * Math.cos(th), y + R * h * pinch * Math.sin(phi), s * R * 0.2 + R * w * zz);
      },
      weights: () => [[BONE.chest, 1]],
      rect: c.rect('tie'), kind: KIND.cloth,
    });
  }
}
