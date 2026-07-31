import Phaser from 'phaser';
import { config } from './config.js';

/**
 * Arena — all environment dressing around the ring (Stage 12).
 *
 * PURELY VISUAL. Nothing in this file is read by movement, hit resolution, the
 * camera clamp or the HUD; it owns no state the rest of the game asks about.
 * The one thing it borrows is the ring bounds rectangle, and only to draw on top
 * of it — the rect itself still comes from RingScene._getRingBounds().
 *
 * ── Why everything is anchored to the canvas rect, not the camera ─────────────
 * The world camera clamps its centre into the ring (see camera.js), so the
 * WIDEST world region that can ever be on screen is bounded by the ring plus one
 * viewport, and at the slider limits that works out to the base canvas rect
 * (0,0)-(GAME_W,GAME_H). The dressing is generated over that rect grown by
 * REGION_MARGIN on each side, so there is no reachable camera position — corner,
 * fully zoomed out, ring resized — where a layer runs out and shows void.
 *
 * ── Everything is BAKED, and that is a performance requirement ────────────────
 * The first cut of this drew each element as its own live layer: a backdrop
 * fill, a haze glow, the crowd, the mat, a grain tile-sprite, an edge shade, a
 * light pool, three beam quads and a vignette. Visually identical to this one —
 * and it cost 16 ms/frame, taking the game from 59 to 30 fps, because ~9
 * screen-sized blended quads per frame is pure fill rate however cheap each one
 * is to set up. (Measured: the CPU cost of building the draw commands was nil,
 * so batching the Graphics differently would not have helped at all.)
 *
 * So each group that never changes between frames is composited ONCE into a
 * canvas texture and drawn as a single quad:
 *
 *   backdrop  void + haze + crowd     baked once (independent of the ring)
 *   mat       base + grain + edge shade + light pool
 *   beams     the three cones         both rebaked only when their inputs change
 *
 * and the backdrop and apron are hidden outright whenever the view sits wholly
 * inside the mat — which at the default zoom is almost every frame. What stays
 * live is the cheap stuff: rope strands, mat trim and the emblem (thin strokes),
 * plus the vignette, which is one unavoidable screen quad.
 *
 * The bakes are keyed on the config values they consume, so the tuning panel
 * still edits them live — dragging a colour just rebakes that one texture.
 *
 * ── Layer order (world camera depths; fighters are 4/5) ───────────────────────
 *   -50 backdrop      -30 mat        -20 ropes/posts/pads
 *   -40 apron         -28 mat trim + emblem
 *    -6 light beams (ADD, BEHIND the fighters on purpose — haze over the rig
 *       would soften exactly the thing you need to read)
 *    18 vignette (in front of the fighters and the hit flashes at 15, behind the
 *       hurtbox debug overlay at 20 so that stays legible while tuning)
 *
 * ── No external art assets ────────────────────────────────────────────────────
 * Every texture here is generated at runtime — the four source textures pixel by
 * pixel, the composites with canvas 2D. They exist because Phaser's Graphics has
 * no gradient fill, and a vignette or light beam built from stacked hard-edged
 * shapes bands visibly.
 */

function cssHex(str) {
  return parseInt(String(str).replace('#', ''), 16);
}

/** Packed 0xRRGGBB → '#rrggbb', for the canvas-2D bakes. */
function hexCss(int) {
  return '#' + (int >>> 0).toString(16).padStart(6, '0');
}

/** Deterministic LCG — the crowd must be identical every reload, not shimmer. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

/** Lighten (amt > 0) or darken (amt < 0) a packed 0xRRGGBB colour. */
function shadeInt(c, amt) {
  const f = (ch) => {
    const v = (c >> ch) & 0xff;
    return Math.max(0, Math.min(255, Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt))));
  };
  return (f(16) << 16) | (f(8) << 8) | f(0);
}

/** Channel-wise blend of two CSS hex colours, returned as a Phaser int. */
function mixHex(aStr, bStr, t) {
  const a = cssHex(aStr), b = cssHex(bStr);
  const r  = Math.round(lerp((a >> 16) & 0xff, (b >> 16) & 0xff, t));
  const g  = Math.round(lerp((a >> 8) & 0xff, (b >> 8) & 0xff, t));
  const bl = Math.round(lerp(a & 0xff, b & 0xff, t));
  return (r << 16) | (g << 8) | bl;
}

