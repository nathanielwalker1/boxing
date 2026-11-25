/** micro2.mjs — follow-up scripted measurements: power rating, tiredness, slip counters, hitting a hurt man, chin. */
import { makeEnv } from './env.mjs';
const env = makeEnv();
const { core, sim } = env;
const cfg = { ...env.cfg, roundSeconds: 180 };
const inp = (o = {}) => ({ move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false, ...o });
const dist = s => Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
const pad = (v, n) => String(v).padStart(n), padr = (v, n) => String(v).padEnd(n);
const spec = (r = {}) => ({ ...core.ROSTER[0], power: 65, speed: 65, chin: 65, stamina: 65, defense: 65, ...r });

function stage(want, specs = [spec(), spec()], seed = 7) {
  let s = sim.createState(specs, cfg, seed);
  for (let t = 0; t < 1200; t++) {
    const d = dist(s), a = inp();
    if (d > want + 0.01) a.move.y = Math.min(1, (d - want) * 3 + 0.12); else if (d < want - 0.02) a.move.y = -0.3;
    s = sim.step(s, [a, inp()], cfg).state;
    if (Math.abs(d - want) < 0.025 && Math.hypot(s.fighters[0].vel.x, s.fighters[0].vel.z) < 0.03 && t > 30) break;
  }
  for (let t = 0; t < 45; t++) s = sim.step(s, [inp(), inp()], cfg).state;
  for (const f of s.fighters) { f.stamina = 1; f.health = 1; }
  return s;
}
function run(s0, ticks, ins, hook = null) {
  let s = s0; const trace = [], events = [];
  for (let t = 0; t < ticks; t++) {
    if (hook) hook(t, s);
    const r = sim.step(s, ins(t, s), cfg);
    for (const e of r.events) events.push({ t, ...e });
    trace.push({ t, pre: s, post: r.state }); s = r.state;
  }
  return { s, trace, events };
}
/** Summary of side 0's first resolved punch: text cell. */
function cell(r) {
  const land = r.events.find(e => e.type === 'punchLand' && e.side === 0);
  if (!land) { const x = r.events.find(e => e.side === 0 && ['punchBlock', 'perfectBlock', 'punchWhiff'].includes(e.type)); return x ? x.type : 'nothing'; }
  const q = r.trace[land.t], hp = q.pre.fighters[1].health - q.post.fighters[1].health;
  const stop = r.trace.filter(x => x.t >= land.t && x.t < land.t + 30 && x.post.hitStop > 0).length;
  const st = q.post.fighters[1].stagger, push = Math.max(...r.trace.filter(x => x.t >= land.t && x.t < land.t + 20).map(x => Math.hypot(x.post.fighters[1].stagger.x, x.post.fighters[1].stagger.z ?? x.post.fighters[1].stagger.y ?? 0)));
  const hurt = r.events.some(e => e.type === 'knockdown' && e.side === 1) ? ' KNOCKDOWN' : r.events.some(e => e.type === 'rocked' && e.side === 1) ? ' ROCKED' : '';
  const start = r.events.find(e => e.type === 'punchStart' && e.side === 0);
  return `${(100 * hp).toFixed(1)}% health, ${land.grade}${land.counter ? ' COUNTER' : ''}, stop ${stop}, push ${push.toFixed(1)} m/s, hit ${land.t - start.t + 1} ticks after press${hurt}`;
}

