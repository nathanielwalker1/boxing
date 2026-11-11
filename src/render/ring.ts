/**
 * render/ring.ts — the ring (CONTRACT §7): platform with a grained canvas top
 * and sponsor skirt panels, posts, per-rope turnbuckle pads, rope end
 * fittings, rope spacers, merged vertex-coloured ropes, sponsor decals on the
 * canvas, and steps at the far neutral corner. Everything is generated;
 * textures are painted canvases. Rebuilt whole when any RING_KEYS value
 * changes (dev sliders), so nothing here is incremental.
 *
 * Value rule (VISUALS L1): the canvas is the darkest large surface fighters
 * stand on; nothing painted here may lift it. Grain is ± a few percent.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RING_HALF, APRON_W, type Config, type Sponsor } from '../core';
import { SPONSORS, paintSlot } from './sponsors';
import { makeCanvas, canvasTexture, segmentMatrix, seededRng } from './util';

export const RING_KEYS = ['ropeCount', 'ropeTopY', 'ropeSag', 'postR', 'matColor', 'matLineColor', 'apronColor',
  'ropeColorA', 'ropeColorB', 'ropeColorC', 'padColorRed', 'padColorBlue', 'padColorNeutral',
  'matGrain', 'matTrimW', 'apronStripeColor', 'apronStripeY', 'sponsorDecalAlpha', 'sponsorDecalTone',
  'ringScuffs', 'ringApronTone', 'ringCushionW', 'ringCoverLen', 'ringStools', 'ringPostFadeNear', 'ringPostFadeFar'] as const;

export function ringKey(c: Config): string { return RING_KEYS.map(k => String(c[k])).join('|'); }

const OUTER = RING_HALF + APRON_W;        // platform half-size
const PLATFORM_H = 1.0;
const ROPE_R = 0.022;
const UP = new THREE.Vector3(0, 1, 0);
const WHITE_ROPE_COOL = new THREE.Color(0.86, 0.95, 1.0);   // linear multipliers: takes the warm rig's red back out of a white rope

// ── Painters ─────────────────────────────────────────────────────────────────

/** The canvas top: base colour, fine grain, faint weave, worn patches, trim square. */
function paintMat(c: Config, aniso: number): THREE.CanvasTexture {
  const size = 1024;
  const [cv, g] = makeCanvas(size, size);
  const pxPerM = size / (OUTER * 2);
  g.fillStyle = c.matColor; g.fillRect(0, 0, size, size);

  if (c.matGrain > 0) {
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    const rng = seededRng(3);
    const amp = c.matGrain * 40;     // ± bytes at grain 1.0 → subtle by default
    for (let i = 0; i < d.length; i += 4) {
      const n = (rng() - 0.5) * 2 * amp;
      d[i] = Math.max(0, Math.min(255, (d[i] ?? 0) + n));
      d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] ?? 0) + n));
      d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] ?? 0) + n));
    }
    g.putImageData(img, 0, 0);
    // weave: faint 4px lattice
    g.globalAlpha = 0.05 * Math.min(1, c.matGrain * 4); g.fillStyle = '#000000';
    for (let y = 0; y < size; y += 4) g.fillRect(0, y, size, 1);
    for (let x = 0; x < size; x += 4) g.fillRect(x, 0, 1, size);
    // worn patches: a few soft dark/light ellipses
    const rng2 = seededRng(11);
    for (let i = 0; i < 14; i++) {
      const x = rng2() * size, y = rng2() * size, r = 60 + rng2() * 160;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      const light = rng2() < 0.4;
      grad.addColorStop(0, light ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 1; g.fillStyle = grad; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 1;
  }

  // Wear (ring dressing, 2026-11-11): boot scuffs — short dark arcs, thickest where the fighting happens — a few
  // pale resin smears, and old stains. All of it darkens or barely lifts: the canvas stays the darkest large surface.
  if (c.ringScuffs > 0) {
    const rs = seededRng(29);
    const mid = size / 2, reach = RING_HALF * pxPerM;
    g.lineCap = 'round';
    for (let i = 0; i < 260 * c.ringScuffs; i++) {
      const a = rs() * Math.PI * 2, d = Math.pow(rs(), 0.8) * reach * 0.95;
      const x = mid + Math.cos(a) * d, y = mid + Math.sin(a) * d;
      const len = (0.08 + rs() * 0.3) * pxPerM, dir = rs() * Math.PI * 2, bend = (rs() - 0.5) * 0.9;
      g.strokeStyle = rs() < 0.8 ? `rgba(0,0,0,${(0.05 + rs() * 0.1).toFixed(3)})` : `rgba(255,255,255,${(0.02 + rs() * 0.03).toFixed(3)})`;
      g.lineWidth = 1 + rs() * 3.5;
      g.beginPath();
      g.moveTo(x, y);
      g.quadraticCurveTo(x + Math.cos(dir + bend) * len * 0.5, y + Math.sin(dir + bend) * len * 0.5, x + Math.cos(dir) * len, y + Math.sin(dir) * len);
      g.stroke();
    }
    for (let i = 0; i < 9 * c.ringScuffs; i++) {
      const x = mid + (rs() - 0.5) * reach * 1.7, y = mid + (rs() - 0.5) * reach * 1.7, r = (0.08 + rs() * 0.22) * pxPerM;
      const grad = g.createRadialGradient(x, y, r * 0.2, x, y, r);
      grad.addColorStop(0, 'rgba(20,8,4,0.10)'); grad.addColorStop(0.8, 'rgba(20,8,4,0.06)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.lineCap = 'butt';
  }

  // The canvas outside the ropes takes the apron colour (a real ring's apron edge), darker than the fighting surface.
  const inset = (OUTER - RING_HALF) * pxPerM;
  if (c.ringApronTone > 0) {
    g.save();
    g.beginPath(); g.rect(0, 0, size, size); g.rect(inset, inset, size - 2 * inset, size - 2 * inset);
    g.clip('evenodd');
    g.globalAlpha = c.ringApronTone; g.fillStyle = c.apronColor; g.fillRect(0, 0, size, size);
    g.globalAlpha = 0.35 * c.ringApronTone; g.fillStyle = '#000000'; g.fillRect(0, 0, size, size);
    g.restore();
  }

  // Trim square just inside the ropes.
  g.strokeStyle = c.matLineColor; g.lineWidth = Math.max(1, c.matTrimW * pxPerM);
  g.strokeRect(inset, inset, size - 2 * inset, size - 2 * inset);
  return canvasTexture(cv, aniso);
}

/** One side of the apron skirt: base colour, hem, stripe, N sponsor panels. */
function paintSkirt(c: Config, panels: { sponsor: Sponsor; slot: 'apronFront' | 'apronSides' }[], aniso: number): THREE.CanvasTexture {
  const w = 2048, h = 256;
  const [cv, g] = makeCanvas(w, h);
  g.fillStyle = c.apronColor; g.fillRect(0, 0, w, h);
  // hem shadow at the bottom, stripe near the top
  const hem = g.createLinearGradient(0, h * 0.7, 0, h);
  hem.addColorStop(0, 'rgba(0,0,0,0)'); hem.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = hem; g.fillRect(0, 0, w, h);
  const sy = h * (1 - c.apronStripeY);
  g.fillStyle = c.apronStripeColor; g.fillRect(0, sy - h * 0.025, w, h * 0.05);
  // sponsor panels, evenly spaced, vertically centred below the stripe
  const n = panels.length;
  const slotW = w / n;
  const ph = h * 0.56, py = Math.min(h - ph - h * 0.06, Math.max(sy + h * 0.06, (h - ph) / 2 + h * 0.08));
  for (let i = 0; i < n; i++) {
    const p = panels[i]!;
    const tex = paintSlot(p.sponsor, p.slot);
    const img = tex.image as HTMLCanvasElement;
    const pw = Math.min(slotW * 0.86, ph * (img.width / img.height));
    const px = slotW * i + (slotW - pw) / 2;
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(px + 6, py + 6, pw, ph);
    g.drawImage(img, px, py, pw, ph);
    tex.dispose();
  }
  return canvasTexture(cv, aniso);
}

/**
 * Make a material dissolve near the lens (phase 2). The follow camera sits
 * just outside the ropes and crosses the ring's diagonals, where the near
 * corner post, its cap and cushion end up bottom-centre of the frame, a metre
 * from the glass. Real broadcast cameras shoot past that post too, but there
 * it is out of focus; here it was a hard dark shape over the canvas. A
 * screen-door dither by view distance needs no blending and no sorting, and
 * leaves every post further than `far` untouched (the other three always are).
 */
function fadeNearLens<M extends THREE.Material>(mat: M, near: number, far: number): M {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms['uFadeNear'] = { value: near };
    shader.uniforms['uFadeFar'] = { value: Math.max(near + 0.01, far) };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', /* glsl */`uniform float uFadeNear, uFadeFar;
        float fadeDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }   // interleaved gradient noise
        void main() {
          { float keep = smoothstep(uFadeNear, uFadeFar, length(vViewPosition)); if (keep < fadeDither(gl_FragCoord.xy)) discard; }`);
  };
  mat.customProgramCacheKey = () => `fadeNearLens:${near}:${far}`;
  return mat;
}

// ── Builders ─────────────────────────────────────────────────────────────────

function boxAt(w: number, h: number, d: number, m: THREE.Matrix4): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).applyMatrix4(m);
}

function withColor(geo: THREE.BufferGeometry, col: THREE.Color): THREE.BufferGeometry {
  const n = geo.attributes['position']!.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Build the whole ring under one group. `aniso` = renderer max anisotropy. */
export function buildRing(c: Config, aniso: number): THREE.Group {
  const ring = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0xd8d8e0, roughness: 0.35, metalness: 0.7 });
  const [title, s1, s2, s3] = [SPONSORS[0]!, SPONSORS[1]!, SPONSORS[2]!, SPONSORS[3]!];

  // Platform: box whose top is the canvas and whose sides are the skirt. Face order +x −x +y −y +z −z.
  const matTex = paintMat(c, aniso);
  const front = paintSkirt(c, [{ sponsor: s2, slot: 'apronSides' }, { sponsor: title, slot: 'apronFront' }, { sponsor: s3, slot: 'apronSides' }], aniso);
  const sideA = paintSkirt(c, [{ sponsor: s1, slot: 'apronSides' }, { sponsor: s3, slot: 'apronSides' }], aniso);
  const sideB = paintSkirt(c, [{ sponsor: s2, slot: 'apronSides' }, { sponsor: s1, slot: 'apronSides' }], aniso);
  const skirtMat = (t: THREE.Texture) => new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 });
  const platform = new THREE.Mesh(new THREE.BoxGeometry(OUTER * 2, PLATFORM_H, OUTER * 2), [
    skirtMat(sideA), skirtMat(sideB),
    new THREE.MeshStandardMaterial({ map: matTex, roughness: 1 }),
    new THREE.MeshStandardMaterial({ color: 0x0c0c0e }),
    skirtMat(front), skirtMat(sideB),
  ]);
  platform.position.y = -PLATFORM_H / 2;
  platform.receiveShadow = true;
  ring.add(platform);

  // Sponsor decals on the canvas (alpha quads; polygon offset keeps them off the mat's depth).
  // Tone: the print is inked into the canvas — it must stay below fighter value (VISUALS L1).
  const decalMat = (t: THREE.Texture) => new THREE.MeshStandardMaterial({
    map: t, transparent: true, opacity: c.sponsorDecalAlpha, roughness: 1, depthWrite: false,
    color: new THREE.Color().setScalar(c.sponsorDecalTone),
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const centre = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 2.0), decalMat(paintSlot(title, 'matCenter', aniso)));
  centre.rotation.x = -Math.PI / 2; centre.position.y = 0.004; centre.receiveShadow = true;
  ring.add(centre);
  const cornerDecal = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.8, 0.8), decalMat(paintSlot(s1, 'matCorners', aniso)), 4);
  cornerDecal.receiveShadow = true;
  {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const off = RING_HALF - 0.75;
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sz], i) => {
      m.compose(new THREE.Vector3(sx! * off, 0.004, sz! * off), q, new THREE.Vector3(1, 1, 1));
      cornerDecal.setMatrixAt(i, m);
    });
  }
  ring.add(cornerDecal);

  // Posts: red (+x,+z), blue (−x,−z), neutral elsewhere.
  const postH = c.ropeTopY + 0.25;
  const pOff = RING_HALF + c.postR + 0.05;
  const corners: { sx: number; sz: number; col: string }[] = [
    { sx: 1, sz: 1, col: c.padColorRed }, { sx: -1, sz: -1, col: c.padColorBlue },
    { sx: 1, sz: -1, col: c.padColorNeutral }, { sx: -1, sz: 1, col: c.padColorNeutral },
  ];
  // Post detail (ring dressing, 2026-11-11): a satin steel post on a base plate, under a dark rubber cap — the
  // bare polished top caught the key and was the brightest thing in frame from the corner seats.
  const fade = <M extends THREE.Material>(m: M): M => fadeNearLens(m, c.ringPostFadeNear, c.ringPostFadeFar);
  const postMetal = fade(new THREE.MeshStandardMaterial({ color: 0x8e9098, roughness: 0.55, metalness: 0.6 }));
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(c.postR, c.postR, postH, 12), postMetal, 4);
  posts.castShadow = true;
  const tmp = new THREE.Matrix4();
  corners.forEach((k, i) => { posts.setMatrixAt(i, tmp.makeTranslation(k.sx * pOff, postH / 2, k.sz * pOff)); });
  ring.add(posts);
  {
    const cap = new THREE.CylinderGeometry(c.postR * 1.25, c.postR * 1.35, 0.07, 12).translate(0, postH + 0.03, 0);
    const base = new THREE.CylinderGeometry(c.postR * 2.2, c.postR * 2.4, 0.03, 12).translate(0, 0.015, 0);
    const trim = new THREE.InstancedMesh(mergeGeometries([cap, base]), fade(new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.9 })), 4);
    corners.forEach((k, i) => { trim.setMatrixAt(i, tmp.makeTranslation(k.sx * pOff, 0, k.sz * pOff)); });
    trim.castShadow = true;
    ring.add(trim);
  }

  // Corner cushions: one tall pad per corner, inside the post, facing the ring centre, in the corner's colour with
  // the sponsor's mark top and bottom (the postPads slot is painted on white so the instance colour tints it).
  const padTex = paintSlot(s3, 'postPads', aniso);
  const yBotRope = c.ropeTopY / c.ropeCount;
  const cushionH = c.ropeTopY - yBotRope + 0.24;
  const cushionGeo = new THREE.BoxGeometry(c.ringCushionW, cushionH, 0.11);
  {
    // Two marks up the cushion's face: repeat the texture vertically on the ±z faces only.
    const uv = cushionGeo.attributes['uv']!;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * Math.max(1, Math.round(cushionH / c.ringCushionW / 1.5)));
    // The narrow side, top and bottom faces (box faces 0–3, four vertices each) carry no mark: on a 0.11 m edge it
    // came out rotated and stretched. They sample the texture's plain corner instead.
    for (let i = 0; i < 16; i++) uv.setXY(i, 0.02, 0.02);
  }
  padTex.wrapT = THREE.RepeatWrapping;
  const pads = new THREE.InstancedMesh(cushionGeo, fade(new THREE.MeshStandardMaterial({ map: padTex, roughness: 0.8 })), 4);
  pads.castShadow = true;
  {
    const col = new THREE.Color(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    const inPost = pOff - (c.postR + 0.075) / Math.SQRT2;
    corners.forEach((k, i) => {
      q.setFromAxisAngle(UP, Math.atan2(-k.sx, -k.sz));     // local +z looks at the ring centre
      pads.setMatrixAt(i, tmp.compose(new THREE.Vector3(k.sx * inPost, yBotRope - 0.12 + cushionH / 2, k.sz * inPost), q, one));
      pads.setColorAt(i, col.set(k.col));
    });
  }
  ring.add(pads);

  // Ropes (merged, vertex-coloured), end fittings, spacers.
  const ropeCols = [c.ropeColorA, c.ropeColorB, c.ropeColorC, c.ropeColorA];
  const h = RING_HALF + c.postR;
  const ropeGeos: THREE.BufferGeometry[] = [];
  // Turnbuckle covers: a padded sleeve over each rope end, in the colour of the corner it runs into.
  const fittings = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8), fade(new THREE.MeshStandardMaterial({ roughness: 0.85 })), 8 * c.ropeCount);
  fittings.castShadow = true;
  const coverCol = new THREE.Color();
  const cornerCol = (p: THREE.Vector3): string => corners.find(k => Math.sign(p.x) === k.sx && Math.sign(p.z) === k.sz)?.col ?? c.padColorNeutral;
  const spacers = new THREE.InstancedMesh(new THREE.BoxGeometry(0.035, 1, 0.035), new THREE.MeshStandardMaterial({ color: 0xe8e8ee, roughness: 0.8 }), 8);
  let fi = 0;
  const ends: [THREE.Vector3, THREE.Vector3][] = [
    [new THREE.Vector3(-h, 0, -h), new THREE.Vector3(h, 0, -h)], [new THREE.Vector3(h, 0, -h), new THREE.Vector3(h, 0, h)],
    [new THREE.Vector3(h, 0, h), new THREE.Vector3(-h, 0, h)], [new THREE.Vector3(-h, 0, h), new THREE.Vector3(-h, 0, -h)],
  ];
  for (let i = 0; i < c.ropeCount; i++) {
    const y = c.ropeTopY * (i + 1) / c.ropeCount;
    const col = new THREE.Color(ropeCols[i % ropeCols.length]);
    // A near-white rope under the warm key and the red corner's back light read pink (phase 1 note). Lean a
    // low-saturation rope cool so it lands on white once the rig has warmed it; coloured ropes are left alone.
    { const hsl = { h: 0, s: 0, l: 0 }; col.getHSL(hsl); if (hsl.s < 0.2 && hsl.l > 0.5) col.multiply(WHITE_ROPE_COOL); }
    for (const [a0, b0] of ends) {
      const a = a0.clone().setY(y), b = b0.clone().setY(y);
      const mid = a.clone().lerp(b, 0.5); mid.y -= c.ropeSag;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      ropeGeos.push(withColor(new THREE.TubeGeometry(curve, 14, ROPE_R, 6, false), col));
      const dir = b.clone().sub(a).normalize();
      fittings.setColorAt(fi, coverCol.set(cornerCol(a)));
      fittings.setMatrixAt(fi++, segmentMatrix(a.clone().addScaledVector(dir, 0.02), a.clone().addScaledVector(dir, 0.02 + c.ringCoverLen), 0.042));
      fittings.setColorAt(fi, coverCol.set(cornerCol(b)));
      fittings.setMatrixAt(fi++, segmentMatrix(b.clone().addScaledVector(dir, -0.02), b.clone().addScaledVector(dir, -0.02 - c.ringCoverLen), 0.042));
    }
  }
  const ropeMesh = new THREE.Mesh(mergeGeometries(ropeGeos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
  ropeMesh.castShadow = true;
  ring.add(ropeMesh, fittings);
  {
    const yBot = c.ropeTopY / c.ropeCount, yTop = c.ropeTopY;
    const sag = 2 * (1 / 3) * (2 / 3) * c.ropeSag;    // bezier offset at t = 1/3
    let si = 0;
    for (const [a, b] of ends) for (const t of [1 / 3, 2 / 3]) {
      const p = a.clone().lerp(b, t);
      spacers.setMatrixAt(si++, tmp.compose(new THREE.Vector3(p.x, (yBot + yTop) / 2 - sag, p.z), new THREE.Quaternion(), new THREE.Vector3(1, yTop - yBot + 0.06, 1)));
    }
  }
  ring.add(spacers);

  // Steps at the far neutral corner (+x, −z), descending outward along the diagonal.
  // …and, with ringStools, at the red and blue corners too, where the corner teams work.
  const stepGeos: THREE.BufferGeometry[] = [], railGeos: THREE.BufferGeometry[] = [];
  const stepCorners: [number, number][] = c.ringStools ? [[1, -1], [1, 1], [-1, -1]] : [[1, -1]];
  for (const [sx, sz] of stepCorners) {
    const yaw = Math.atan2(sx, sz);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const perp = new THREE.Vector3(dir.z, 0, -dir.x);
    const corner = new THREE.Vector3(sx * OUTER, 0, sz * OUTER);
    const nSteps = 4, sh = PLATFORM_H / (nSteps + 1), depth = 0.34, width = 1.0;
    const tops: THREE.Vector3[] = [];
    for (let i = 0; i < nSteps; i++) {
      const top = -sh * (i + 1);
      const cpos = corner.clone().addScaledVector(dir, depth * (i + 0.5) + 0.05);
      cpos.y = (top + -PLATFORM_H) / 2;
      stepGeos.push(boxAt(width, top + PLATFORM_H, depth, tmp.compose(cpos, q, new THREE.Vector3(1, 1, 1))));
      tops.push(new THREE.Vector3(cpos.x, top, cpos.z));
    }
    for (const side of [-1, 1]) {
      const p0 = tops[0]!.clone().addScaledVector(perp, side * (width / 2 + 0.03));
      const p1 = tops[nSteps - 1]!.clone().addScaledVector(perp, side * (width / 2 + 0.03));
      for (const p of [p0, p1]) railGeos.push(boxAt(0.04, 0.9, 0.04, tmp.makeTranslation(p.x, p.y + 0.45, p.z)));
      const r0 = p0.clone().setY(p0.y + 0.9), r1 = p1.clone().setY(p1.y + 0.9);
      railGeos.push(new THREE.CylinderGeometry(0.02, 0.02, 1, 8).applyMatrix4(segmentMatrix(r0, r1, 1)));
    }
  }
  {
    const steps = new THREE.Mesh(mergeGeometries(stepGeos), new THREE.MeshStandardMaterial({ color: 0x24242a, roughness: 0.9 }));
    steps.castShadow = true; steps.receiveShadow = true;
    const rails = new THREE.Mesh(mergeGeometries(railGeos), metal);
    ring.add(steps, rails);
  }

  // Corner kit (ring dressing): a stool, a bucket and a bottle on the apron outside the ropes at the red and blue
  // corners — where a cornerman leaves them between rounds. One merged, vertex-coloured mesh.
  if (c.ringStools) {
    const kit: THREE.BufferGeometry[] = [];
    const tint = (g: THREE.BufferGeometry, hex: number | string): THREE.BufferGeometry => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('uv'); return withColor(n, new THREE.Color(hex)); };
    for (const [sgn, col] of [[1, c.padColorRed], [-1, c.padColorBlue]] as [number, string][]) {
      // Along the +x / −x side of the corner, clear of the steps on the diagonal.
      const sx = sgn * (OUTER - 0.3), sz = sgn * (RING_HALF - 0.75);
      kit.push(tint(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 14).translate(sx, 0.43, sz), col));                 // stool seat
      kit.push(tint(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8).translate(sx, 0.21, sz), 0x9a9aa2));              // stool column
      kit.push(tint(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 14).translate(sx, 0.01, sz), 0x4a4a52));            // stool foot
      kit.push(tint(new THREE.CylinderGeometry(0.15, 0.12, 0.27, 14, 1, true).translate(sx, 0.135, sz - sgn * 0.45), 0xb9bcc4));   // bucket
      kit.push(tint(new THREE.CylinderGeometry(0.12, 0.12, 0.01, 14).translate(sx, 0.02, sz - sgn * 0.45), 0x30323a));              // …its bottom
      kit.push(tint(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 8).translate(sx - sgn * 0.02, 0.1, sz + sgn * 0.3), 0xdfe8f2));  // bottle
      kit.push(tint(new THREE.BoxGeometry(0.3, 0.02, 0.42).translate(sx + sgn * 0.02, 0.012, sz - sgn * 0.95), 0xe8e8ea));         // towel
    }
    const kitMesh = new THREE.Mesh(mergeGeometries(kit), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }));
    kitMesh.castShadow = true; kitMesh.receiveShadow = true;
    ring.add(kitMesh);
  }

  return ring;
}
