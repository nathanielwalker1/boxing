/**
 * styles_test.mjs — overhaul phase 2: a style is the fighter's guard, for the
 * player's fighter as much as the AI's (core/styles.ts, sim). In Node.
 *   - every style has a guard, stance, rhythm, range, a description and three ways to beat it
 *   - the five guard shapes are real: where the gloves rest and block, what the
 *     block covers (round the head, the body, an uppercut), what it costs to be
 *     hit on it, the jab from it, the crouch, the exposure, the feet
 *   - createState applies spec.style to BOTH sides; stylesOn off = the high guard
 *   - inside is earned: a jab stops a man walking straight in
 * Same body, same ratings (neutral) for every case: only the style differs.
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit({ rated: true });
const { cfg, core, sim, inp, NONE, T, fresh, run, of, first, mag, flick, SIM_DT } = k;
const { STYLES, GUARDS } = core;
const N = cfg.ratingNeutral;
const base = { ...k.specs[0], power: N, speed: N, chin: N, stamina: N, defense: N };
const as = style => ({ ...base, style });
const IDS = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];
const quiet = { ...cfg, staminaBlockDrain: 0, staminaRegen: 0, healthRegen: 0 };
const start = (s0, s1, d = 0.79, c = quiet, settle = 30) => fresh(c, d, settle, 0, 1, [as(s0), as(s1)]);
const res = evs => evs.find(e => e.side === 0 && /punch(Land|Block|Whiff)|perfectBlock/.test(e.type));
const BLOCK = inp({ block: true });

// ── 1. The table ────────────────────────────────────────────────────────────
console.log('\n=== 1. The style table ===');
{
  check('five styles, each with a guard, stance, rhythm, range, a line and three ways to beat it', IDS.every(id => { const s = STYLES[id]; return s && s.id === id && GUARDS[s.guard] && s.stanceWidth > 0 && s.bounceHz > 0 && s.bounceAmp > 0 && ['outside', 'mid', 'inside'].includes(s.range) && s.desc.length > 10 && s.beat.length === 3 && s.beat.every(b => b.length > 10); }));
  check(`the five styles hold the five guards (${IDS.map(id => `${id}: ${STYLES[id].guard}`).join(', ')})`, new Set(IDS.map(id => STYLES[id].guard)).size === 5);
  const s = start('swarmer', 'outboxer');
  check('createState gives each side its own style and guard', s.fighters[0].styleId === 'swarmer' && s.fighters[0].guardShape === 'peekaboo' && s.fighters[1].styleId === 'outboxer' && s.fighters[1].guardShape === 'long');
  const off = { ...quiet, stylesOn: false };
  const o = start('swarmer', 'outboxer', 0.79, off);
  const ref = start('pressure', 'pressure', 0.79, off);
  check('stylesOn off: everybody holds the high guard, hands where they always were', o.fighters[0].guardShape === 'high' && near(o.fighters[0].gloves[0].pos.y, ref.fighters[0].gloves[0].pos.y, 1e-9) && near(o.fighters[1].gloves[0].pos.x, ref.fighters[1].gloves[0].pos.x, 1e-9));
  const hi = start('pressure', 'pressure');
  check('pressure = the high guard = exactly the pre-style hands', near(hi.fighters[0].gloves[0].pos.y, ref.fighters[0].gloves[0].pos.y, 1e-9) && near(hi.fighters[0].gloves[1].pos.x, ref.fighters[0].gloves[1].pos.x, 1e-9));
}

// ── 2. Where the hands are ──────────────────────────────────────────────────
console.log('\n=== 2. The shapes ===');
{
  const hands = style => { const f = start(style, 'pressure', 2.0).fighters[0]; return { lead: f.gloves[0].pos, rear: f.gloves[1].pos, head: f.headBox, f }; };
  const high = hands('pressure'), shell = hands('counter'), peek = hands('swarmer'), long = hands('outboxer'), low = hands('slugger');
  check(`shell: the lead hand rests low across the body (${(high.lead.y - shell.lead.y).toFixed(2)} m under the high guard's), the rear by the chin`, high.lead.y - shell.lead.y > 0.3 && Math.abs(shell.rear.y - high.rear.y) < 0.08);
  check(`peek-a-boo: both gloves on the cheeks (${(Math.abs(peek.lead.z - peek.rear.z)).toFixed(2)} m apart, level), and he sits ${((high.head.y - peek.head.y) * 100).toFixed(0)} cm lower`, Math.abs(peek.lead.y - peek.rear.y) < 0.03 && Math.abs(peek.lead.z - peek.rear.z) < Math.abs(high.lead.z - high.rear.z) - 0.1 && near(high.head.y - peek.head.y, GUARDS.peekaboo.crouch, 1e-6));
  check(`long guard: the lead glove is ${(long.lead.x - high.lead.x).toFixed(2)} m further out`, long.lead.x - high.lead.x > 0.12);
  check(`hands low: both gloves ${(high.lead.y - low.lead.y).toFixed(2)} / ${(high.rear.y - low.rear.y).toFixed(2)} m down`, high.lead.y - low.lead.y > 0.2 && high.rear.y - low.rear.y > 0.2);
  check('…and the low guard leaves him exposed at rest (vuln), the others do not', near(low.f.vuln, GUARDS.low.expose, 1e-9) && high.f.vuln === 0 && peek.f.vuln === 0);
}

// ── 3. The jab from each guard ──────────────────────────────────────────────
console.log('\n=== 3. The jab ===');
{
  const jab = (style, d) => run(start(style, 'pressure', d), 30, i => [inp({ jab: i === 0 }), NONE], quiet).evs;
  const tell = style => first(jab(style, 0.8), 'punchStart').tell;
  check(`press to contact: long guard ${(tell('outboxer') * 1000).toFixed(0)} ms, high ${(tell('pressure') * 1000).toFixed(0)}, peek-a-boo ${(tell('swarmer') * 1000).toFixed(0)}, shell ${(tell('counter') * 1000).toFixed(0)}`, tell('outboxer') < tell('pressure') - 0.008 && tell('counter') > tell('pressure') + 0.004 && near(tell('outboxer'), cfg.jabCock * GUARDS.long.jabTime + cfg.jabExtend, 1e-9));
  const reach = style => { let far = 0; for (let d = 0.9; d <= 1.2; d += 0.02) if (res(jab(style, d))?.type === 'punchLand') far = d; return far; };
  const rl = reach('outboxer'), rh = reach('pressure'), rp = reach('swarmer');
  check(`reach: long guard lands to ${rl.toFixed(2)} m, high ${rh.toFixed(2)}, peek-a-boo ${rp.toFixed(2)}`, rl > rh && rp < rh);
}

// ── 4. What the block covers ────────────────────────────────────────────────
console.log('\n=== 4. The block ===');
{
  // Side 0 (high guard) punches a blocker in each guard.
  const hit = (style, type, d, x = 0, level = false) => { const r = run(start('pressure', style, d), 55, i => [inp({ [type]: i === 10, level: level && i <= 10, move: { x: i === 10 ? x : 0, y: 0 } }), BLOCK], quiet); return { ev: res(r.evs), d: r.s.fighters[1] }; };
  const cross = Object.fromEntries(IDS.map(id => [id, hit(id, 'cross', 0.79)]));
  check('a cross is blocked by every guard', IDS.every(id => cross[id].ev?.type === 'punchBlock'), IDS.map(id => `${id}:${cross[id].ev?.type}`).join(' '));
  check(`…but it rolls off the shell: guard left ${(cross.counter.ev.guard * 100).toFixed(0)}% (high ${(cross.pressure.ev.guard * 100).toFixed(0)}%, long ${(cross.outboxer.ev.guard * 100).toFixed(0)}%), stun ${(cross.counter.ev.stun * 1000).toFixed(0)} ms (high ${(cross.pressure.ev.stun * 1000).toFixed(0)})`, cross.counter.ev.guard > cross.pressure.ev.guard + 0.05 && cross.outboxer.ev.guard < cross.pressure.ev.guard - 0.02 && cross.counter.ev.stun < cross.pressure.ev.stun * 0.8);
  const up = Object.fromEntries(IDS.map(id => [id, hit(id, 'uppercut', 0.58, 1)]));
  check(`an uppercut SPLITS the peek-a-boo (lands through it, power ${up.swarmer.ev?.power?.toFixed(2)}); a fresh high guard half-stops it (${up.pressure.ev?.type}); the shell smothers it (${up.counter.ev?.type}, chip ${(up.counter.ev?.chip * 100).toFixed(1)}% vs the high guard's ${(up.pressure.ev?.chip * 100).toFixed(1)}%)`, up.swarmer.ev?.type === 'punchLand' && up.swarmer.ev.through && up.pressure.ev?.type === 'punchBlock' && up.counter.ev?.type === 'punchBlock' && up.counter.ev.chip <= up.pressure.ev.chip);
  const body = Object.fromEntries(IDS.map(id => [id, hit(id, 'cross', 0.79, 0, true)]));
  check(`a body cross: half-stopped by a fresh high guard (${body.pressure.ev?.type}), UNDER the long guard (${body.outboxer.ev?.type}${body.outboxer.ev?.through ? ' through' : ''}), and the shell's arm is across it (${body.counter.ev?.type}, chip ${(body.counter.ev?.chip * 100).toFixed(1)}% vs ${(body.pressure.ev?.chip * 100).toFixed(1)}%)`, body.pressure.ev?.type === 'punchBlock' && body.outboxer.ev?.type === 'punchLand' && body.outboxer.ev.through && body.counter.ev?.type === 'punchBlock' && body.counter.ev.chip < body.pressure.ev.chip);
  // Round the guard: a hook from 30° off the blocker's line (his feet slow, as after a pivot).
  const angled = (style, deg) => {
    const s = start('pressure', style, 0.72);
    const d = s.fighters[1], a = s.fighters[0], th = Math.PI + deg * Math.PI / 180;
    a.pos = { x: d.pos.x + Math.cos(th) * 0.72, z: d.pos.z + Math.sin(th) * 0.72 };
    a.yaw = Math.atan2(d.pos.z - a.pos.z, d.pos.x - a.pos.x);
    d.turned = 2;
    const c = { ...quiet, pivotTurnScale: 0 };
    return res(run(s, 45, i => [inp({ hook: i === 0, move: { x: i === 0 ? -1 : 0, y: 0 } }), BLOCK], c).evs);
  };
  const hs = angled('counter', 12), hp = angled('swarmer', 12), hh = angled('pressure', 12);
  check(`a hook from 12° off his line: round the shell (${hs?.type}${hs?.through ? ' through' : ''}), not round the peek-a-boo (${hp?.type}) or the high guard (${hh?.type})`, hs?.type === 'punchLand' && hs.through && hp?.type === 'punchBlock' && hh?.type === 'punchBlock');
  // Hands low: the block takes a beat to get there.
  const late = style => res(run(start('pressure', style, 0.79), 40, i => [inp({ cross: i === 0 }), inp({ block: i >= 8 })], quiet).evs);
  const ll = late('slugger'), lh = late('pressure');
  check(`a block raised 4 ticks before the cross: from the high guard it is a ${lh?.type}; from hands low it is not up yet (${ll?.type}${ll?.through ? ' through' : ''})`, (lh?.type === 'punchBlock' || lh?.type === 'perfectBlock') && ll?.type === 'punchLand' && ll.through === true);
}

// ── 5. Feet and head ────────────────────────────────────────────────────────
console.log('\n=== 5. Feet and head ===');
{
  const top = style => { const r = run(start(style, 'pressure', 2.0), 90, () => [inp({ move: { x: 1, y: 0 } }), NONE], quiet); return Math.hypot(r.s.fighters[0].vel.x, r.s.fighters[0].vel.z); };
  check(`hands low moves ${(top('slugger') / top('pressure')).toFixed(2)}× as fast as the high guard`, near(top('slugger') / top('pressure'), GUARDS.low.move, 0.01));
  const window = style => { let n = 0; run(start(style, 'pressure', 2.0), 60, i => [inp({ move: flick(1, 0)(i) }), NONE], quiet, s => { if (s.fighters[0].slip.active) n++; }); return n; };
  check(`the slip window: hands low ${window('slugger')} ticks, peek-a-boo ${window('swarmer')}, high ${window('pressure')}`, window('slugger') >= window('swarmer') && window('swarmer') > window('pressure'));
}

// ── 6. Inside is earned ─────────────────────────────────────────────────────
console.log('\n=== 6. Inside is earned ===');
{
  // Side 1 walks straight in from 1.7 m; side 0 jabs as he arrives. How close does he get in the next half second?
  const walkIn = c => {
    let pressed = false, landed = null, closest = 9;
    const r = run(fresh(c, 1.7, 10, 0, 1, [as('pressure'), as('pressure')]), 110, (i, s) => { const go = !pressed && k.dist(s) < 1.1; if (go) pressed = true; return [inp({ jab: go }), inp({ move: { x: 0, y: 1 } })]; }, c,
      (s, i, ev) => { if (landed === null && ev.some(e => e.type === 'punchLand' && e.side === 0)) landed = i; if (landed !== null && i <= landed + 30) closest = Math.min(closest, k.dist(s)); });
    const at = landed === null ? null : r.evs.find(e => e.type === 'punchLand');
    return { closest, landed, at, s: r.s };
  };
  const on = walkIn(quiet), off = walkIn({ ...quiet, jabStopOn: false });
  check(`a jab on a man walking straight in STOPS him: half a second later he has got no nearer than ${on.closest.toFixed(2)} m (${off.closest.toFixed(2)} m with jabStopOn off)`, on.landed !== null && off.landed !== null && on.closest > off.closest + 0.12);
  check('…and the same jab is no heavier for it (the stop is in his feet, not on the bar)', near(on.at.power, off.at.power, 1e-9));
  const standing = run(fresh(quiet, 0.8, 10, 0, 1, [as('pressure'), as('pressure')]), 12, i => [inp({ jab: i === 0 }), NONE], quiet).s.fighters[1];
  check('a jab on a man standing still does not stun-lock him', standing.blockStun === 0);

  // Phase 3: behind the gloves is not free either. He walks in with the guard up; the jab lands on it.
  const guarded = c => {
    let pressed = false, hit = null, closest = 9, blocked = false;
    run(fresh(c, 1.7, 10, 0, 1, [as('pressure'), as('pressure')]), 110, (i, s) => { const go = !pressed && k.dist(s) < 1.1; if (go) pressed = true; return [inp({ jab: go }), inp({ block: true, move: { x: 0, y: 1 } })]; }, c,
      (s, i, ev) => { if (hit === null && ev.some(e => e.type === 'punchBlock' && e.side === 0)) { hit = i; blocked = true; } if (hit !== null && i <= hit + 12) closest = Math.min(closest, k.dist(s)); });
    return { closest, blocked };
  };
  const gOn = guarded(quiet), gOff = guarded({ ...quiet, jabStopGuard: 0 });
  check(`a jab on the GUARD of a man walking in takes his step: 0.2 s later he is at ${gOn.closest.toFixed(2)} m (${gOff.closest.toFixed(2)} m with jabStopGuard 0)`, gOn.blocked && gOff.blocked && gOn.closest > gOff.closest + 0.03);
  // …and a jab is a jab: whatever stacked on it, it lands with at most jabImpulseCap.
  const big = walkIn({ ...quiet, jabImpulseMult: 3 }), capOff = walkIn({ ...quiet, jabImpulseMult: 3, jabImpulseCap: 0 });
  const magOf = e => Math.hypot(e.impulse.x, e.impulse.z);
  check(`a jab never lands with more than jabImpulseCap (${magOf(big.at).toFixed(0)} N·s; ${magOf(capOff.at).toFixed(0)} with the cap off)`, magOf(big.at) <= quiet.jabImpulseCap + 1e-6 && magOf(capOff.at) > quiet.jabImpulseCap);
}

done();
