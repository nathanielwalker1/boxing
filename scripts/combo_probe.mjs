#!/usr/bin/env node
/**
 * combo_probe.mjs — where does a combination break? (polish phase, item 2)
 *
 * A scripted 1-2-3 (jab, cross, lead hook) and 1-2-body-hook thrown by side 0
 * at a target standing with a resting guard, at 0.60 → 1.00 m in 5 cm steps,
 * in open ring and with the target backed on the ropes. Per punch: the press
 * tick, the start tick, the hit-test tick, the outcome and grade, the gap
 * between the fighters at the hit test, and for the whole combination how far
 * the target was knocked, how many ticks hit-stop froze, and any press that
 * was delayed or dropped.
 *
 *   node scripts/combo_probe.mjs                 # the table, config as shipped
 *   node scripts/combo_probe.mjs gap=12          # ticks between presses (default 8 ≈ 133 ms; a quick human)
 *   node scripts/combo_probe.mjs key=value …     # config overrides (numbers / true / false)
 *   node scripts/combo_probe.mjs rated           # ratings and guard shapes on (the roster's own numbers)
 *   node scripts/combo_probe.mjs detail=0.80     # per-tick trace of the 1-2-3 at that distance, open ring
 *
 * Reading a cell: `L/c 0.83 +0` = landed / clean, fighters 0.83 m apart at
 * the hit test, started 0 ticks after it could first have started had nothing
 * been in flight (i.e. the press waited that long). W = whiff, B = block,
 * `--` = the press never became a punch.
 */
import { kit } from './bots/kit.mjs';

export const COMBOS = {
  '1-2-3': [{ p: 'jab' }, { p: 'cross' }, { p: 'hook', x: -1 }],
  '1-2-body3': [{ p: 'jab' }, { p: 'cross' }, { p: 'hook', x: -1, level: true }],
};

