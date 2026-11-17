/**
 * mocap_geo_test.mjs — cfg.mocapGeo: the sim's punching glove is the mocap clip's glove (core/mocap.ts, sim/mocap.ts).
 *   npm run test:quick mocap_geo
 * Off: the sim is bit-identical to before (hash recorded before the feature). On: every punch lands inside its
 * band (measured here, the clips are still being re-cut) and whiffs 15 cm past it; a cramped straight lands softer;
 * the height aim keeps a jab landing on a man 10 cm taller / shorter; two runs agree; the hit glove is the clip glove.
 */
import { load } from './load.mjs';
import { check, done } from './check.js';
import { loadMocapLib } from './lib/mocap_load.mjs';
import { makeBands, PUNCHES } from './lib/mocap_bands.mjs';

const [core, sim, AI, mocap, smoc] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts', '/src/sim/mocap.ts');
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
function aiFight(cfg, seed = 11, ticks = 1200) {
  const specs = [core.ROSTER[0], core.ROSTER[1]];
  let s = sim.createState(specs, cfg, seed);
  let a = AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), b = AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg));
  let lands = 0;
  for (let i = 0; i < ticks; i++) {
    const da = AI.aiStep(a, s, cfg), db = AI.aiStep(b, s, cfg); a = da.ai; b = db.ai;
    const r = sim.step(s, [da.input, db.input], cfg); s = r.state;
    lands += r.events.filter(e => e.type === 'punchLand').length;
  }
  return { hash: fnv(JSON.stringify(s)), lands };
}

// ── 1. off: identical to the sim before mocapGeo existed (hash recorded 2026-11-16 before any sim edit) ──
{
  const off = aiFight(core.createConfig());
  check('toggle off: a seeded 20 s AI fight hashes as before the feature (e057aef1)', off.hash === 'e057aef1', off.hash);
  // and with the library loaded but the toggle off, still the same
  loadMocapLib(mocap);
  check('…with the clip library injected, still identical', aiFight(core.createConfig()).hash === 'e057aef1');
}

const base = core.createConfig();
const cfg = { ...base, punchTimeScale: base.humanPunchTimeScale, mocapGeo: true };
const B = makeBands(core, sim);
const ok = (o, low) => o.type === 'punchLand' && o.part === (low ? 'body' : 'head');

// ── 2. bands: land inside, whiff 15 cm beyond ──
const table = [];
const sep = base.separationDist * base.mocapCloseScale;
for (const low of [false, true]) for (const p of PUNCHES) {
  if (low && p.btn === 'uppercut') continue;
  const b = B.band(cfg, p, low, 0, 0.6, 1.8);
  const name = `${low ? 'body' : 'head'} ${p.name}`;
  table.push(`${name} ${b.lo?.toFixed(2)}-${b.hi?.toFixed(2)}`);
  if (b.lo === null) { check(`${name}: lands somewhere`, false); continue; }
  const mid = (b.lo + b.hi) / 2;
  check(`${name}: lands mid-band (${mid.toFixed(2)} m) and at its far end (${b.hi.toFixed(2)})`, ok(B.throwAt(cfg, mid, p, low, 0), low) && ok(B.throwAt(cfg, b.hi, p, low, 0), low));
  const far = B.throwAt(cfg, b.hi + 0.15, p, low, 0);
  check(`${name}: whiffs 15 cm beyond (${(b.hi + 0.15).toFixed(2)})`, far.type === 'punchWhiff', far.type + ' ' + (far.part ?? ''));
  check(`${name}: lands from the closest the bodies get (${sep.toFixed(2)})`, b.lo <= sep + 0.03, b.lo.toFixed(2));
}
console.log('bands (centre to centre, same height): ' + table.join(' | '));

// ── 3. too close: a straight lands, softer ──
{
  const jab = PUNCHES[0];
  const close = B.throwAt(cfg, sep, jab, false, 0), mid = B.throwAt(cfg, 1.0, jab, false, 0);
  check(`a jab at body contact (${sep.toFixed(2)} m) lands with less power than at 1.0 m`, close.type === 'punchLand' && mid.type === 'punchLand' && close.power < mid.power * 0.9, `${close.type} ${close.power?.toFixed(3)} vs ${mid.power?.toFixed(3)}`);
  const hook = PUNCHES[2];
  const hc = B.throwAt(cfg, sep, hook, false, 0), hm = B.throwAt(cfg, 0.9, hook, false, 0);
  // (inside, the hook button throws the shovel hook at shovelHookPower of a hook — its own weight, no close-range ramp: punch_test)
  const want = hc.variant === 'shovelHook' && hm.variant !== 'shovelHook' ? base.shovelHookPower : 1;
  check('a lead hook at body contact keeps its power (no close-range ramp; the shovel hook its own weight)', hc.type === 'punchLand' && hm.type === 'punchLand' && hc.power >= hm.power * want * 0.9, `${hc.variant} ${hc.power?.toFixed(3)} vs ${hm.variant} ${hm.power?.toFixed(3)} x ${want}`);
}

