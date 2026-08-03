/**
 * glove_test.mjs — Stage 14 part 1: the drawn glove IS the fist hit circle.
 * Run with: node scripts/glove_test.mjs   (dev server must be running)
 *
 * The fist was the one place where hit geometry and drawn geometry had come
 * apart: config.fistRadius has been a live hit circle at the solved wrist since
 * Stage 9, but nothing was ever drawn there. This file pins the fix down —
 * across all four punch types, both rig slots and both fighters:
 *
 *   1. A glove is actually drawn, at the WRIST, with radius == config.fistRadius
 *      (so dragging the Fist Radius slider resizes the glove).
 *   2. Its center matches the pose solve getFistPos() reads — the same pose
 *      data, not a parallel offset that could drift out of agreement.
 *   3. Its COLOUR follows the rear-side treatment (Stage 14 part 3): a resting
 *      rear glove is darkened by config.rearLimbDarken like every other rear
 *      limb, and a rear glove at full extension mid-cross is back at full
 *      colour. A glove at full brightness on a dimmed rear arm reads as a bug.
 *
 * Assertions are made against the graphics COMMAND BUFFER rather than pixels:
 * that is the draw call the renderer consumes, so it carries the exact center,
 * radius and fill colour with no sampling, occlusion or colour-blend guesswork.
 * Phaser encodes Graphics.fillCircle as BEGIN_PATH / ARC(x,y,r,…) / FILL_PATH,
 * with the fill colour set by the preceding FILL_STYLE.
 */
import { chromium } from 'playwright';
import { DEV_URL } from './devUrl.js';
import { mkdirSync } from 'fs';

mkdirSync('scripts/output', { recursive: true });

const EPS = 0.001;

const browser = await chromium.launch();
const page    = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console',   m => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto(DEV_URL, { waitUntil: 'networkidle', timeout: 15000 });
await page.waitForTimeout(1200);

// Silence everything that would move a fighter or deform its pose underneath
// the probe — this file is about where the glove is drawn, nothing else.
await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  window.__config.dummyMoveSpeed           = 0;
  window.__config.dummyAttackDelayMin      = 999;
  window.__config.dummyAttackDelayMax      = 999;
  window.__config.dummyBlockReactionChance = 0;
  sc.dummy.attackTimer = 999;

  // Phaser Graphics command opcodes (Commands.js) and their argument counts.
  const ARGS = {
    0: 7,   // ARC          x y radius startAngle endAngle anticlockwise overshoot
    1: 0,   // BEGIN_PATH
    2: 0,   // CLOSE_PATH
    3: 4,   // FILL_RECT    x y w h
    4: 2,   // LINE_TO      x y
    5: 2,   // MOVE_TO      x y
    6: 3,   // LINE_STYLE   width color alpha
    7: 2,   // FILL_STYLE   color alpha
    8: 0,   // FILL_PATH
    9: 0,   // STROKE_PATH
    10: 6,  // FILL_TRIANGLE
    11: 6,  // STROKE_TRIANGLE
    14: 0,  // SAVE
    15: 0,  // RESTORE
    16: 2,  // TRANSLATE    x y
    17: 2,  // SCALE        x y
    18: 1,  // ROTATE       radians
  };

  /** Every filled circle in a Graphics buffer, with the fill colour in force. */
  const readArcs = (buf) => {
    const out = [];
    let color = 0, alpha = 1;
    for (let i = 0; i < buf.length;) {
      const op = buf[i];
      const n  = ARGS[op];
      if (n === undefined) break;                     // unknown opcode — stop rather than misparse
      if (op === 7) { color = buf[i + 1]; alpha = buf[i + 2]; }
      if (op === 0) out.push({ x: buf[i + 1], y: buf[i + 2], r: buf[i + 3], color, alpha });
      i += 1 + n;
    }
    return out;
  };

  /**
   * Hold one punch pose open and read back both the drawn circles and the pose
   * solve. _punchState is the single input _draw() and getFistPos() BOTH read,
   * so stubbing it is what makes the two comparable at an exact instant instead
   * of racing the punch timer for a frame.
   */
  window.__gloveProbe = (who, type, slot) => {
    const f = who === 'player' ? sc.fighter : sc.dummy;
    const p = window.__rig.peakProgress(type);
    const st = type ? { type, arm: slot, p, aim: 0 } : null;

    const saved = f._punchState;
    f._punchState = () => st;
    f._bob = 0;
    f.reaction.reset();
    (f._draw ? f._draw : f.draw).call(f);

    const pose = window.__rig.computePose(st, f.isBlocking ? 1 : 0, 0);
    const anat = window.__rig.armSlot(f.stance, 'left') === slot ? 'left' : 'right';
    const out = {
      arcs: readArcs(f.gfx.commandBuffer),
      wrist: {
        lead: { x: pose.lead.wx, y: pose.lead.wy },
        rear: { x: pose.rear.wx, y: pose.rear.wy },
      },
      // The world-space fist _resolveAttack tests with, and the transform that
      // maps rig-local → world, so the two spaces can be reconciled.
      fist: f.getFistPos(anat),
      origin: { x: f.x, y: f.y, flip: f.facingRight ? 1 : -1 },
      fistRadius: window.__config.fistRadius,
    };
    f._punchState = saved;
    return out;
  };

  /** The rig's own rear-side darkening, mirrored so the test can predict it. */
  window.__darken = (c, amount) => {
    const t = 1 - Math.min(Math.max(amount, 0), 1);
    return (Math.round(((c >> 16) & 0xff) * t) << 16)
         | (Math.round(((c >> 8) & 0xff) * t) << 8)
         |  Math.round((c & 0xff) * t);
  };
  window.__palette = (who) => (who === 'player'
    ? { glove: parseInt(window.__config.fighterGloveColor.replace('#', ''), 16) }
    : { glove: parseInt(window.__config.dummyGloveColor.replace('#', ''), 16) });
});

