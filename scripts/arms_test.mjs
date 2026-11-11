/**
 * arms_test.mjs — the sim's arms and arm contacts (2026-09-18, "arms still go
 * through each other when exchanging punches… should feel like meat and bone").
 *   - rest: elbows hang below the shoulders, outside the torso, bones the right length
 *   - an exchange (both fighters throw at once, every pairing): no forearm
 *     ever enters the other's forearm, upper arm or glove beyond the give
 *   - a jab into a block stops at the guard and still resolves as a block
 *   - the drawn geometry IS this geometry: arms are on the state, cloned per tick
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, closestOnSegment, closestSegSeg, v3dist } = core;
// ratingsOn / stylesOn off (overhaul phase 2): this file pins the reference fighters' numbers and margins as they were before
// ratings and guard shapes did anything — both un-rated, both in the high guard. ratings_test / styles_test cover those.
const cfg = { ...({ ...createConfig(), ratingsOn: false, stylesOn: false }), healthDamagePerImpulse: 0, staminaPunchCost: 0 };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const BLOCK = inp({ block: true });
const cm = v => (v * 100).toFixed(1);

function fresh(dist) {
  let s = sim.createState(specs, cfg, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], cfg).state;
  return s;
}

// ── 1. Rest ──────────────────────────────────────────────────────────────────
{
  const s = fresh(0.85);
  for (const [side, f] of s.fighters.entries()) {
    for (let i = 0; i < 2; i++) {
      const a = f.arms[i], g = f.gloves[i].pos;
      check(`side ${side} arm ${i}: upper arm is the body's length`, near(v3dist(a.shoulder, a.elbow), f.body.upperArm, 1e-6), `${cm(v3dist(a.shoulder, a.elbow))} vs ${cm(f.body.upperArm)}`);
      check(`side ${side} arm ${i}: forearm reaches the glove (≤ stretch)`, v3dist(a.elbow, g) <= f.body.forearm * cfg.rigArmStretchMax + 1e-6, cm(v3dist(a.elbow, g)));
      check(`side ${side} arm ${i}: elbow hangs below the shoulder at the guard`, a.elbow.y < a.shoulder.y, `${cm(a.elbow.y - a.shoulder.y)} cm`);
      const clear = v3dist(closestOnSegment(f.bodyBox.a, f.bodyBox.b, a.elbow), a.elbow);
      check(`side ${side} arm ${i}: elbow clears the torso`, clear >= f.body.bodyR * (1 + cfg.rigForearmR) * cfg.rigElbowClearance - 1e-6, `${cm(clear)} cm from the axis`);
    }
  }
}

// ── 2. The exchange ──────────────────────────────────────────────────────────
// Every pairing of the four punches thrown simultaneously at 0.75 m (and the
// straights at 0.6), with the AI off. Tracks, every tick, the deepest entry
// of any forearm into the other fighter's forearm / upper arm / glove.
function exchange(pa, pb, dist, xa = -1, xb = -1) {
  let s = fresh(dist);
  const give = s.fighters[0].body.gloveR * cfg.contactSquash;
  let worst = { ff: -1, fu: -1, fg: -1 };
  for (let i = 0; i < 45; i++) {
    s = sim.step(s, [inp(i === 0 ? { [pa]: true, move: { x: xa, y: 0 } } : {}), inp(i === 0 ? { [pb]: true, move: { x: xb, y: 0 } } : {})], cfg).state;
    const [a, b] = s.fighters;
    const foreA = a.body.bodyR * cfg.rigForearmR, foreB = b.body.bodyR * cfg.rigForearmR;
    const upA = a.body.bodyR * cfg.rigUpperArmR, upB = b.body.bodyR * cfg.rigUpperArmR;
    for (let p = 0; p < 2; p++) for (let q = 0; q < 2; q++) {
      const fa = [a.arms[p].elbow, a.gloves[p].pos], fb = [b.arms[q].elbow, b.gloves[q].pos];
      const ff = closestSegSeg(fa[0], fa[1], fb[0], fb[1]);
      worst.ff = Math.max(worst.ff, foreA + foreB - v3dist(ff.p, ff.q));
      const fu = closestSegSeg(fa[0], fa[1], b.arms[q].shoulder, b.arms[q].elbow);
      worst.fu = Math.max(worst.fu, foreA + upB - v3dist(fu.p, fu.q));
      const uf = closestSegSeg(fb[0], fb[1], a.arms[p].shoulder, a.arms[p].elbow);
      worst.fu = Math.max(worst.fu, foreB + upA - v3dist(uf.p, uf.q));
      worst.fg = Math.max(worst.fg, foreB + a.body.gloveR - v3dist(a.gloves[p].pos, closestOnSegment(fb[0], fb[1], a.gloves[p].pos)));
      worst.fg = Math.max(worst.fg, foreA + b.body.gloveR - v3dist(b.gloves[q].pos, closestOnSegment(fa[0], fa[1], b.gloves[q].pos)));
    }
  }
  return { worst, give };
}
const TYPES = ['jab', 'cross', 'hook', 'uppercut'];
let deepest = { ff: -1, fu: -1, fg: -1 }, give = 0;
for (const pa of TYPES) for (const pb of TYPES) {
  const r = exchange(pa, pb, 0.75);
  give = r.give;
  for (const k of Object.keys(deepest)) deepest[k] = Math.max(deepest[k], r.worst[k]);
}
for (const pa of ['jab', 'cross']) for (const pb of ['jab', 'cross']) {
  const r = exchange(pa, pb, 0.6);
  for (const k of Object.keys(deepest)) deepest[k] = Math.max(deepest[k], r.worst[k]);
}
// Forearm vs forearm and forearm vs upper arm are separated to (sum of radii − give/2); tolerance one give.
// Tolerance 1.5 cm over the give: a landed punch sits the struck body down (reaction.sink) and swings its shoulders on the land tick, and the contacts catch up within the tick's sub-steps.
check(`exchange: no forearm enters the other's forearm beyond the give (16 pairings @0.75 + 4 @0.6)`, deepest.ff <= give + 0.015, `deepest ${cm(deepest.ff)} cm (give ${cm(give)})`);
// Forearm vs upper arm is NOT resolved (a cross to the chin runs along the lead shoulder; deflecting it there threw it off the head) — reported, loosely bounded.
check('exchange: a forearm never sinks more than 12 cm into the other\'s upper arm (unresolved by design, the shoulder gives)', deepest.fu <= 0.12, `deepest ${cm(deepest.fu)} cm`);
check('exchange: no glove enters the other\'s forearm beyond the give', deepest.fg <= give + 0.015, `deepest ${cm(deepest.fg)} cm`);
console.log(`     deepest arm-into-arm over 20 exchanges: forearm/forearm ${cm(deepest.ff)}, forearm/upper ${cm(deepest.fu)}, glove/forearm ${cm(deepest.fg)} cm (give ${cm(give)})`);

// ── 3. A jab into a block ────────────────────────────────────────────────────
{
  let s = fresh(0.79);
  for (let i = 0; i < 5; i++) s = sim.step(s, [NONE, BLOCK], cfg).state;
  let outcome = null, minHeadGap = 9;
  for (let i = 0; i < 30; i++) {
    const r = sim.step(s, [inp({ jab: i === 0 }), BLOCK], cfg); s = r.state;
    for (const e of r.events) if (e.side === 0 && (e.type === 'punchBlock' || e.type === 'perfectBlock' || e.type === 'punchLand' || e.type === 'punchWhiff')) outcome = e.type;
    const a = s.fighters[0], d = s.fighters[1];
    minHeadGap = Math.min(minHeadGap, v3dist(a.gloves[0].pos, d.headBox) - d.headBox.r - a.body.gloveR);
  }
  check('a jab into a held block resolves as a block', outcome === 'punchBlock' || outcome === 'perfectBlock', outcome);
  check('…and the fist never sinks past the give into the face behind the gloves', minHeadGap >= -give - 0.005, `${cm(minHeadGap)} cm from the head surface at the closest`);
}

// ── 4. Arms are state ────────────────────────────────────────────────────────
{
  const s = fresh(0.85);
  const n = sim.step(s, [inp({ cross: true }), NONE], cfg).state;
  check('stepping does not alias the previous state\'s arms', n.fighters[0].arms[1] !== s.fighters[0].arms[1] && n.fighters[0].arms[1].elbow !== s.fighters[0].arms[1].elbow);
  check('a cross moves the rear elbow', v3dist(n.fighters[0].arms[1].elbow, s.fighters[0].arms[1].elbow) > 1e-4);
}

done();