// ── Source textures (per-pixel, generated once) ──────────────────────────────
const KEY_RADIAL   = 'arena-radial';
const KEY_VIGNETTE = 'arena-vignette';
const KEY_GRAIN    = 'arena-grain';
const KEY_BEAM     = 'arena-beam';
// ── Composites (canvas 2D, rebaked on demand) ────────────────────────────────
const KEY_BACKDROP = 'arena-backdrop';
const KEY_MAT      = 'arena-mat';
const KEY_BEAMS    = 'arena-beams';

/**
 * Write an RGBA texture from a per-pixel callback.
 * @param {(nx:number, ny:number, x:number, y:number) => [number,number,number,number]} shade
 *        nx, ny are normalised to -1..1 across the texture.
 */
function makeTexture(scene, key, w, h, shade) {
  if (scene.textures.exists(key)) return key;
  const tex = scene.textures.createCanvas(key, w, h);
  const ctx = tex.getContext();
  const img = ctx.createImageData(w, h);
  const d   = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i  = (y * w + x) * 4;
      const nx = ((x + 0.5) / w) * 2 - 1;
      const ny = ((y + 0.5) / h) * 2 - 1;
      const [r, g, b, a] = shade(nx, ny, x, y);
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  tex.refresh();
  return key;
}

function ensureSourceTextures(scene) {
  // Soft round glow, white core → transparent edge. Used additively for the
  // pool of light on the mat.
  makeTexture(scene, KEY_RADIAL, 256, 256, (nx, ny) => {
    const r = Math.min(1, Math.hypot(nx, ny));
    const a = (1 - r) * (1 - r);
    return [255, 250, 235, Math.round(a * 255)];
  });

  // Vignette: transparent centre → black corners. Stretched over a non-square
  // rect it becomes elliptical, which is what a rectangular viewport wants.
  makeTexture(scene, KEY_VIGNETTE, 256, 256, (nx, ny) => {
    const r = Math.hypot(nx, ny) / Math.SQRT2;     // 0 centre → 1 corner
    const t = Math.max(0, Math.min(1, (r - 0.34) / 0.66));
    const a = t * t * (3 - 2 * t);                 // smoothstep
    return [0, 0, 0, Math.round(Math.pow(a, 1.25) * 255)];
  });

  // Canvas grain: two-tone speckle plus a faint weave, so the mat has both light
  // and dark noise and reads as fabric rather than as added dust.
  const rng = makeRng(0x9e3779b9);
  makeTexture(scene, KEY_GRAIN, 128, 128, (_nx, _ny, x, y) => {
    const speckle = rng();
    const weave   = 0.5 + 0.5 * Math.sin((x + y) * 0.9) * Math.sin((x - y) * 0.55);
    const light   = speckle > 0.5;
    const a       = (Math.abs(speckle - 0.5) * 2) * (0.35 + 0.65 * weave);
    return light ? [255, 244, 220, Math.round(a * 190)]
                 : [40, 26, 10, Math.round(a * 190)];
  });

  // Light beam: a cone widening downward, brightest at the emitter, fading to
  // fully transparent at every edge so it can never show a hard boundary.
  makeTexture(scene, KEY_BEAM, 128, 256, (nx, _ny, _x, y) => {
    const t     = y / 255;                          // 0 emitter → 1 far end
    const width = 0.30 + 0.70 * t;                  // cone spread
    const u     = nx / width;
    if (u <= -1 || u >= 1) return [0, 0, 0, 0];
    const across = Math.cos((u * Math.PI) / 2);
    const along  = Math.pow(1 - t, 1.35) * Math.min(1, t / 0.06);
    return [255, 248, 225, Math.round(across * across * along * 255)];
  });
}

/** Get (creating or resizing as needed) a cleared canvas texture to bake into. */
function bakeTarget(scene, key, w, h) {
  let tex = scene.textures.exists(key) ? scene.textures.get(key) : null;
  if (tex && (tex.getSourceImage().width !== w || tex.getSourceImage().height !== h)) {
    scene.textures.remove(key);
    tex = null;
  }
  if (!tex) tex = scene.textures.createCanvas(key, w, h);
  const ctx = tex.getContext();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  return { tex, ctx };
}

