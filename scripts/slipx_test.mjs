/**
 * slipx_test.mjs — overhaul A4, the slip's new half (sim/slip.ts + combat.ts), in Node:
 *   - LOADED: a slip loads the hand on that side; its counter winds up faster and
 *     hits harder; the other hand does not; it lapses; the pull loads the cross
 *   - CHAINS: a flick the other way mid-slip starts the next from where the head
 *     is; a roll can end the chain; slipChainMax
 *   - THE ROLL: level + lateral flick, the head goes down and across and under a hook
 *   - THE WRONG WAY: slipping into a punch hurts more than standing still
 * (slip_test.mjs still pins the slip's own geometry and margins.)
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
// skelOn false (anim Phase 1.1): this file pins the roll's U depth exactly and the wrong-way slip that the old shoulder line caught; on the rigid skeleton the spine arcs and the shoulder clears the jab. skel_test §4 has the skeleton's counterparts.
k.cfg.skelOn = false;
const { cfg, sim, inp, NONE, T, fresh, run, of, first, mag, flick, SIM_DT } = k;
const MID = 0.79;
const startOf = (evs, side = 0) => evs.find(e => e.type === 'punchStart' && e.side === side);
const landOf = (evs, side = 0) => evs.find(e => e.type === 'punchLand' && e.side === side);

// ── 1. Loaded ───────────────────────────────────────────────────────────────
console.log('\n=== 1. Loaded ===');
{
  const afterSlip = (x, y = 0) => run(fresh(cfg, MID, 20), 4, i => [inp({ move: flick(x, y)(i) }), NONE]).s.fighters[0];
  const rear = afterSlip(1), lead = afterSlip(-1), pull = afterSlip(0, -1);
  check('a slip to the rear side loads the rear hand, to the lead side the lead hand; the pull loads the rear', rear.loaded === 1 && lead.loaded === -1 && pull.loaded === 1 && near(rear.loadedT, cfg.slipLoadedTime, 3 * SIM_DT));
  const gone = run(fresh(cfg, MID, 20), T(cfg.slipLoadedTime) + 6, i => [inp({ move: flick(1, 0)(i) }), NONE]).s.fighters[0];
  check('the load lapses after slipLoadedTime', gone.loaded === 0 && gone.loadedT === 0);

  // Slip to the rear, then the cross: loaded. The same cross cold: not.
  const slipX = c => run(fresh(c, MID, 20), 50, i => [inp({ cross: i === 8, move: flick(1, 0)(i) }), NONE], c);
  const coldX = run(fresh(cfg, MID, 20), 50, i => [inp({ cross: i === 8 }), NONE]);
  const hot = slipX(cfg);
  let wasLoaded = false;
  run(fresh(cfg, MID, 20), 12, i => [inp({ cross: i === 8, move: flick(1, 0)(i) }), NONE], cfg, s => { if (s.fighters[0].punch.type === 'cross') wasLoaded = s.fighters[0].punch.loaded; });
  check('the cross off a slip to the rear is the LOADED counter (punch.loaded)', wasLoaded && run(fresh(cfg, MID, 20), 12, i => [inp({ cross: i === 8, move: flick(1, 0)(i) }), NONE]).s.fighters[0].loaded === 0);
  check(`…quicker off the mark (${startOf(hot.evs).tell.toFixed(3)} s vs ${startOf(coldX.evs).tell.toFixed(3)} s)`, startOf(hot.evs).tell < startOf(coldX.evs).tell - 0.02);
  // (Phase 3: compared with the SAME cross off the same slip with the load off, not with a cross thrown square. With
  // the lane tracking his height, the cross from the slipped position meets his resting lead glove and pins it on his
  // face — a land through the hands (guardPinnedCover) — which the square cross does not; before, red's lane sat 5.5 cm low on
  // blue and went under that glove either way. Measured: loaded-off-the-slip / square = 0.84.)
  const off = slipX({ ...cfg, slipLoadedOn: false });
  check(`…and harder (${(landOf(hot.evs).power / landOf(off.evs).power).toFixed(2)}× = slipLoadedPower)`, near(landOf(hot.evs).power / landOf(off.evs).power, cfg.slipLoadedPower, 0.02));
  const slipJab = run(fresh(cfg, MID, 20), 12, i => [inp({ jab: i === 8, move: flick(1, 0)(i) }), NONE]);
  check('the OTHER hand is not loaded (a jab off a rear-side slip is a jab; the load stays for the cross)', near(startOf(slipJab.evs).tell, cfg.jabCock + cfg.jabExtend, 1e-9) && slipJab.s.fighters[0].loaded === 1);
  const leadHook = run(fresh(cfg, 0.72, 20), 50, i => [inp({ hook: i === 8, move: i === 8 ? { x: -1, y: 0 } : flick(-1, 0)(i) }), NONE]);
  const coldHook = run(fresh(cfg, 0.72, 20), 50, i => [inp({ hook: i === 8, move: { x: i === 8 ? -1 : 0, y: 0 } }), NONE]);
  check(`the lead hook off a slip to the lead side is loaded (${(landOf(leadHook.evs)?.power / landOf(coldHook.evs)?.power).toFixed(2)}×)`, landOf(leadHook.evs) && near(landOf(leadHook.evs).power / landOf(coldHook.evs).power, cfg.slipLoadedPower, 0.03));
  check('slipLoadedOn off: no load (the wind-up of a cold cross)', near(startOf(off.evs).tell, startOf(coldX.evs).tell, 1e-9) && landOf(off.evs).power < landOf(hot.evs).power);
}

// ── 2. Chains ───────────────────────────────────────────────────────────────
console.log('\n=== 2. Chained slips ===');
{
  const noBurst = { ...cfg, burstOn: false };   // so a repeated flick is judged as a flick
  const at = cfg.slipChainAfter;   // the next flick is RELEASED after this
  const A = 0, B = 7, C = 14, D = 21;
  const stick = (seq) => i => { for (const [t0, x] of seq) if (i >= t0 && i < t0 + 2) return { x, y: 0 }; return { x: 0, y: 0 }; };
  const chain = (seq, c = noBurst, lv = () => false) => { const tr = []; const r = run(fresh(c, 2.0, 20), 60, i => [inp({ move: stick(seq)(i), level: lv(i) }), NONE], c, s => tr.push({ off: s.fighters[0].slip.offset, chain: s.fighters[0].slip.chain })); return { evs: of(r.evs, 'slip'), tr, s: r.s }; };
  const two = chain([[A, 1], [B, -1]]);
  check('a flick the other way while the head is off the line chains: slip 1, slip 2', two.evs.length === 2 && two.evs[0].chain === 1 && two.evs[1].chain === 2 && two.evs[1].dir === -two.evs[0].dir);
  let jump = 0; for (let i = 1; i < two.tr.length; i++) jump = Math.max(jump, Math.abs(two.tr[i].off - two.tr[i - 1].off));
  const lo = Math.min(...two.tr.map(t => t.off)), hi = Math.max(...two.tr.map(t => t.off));
  check(`the head crosses from one side to the other (${hi.toFixed(2)} → ${lo.toFixed(2)} m) with no jump (biggest tick ${(jump * 100).toFixed(1)} cm)`, near(hi, cfg.slipHeadOffset, 1e-6) && near(lo, -cfg.slipHeadOffset, 1e-6) && jump < cfg.slipHeadOffset * 2 / (cfg.slipChainRise / SIM_DT) + 0.03);
  const three = chain([[A, 1], [B, -1], [C, 1]], noBurst, i => i >= C && i <= C + 3);
  check('slip, slip, ROLL: the third move of the chain is the roll', three.evs.length === 3 && three.evs[2].kind === 'roll' && three.evs[2].chain === 3, three.evs.map(e => `${e.kind}:${e.chain}`).join(' '));
  const four = chain([[A, 1], [B, -1], [C, 1], [D, -1]]);
  check(`slipChainMax (${cfg.slipChainMax}): a fourth is refused`, four.evs.length === 3);
  const same = chain([[A, 1], [B, 1]]);
  check('the SAME way again is not a chain', same.evs.length === 1);
  const off = chain([[A, 1], [B, -1]], { ...noBurst, slipChainOn: false });
  check('slipChainOn off: one slip at a time (v1)', off.evs.length === 1);
  check('the loaded side follows the last slip', run(fresh(noBurst, 2.0, 20), B + 4, i => [inp({ move: stick([[A, 1], [B, -1]])(i) }), NONE], noBurst).s.fighters[0].loaded === -1);
  void at;
}

// ── 3. The roll ─────────────────────────────────────────────────────────────
console.log('\n=== 3. The roll ===');
{
  const twins = [k.specs[0], k.specs[0]];
  const LV = 10;   // ticks the level is held before the flick
  // (The level is let go right after the flick: the roll holds it down itself for the U.)
  const roll = (c = cfg) => { const tr = []; const s0 = fresh(c, 2.0, 20, 0, 1, twins); const r = run(s0, 70, i => [inp({ level: i < LV + 4, move: flick(1, 0, LV)(i) }), NONE], c, s => tr.push({ y: s.fighters[0].headBox.y, off: s.fighters[0].slip.offset, kind: s.fighters[0].slip.kind, act: s.fighters[0].slip.active, dip: s.fighters[0].slip.dip })); return { r, tr, s0 }; };
  const a = roll();
  const ev = first(a.r.evs, 'slip');
  check('level + a lateral flick is a ROLL', ev && ev.kind === 'roll' && ev.dodged === false);
  const lowest = Math.min(...a.tr.map(t => t.y));
  check(`the head goes down levelDrop + rollDip at the bottom of the U (${(a.s0.fighters[0].headBox.y - lowest).toFixed(3)} m)`, near(a.s0.fighters[0].headBox.y - lowest, cfg.levelDrop + cfg.rollDip + cfg.slipCrouch, 0.03));
  const active = a.tr.filter(t => t.act).length;
  check(`…over rollDuration (${active} ticks), coming out on the flicked side, loaded there`, Math.abs(active - T(cfg.rollDuration)) <= 1 && near(Math.max(...a.tr.map(t => t.off)), cfg.slipHeadOffset, 1e-6) && run(a.s0, LV + 6, i => [inp({ level: i < LV + 4, move: flick(1, 0, LV)(i) }), NONE]).s.fighters[0].loaded === 1);
  check('slip.dip reports the U', Math.max(...a.tr.map(t => t.dip)) > cfg.rollDip * 0.95);

  // Under a hook. The roller (side 1) starts the roll as the hook winds up; the head is at the bottom as it arrives.
  const hook = (dummy, c = cfg) => run(fresh(c, 0.72, 20, 0, 1, twins), 60, i => [inp({ hook: i === LV, move: { x: i === LV ? 1 : 0, y: 0 } }), dummy(i)], c);
  const under = hook(i => inp({ level: i >= LV - 8 && i < LV + 16, move: flick(-1, 0, LV + 2)(i) }));
  const res = evs => evs.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));
  check(`a head hook goes OVER a roll (${res(under.evs)?.type}) and the roll is credited with the dodge`, res(under.evs)?.type === 'punchWhiff' && under.evs.some(e => e.type === 'slip' && e.dodged && e.kind === 'roll' && e.side === 1));
  check('…which opens the counter window on the hooker', under.s.fighters[0].counterWindow > 0 || under.evs.some(e => e.type === 'slip' && e.dodged));
  const stood = hook(() => NONE);
  check('the same hook lands on a man who stands there', res(stood.evs)?.type === 'punchLand' && res(stood.evs).part === 'head');
  const off = roll({ ...cfg, rollOn: false });
  check('rollOn off: level + flick is a plain slip', first(off.r.evs, 'slip')?.kind === 'slip');
}

// ── 4. The wrong way ────────────────────────────────────────────────────────
console.log('\n=== 4. The wrong way ===');
{
  // The dummy slips INTO the jab hand (slip_test pins this: the head clears, the shoulder catches it).
  const L = landOf(run(fresh(cfg, MID, 20), 20, i => [inp({ jab: i === 0 }), NONE]).evs).tick;
  void L;
  // (30 ticks of settle, as slip_test: the shoulder catches this jab by ~2 cm and the idle bob is part of that.)
  // (jabImpulseCap 0 in this section: the wrong-way multiplier is measured on the jab without the cap.)
  const into = c0 => { const c = { ...c0, jabImpulseCap: 0 }; return run(fresh(c, MID, 30), 30, i => [inp({ jab: i === 0 }), inp({ move: flick(1, 0)(i) })], c); };
  // Phase 3: with the lane on his head the fist clears the capsule by ~6 cm; the shoulder he leaned onto it is counted
  // wrongWayShoulder higher. So with the rule off this is now a clean dodge (it used to clip the shoulder, glancing).
  const on = landOf(into(cfg).evs), offRun = into({ ...cfg, wrongWayOn: false }), plain = landOf(into({ ...cfg, slipWrongWayMult: 1 }).evs);
  const stand = landOf(run(fresh(cfg, MID, 20), 20, i => [inp({ jab: i === 0 }), NONE]).evs);
  check(`slipping INTO the jab: it lands (${on?.part}) flagged wrongWay; with wrongWayOn off the same slip is a dodge`, on && on.part === 'body' && on.wrongWay === true && !landOf(offRun.evs) && offRun.evs.some(e => e.type === 'slip' && e.dodged));
  check(`…${(on.power / plain.power).toFixed(2)}× = slipWrongWayMult, and ${on.grade}: never glancing — he moved onto the fist`, on.grade !== 'glancing' && near(on.power / plain.power, cfg.slipWrongWayMult, 0.02));
  check('wrongWayShoulder 0: the capsule alone no longer catches it', !landOf(into({ ...cfg, wrongWayShoulder: 0 }).evs));
  check(`…and more than if he had stood still (${on.power.toFixed(2)} vs ${stand.power.toFixed(2)})`, on.power > stand.power * 1.2);
  const away = run(fresh(cfg, MID, 20), 30, i => [inp({ jab: i === 0 }), inp({ move: flick(-1, 0)(i) })]);
  check('slipping AWAY from it is still the dodge', away.evs.some(e => e.type === 'slip' && e.dodged) && !landOf(away.evs));
}

done();
