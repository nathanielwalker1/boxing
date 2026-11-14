/**
 * guard_holes_test.mjs — guardHolesV2 (sim/combat.ts guardCover + the block's cost), in Node, scripted punches into a held guard:
 *   head hook comes round a high guard; uppercut splits a tight one; body shot gets under a high guard;
 *   pressure wears the cover down and it recovers; a blocked heavy shot moves the head and costs wind, a jab almost none;
 *   a block raised inside the timing window rocks the thrower and opens the counter window; off = the old numbers.
 */
import { kit } from './bots/kit.mjs';
import { check, near, done } from './check.js';

const k = await kit();
const { cfg, sim, inp, NONE, fresh, run, mag } = k;
const quiet = { ...cfg, stylesOn: true, staminaBlockDrain: 0, staminaRegen: 0, healthRegen: 0, guardMeterOn: false, guardHolesV2: true, blockFeelV2: false };   // (blockFeelV2 tones the block's head rock down and brings the fist home sooner on purpose: block_feel_test.mjs holds that; this file pins guardHolesV2's own numbers)
const off = { ...quiet, guardHolesV2: false };
const BLOCK = inp({ block: true });
const MID = 0.79;
const res = evs => evs.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchBlock' || e.type === 'perfectBlock' || e.type === 'punchWhiff'));
/** Side 0 throws `type`; the blocker (side 1) holds `dummy`, in guard `shape`, with `level` held or not. */
function at(type, d, c, { shape = 'high', x = 0, n = 45, level = false, aim = false, dummy = BLOCK } = {}) {
  const s = fresh(c, d, 20); s.fighters[1].guardShape = shape;
  return run(s, n, i => [inp({ [type]: aim ? i === 10 : i === 0, level: aim && i <= 10, move: { x: i === (aim ? 10 : 0) ? x : 0, y: 0 } }), { ...dummy, level }], c);
}
/** The same shot on a blocker holding nothing, for the unblocked impulse. */
const rawOf = (type, d, c, o) => { const r = at(type, d, { ...c, gradesOn: false }, { ...o, dummy: NONE }); return mag(res(r.evs)); };
const cover = (c, type, part, shape, level = 0, press = 0) => {
  const s = fresh(c, MID, 20), d = s.fighters[1];
  d.guardShape = shape; d.level = level; d.blockT = 1; d.block = true; sim.setGuardPress?.(d, press);
  if (press) d.moveHist[44] = press;
  return sim.guardCover(d, type, part, 1, 0, c);
};

console.log('\n=== 1. A head hook comes round a high guard ===');
{
  const jab = cover(quiet, 'jab', 'head', 'high'), cross = cover(quiet, 'cross', 'head', 'high'), hook = cover(quiet, 'hook', 'head', 'high');
  check(`a straight to the head meets the whole high guard (jab ${jab.toFixed(2)}, cross ${cross.toFixed(2)})`, jab > 0.95 && cross > 0.95);
  check(`a head hook meets less of it (${hook.toFixed(2)}) — it leaks more than a straight`, hook < jab - 0.3 && near(hook, quiet.guardHolesHookCover, 0.02));
  check('…but not the shell or the peek-a-boo, which close round the head', cover(quiet, 'hook', 'head', 'shell') > 0.8 && cover(quiet, 'hook', 'head', 'peekaboo') > 0.95);
  const jb = res(at('jab', MID, quiet).evs), hk = res(at('hook', 0.72, quiet, { x: 1 }).evs);
  check(`end to end: the jab is blocked (${jb?.type}); the hook is still a block at reduced cover or a land through (${hk?.type})`, jb?.type === 'punchBlock' && (hk?.type === 'punchBlock' || hk?.through));
  const hOn = rawOf('hook', 0.72, quiet, { x: 1 });
  const chipOn = res(at('hook', 0.72, quiet, { x: 1 }).evs)?.chip ?? 0, chipOff = res(at('hook', 0.72, off, { x: 1 }).evs)?.chip ?? 0;
  check(`a hook chips the blocker more with holes on than off (${chipOn.toFixed(4)} vs ${chipOff.toFixed(4)} of ${hOn.toFixed(0)} N·s)`, chipOn > chipOff);
}