// ── 4. height aim: the jab lands on a taller and a shorter man across >= 80% of the same-height band ──
{
  const jab = PUNCHES[0];
  const b = B.band(cfg, jab, false, 0, 0.6, 1.8);
  for (const dh of [0.1, -0.1]) {
    let n = 0, l = 0;
    for (let d = b.lo; d <= b.hi + 1e-9; d += 0.04) { n++; if (ok(B.throwAt(cfg, d, jab, false, dh), false)) l++; }
    check(`jab on a man ${dh > 0 ? '10 cm taller' : '10 cm shorter'}: lands over ${l}/${n} of the band (>= 80%)`, l / n >= 0.8);
  }
}

// ── 5. determinism with the toggle on ──
{
  const r1 = aiFight(cfg, 23), r2 = aiFight(cfg, 23);
  check('toggle on: two seeded AI fights hash the same', r1.hash === r2.hash, `${r1.hash} vs ${r2.hash}`);
  check('…and the fight had lands in it', r1.lands > 3, String(r1.lands));
}

// ── 6. the glove at the hit tick is the clip's glove (free in the air just past the band, and at the band's far end
//      where it only just touches; nearer in, the contacts stop it on the surface — it does not go through) ──
{
  const hiOf = name => Number(table.find(t => t.startsWith('head ' + name + ' ')).split('-').pop());
  for (const [p, d] of [[PUNCHES[0], hiOf('jab') + 0.05], [PUNCHES[1], hiOf('cross') + 0.05], [PUNCHES[3], hiOf('rear hook') + 0.05], [PUNCHES[1], hiOf('cross')], [PUNCHES[3], hiOf('rear hook')]]) {
    let gap = null;
    const o = B.throwAt(cfg, d, p, false, 0, (prev, s, evs) => {
      if (!evs.some(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff'))) return;
      const f = s.fighters[0], mg = smoc.mocapGlove(f), g = f.gloves[f.punch.hand === 'lead' ? 0 : 1].pos;
      if (mg) gap = Math.hypot(g.x - mg.x, g.y - mg.y, g.z - mg.z);
    });
    check(`${p.name} at ${d} m (${o.type}): the hit-tick glove is within 2 cm of the clip glove`, gap !== null && gap < 0.02, gap === null ? 'no glove' : (gap * 100).toFixed(1) + ' cm');
  }
}
// ── 7. ONE clip choice: a cross chained off a jab plays the jab-cross combination clip, in the sim's glove AND in what
//      the drawn side reads (mocapPunchNow on the same state); an unchained cross plays the single cross ──
{
  const run = (crossAt, level = false) => {
    let s = sim.createState([core.ROSTER[0], core.ROSTER[1]], cfg, 1);
    s.fighters[0].pos = { x: -0.45, z: 0 }; s.fighters[1].pos = { x: 0.45, z: 0 };
    const idle = core.cloneInput(core.NULL_INPUT);
    for (let i = 0; i < 30; i++) s = sim.step(s, [idle, idle], cfg).state;
    let simPick = null, drawPick = null;
    for (let i = 0; i < 70; i++) {
      const a = { ...core.cloneInput(core.NULL_INPUT), jab: i === 0, cross: i === crossAt, level };
      s = sim.step(s, [a, idle], cfg).state;
      const f = s.fighters[0];
      if (f.punch.type === 'cross' && !simPick) {
        simPick = smoc.mocapGeoOf(f)?.pick?.name ?? null;
        drawPick = smoc.mocapPunchNow(f, s.fighters[1], cfg)?.geo.pick?.name ?? null;
      }
    }
    return { simPick, drawPick };
  };
  // (the only jab-cross clip is thrown to the BODY: it plays for a chained body cross; a chained HEAD cross keeps the
  //  head-height single cross — the body combo lifted to the head was the "weird animation upwards")
  const chained = run(7), single = run(40), low = run(7, true);
  check(`a cross pressed while the jab is in flight (head): sim and drawn read pick the same, the head cross (${chained.simPick} / ${chained.drawPick})`, chained.simPick === 'cross' && chained.drawPick === 'cross');
  check(`a cross thrown on its own plays the single cross (${single.simPick} / ${single.drawPick})`, single.simPick === 'cross' && single.drawPick === 'cross');
  check(`a body cross chained off a body jab plays combo_jab_cross in the sim and the drawn read (${low.simPick} / ${low.drawPick})`, low.simPick === 'combo_jab_cross' && low.drawPick === 'combo_jab_cross');
}
done();