const srcImage = (scene, key) => scene.textures.get(key).getSourceImage();

// How far past the base canvas rect the dressing extends. See the header note:
// the visible world region is bounded by that rect at every legal zoom/ring
// size, so this is pure safety headroom against future slider ranges.
const REGION_MARGIN_X = 260;
const REGION_MARGIN_Y = 220;

// Bake resolution for the two ring-relative composites. They are stretched onto
// the ring rect, so this is "texels across the ring", not a world size — the
// grain therefore keeps the same apparent size whatever the ring is set to.
const MAT_BAKE  = 512;
const BEAM_BAKE = 512;

// The beam sheet's rect, as multiples of the ring's own width/height (offsets
// measured from ring centre-x and ring top). Wide and tall enough that every
// cone has faded to nothing well inside it.
const SHEET_W = 1.6, SHEET_H = 2.2;
const SHEET_X0 = -0.8, SHEET_Y0 = -0.6;

// Per-beam emitter offset (× ring width, from centre), tilt in degrees, and the
// shared cone size (× ring width / height). Spread wide and kept narrow so the
// three read as separate cones — three broad overlapping ones just raise the
// whole frame's brightness, which is indistinguishable from lowering the
// vignette.
const BEAM_SPREAD = [-0.55, 0.0, 0.55];
const BEAM_TILT   = [-13, 2, 14];
const BEAM_W = 0.36, BEAM_H = 1.75, BEAM_TOP = -0.35;

export class Arena {
  /**
   * @param {Phaser.Scene} scene
   * @param {number} gameW  base canvas width  (ring centre is gameW / 2)
   * @param {number} gameH  base canvas height
   */
  constructor(scene, gameW, gameH) {
    this.scene = scene;
    this.gameW = gameW;
    this.gameH = gameH;

    this.region = {
      x0: -REGION_MARGIN_X,
      y0: -REGION_MARGIN_Y,
      x1: gameW + REGION_MARGIN_X,
      y1: gameH + REGION_MARGIN_Y,
    };

    ensureSourceTextures(scene);

    const cx = gameW / 2, cy = gameH / 2;

    // Backdrop — void + haze + crowd, baked once. Its content is deliberately
    // independent of the ring bounds (crowd depth is a function of position
    // within the region alone), so resizing the ring never rebakes it: the
    // platform just covers more or less of it.
    this._bakeBackdrop();
    this.backdrop = scene.add
      .image(this.region.x0, this.region.y0, KEY_BACKDROP)
      .setOrigin(0, 0)
      .setDepth(-50);

    this.apronGfx = scene.add.graphics().setDepth(-40);

    this._matKey = '';
    this._bakeMat();
    this.mat = scene.add.image(cx, cy, KEY_MAT).setDepth(-30);

    this.detailGfx = scene.add.graphics().setDepth(-28);
    this.ropeGfx   = scene.add.graphics().setDepth(-20);

    this._beamKey = '';
    this._bakeBeams();
    this.beamSheet = scene.add.image(cx, cy, KEY_BEAMS)
      .setDepth(-6)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.vignette = scene.add.image(cx, cy, KEY_VIGNETTE).setDepth(18);
  }

  /** Every object this component owns, for camera layer assignment. */
  displayObjects() {
    return [
      this.backdrop, this.apronGfx, this.mat,
      this.detailGfx, this.ropeGfx, this.beamSheet, this.vignette,
    ];
  }

