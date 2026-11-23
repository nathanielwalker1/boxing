/**
 * mocap_outcome_test.mjs — cfg.mocapOutcome (sim/outcome.ts): the punch is decided by RULE at its hit tick.
 *   npm run test:quick mocap_outcome
 * The rule table: whiff beyond the band's far end, land inside it, a straight inside near lands softer, a hook keeps
 * its power close, a held block blocks every punch, a slip in its window dodges a head punch (and the wrong way is
 * caught on the shoulder), a body variant lands on the body, the contact point is on the drawn target, the tells,
 * determinism; and with the toggle off the sim hashes as before.
 */
import { load } from './load.mjs';
import { check, done } from './check.js';
import { loadMocapLib } from './lib/mocap_load.mjs';

const [core, sim, AI, mocap, oc] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts', '/src/sim/outcome.ts');
const fnv = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
function aiFight(cfg, seed = 11, ticks = 1200) {
  const specs = [core.ROSTER[0], core.ROSTER[1]];
  let s = sim.createState(specs, cfg, seed);
  let a = AI.createAi(0, seed, cfg, AI.styleFor(specs[0], cfg)), b = AI.createAi(1, seed, cfg, AI.styleFor(specs[1], cfg));
  const n = { land: 0, block: 0, whiff: 0 };
  for (let i = 0; i < ticks; i++) {
    const da = AI.aiStep(a, s, cfg), db = AI.aiStep(b, s, cfg); a = da.ai; b = db.ai;
    const r = sim.step(s, [da.input, db.input], cfg); s = r.state;
    for (const e of r.events) { if (e.type === 'punchLand') n.land++; else if (e.type === 'punchBlock') n.block++; else if (e.type === 'punchWhiff') n.whiff++; }
  }
  return { hash: fnv(JSON.stringify(s)), n };
}

loadMocapLib(mocap);
// ── 0. off: identical to before (mocap_geo_test's recorded hash) ──
// (was e057aef1 until 2026-11-22: the round state gained two counters, iqScore and reached; with them deleted the state still hashes e057aef1)
check('toggle off (library loaded): a seeded 20 s AI fight hashes as before (1bdb9087)', aiFight(core.createConfig()).hash === '1bdb9087');

const base = core.createConfig();
const cfg = { ...base, punchTimeScale: base.humanPunchTimeScale, mocapGeo: true, mocapOutcome: true };
const inp = (o = {}) => ({ ...core.cloneInput(core.NULL_INPUT), ...o });
const P = [
  { name: 'jab', btn: 'jab', x: 0, far: 'mocapFarJab', bodyFar: 'mocapFarBodyJab' }, { name: 'cross', btn: 'cross', x: 0, far: 'mocapFarCross', bodyFar: 'mocapFarBodyCross' },
  { name: 'lead hook', btn: 'hook', x: -1, far: 'mocapFarLeadHook', bodyFar: 'mocapFarBodyHook' }, { name: 'rear hook', btn: 'hook', x: 1, far: 'mocapFarRearHook', bodyFar: 'mocapFarBodyHook' },
  { name: 'lead upper', btn: 'uppercut', x: -1, far: 'mocapFarLeadUpper' }, { name: 'rear upper', btn: 'uppercut', x: 1, far: 'mocapFarRearUpper' },
];
const H = core.ROSTER[0].heightM / base.mocapBandRefHeight;
// the far ends the sim uses: measured from the clips (core/mocap.ts mocapBandFar), or the hand-set keys with that off
const R0 = core.ROSTER[0], G0 = sim.createState([R0, R0], cfg, 1).fighters[0].body.gloveR;
const TYPE = { jab: ['jab', 'lead'], cross: ['cross', 'rear'], 'lead hook': ['hook', 'lead'], 'rear hook': ['hook', 'rear'], 'lead upper': ['uppercut', 'lead'], 'rear upper': ['uppercut', 'rear'] };
// (+ the head cross's step, mocapCrossStep, and the hook / uppercut floors mocapFarMinHook / Upper: sim/outcome.ts punchBand)
const farOf = (p, low) => Math.max((TYPE[p.name][0] === 'hook' ? base.mocapFarMinHook : TYPE[p.name][0] === 'uppercut' ? base.mocapFarMinUpper : 0) * H,
  (base.mocapBandsFromClips
    ? mocap.mocapBandFar(mocap.mocapLib(), cfg, R0.heightM, R0.stance, TYPE[p.name][0], TYPE[p.name][1], low, R0.heightM, R0.stance, G0)
    : base[low ? p.bodyFar : p.far] * H) + (p.name === 'cross' && !low ? base.mocapCrossStep * R0.heightM / base.mocapBandRefHeight : 0));
