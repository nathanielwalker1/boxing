/**
 * stam15.mjs — the 15-second stamina test (audit P3). A man presses a punch every `gap` ticks for 15 s against a target who
 * stands (all land), holds his guard (all blocked), or is out of range (all miss). Prints stamina at 5 / 10 / 15 s and the
 * ceiling. Targets: all miss ends under 0.5, all land above 0.85.
 *   node scripts/balance/stam15.mjs ['<cfg json>'] [gap ticks, default 24 = a human's busy pace; 4 = mashing]
 * Uses the bundle (`npm run balance -- bundle` after a rules change).
 */
import { makeEnv } from './env.mjs';
const env = makeEnv();
const { sim } = env;
const cfg = { ...env.cfg, roundSeconds: 180, ...(process.argv[2] ? JSON.parse(process.argv[2]) : {}) };
const GAP = +(process.argv[3] || 24);
const inp = (o = {}) => ({ move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false, ...o });
const dist = s => Math.hypot(s.fighters[1].pos.x - s.fighters[0].pos.x, s.fighters[1].pos.z - s.fighters[0].pos.z);
function stage(want) {
  let s = sim.createState([env.core.ROSTER[0], env.core.ROSTER[0]], cfg, 7);
  for (let t = 0; t < 1200; t++) {
    const d = dist(s), a = inp();
    if (d > want + 0.01) a.move.y = Math.min(1, (d - want) * 3 + 0.12); else if (d < want - 0.02) a.move.y = -0.3;
    a.walk = true;
    s = sim.step(s, [a, inp()], cfg).state;
    if (Math.abs(d - want) < 0.025 && Math.hypot(s.fighters[0].vel.x, s.fighters[0].vel.z) < 0.03 && t > 30) break;
  }
  for (let t = 0; t < 45; t++) s = sim.step(s, [inp(), inp()], cfg).state;
  for (const f of s.fighters) { f.stamina = 1; f.health = 1; }
  return s;
}
function grind(seq, D, targetIn) {
  let s = stage(D), n = 0, thrown = 0, landed = 0; const marks = [];
  const home = s.fighters.map(f => ({ ...f.pos }));
  for (let t = 0; t < 900; t++) {
    // both men pinned where they started (a hit pushes the target out of range and "all land" becomes "mostly miss")
    s.fighters.forEach((f, i) => { f.pos = { ...home[i] }; f.vel = { x: 0, z: 0 }; f.stagger = { x: 0, z: 0 }; });
    const a = inp();
    if (t % GAP === 0) a[seq[n % seq.length]] = true;
    const r = sim.step(s, [a, targetIn ? targetIn(t, s) : inp()], cfg); s = r.state;
    const d = s.fighters[1]; d.health = 1; d.hurt = 0; d.stamina = 1; if (d.down) d.down = false;
    for (const e of r.events) if (e.side === 0) { if (e.type === 'punchStart') { thrown++; n++; } else if (e.type === 'punchLand') landed++; }
    if (t === 299 || t === 599 || t === 899) marks.push(s.fighters[0].stamina);
  }
  return { marks, thrown, landed, cap: s.fighters[0].staminaCap ?? 1 - (s.fighters[0].wear ?? 0) };
}
const pad = (v, n) => String(v).padStart(n);
console.log(`15 s, a press every ${GAP} ticks:  thrown landed   5s   10s   15s  ceiling`);
for (const [nm, seq] of [['jab-cross-hook-cross', ['jab', 'cross', 'hook', 'cross']], ['jab-cross', ['jab', 'cross']], ['hooks L R', ['hook']]])
  for (const [how, D, tgt] of [['all land', 1.0, null], ['all blocked', 1.0, () => inp({ block: true })], ['all miss', 2.4, null]]) {
    const r = grind(seq, D, tgt);
    console.log(`${(nm + ', ' + how).padEnd(34)}${pad(r.thrown, 6)}${pad(r.landed, 7)}${r.marks.map(m => pad(m.toFixed(2), 6)).join('')}${pad((+r.cap).toFixed(2), 8)}`);
  }