  // ── Backdrop bake: void, haze, crowd ───────────────────────────────────────
  //
  // Rows of head + shoulder silhouettes across the whole dressing region, drawn
  // far-to-near so nearer rows overlap. Both size and colour key off the row's
  // vertical position only: high in the region = far away, so small and hazed
  // toward the backdrop colour; low = near, so large and nearly black. That
  // atmospheric-perspective ramp is the entire depth cue — no per-figure detail,
  // consistent with how the fighters themselves are drawn.
  _bakeBackdrop() {
    const { x0, y0, x1, y1 } = this.region;
    const W = x1 - x0, H = y1 - y0;
    const { tex, ctx } = bakeTarget(this.scene, KEY_BACKDROP, W, H);

    ctx.fillStyle = config.arenaVoidColor;
    ctx.fillRect(0, 0, W, H);

    // A wide, very dim lift centred on the ring so the crowd nearest the action
    // isn't a flat black field — the arena reads as lit from the middle.
    if (config.arenaHazeAlpha > 0) {
      const grad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.55);
      grad.addColorStop(0, config.arenaHazeColor);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = config.arenaHazeAlpha;
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    const rng    = makeRng(0x5eed1234);
    const rowGap = Math.max(8, config.crowdRowGap);

    for (let y = 0; y <= H + rowGap; y += rowGap) {
      const t     = Math.max(0, Math.min(1, y / H));
      const scale = lerp(0.55, 1.55, t) * config.crowdHeadScale;
      const color = mixHex(config.crowdFarColor, config.crowdNearColor, t);
      const step  = Math.max(6, config.crowdSeatGap * scale);
      const head  = 5.5 * scale;

      // Offset each row by a fraction of a seat so the columns don't line up
      // into a visible grid.
      let x = -step * rng();
      for (; x <= W + step; x += step) {
        if (rng() < 0.08) continue;   // empty seats — an unbroken field reads as wallpaper

        const jx = x + (rng() - 0.5) * step * 0.55;
        const jy = y + (rng() - 0.5) * rowGap * 0.45;
        const r  = head * lerp(0.78, 1.22, rng());

        // A few figures catch the ring light. Without them the crowd is one flat
        // value and stops reading as individual people at a glance.
        const col = rng() < config.crowdHighlightChance
          ? mixHex(config.crowdFarColor, config.crowdHighlightColor, lerp(0.35, 1, rng()))
          : shadeInt(color, lerp(-0.22, 0.22, rng()));

        ctx.fillStyle = hexCss(col);
        ctx.beginPath();
        ctx.ellipse(jx, jy + r * 1.7, r * 1.7, r * 1.3, 0, 0, Math.PI * 2);   // shoulders
        ctx.fill();
        ctx.beginPath();
        ctx.arc(jx, jy, r, 0, Math.PI * 2);                                   // head
        ctx.fill();
      }
    }

    tex.refresh();
  }

  /** Rebake the crowd/backdrop — its inputs are not checked per frame. */
  rebuildCrowd() {
    this._bakeBackdrop();
    if (this.backdrop) this.backdrop.setTexture(KEY_BACKDROP);
  }

  // ── Mat bake: base colour, grain, edge shade, light pool ───────────────────
  _bakeMat() {
    const { tex, ctx } = bakeTarget(this.scene, KEY_MAT, MAT_BAKE, MAT_BAKE);
    const N = MAT_BAKE;

    ctx.fillStyle = config.ringFloorColor;
    ctx.fillRect(0, 0, N, N);

    if (config.matGrainAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = config.matGrainAlpha;
      ctx.fillStyle = ctx.createPattern(srcImage(this.scene, KEY_GRAIN), 'repeat');
      ctx.fillRect(0, 0, N, N);
      ctx.restore();
    }

    if (config.matShadeAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = config.matShadeAlpha;
      ctx.drawImage(srcImage(this.scene, KEY_VIGNETTE), 0, 0, N, N);
      ctx.restore();
    }

    if (config.matGlowAlpha > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = config.matGlowAlpha;
      const s = N * 1.25;
      ctx.drawImage(srcImage(this.scene, KEY_RADIAL), (N - s) / 2, (N - s) / 2, s, s);
      ctx.restore();
    }

    tex.refresh();
  }