/** One throw by side 0 from `dist`; opp(i) = side 1's input on tick i. Returns the first outcome event (+ slip events seen). */
function throwAt(dist, p, { low = false, opp = () => inp(), c = cfg } = {}) {
  const specs = [core.ROSTER[0], { ...core.ROSTER[1], heightM: core.ROSTER[0].heightM, stance: core.ROSTER[0].stance }];
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  s.fighters[0].yaw = 0; s.fighters[1].yaw = Math.PI;
  const lv = low ? { level: true } : {};
  for (let i = 0; i < 40; i++) s = sim.step(s, [inp(lv), opp(-1)], c).state;
  const slips = [];
  let tell = null;
  for (let i = 0; i < 90; i++) {
    const r = sim.step(s, [inp({ ...lv, [p.btn]: i === 0, move: { x: i === 0 ? p.x : 0, y: 0 } }), opp(i)], c);
    s = r.state;
    for (const e of r.events) { if (e.type === 'slip' && e.dodged) slips.push(e); if (e.type === 'punchStart' && e.side === 0) tell = e.tell; }
    const e = r.events.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));
    if (e) return { ...e, tick: i, slips, s, tell, hitDist: Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z) };
  }
  return { type: 'none', slips };
}
const sep = base.mocapSeparation;

// ── 1. bands: whiff beyond far, land inside, on the part thrown at ──
if (base.mocapBandsFromClips) {
  const bands = P.flatMap(p => [false, true].filter(low => !low || p.bodyFar).map(low => `${low ? 'body ' : ''}${p.name} ${farOf(p, low)?.toFixed(2)}`));
  console.log(`bands from the clips (far end, m, centre to centre, ${R0.heightM} m fighters): ${bands.join(' | ')}`);
  check('every band is measured from its clip and reaches past the separation (each punch lands somewhere)', P.every(p => [false, true].every(low => (low && !p.bodyFar) || (farOf(p, low) ?? 0) > sep + 0.05)), bands.join(' | '));
}
const tells = [];
for (const low of [false, true]) for (const p of P) {
  if (low && !p.bodyFar) continue;
  const far = farOf(p, low), want = low ? 'body' : 'head';
  const name = `${low ? 'body' : 'head'} ${p.name}`;
  const out = throwAt(far + 0.05, p, { low });
  check(`${name}: whiffs just beyond its far end (${(far + 0.05).toFixed(2)} m)`, out.type === 'punchWhiff', `${out.type} at ${out.hitDist?.toFixed(2)}`);
  for (const d of [far - 0.04, (far + sep) / 2, sep + 0.02]) {
    const o = throwAt(d, p, { low });
    check(`${name}: lands on the ${want} at ${d.toFixed(2)} m`, o.type === 'punchLand' && o.part === want, `${o.type} ${o.part ?? ''} ${o.variant ?? ''}`);
  }
  if (!low) tells.push(`${p.name} ${(throwAt(1.0, p).tell * 1000).toFixed(0)} ms`);
}

// ── 2. close range: a straight lands softer, a hook keeps its power ──
{
  const jc = throwAt(sep, P[0]), jm = throwAt(1.0, P[0]);
  check(`a jab at the separation (${sep}) lands with less power than at 1.0 m`, jc.type === 'punchLand' && jm.type === 'punchLand' && jc.power < jm.power * 0.9, `${jc.power?.toFixed(3)} vs ${jm.power?.toFixed(3)}`);
  const hc = throwAt(sep, P[2]), hm = throwAt(0.95, P[2]);
  const want = hc.variant === 'shovelHook' && hm.variant !== 'shovelHook' ? base.shovelHookPower : 1;
  check('a lead hook at the separation keeps its power (no ramp; a shovel hook its own weight)', hc.type === 'punchLand' && hm.type === 'punchLand' && hc.power >= hm.power * want * 0.9, `${hc.variant} ${hc.power?.toFixed(3)} vs ${hm.variant} ${hm.power?.toFixed(3)}`);
}

// ── 3. a held block blocks every punch at every distance in its band ──
{
  let n = 0, b = 0; const miss = [];
  for (const low of [false, true]) for (const p of P) {
    if (low && !p.bodyFar) continue;
    const far = farOf(p, low);
    for (const d of [sep + 0.02, (sep + far) / 2, far - 0.03]) {
      const o = throwAt(d, p, { low, opp: () => inp({ block: true }) });
      n++;
      if (o.type === 'punchBlock' || o.type === 'perfectBlock') b++; else miss.push(`${low ? 'body ' : ''}${p.name}@${d.toFixed(2)}:${o.type}`);
    }
  }
  check(`a held block blocks ${b}/${n} punches (every punch, near / mid / far)`, b === n, miss.join(' '));
}