console.log('\n=== 2. An uppercut splits a tight guard ===');
{
  const high = cover(quiet, 'uppercut', 'head', 'high'), shell = cover(quiet, 'uppercut', 'head', 'shell'), peek = cover(quiet, 'uppercut', 'head', 'peekaboo');
  check(`uppercut cover: high ${high.toFixed(2)}, shell ${shell.toFixed(2)}, peek-a-boo ${peek.toFixed(2)} — the tight ones are split (under ${quiet.guardThroughAt})`, shell < high && peek < high && shell < quiet.guardThroughAt && peek < quiet.guardThroughAt && high >= quiet.guardThroughAt);
  const up = res(at('uppercut', 0.58, quiet, { shape: 'shell', x: 1 }).evs), upH = res(at('uppercut', 0.58, quiet, { shape: 'high', x: 1 }).evs);
  check(`end to end: it lands through the shell (${up?.type} through=${up?.through}); the high guard stops it (${upH?.type})`, up?.type === 'punchLand' && up.through === true && upH?.type === 'punchBlock');
}

console.log('\n=== 3. A body shot gets under a high guard ===');
{
  const hi = cover(quiet, 'jab', 'body', 'high', 0), lo = cover(quiet, 'jab', 'body', 'high', 1);
  check(`body cover: guard high ${hi.toFixed(2)}, level held ${lo.toFixed(2)}`, hi < quiet.guardThroughAt && lo >= quiet.guardThroughAt);
  const on = res(at('jab', MID, quiet, { aim: true, n: 50 }).evs), held = res(at('jab', MID, quiet, { aim: true, n: 50, level: true }).evs);
  const old = res(at('jab', MID, off, { aim: true, n: 50 }).evs);
  check(`end to end: a body jab lands under the high guard (${on?.type} ${on?.part}); blocked with level held (${held?.type}); blocked with holes off (${old?.type})`,
    on?.type === 'punchLand' && on.part === 'body' && held?.type === 'punchBlock' && old?.type === 'punchBlock');
}

console.log('\n=== 4. Pressure wears the guard down ===');
{
  const c = n => cover(quiet, 'jab', 'head', 'high', 0, n);
  check(`cover of the 1st..4th jab in a flurry: ${[0, 1, 2, 3].map(n => c(n).toFixed(2)).join(', ')}`, c(3) < c(0) - 0.4 && c(3) < quiet.guardThroughAt && c(1) >= quiet.guardThroughAt);
  // A real flurry: four jabs, one every 18 ticks (0.3 s).
  const s = fresh(quiet, MID, 20); let st = s; const outs = [], covs = [];
  for (let i = 0; i < 18 * 5; i++) {
    st.fighters[1].pos = { x: st.fighters[0].pos.x + MID, z: st.fighters[0].pos.z }; st.fighters[1].stagger = { x: 0, z: 0 };
    const press = i % 18 === 0 && i < 18 * 4;
    const r = sim.step(st, [inp({ jab: press }), BLOCK], quiet); st = r.state;
    for (const e of r.events) if (e.side === 0 && (e.type === 'punchBlock' || e.type === 'punchLand')) { outs.push(e.type === 'punchBlock' ? 'block' : e.through ? 'through' : 'land'); covs.push(st.fighters[1].moveHist[44]); }
  }
  check(`a quick combination: ${outs.join(' → ')} — it starts blocked and leaks by the end`, outs[0] === 'block' && outs.length >= 3 && outs[outs.length - 1] !== 'block');
  const p0 = st.fighters[1].moveHist[44];
  const half = run(st, 72, () => [NONE, BLOCK], quiet).s.fighters[1].moveHist[44], rest = run(st, 300, () => [NONE, BLOCK], quiet).s.fighters[1];
  check(`after a rest the wear recovers (press ${p0.toFixed(2)} → ${half.toFixed(2)} after 1.2 s → ${rest.moveHist[44].toFixed(2)} after 5 s)`, half < p0 - 0.9 && rest.moveHist[44] < 0.01);
  check('holes off: the wear is never counted and a 4th jab is blocked as a 1st', cover(off, 'jab', 'head', 'high', 0, 3) === cover(off, 'jab', 'head', 'high', 0, 0));
}

