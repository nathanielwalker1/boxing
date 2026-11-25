/**
 * kinds.mjs — per style, from a balance run's jsonl: where the dodges and the counters came from, and the counters' share
 * of lands and of damage. `node scripts/balance/kinds.mjs <label>`. One line a style.
 */
import { readFileSync } from 'node:fs';
const label = process.argv[2] || 'styles';
const rows = readFileSync(new URL(`../output/balance/${label}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const acc = {};
const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };
for (const r of rows) r.r.stats.forEach((q, side) => {
  const A = acc[side === (r.swap ? 1 : 0) ? r.a : r.b] ||= { n: 0, land: 0, dmg: 0, counters: 0, counterDmg: 0, dodge: {}, after: {}, thrown: {} };
  A.n++; A.counters += q.counters; A.counterDmg += q.counterDmg || 0;
  for (const [k, p] of Object.entries(q.p)) { A.land += p.landHead + p.landBody; A.dmg += p.dmgHead + p.dmgBody; add(A.thrown, k, p.thrown); }
  for (const [k, v] of Object.entries(q.dodgeKinds || {})) add(A.dodge, k, v);
  for (const [k, v] of Object.entries(q.counterAfter || {})) add(A.after, k, v);
});
const per = (o, n) => Object.entries(o).map(([k, v]) => `${k} ${(v / n).toFixed(1)}`).join(', ') || '-';
for (const [name, A] of Object.entries(acc)) {
  const pc = (a, b) => b ? Math.round(100 * a / b) + '%' : '-';
  console.log(`${name.padEnd(10)} n=${A.n}  lands ${(A.land / A.n).toFixed(0)}  counters ${(A.counters / A.n).toFixed(1)} = ${pc(A.counters, A.land)} of lands, ${pc(A.counterDmg, A.dmg)} of damage | dodges: ${per(A.dodge, A.n)} | counters after: ${per(A.after, A.n)} | thrown: ${per(A.thrown, A.n)}`);
}
