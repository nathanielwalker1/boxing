/** report.mjs — tables from out/results.jsonl.   node report.mjs */
import { readFileSync } from 'node:fs';
const rows = readFileSync(new URL(`../output/balance/${process.argv[2] || 'results'}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const pad = (v, n) => String(v).padStart(n), padr = (v, n) => String(v).padEnd(n);
const pct = (x, n) => n ? (100 * x / n).toFixed(0) + '%' : '-';
const byTag = t => rows.filter(r => r.tag === t);
/** score from a's point of view */
const sc = r => r.r.winner === null ? 0.5 : (r.r.winner === (r.swap ? 1 : 0) ? 1 : 0);
const sideOfA = r => (r.swap ? 1 : 0);
console.log(`${rows.length} fights: ` + Object.entries(rows.reduce((m, r) => (m[r.tag] = (m[r.tag] || 0) + 1, m), {})).map(([k, v]) => `${k} ${v}`).join(', '));

function pairs(tag, title) {
  const g = {};
  for (const r of byTag(tag)) { const k = r.a + ' vs ' + r.b; (g[k] ??= { n: 0, s: 0, m: {} }); g[k].n++; g[k].s += sc(r); g[k].m[r.r.method] = (g[k].m[r.r.method] || 0) + 1; }
  if (!Object.keys(g).length) return;
  console.log(`\n== ${title}`);
  for (const [k, v] of Object.entries(g)) console.log(padr(k, 44) + pad(pct(v.s, v.n), 6) + pad('n=' + v.n, 6) + '   ' + Object.entries(v.m).map(([a, b]) => `${a} ${b}`).join(', '));
}
function overall(tag, title) {
  const g = {};
  for (const r of byTag(tag)) for (const [me, s] of [[r.a, sc(r)], [r.b, 1 - sc(r)]]) { (g[me] ??= { n: 0, s: 0, w: 0, l: 0, d: 0 }); g[me].n++; g[me].s += s; if (s === 1) g[me].w++; else if (s === 0) g[me].l++; else g[me].d++; }
  if (!Object.keys(g).length) return;
  console.log(`-- ${title}`);
  for (const [k, v] of Object.entries(g).sort((x, y) => y[1].s / y[1].n - x[1].s / x[1].n)) console.log(padr(k, 30) + pad(pct(v.s, v.n), 6) + pad(`${v.w}-${v.l}-${v.d}`, 10));
}
pairs('style_med', 'style vs style, medium (win % of the first-named; draws count half)'); overall('style_med', 'overall per style, medium');
pairs('style_hard', 'style vs style, hard'); overall('style_hard', 'overall per style, hard');
pairs('ladder_in', 'skill ladder inside a style (2 = hard, 1 = medium, 0 = easy)');
pairs('ladder_x', 'skill ladder across styles: hard A vs easy B');
{
  const x = byTag('ladder_x'); if (x.length) console.log(`   all cross-style hard-vs-easy: ${pct(x.reduce((s, r) => s + sc(r), 0), x.length)} for the hard fighter, n=${x.length}`);
  const y = byTag('ladder_in').filter(r => r.a.endsWith('2') && r.b.endsWith('0')); if (y.length) console.log(`   all same-style hard-vs-easy: ${pct(y.reduce((s, r) => s + sc(r), 0), y.length)} for the hard fighter, n=${y.length}`);
}
{
  const g = {};
  for (const r of byTag('exploit')) { const q = (g[r.a] ??= { n: 0, s: 0, w: 0, l: 0, d: 0, m: {}, vs: [] }); const s = sc(r); q.n++; q.s += s; if (s === 1) q.w++; else if (s === 0) q.l++; else q.d++; q.m[r.r.method] = (q.m[r.r.method] || 0) + 1; q.vs.push(r.b.slice(0, 4) + (s === 1 ? '+' : s === 0 ? '-' : '=')); }
  if (Object.keys(g).length) {
    console.log('\n== exploit bots vs the medium AI (bot\'s results; target: under 30%)');
    for (const [k, v] of Object.entries(g).sort((x, y) => y[1].s / y[1].n - x[1].s / x[1].n)) console.log(padr(k, 18) + pad(pct(v.s, v.n), 6) + pad(`${v.w}-${v.l}-${v.d}`, 8) + '   ' + v.vs.join(' ') + '   ' + Object.entries(v.m).map(([a, b]) => `${a} ${b}`).join(', '));
  }
}
pairs('nojab', 'a medium style vs the same style with its jab presses deleted'); pairs('jab2cross', 'vs the same style with jabs turned into crosses');
pairs('headonly', 'a medium style vs the same style never allowed to drop its level (no body shots, no ducks)');
pairs('rating', 'one rating 95 vs 35, everything else equal (pressure, medium)');
overall('roster', 'roster fighters, own body + ratings + style, medium');

// ---- what happens inside AI-vs-AI fights ----
const aiTags = ['style_med', 'style_hard', 'roster', 'ladder_in', 'ladder_x'];
function inside(title, sel, sideFilter = () => true) {
  const fs = rows.filter(sel); if (!fs.length) return;
  const P = ['jab', 'cross', 'hook', 'uppercut'];
  const T = Object.fromEntries(P.map(k => [k, { thrown: 0, land: 0, body: 0, dmg: 0, blocked: 0, dodged: 0, whiff: 0 }]));
  let counters = 0, rocked = 0, conv = 0, kd = 0, bodyHurt = 0, gb = 0, stam = 0, stamMin = 1, sides = 0, vh = { land: 0, block: 0, miss: 0 }, vo = { land: 0, block: 0, miss: 0 }, endStam = 0, pb = 0, slips = 0, feints = 0;
  const causes = {}, falls = {}, kinds = {}, methods = {};
  for (const r of fs) {
    methods[r.r.method] = (methods[r.r.method] || 0) + 1;
    r.r.stats.forEach((q, side) => {
      if (!sideFilter(r, side)) return;
      sides++;
      for (const k of P) { const p = q.p[k], t = T[k]; t.thrown += p.thrown; t.land += p.landHead + p.landBody; t.body += p.landBody; t.dmg += p.dmgHead + p.dmgBody; t.blocked += p.blocked; t.dodged += p.dodged; t.whiff += p.whiff; }
      counters += q.counters; rocked += q.rockedGiven; conv += q.rockedConverted; kd += q.kdGiven; bodyHurt += q.bodyHurtGiven; gb += q.guardBreakGiven; pb += q.perfectBlocks; slips += q.slipsDodged; feints += q.feints;
      stam += q.stamSum / Math.max(1, q.ticks); stamMin = Math.min(stamMin, q.stamMin); endStam += q.stamEnd;
      for (const k of ['land', 'block', 'miss']) { vh[k] += q.vsHurt[k]; vo[k] += q.vsOk[k]; }
      for (const [o, src] of [[causes, q.kdCauses], [falls, q.kdFalls], [kinds, q.kdKinds]]) for (const [k, v] of Object.entries(src)) o[k] = (o[k] || 0) + v;
    });
  }
  const tot = k => P.reduce((s, p) => s + T[p][k], 0);
  console.log(`\n== ${title}  (${fs.length} fights, ${sides} fighter-sides)`);
  console.log('   how fights end: ' + Object.entries(methods).map(([k, v]) => `${k} ${pct(v, fs.length)}`).join(', '));
  console.log(padr('   punch', 12) + pad('thrown%', 9) + pad('landed%', 9) + pad('damage%', 9) + pad('accuracy', 9) + pad('blocked', 9) + pad('dodged', 8) + pad('missed', 8) + pad('to body', 9));
  for (const k of P) { const t = T[k]; console.log(padr('   ' + k, 12) + pad(pct(t.thrown, tot('thrown')), 9) + pad(pct(t.land, tot('land')), 9) + pad(pct(t.dmg, tot('dmg')), 9) + pad(pct(t.land, t.thrown), 9) + pad(pct(t.blocked, t.thrown), 9) + pad(pct(t.dodged, t.thrown), 8) + pad(pct(t.whiff, t.thrown), 8) + pad(pct(t.body, t.land), 9)); }
  console.log(`   per fighter per fight: thrown ${(tot('thrown') / sides).toFixed(0)}, landed ${(tot('land') / sides).toFixed(0)}, counters ${(counters / sides).toFixed(1)}, slips that dodged ${(slips / sides).toFixed(1)}, perfect blocks ${(pb / sides).toFixed(1)}, feints ${(feints / sides).toFixed(1)}`);
  console.log(`   hurt: rocked ${(rocked / sides).toFixed(2)}, winded ${(bodyHurt / sides).toFixed(2)}, guard breaks ${(gb / sides).toFixed(2)}, knockdowns ${(kd / sides).toFixed(2)} per fighter per fight; rocked -> knockdown before he recovered: ${conv} of ${rocked}`);
  console.log(`   knockdown causes ${JSON.stringify(causes)} kinds ${JSON.stringify(kinds)} falls ${JSON.stringify(falls)}`);
  const rate = v => { const n = v.land + v.block + v.miss; return `${pct(v.land, n)} land / ${pct(v.block, n)} blocked / ${pct(v.miss, n)} miss (n=${n})`; };
  console.log(`   punches at a HEALTHY man: ${rate(vo)};  at a HURT man: ${rate(vh)}`);
  console.log(`   stamina: average ${(stam / sides).toFixed(2)}, lowest seen ${stamMin.toFixed(2)}, at the final bell ${(endStam / sides).toFixed(2)}`);
}
inside('inside AI-vs-AI fights, all', r => aiTags.includes(r.tag));
{
  // the comeback rate: of the fights where somebody was rocked and somebody won, how often the man rocked FIRST won
  const f = rows.filter(r => aiTags.includes(r.tag) && r.r.firstRocked != null && r.r.winner != null);
  console.log(`\n== comeback rate: the fighter rocked first still won ${pct(f.filter(r => r.r.winner === r.r.firstRocked).length, f.length)} of ${f.length} fights (of ${rows.filter(r => aiTags.includes(r.tag)).length}; the rest had no rock or no winner)`);
}
if (process.env.BRIEF) process.exit(0);   // BRIEF=1: the headline tables only, no per-style blocks
for (const st of ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'])
  if (rows.some(r => r.tag === 'style_med' && (r.a.startsWith(st) || r.b.startsWith(st)))) inside(`style ${st} (medium, its own numbers)`, r => r.tag === 'style_med', (r, side) => (side === (r.swap ? 1 : 0) ? r.a : r.b).startsWith(st));