const results = [];
const fail = (msg) => { results.push({ ok: false, msg }); };
const pass = (msg) => { results.push({ ok: true,  msg }); };

const hex = n => '#' + n.toString(16).padStart(6, '0');

for (const who of ['player', 'dummy']) {
  for (const type of ['jab', 'cross', 'hook', 'uppercut']) {
    for (const slot of ['lead', 'rear']) {
      const probe = await page.evaluate(
        ([who, type, slot]) => {
          const r = window.__gloveProbe(who, type, slot);
          const pal = window.__palette(who);
          const d = window.__config.rearLimbDarken;
          return {
            ...r,
            gloveColor: pal.glove,
            // The rear glove is darkened like every other rear limb — EXCEPT
            // when the rear arm is the one throwing, which sheds the treatment
            // completely by full extension (ext = 1 at peakAt).
            rearGloveColor: slot === 'rear'
              ? pal.glove
              : window.__darken(pal.glove, d),
          };
        },
        [who, type, slot],
      );

      const label = `${who} ${type}/${slot}`;
      const R = probe.fistRadius;

      // ── 1. A glove of exactly fistRadius exists at each wrist ─────────────
      for (const side of ['lead', 'rear']) {
        const w   = probe.wrist[side];
        const hit = probe.arcs.find(a =>
          Math.abs(a.x - w.x) < EPS && Math.abs(a.y - w.y) < EPS && Math.abs(a.r - R) < EPS);
        if (hit) {
          const want = side === 'lead' ? probe.gloveColor : probe.rearGloveColor;
          if (hit.color !== want) {
            fail(`${label} — ${side} glove drawn at the wrist but in ${hex(hit.color)}, expected ${hex(want)}`);
          } else {
            pass(`${label} — ${side} glove at wrist (${w.x.toFixed(1)}, ${w.y.toFixed(1)}) r=${R} ${hex(hit.color)}`);
          }
        } else {
          const near = probe.arcs.map(a => `(${a.x.toFixed(1)},${a.y.toFixed(1)},r${a.r})`).join(' ');
          fail(`${label} — no r=${R} circle at the ${side} wrist (${w.x.toFixed(1)}, ${w.y.toFixed(1)}); drew ${near}`);
        }
      }

      // ── 2. The throwing glove is where the hit circle is ──────────────────
      // getFistPos() is what _resolveAttack tests with. Mapping the drawn glove
      // through the same facing mirror has to land on it exactly, or the thing
      // you see and the thing that hits have come apart again.
      const w  = probe.wrist[slot];
      const wx = probe.origin.x + w.x * probe.origin.flip;
      const wy = probe.origin.y + w.y;
      if (Math.abs(wx - probe.fist.x) > EPS || Math.abs(wy - probe.fist.y) > EPS) {
        fail(`${label} — drawn glove (${wx.toFixed(2)}, ${wy.toFixed(2)}) ≠ getFistPos (${probe.fist.x.toFixed(2)}, ${probe.fist.y.toFixed(2)})`);
      } else {
        pass(`${label} — drawn glove world pos == getFistPos`);
      }
    }
  }
}

// ── 3. The glove tracks the Fist Radius slider ──────────────────────────────
// The whole point of reusing config.fistRadius rather than a new constant.
for (const R of [4, 10, 22]) {
  const drawnR = await page.evaluate((R) => {
    window.__config.fistRadius = R;
    const p = window.__gloveProbe('player', 'jab', 'lead');
    const hit = p.arcs.find(a =>
      Math.abs(a.x - p.wrist.lead.x) < 0.001 && Math.abs(a.y - p.wrist.lead.y) < 0.001);
    return hit ? hit.r : null;
  }, R);
  if (drawnR === R) pass(`Fist Radius ${R} → glove drawn at r=${drawnR}`);
  else              fail(`Fist Radius ${R} → glove drawn at r=${drawnR}`);
}
await page.evaluate(() => { window.__config.fistRadius = 10; });

// ── 4. The block pose draws both gloves ─────────────────────────────────────
// Not a claim about coverage (see the LEAD_BLOCK/REAR_BLOCK notes in rig.js) —
// only that the block pose gets gloves at both wrists like every other pose.
const block = await page.evaluate(() => {
  const sc = window.__game.scene.keys.RingScene;
  sc.fighter.isBlocking = true;
  const r = window.__gloveProbe('player', null, 'lead');
  sc.fighter.isBlocking = false;
  return r;
});
for (const side of ['lead', 'rear']) {
  const w = block.wrist[side];
  const hit = block.arcs.find(a =>
    Math.abs(a.x - w.x) < EPS && Math.abs(a.y - w.y) < EPS && Math.abs(a.r - block.fistRadius) < EPS);
  if (hit) pass(`block pose — ${side} glove at (${w.x.toFixed(1)}, ${w.y.toFixed(1)})`);
  else     fail(`block pose — no glove at the ${side} wrist (${w.x.toFixed(1)}, ${w.y.toFixed(1)})`);
}

await browser.close();

// ── Report ──────────────────────────────────────────────────────────────────
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.msg}`);
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('Page errors:', errors.length ? errors : 'none');
if (failed.length || errors.length) process.exit(1);