/** Run one combination. Returns per-punch rows and totals. `ropes`: the target starts with its back on the ropes. */
export function runCombo(k, cfg, combo, dist, { ropes = false, gap = 8, ticks = 150, targetInput = null, trace = null } = {}) {
  const cx = ropes ? k.bound(cfg) - dist / 2 - 0.01 : 0;
  let s = k.fresh(cfg, dist, 40, cx);
  const start = { a: { ...s.fighters[0].pos }, d: { ...s.fighters[1].pos } };
  const rows = combo.map((c, i) => ({ punch: c.p, press: i * gap, start: -1, hit: -1, outcome: '--', grade: '', gap: NaN, combo: 0, impulse: 0, variant: '', nerf: 0, finisher: false }));
  let started = 0, resolved = 0, frozen = 0, maxStop = 0;
  for (let i = 0; i < ticks; i++) {
    const idx = rows.findIndex(r => r.press === i);
    const c = idx >= 0 ? combo[idx] : null;
    // The level for a body shot: held from the moment the punch before it has started until it has started itself.
    const lv = combo.findIndex((x, j) => x.level && started === j && (j === 0 || rows[j - 1].start >= 0));
    const input = k.inp({ [c?.p ?? 'none']: true, move: { x: c?.x ?? 0, y: 0 }, level: lv >= 0 });
    const r = k.sim.step(s, [input, targetInput ? targetInput(i, s) : k.NONE], cfg); s = r.state;
    if (s.hitStop > 0) { frozen++; maxStop = Math.max(maxStop, s.hitStop); }
    for (const e of r.events) {
      if (e.side !== 0) continue;
      if (e.type === 'punchStart' && started < rows.length) { rows[started].start = i; rows[started].variant = e.variant; rows[started].nerf = e.nerf ?? 0; started++; }
      if ((e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock' || e.type === 'perfectBlock') && resolved < rows.length) {
        const row = rows[resolved++];
        row.hit = i; row.gap = k.dist(s);
        row.outcome = e.type === 'punchLand' ? 'L' : e.type === 'punchWhiff' ? 'W' : 'B';
        if (e.type === 'punchLand') { row.grade = e.grade[0]; row.combo = e.combo; row.impulse = k.mag(e); row.finisher = !!e.finisher; row.part = e.part; }
      }
    }
    if (trace) trace(i, s, r.events);
  }
  const moved = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
  return { rows, frozen, maxStop, knocked: moved(s.fighters[1].pos, start.d), followed: moved(s.fighters[0].pos, start.a), endGap: k.dist(s), s };
}

const cellOf = (r, prev) => {
  if (r.start < 0) return '--'.padEnd(15);
  const wait = r.start - r.press;
  return `${r.outcome}${r.grade ? '/' + r.grade : ''}${r.finisher ? '!' : ''} ${Number.isNaN(r.gap) ? ' -- ' : r.gap.toFixed(2)} +${wait}`.padEnd(15);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const k = await kit({ rated: args.includes('rated') });
  const cfg = { ...k.cfg };
  let gap = 8, detail = null;
  for (const a of args) {
    const m = a.match(/^(\w+)=(.+)$/); if (!m) continue;
    if (m[1] === 'gap') gap = Number(m[2]);
    else if (m[1] === 'detail') detail = Number(m[2]);
    else cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]);
  }
  if (detail !== null) {
    console.log(`1-2-3 at ${detail.toFixed(2)} m, open ring, presses ${gap} ticks apart — per tick: gap, target stagger speed, hit-stop, attacker punch`);
    runCombo(k, cfg, COMBOS['1-2-3'], detail, { gap, ticks: 70, trace: (i, s, evs) => {
      const a = s.fighters[0], d = s.fighters[1];
      const ev = evs.filter(e => /punch|rocked|knockdown/.test(e.type)).map(e => `${e.type}${e.side ?? ''}${e.grade ? ':' + e.grade : ''}`).join(' ');
      console.log(`${String(i).padStart(3)} gap ${k.dist(s).toFixed(3)} stag ${Math.hypot(d.stagger.x, d.stagger.z).toFixed(2)} stop ${s.hitStop.toFixed(3)} ${(a.punch.type ?? '-').padEnd(8)} ${a.punch.phase.padEnd(7)} ${a.punch.progress.toFixed(2)} ${ev}`);
    } });
  } else {
    const dists = []; for (let d = 0.60; d <= 1.0001; d += 0.05) dists.push(Math.round(d * 100) / 100);
    console.log(`\nCombination probe — presses ${gap} ticks (${Math.round(gap * 1000 / 60)} ms) apart; cell = outcome/grade (! = finisher)  gap at the hit test (m)  +ticks the press waited\n`);
    if (args.includes('brief')) {
      // One line per table: at how many of the nine distances every punch landed, and the longest the attacker travelled.
      for (const [name, combo] of Object.entries(COMBOS)) for (const ropes of [false, true]) {
        const rs = dists.map(d => runCombo(k, cfg, combo, d, { ropes, gap }));
        const all = rs.filter(r => r.rows.every(x => x.outcome === 'L')).length;
        console.log(`${name.padEnd(10)} ${(ropes ? 'ropes' : 'open').padEnd(6)} all landed at ${all}/${dists.length} distances · lands ${rs.map(r => r.rows.filter(x => x.outcome === 'L').length).join('')} · attacker travelled up to ${Math.max(...rs.map(r => r.followed)).toFixed(2)} m · target knocked up to ${Math.max(...rs.map(r => r.knocked)).toFixed(2)} m · frozen up to ${Math.max(...rs.map(r => r.frozen))} t`);
      }
    } else for (const [name, combo] of Object.entries(COMBOS)) for (const ropes of [false, true]) {
      console.log(`${name} — ${ropes ? 'target on the ropes' : 'open ring'}`);
      console.log('  dist  ' + combo.map((c, i) => `${i + 1} ${c.p}`.padEnd(15)).join(' ') + ' knocked  followed  frozen  landed');
      for (const d of dists) {
        const r = runCombo(k, cfg, combo, d, { ropes, gap });
        const n = r.rows.filter(x => x.outcome === 'L').length;
        console.log(`  ${d.toFixed(2)}  ${r.rows.map(x => cellOf(x)).join(' ')} ${r.knocked.toFixed(2)} m   ${r.followed.toFixed(2)} m   ${String(r.frozen).padStart(2)} t    ${n}/${combo.length}`);
      }
      console.log('');
    }
  }
}