console.log('== power rating: one clean shot on an open standing man (both otherwise all-65)');
for (const k of ['jab', 'cross', 'hook', 'uppercut']) for (const pw of [35, 65, 95]) {
  const D = k === 'uppercut' ? 0.95 : 1.05;
  console.log(`${padr(k, 9)} power ${pw}: ` + cell(run(stage(D, [spec({ power: pw }), spec()]), 120, t => [inp({ [k]: t < 2 }), inp()])));
}
console.log('\n== stepping in: stick forward from 0.5 m further out, punch pressed (stick still forward) when the gap suits the punch');
for (const [k, D] of [['jab', 1.32], ['cross', 1.22], ['hook', 1.2], ['uppercut', 1.1]]) {
  let pressed = -1;
  const r = run(stage(D + 0.5), 200, (t, s) => { const a = inp({ move: { x: 0, y: 1 } }); if (pressed < 0 && dist(s) <= D) pressed = t; if (pressed >= 0 && t - pressed < 2) a[k] = true; if (pressed >= 0 && t - pressed > 3) a.move.y = 0; return [a, inp()]; });
  console.log(`${padr(k, 9)} ` + cell(r));
}
console.log('\n== speed rating: press-to-hit and hands-free, cross');
for (const sp of [35, 65, 95]) {
  const r = run(stage(1.05, [spec({ speed: sp }), spec()]), 120, t => [inp({ cross: t < 2 }), inp()]);
  const free = r.trace.find(q => q.t > 3 && q.post.fighters[0].punch.type === null);
  console.log(`speed ${sp}: ` + cell(r) + `, hands free at tick ${free ? free.t + 1 : '-'}`);
}
console.log('\n== tired attacker (stamina pinned at the press)');
for (const k of ['cross', 'hook']) for (const st of [1, 0.5, 0.25, 0.05]) {
  const s0 = stage(1.05); s0.fighters[0].stamina = st;
  console.log(`${padr(k, 6)} stamina ${st.toFixed(2)}: ` + cell(run(s0, 120, t => [inp({ [k]: t < 2 }), inp()])));
}
console.log('\n== tired / hurt TARGET: the same hook');
for (const [label, mut] of [['fresh', f => {}], ['stamina 0.05', f => { f.stamina = 0.05; }], ['health 0.3', f => { f.health = 0.3; }], ['health 0.3 + stamina 0.05', f => { f.health = 0.3; f.stamina = 0.05; }], ['already rocked (hurt 1.5 s left)', f => { f.hurt = 1.5; f.hurtMax = 1.5; }]]) {
  const s0 = stage(1.05); mut(s0.fighters[1]);
  const r = run(s0, 120, t => [inp({ hook: t < 2 }), inp()], (t, s) => { if (t < 21 && label.includes('stamina')) s.fighters[1].stamina = 0.05; });
  console.log(`${padr(label, 34)} ` + cell(r) + `  (his rock bar ${Math.round(sim.stunThreshold(s0.fighters[1], cfg))})`);
}
console.log('\n== chin: the biggest single shot I can stage (hook as he extends his own body hook) vs chin 35 / 65 / 95 at health 0.4');
for (const ch of [35, 65, 95]) {
  const s0 = stage(1.0, [spec({ power: 95 }), spec({ chin: ch })]); s0.fighters[1].health = 0.4;
  const r = run(s0, 140, t => [inp({ hook: t === 24 || t === 25 }), inp({ hook: t === 30 || t === 31, level: t >= 30 && t < 38 })]);
  console.log(`chin ${ch}: ` + cell(r));
}
console.log('\n== slip then counter: he jabs at tick 30 (lands tick 43). I tap sideways at tick 30+k, then press the punch 8 ticks later');
for (const k of ['cross', 'hook']) {
  const base = cell(run(stage(1.05), 120, t => [inp({ [k]: t < 2 }), inp()]));
  console.log(`${k} with no slip, on a set man: ${base}`);
  for (const lag of [2, 6, 10]) {
    const r = run(stage(1.05), 160, t => [inp({ move: { x: (t >= 30 + lag && t < 33 + lag) ? 1 : 0, y: 0 }, [k]: t === 38 + lag || t === 39 + lag }), inp({ jab: t === 30 || t === 31 })]);
    const dodged = r.events.some(e => e.type === 'punchWhiff' && e.side === 1 && e.dodged), hitMe = r.events.some(e => e.type === 'punchLand' && e.side === 1);
    console.log(`   slip ${lag} ticks after his press: his jab ${dodged ? 'dodged' : hitMe ? 'HIT ME' : 'other'}; my ${k}: ` + cell(r));
  }
}
console.log('\n== evade spam: he jabs every 40 ticks for 20 s; I tap sideways every N ticks and do nothing else. Jabs that hit me:');
for (const every of [0, 12, 20, 36, 60]) {
  let s = stage(1.1), hit = 0, thrown = 0;
  for (let t = 0; t < 1200; t++) {
    const me = inp(); if (every && t % every < 3) me.move.x = (Math.floor(t / every) % 2) ? 1 : -1;
    const r = sim.step(s, [me, inp({ jab: t % 40 < 2 })], cfg); s = r.state; s.fighters[0].health = 1;
    for (const e of r.events) if (e.side === 1) { if (e.type === 'punchStart') thrown++; if (e.type === 'punchLand') hit++; }
  }
  console.log(`   tap every ${every || 'never'}: ${hit} of ${thrown} jabs landed`);
}
console.log('\n== holding block for 30 s against non-stop cross-hook pressure: my health, stamina and guard at the end');
{
  let s = stage(1.0), n = 0, gb = 0;
  for (let t = 0; t < 1800; t++) {
    const a = inp({ move: { x: 0, y: dist(s) > 1.02 ? 0.6 : 0 } }); if (t % 4 === 0) a[['cross', 'hook'][n % 2]] = true;
    const r = sim.step(s, [inp({ block: true }), a], cfg); s = r.state;
    for (const e of r.events) { if (e.type === 'punchStart' && e.side === 1) n++; if (e.type === 'guardBreak') gb++; }
  }
  const f = s.fighters[0], g = Object.keys(f).filter(k => /guard/i.test(k)).map(k => `${k}=${typeof f[k] === 'number' ? f[k].toFixed(2) : JSON.stringify(f[k])}`).join(' ');
  console.log(`   blocker: health ${f.health.toFixed(2)}, stamina ${f.stamina.toFixed(2)}, guard breaks ${gb}, ${g}; attacker threw ${n}, attacker stamina ${s.fighters[1].stamina.toFixed(2)}`);
}
