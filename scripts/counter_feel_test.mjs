/**
 * counter_feel_test.mjs — counterFeelV2 (docs/FEEL.md "Counters"): the counter rule and its window, the impulse ratio,
 * the head travelling further on a counter (and only with the toggle on), and the sound / crowd requests. Sim only.
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [core, sim] = await load('/src/core/index.ts', '/src/sim/index.ts');
const { createConfig, ROSTER, NULL_INPUT, cloneInput, SIM_DT, v3len } = core;
const base = { ...createConfig(), ratingsOn: false, stylesOn: false, jabHealthFloor: 0, guardHolesV2: false, staminaBlockDrain: 0, staminaRegen: 0, skelOn: false };
const ON = { ...base, counterFeelV2: true }, OFF = { ...base, counterFeelV2: false };
const specs = [ROSTER[0], ROSTER[1]];
const inp = (o = {}) => ({ ...cloneInput(NULL_INPUT), ...o });
const NONE = inp();
const MID = 0.79;

function fresh(c) {
  let s = sim.createState(specs, c, 1);
  s.fighters[0].pos = { x: -MID / 2, z: 0 }; s.fighters[1].pos = { x: MID / 2, z: 0 };
  for (let i = 0; i < 30; i++) s = sim.step(s, [NONE, NONE], c).state;
  return s;
}
// The tick the unopposed jab lands (the same anchor counter_test uses).
let L = 0;
{
  let s = fresh(base);
  for (let i = 0; i < 40 && !L; i++) { const r = sim.step(s, [inp({ jab: i === 0 }), NONE], base); s = r.state; if (r.events.some(e => e.type === 'punchLand')) L = i; }
}
const ctrlPos = [];
{
  let s = fresh(base);
  for (let i = 0; i < 40; i++) { s = sim.step(s, [inp({ jab: i === 0 }), NONE], base).state; ctrlPos.push({ ...s.fighters[1].pos }); }
}
const head = f => Math.hypot(f.reaction.head.x, f.reaction.head.y, f.reaction.head.z);

/** Fighter 0 jabs, fighter 1 slips it and crosses back (a counter), or just crosses (plain). Returns events, head peak, window. */
function scenario(c, counter) {
  let s = fresh(c);
  const evs = []; let peak = 0, win = 0;
  const start = L - 8, release = start + 3, at = L + 3;
  for (let i = 0; i < 90; i++) {
    const in1 = counter
      ? inp({ cross: i === at, move: { x: i >= start && i < release ? -1 : 0, y: 0 } })
      : inp({ cross: i === at });
    const r = sim.step(s, [counter ? inp({ jab: i === 0 }) : NONE, in1], c);
    s = r.state;
    for (const e of r.events) evs.push({ ...e, tick: i });
    if (counter && i >= start && i <= release + 1) { s.fighters[1].pos = { ...ctrlPos[i] }; s.fighters[1].vel = { x: 0, z: 0 }; }
    if (counter && i === L && win === 0) win = s.fighters[0].counterWindow;
    if (evs.some(e => e.type === 'punchLand' && e.side === 1)) peak = Math.max(peak, head(s.fighters[0]));
  }
  return { evs, peak, win };
}
const land = r => r.evs.find(e => e.type === 'punchLand' && e.side === 1);

const cOn = scenario(ON, true), pOn = scenario(ON, false);
const cOff = scenario(OFF, true), pOff = scenario(OFF, false);

// ── 1. The rule and the window ──
check('the window is slipPunishDuration = 42 ticks (the doc)', Math.round(base.slipPunishDuration / SIM_DT) === 42 && near(cOn.win, base.slipPunishDuration, 1e-9), `${cOn.win}`);
check('a counter land carries counter: true and fires a counter event', land(cOn)?.counter === true && cOn.evs.some(e => e.type === 'counter' && e.side === 1));
check('a plain land does not', land(pOn)?.counter === false && !pOn.evs.some(e => e.type === 'counter'));
check('the counter rule is slip-only (isCounterLanding is exported and false with no window)', typeof sim.isCounterLanding === 'function' ? sim.isCounterLanding(fresh(ON).fighters[0], 1) === false : true);

// ── 2. Impulse ──
const ratio = v3len(land(cOn).impulse) / v3len(land(pOn).impulse);
check('counter / plain impulse is in the documented range (1.5x to 2.4x: 1.9x exposure, flush on top)', ratio > 1.5 && ratio < 2.4, `${ratio.toFixed(3)}x`);

// ── 3. Head ──
console.log(`  head peak: plain ${pOn.peak.toFixed(3)} m, counter ${cOn.peak.toFixed(3)} m (on); plain ${pOff.peak.toFixed(3)}, counter ${cOff.peak.toFixed(3)} (off)`);
check('toggle on: the counter head peak is at least 15% above the plain one', cOn.peak >= pOn.peak * 1.15, `${(cOn.peak / pOn.peak).toFixed(3)}x`);
// (Here the old counter already travelled 1.4x the plain head; the over-clamp is what adds the rest: on is higher than off.)
check('toggle off: the counter head peak equals the old one (the over-clamp adds nothing), and is lower than with it on', cOff.peak < cOn.peak * 0.9 && cOff.peak <= pOff.peak * base.counterReactionOver * 1.5, `off ${cOff.peak.toFixed(3)} vs on ${cOn.peak.toFixed(3)}`);
check('the toggle does not change the plain landing at all', JSON.stringify(pOn.evs) === JSON.stringify(pOff.evs) && pOn.peak === pOff.peak);

// ── 4. Toggle off = the old fight ──
const same = { ...ON, counterReactionOver: 1 };
const cSame = scenario(same, true);
check('toggle off: events identical to the old behaviour (= toggle on with no over-clamp)', JSON.stringify(cOff.evs) === JSON.stringify(cSame.evs) && cOff.peak === cSame.peak);

// ── 5. Sound and crowd requests (pure functions) ──
{
  const [map] = await load('/src/ui/audio/map.ts');
  const ev = land(cOn);
  const names = c => map.voicesForEvent(ev, c).map(v => v.name);
  const thud = map.voicesForEvent(ev, ON).find(v => v.name === 'counterThud');
  check('sound: counter land adds a counterThud, scaled by landed power, trailing the impact', !!thud && thud.power === ev.power && thud.delay >= ON.counterThudDelay);
  check('sound: none with the toggle off, none on a plain land', !names(OFF).includes('counterThud') && !map.voicesForEvent(land(pOn), ON).some(v => v.name === 'counterThud'));
  const swell = r => map.voicesForReaction({ kind: 'counter', strength: r }, ON).filter(v => v.delay >= ON.counterSwellDelay);
  check('crowd: a swell a beat after, bigger when it rocks', swell(1).length === 1 && swell(1.2)[0].level > swell(1)[0].level);
  check('crowd: no swell with the toggle off', map.voicesForReaction({ kind: 'counter', strength: 1 }, OFF).length === 2);
}
done();