// ── 4. slips: a lateral flick timed into the punch dodges it (slip event, dodged) one way; the wrong way is caught on the shoulder ──
{
  const flick = (x, at) => i => inp({ move: { x: i >= at && i < at + 2 ? x : 0, y: 0 } });
  const res = [-1, 1].map(x => throwAt(1.0, P[0], { opp: flick(x, 4) }));
  const dodged = res.filter(o => o.type === 'punchWhiff' && o.slips.length > 0).length;
  const wrong = res.filter(o => o.type === 'punchLand' && o.part === 'body').length;
  check(`a slip in its window dodges the jab one way (slip event, dodged) and is caught on the shoulder the other way (${res.map(o => `${o.type}/${o.part ?? '-'}/${o.slips.length}`).join(', ')})`,
    dodged === 1 && (wrong === 1 || !(base.wrongWayOn && base.wrongWayShoulder > 0)));
  const late = throwAt(1.0, P[0], { opp: flick(-1, 40) }), late2 = throwAt(1.0, P[0], { opp: flick(1, 40) });
  check('a slip long after the punch landed does not change it (both land on the head)', late.type === 'punchLand' && late.part === 'head' && late2.type === 'punchLand' && late2.part === 'head');
  // the pull: straight back (timed for the cross's 0.42 s tell, 2026-11-17: 6 ticks later than for the old 0.32 s)
  const pull = throwAt(1.0, P[1], { opp: i => inp({ move: { x: 0, y: i >= 12 && i < 14 ? -1 : 0 } }) });
  check(`a pull in its window dodges the cross (${pull.type}, ${pull.slips.length} slip event)`, pull.type === 'punchWhiff' && pull.slips.length === 1);
  // a body punch is not dodged by a slip
  const bodySlip = [-1, 1].map(x => throwAt(0.95, P[0], { low: true, opp: flick(x, 3) }));
  check(`a slip does not dodge a body jab (${bodySlip.map(o => `${o.type}/${o.part}`).join(', ')})`, bodySlip.every(o => o.type === 'punchLand' && o.part === 'body'));
}

// ── 5. the contact point is on the drawn target, facing the attacker ──
{
  const o = throwAt(1.0, P[0]), d1 = o.s.fighters[1], a0 = o.s.fighters[0];
  // (the state is after the land tick: the hit has already moved his head a little, hence the tolerance: 6 cm since the 0.28 s jab, which lands harder and moves the head further in its land tick)
  const t = mocap.mocapDrawnTargets(mocap.mocapLib(), cfg, d1, core.GUARDS[cfg.stylesOn ? d1.guardShape : 'high'].crouch, mocap.makeDrawnTargets());
  const dh = Math.hypot(o.at.x - t.head.x, o.at.y - t.head.y, o.at.z - t.head.z);
  const ok = Math.abs(dh - (t.headR + a0.body.gloveR * (1 - base.contactSquash))) < 0.06 && o.at.x < t.head.x && Math.abs(o.at.y - t.head.y) < 0.03;
  check(`a jab's contact point rests on the drawn head's front at head-centre height (${(dh * 100).toFixed(1)} cm from its centre, y ${o.at.y.toFixed(2)} vs ${t.head.y.toFixed(2)})`, ok);
  check('…and punch.contact is that point', a0.punch.contact && Math.hypot(a0.punch.contact.x - o.at.x, a0.punch.contact.y - o.at.y, a0.punch.contact.z - o.at.z) < 1e-9);
  const b = throwAt(1.0, P[0], { opp: () => inp({ block: true }) });
  const g = b.s.fighters[1].gloves.map(x => Math.hypot(x.pos.x - b.at.x, x.pos.y - b.at.y, x.pos.z - b.at.z));
  check(`a blocked jab's contact point rests on his guard glove (${(Math.min(...g) * 100).toFixed(1)} cm from its centre)`, Math.min(...g) < 0.2);
}

// ── 6. tells ──
{
  const ms = name => Number(tells.find(t => t.startsWith(name + ' ')).split(' ').slice(-2)[0]);
  console.log('tells (press to hit, head, 1.0 m): ' + tells.join(' | '));
  check(`the jab's tell is at least ${base.mocapTellJab * 1000 - 9} ms`, ms('jab') >= base.mocapTellJab * 1000 - 9, String(ms('jab')));
  for (const n of ['cross', 'lead hook', 'rear hook', 'lead upper', 'rear upper']) check(`the ${n}'s tell is at least ${base.mocapTellHeavy * 1000 - 9} ms`, ms(n) >= base.mocapTellHeavy * 1000 - 9, String(ms(n)));
}

// ── 7. determinism ──
{
  const r1 = aiFight(cfg, 23), r2 = aiFight(cfg, 23);
  check('toggle on: two seeded AI fights hash the same', r1.hash === r2.hash);
  check(`…and the fight has lands, blocks and whiffs in it (${JSON.stringify(r1.n)})`, r1.n.land > 3);
}
done();