console.log('\n=== 5. A block feels like something ===');
{
  const peakHead = r => { let m = 0; return { r, get: () => m, track: s => { const h = s.fighters[1].reaction.head; m = Math.max(m, Math.hypot(h.vx, h.vz)); } }; };
  const run1 = (type, d, c, x = 0) => { const s = fresh(c, d, 20); const t = peakHead(); const r = run(s, 40, i => [inp({ [type]: i === 0, move: { x: i === 0 ? x : 0, y: 0 } }), BLOCK], c, st => t.track(st)); return { head: t.get(), stam: 1 - r.s.fighters[1].stamina, rb: r.evs.some(e => e.type === 'punchBlock') }; };
  const hookOn = run1('hook', 0.72, quiet, 1), hookOff = run1('hook', 0.72, off, 1), jabOn = run1('jab', MID, quiet), crossOn = run1('cross', MID, quiet), jabOff = run1('jab', MID, off);
  check(`a blocked hook moves the head (${hookOn.head.toFixed(3)} vs ${hookOff.head.toFixed(3)} holes off)`, hookOn.head > hookOff.head * 1.5);
  check(`a blocked jab moves it less than a hook (${jabOn.head.toFixed(3)} vs ${hookOn.head.toFixed(3)})`, jabOn.head < hookOn.head * 0.6);
  check(`stamina: a blocked cross ${(crossOn.stam * 100).toFixed(2)}% vs a blocked jab ${(jabOn.stam * 100).toFixed(2)}%`, crossOn.stam > jabOn.stam * 3 && jabOn.stam < 0.01);
  const reb = (c) => { let end = null; run(fresh(c, MID, 20), 80, i => [inp({ cross: i === 0 }), BLOCK], c, (s, i) => { if (end === null && i > 2 && s.fighters[0].punch.type === null) end = i; }); return end; };
  check(`the thrower's punch comes home later off a block (${reb(quiet)} vs ${reb(off)} ticks)`, reb(quiet) > reb(off));
}

console.log('\n=== 6. A well-timed block staggers the thrower and opens the counter window ===');
{
  const L = res(at('cross', MID, quiet, { dummy: NONE }).evs).tick;
  const go = (c, raiseAt) => {
    let win = 0, evs = [], st = fresh(c, MID, 20), stag = 0;
    const r = run(st, 70, i => [inp({ cross: i === 0 }), inp({ block: i >= raiseAt && i < L + 6, jab: i >= L + 6 && i % 2 === 0 })], c, (s, i) => { const a = s.fighters[0]; win = Math.max(win, a.counterWindow); if (i > 2 && stag === 0 && a.punch.type === null) stag = i; });
    return { win, stag, evs: r.evs, src: sim.punishSource(r.s.fighters[0]) };
  };
  const timed = go(quiet, L - 8), held = go(quiet, 0), offT = go(off, L - 8);
  check(`raised 8 ticks before the hit: the thrower's arm hangs (home at tick ${timed.stag} vs ${held.stag} for a held block) and the window opens (${timed.win.toFixed(2)} s)`, timed.win > 0.5 && timed.stag > held.stag + 3);
  check(`held all along: no window (${held.win.toFixed(2)})`, held.win === 0);
  check('the blocker\'s answer inside the window is a COUNTER (the same event a slip makes)', timed.evs.some(e => e.type === 'counter' && e.side === 1));
  check('holes off: a late block opens nothing', offT.win === 0 || offT.win < 0.3);
}

console.log('\n=== Through-rates by punch (blocker holds a guard, V2 off → on) ===');
{
  const cases = [
    ['jab head      high ', 'jab', MID, { }], ['cross head    high ', 'cross', MID, { }],
    ['hook head     high ', 'hook', 0.72, { x: 1 }], ['hook head     shell', 'hook', 0.72, { x: 1, shape: 'shell' }],
    ['uppercut      high ', 'uppercut', 0.58, { x: 1 }], ['uppercut      shell', 'uppercut', 0.58, { x: 1, shape: 'shell' }],
    ['body jab      high ', 'jab', MID, { aim: true, n: 50 }],
  ];
  const classify = r => { const e = res(r.evs); return !e ? '?' : e.type === 'punchBlock' ? 'blocked' : e.type === 'perfectBlock' ? 'perfect' : e.through ? 'partial' : 'lands'; };
  for (const [name, type, d, o] of cases) console.log(`  ${name}  off: ${classify(at(type, d, off, o)).padEnd(8)} on: ${classify(at(type, d, quiet, o)).padEnd(8)} cover on ${cover(quiet, type === 'jab' && o.aim ? 'jab' : type, o.aim ? 'body' : 'head', o.shape ?? 'high', 0).toFixed(2)} off ${cover(off, type, o.aim ? 'body' : 'head', o.shape ?? 'high', 0).toFixed(2)}`);
  // A four-jab flurry, rate of the 4th jab getting through.
  const flurry = c => { let st = fresh(c, MID, 20), last = null; for (let i = 0; i < 18 * 5; i++) { st.fighters[1].pos = { x: st.fighters[0].pos.x + MID, z: st.fighters[0].pos.z }; st.fighters[1].stagger = { x: 0, z: 0 }; const r = sim.step(st, [inp({ jab: i % 18 === 0 && i < 72 }), BLOCK], c); st = r.state; for (const e of r.events) if (e.side === 0 && (e.type === 'punchBlock' || e.type === 'punchLand')) last = e.type === 'punchBlock' ? 'blocked' : 'partial'; } return last; };
  console.log(`  4th jab of a flurry  off: ${flurry(off)}  on: ${flurry(quiet)}`);
}

done();