  // ── Beam sheet bake: the three cones on transparent ────────────────────────
  // Drawn in sheet-normalised space and stretched onto a rect defined as a
  // multiple of the ring's size, so the cones scale with the ring for free and a
  // ring resize never needs a rebake.
  _bakeBeams() {
    const { tex, ctx } = bakeTarget(this.scene, KEY_BEAMS, BEAM_BAKE, BEAM_BAKE);
    const N     = BEAM_BAKE;
    const count = Math.round(config.beamCount);
    const beam  = srcImage(this.scene, KEY_BEAM);

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < Math.min(count, BEAM_SPREAD.length); i++) {
      const u  = ((BEAM_SPREAD[i] - SHEET_X0) / SHEET_W) * N;   // emitter, sheet-normalised
      const v  = ((BEAM_TOP - SHEET_Y0) / SHEET_H) * N;
      const bw = (BEAM_W / SHEET_W) * N;
      const bh = (BEAM_H / SHEET_H) * N;

      ctx.save();
      ctx.translate(u, v);
      ctx.rotate((BEAM_TILT[i] * Math.PI) / 180);
      ctx.drawImage(beam, -bw / 2, 0, bw, bh);
      ctx.restore();
    }

    tex.refresh();
  }

  // ── Per-frame world dressing ───────────────────────────────────────────────
  drawWorld(bounds) {
    this._refreshBakes();
    this._drawApron(bounds);
    this._placeMat(bounds);
    this._drawDetail(bounds);
    this._drawRopes(bounds);
    this._placeBeams(bounds);
  }

  /**
   * Rebake the two config-driven composites if any value they consume changed.
   * Comparing a short string is free; the bake itself only runs on an actual
   * edit, which is what keeps the tuning panel live without paying for it every
   * frame.
   */
  _refreshBakes() {
    const matKey = [
      config.ringFloorColor, config.matGrainAlpha,
      config.matShadeAlpha, config.matGlowAlpha,
    ].join('|');
    if (matKey !== this._matKey) {
      this._matKey = matKey;
      this._bakeMat();
      if (this.mat) this.mat.setTexture(KEY_MAT);
    }

    const beamKey = String(Math.round(config.beamCount));
    if (beamKey !== this._beamKey) {
      this._beamKey = beamKey;
      this._bakeBeams();
      if (this.beamSheet) this.beamSheet.setTexture(KEY_BEAMS);
    }
  }

  // Apron deck (the platform outside the ropes) plus the skirt hanging off its
  // near edge. The skirt is drawn only on the bottom side on purpose: that is
  // the edge facing the viewer in this projection, and it is what gives the ring
  // a height off the arena floor rather than reading as a painted rectangle.
  _drawApron(bounds) {
    const g  = this.apronGfx;
    const ap = Math.max(0, config.ringApronWidth);
    const sk = Math.max(0, config.ringSkirtHeight);
    g.clear();

    const dx = bounds.left - ap, dy = bounds.top - ap;
    const dw = (bounds.right - bounds.left) + ap * 2;
    const dh = (bounds.bottom - bounds.top) + ap * 2;

    g.fillStyle(cssHex(config.apronDeckColor), 1);
    g.fillRect(dx, dy, dw, dh);
    // Lit outer lip — without it the deck and the dark crowd behind it merge
    // into one mass and the platform loses its silhouette.
    g.lineStyle(2, shadeInt(cssHex(config.apronDeckColor), 0.35), 0.9);
    g.strokeRect(dx + 1, dy + 1, dw - 2, dh - 2);

    if (sk <= 0) return;

    // Skirt front face, its lit top stripe, and the fall-off toward the floor.
    g.fillStyle(cssHex(config.apronSkirtColor), 1);
    g.fillRect(dx, dy + dh, dw, sk);
    g.fillStyle(cssHex(config.apronStripeColor), 0.9);
    g.fillRect(dx, dy + dh, dw, Math.max(2, sk * 0.2));
    g.fillStyle(0x000000, 0.35);
    g.fillRect(dx, dy + dh + sk * 0.62, dw, sk * 0.38);

    // Pleats — evenly spaced vertical creases across the skirt face
    g.lineStyle(1, 0x000000, 0.22);
    const pleat = 26;
    for (let x = dx + pleat; x < dx + dw; x += pleat) {
      g.beginPath();
      g.moveTo(x, dy + dh + sk * 0.2);
      g.lineTo(x, dy + dh + sk);
      g.strokePath();
    }
  }

  _placeMat(bounds) {
    this.mat
      .setPosition((bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2)
      .setDisplaySize(bounds.right - bounds.left, bounds.bottom - bounds.top);
  }

  // Mat trim + centre mark. Left as live strokes rather than baked into the mat
  // texture: they are a few thin paths with no measurable fill cost, the trim
  // wants to stay crisp at the mat edge whatever the ring size, and keeping the
  // emblem out of a stretched texture is what keeps it circular on a non-square
  // ring.
  _drawDetail(bounds) {
    const g = this.detailGfx;
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    g.clear();

    g.lineStyle(Math.max(1, config.ringBorderThickness), cssHex(config.matTrimColor), 0.55);
    g.strokeRect(bounds.left, bounds.top, w, h);

    this._drawEmblem(g, (bounds.left + bounds.right) / 2, (bounds.top + bounds.bottom) / 2,
                     Math.min(w, h));
  }

  // Original abstract mark — concentric rings and a diamond, echoing the punch
  // diamond. No text and no wordmark: at this scale lettering turns to mush, and
  // a busy mat costs more readability than it buys atmosphere. Deliberately
  // small, too: at the default zoom only ~55% of the mat's height is on screen,
  // so anything larger stops reading as a centre mark and becomes a full-frame
  // target behind the fighters.
  _drawEmblem(g, cx, cy, span) {
    const a = config.matEmblemAlpha;
    if (a <= 0) return;

    const R   = span * 0.125;
    const col = cssHex(config.matEmblemColor);

    g.lineStyle(Math.max(1, R * 0.055), col, a);
    g.strokeCircle(cx, cy, R);
    g.strokeCircle(cx, cy, R * 0.74);

    g.fillStyle(col, a * 0.85);
    g.fillPoints([
      new Phaser.Geom.Point(cx, cy - R * 0.5),
      new Phaser.Geom.Point(cx + R * 0.5, cy),
      new Phaser.Geom.Point(cx, cy + R * 0.5),
      new Phaser.Geom.Point(cx - R * 0.5, cy),
    ], true);

    g.fillStyle(cssHex(config.ringFloorColor), a * 1.6);
    g.fillPoints([
      new Phaser.Geom.Point(cx, cy - R * 0.22),
      new Phaser.Geom.Point(cx + R * 0.22, cy),
      new Phaser.Geom.Point(cx, cy + R * 0.22),
      new Phaser.Geom.Point(cx - R * 0.22, cy),
    ], true);
  }

  // ── Ropes, posts, turnbuckles ──────────────────────────────────────────────
  //
  // Strand 0 sits exactly on the ring bounds rect and the rest step OUTWARD, so
  // the drawn ropes still mark the line the fighters actually clamp to — the
  // multi-strand look is added without moving where the boundary appears to be.
  _drawRopes(bounds) {
    const g = this.ropeGfx;
    g.clear();

    const n    = Math.max(1, Math.round(config.ringRopeCount));
    const gap  = Math.max(1, config.ringRopeSpacing);
    const th   = Math.max(1, config.ringRopeThickness);
    const cols = [config.ringRopeColor, config.ringRopeColor2, config.ringRopeColor3];

    const strand = (x1, y1, x2, y2, color) => {
      // Drop shadow first so each strand reads as sitting above the deck.
      g.lineStyle(th, 0x000000, 0.3);
      g.beginPath(); g.moveTo(x1, y1 + 2); g.lineTo(x2, y2 + 2); g.strokePath();
      g.lineStyle(th, color, 1);
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.strokePath();
      // Highlight along the top of the cord
      g.lineStyle(Math.max(1, th * 0.3), 0xffffff, 0.25);
      g.beginPath(); g.moveTo(x1, y1 - th * 0.3); g.lineTo(x2, y2 - th * 0.3); g.strokePath();
    };

    for (let i = 0; i < n; i++) {
      const o = i * gap;
      const c = cssHex(cols[i % cols.length]);
      strand(bounds.left - o, bounds.top - o, bounds.right + o, bounds.top - o, c);       // far
      strand(bounds.left - o, bounds.bottom + o, bounds.right + o, bounds.bottom + o, c); // near
      strand(bounds.left - o, bounds.top - o, bounds.left - o, bounds.bottom + o, c);     // left
      strand(bounds.right + o, bounds.top - o, bounds.right + o, bounds.bottom + o, c);   // right
    }

    const out = (n - 1) * gap;
    for (const [px, py, sx, sy, left] of [
      [bounds.left - out,  bounds.top - out,     1,  1, true],
      [bounds.right + out, bounds.top - out,    -1,  1, false],
      [bounds.left - out,  bounds.bottom + out,  1, -1, true],
      [bounds.right + out, bounds.bottom + out, -1, -1, false],
    ]) {
      this._drawCorner(g, px, py, sx, sy, left);
    }
  }

  /**
   * One corner: the turnbuckle pad wrapping the rope ends, then the post cap.
   * @param sx,sy  unit vector pointing INTO the ring from this corner
   * @param left   true for the two left-hand corners (pad colour A)
   */
  _drawCorner(g, px, py, sx, sy, left) {
    const pad = Math.max(4, config.ringPadSize);
    const th  = pad * 0.62;
    const ps  = Math.max(4, config.ringPostSize);

    // Pad: a band laid diagonally across the corner, from a point along one edge
    // to a point along the other.
    const ax = px + sx * pad,  ay = py;
    const bx = px,             by = py + sy * pad;
    const ox = sx * th * 0.72, oy = sy * th * 0.72;
    const quad = [
      new Phaser.Geom.Point(ax, ay),
      new Phaser.Geom.Point(bx, by),
      new Phaser.Geom.Point(bx + ox, by + oy),
      new Phaser.Geom.Point(ax + ox, ay + oy),
    ];

    g.fillStyle(cssHex(left ? config.ringPadColorA : config.ringPadColorB), 1);
    g.fillPoints(quad, true);
    g.lineStyle(1, 0x000000, 0.35);
    g.strokePoints(quad, true);

    // Post cap
    g.fillStyle(0x000000, 0.35);
    g.fillRect(px - ps / 2 + 2, py - ps / 2 + 3, ps, ps);
    g.fillStyle(cssHex(config.ringPostColor), 1);
    g.fillRect(px - ps / 2, py - ps / 2, ps, ps);
    g.fillStyle(0x000000, 0.22);
    g.fillRect(px - ps / 2, py + ps * 0.15, ps, ps * 0.35);
  }

  // Anchored in WORLD space relative to the ring, so the beams pan with the
  // camera the way a fixed light rig should rather than sticking to the screen.
  _placeBeams(bounds) {
    const w = bounds.right - bounds.left;
    const h = bounds.bottom - bounds.top;
    this.beamSheet
      .setPosition((bounds.left + bounds.right) / 2 + (SHEET_X0 + SHEET_W / 2) * w,
                   bounds.top + (SHEET_Y0 + SHEET_H / 2) * h)
      .setDisplaySize(SHEET_W * w, SHEET_H * h)
      .setAlpha(config.beamAlpha)
      .setVisible(config.beamAlpha > 0 && Math.round(config.beamCount) >= 1);
  }

  // ── Screen-focus vignette, and visibility culling ──────────────────────────
  //
  // The vignette is kept on the WORLD camera and re-fitted to the visible rect
  // each frame rather than parked on the UI camera: the HUD layer is left
  // exactly as it was, and the vignette automatically sits under every UI
  // element instead of depending on depth ordering against them. Called after
  // the camera has settled this frame's scroll, so the fit is exact; the small
  // oversize is belt-and-braces against sub-pixel rounding at the view edge.
  //
  // The same view rect culls the two layers that live entirely outside the mat.
  // At the default zoom the camera clamp keeps the view inside the ring, so this
  // is not a rare case — it is almost every frame, and it is most of why this
  // stage costs nearly nothing at the zoom the game actually runs at.
  updateOverlay(view, bounds) {
    this.vignette
      .setPosition((view.left + view.right) / 2, (view.top + view.bottom) / 2)
      .setDisplaySize(view.width + 4, view.height + 4)
      .setAlpha(config.vignetteStrength)
      .setVisible(config.vignetteStrength > 0);

    const insideMat =
      view.left >= bounds.left && view.right  <= bounds.right &&
      view.top  >= bounds.top  && view.bottom <= bounds.bottom;
    this.backdrop.setVisible(!insideMat);
    this.apronGfx.setVisible(!insideMat);
  }
}
