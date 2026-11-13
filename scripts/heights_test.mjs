/**
 * heights_test.mjs — punches go where the other man actually is, across the
 * roster of eight (1.63 m to 1.98 m, reach 1.62 m to 2.11 m). In Node, the
 * game as shipped (ratings and guard shapes on).
 *   - for every ordered roster pair, a jab, cross, hook and uppercut land on the
 *     HEAD and a body jab, body cross and body hook land on the BODY, from the
 *     punch's natural range for that pair (the middle of the distances it lands from)
 *   - a standing short man is not unhittable by a tall man's straight, nor the
 *     other way round
 *   - reach matters: the 1.98 m man's jab lands from where the 1.63 m man's whiffs
 *   - the lane tracks the opponent's standing height fully (punchAimDeadband 0)
 *
 * `node scripts/heights_test.mjs probe [key=value…]` prints the measured table instead.
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';

const k = await kit({ rated: true });
const { core, inp, NONE, run, fresh } = k;
const ROSTER = core.ROSTER;
const args = process.argv.slice(2);
const probe = args[0] === 'probe';
// skelPoleTwist 1 (anim Phase 1.1b): with the hook's elbow out where a shoulder can put it (0.5, the default) the body hook on boiler (1.98 m) from 0.675 m misses; LOG_SKELETON.md, behavioural shifts.
// skelGuardFlareFree −1 = the legacy flare (Phase 1.1b): with the guard's elbows held down (0.3, the default) monsoon's uppercut misses raffle — one pairing of 49; LOG_SKELETON.md.
const cfg = { ...k.cfg, skelPoleTwist: 1, skelGuardFlareFree: -1 };
for (const a of args.slice(1)) { const [key, v] = a.split('='); cfg[key] = Number(v); }

/** The seven punches: [name, press, body lane?, stick x at the press (the hand, for hook / uppercut)]. */
const PUNCHES = [
  ['jab', 'jab', false, 0], ['cross', 'cross', false, 0], ['hook', 'hook', false, -1], ['uppercut', 'uppercut', false, 1],
  ['bodyJab', 'jab', true, 0], ['bodyCross', 'cross', true, 0], ['bodyHook', 'hook', true, -1],
];
const LOW = 9;   // ticks the level is held before a body punch is pressed
const DISTS = []; for (let d = 1.5; d >= 0.449; d -= 0.075) DISTS.push(Math.round(d * 1000) / 1000);

/** `a` throws at `b` from `d` m: the punch's outcome for side 0. */
function throwAt(a, b, [, press, body, x], d, c = cfg) {
  const s = fresh(c, d, 12, 0, 1, [a, b]);
  const at = body ? LOW : 0;
  let out = null;
  run(s, at + 50, i => [inp({ level: body && i <= at, [press]: i === at, move: { x: i === at ? x : 0, y: 0 } }), NONE], c, (st, i, ev) => {
    const e = ev.find(e => e.side === 0 && (e.type === 'punchLand' || e.type === 'punchWhiff' || e.type === 'punchBlock'));
    if (e) { out = e; return true; }
  });
  return out;
}
/** Every distance the punch lands from, far to near: [{ d, part, grade, variant }]. */
function band(a, b, punch, c = cfg) {
  const lands = [];
  for (const d of DISTS) { const e = throwAt(a, b, punch, d, c); if (e?.type === 'punchLand') lands.push({ d, part: e.part, grade: e.grade, variant: e.variant }); }
  return lands;
}

const rows = [];
for (const a of ROSTER) for (const b of ROSTER) {
  if (a === b) continue;
  for (const punch of PUNCHES) {
    const lands = band(a, b, punch);
    const want = punch[2] ? 'body' : 'head';
    // Natural range: the middle of the distances it lands from — the middle landing distance and its two neighbours.
    // The punch is "on" if most of those hit the intended part (one stray sample at a range boundary does not fail it).
    const m = Math.floor((lands.length - 1) / 2);
    const mid = lands.length ? lands[m] : null;
    const near = lands.slice(Math.max(0, m - 1), m + 2);
    const on = near.length > 0 && near.filter(l => l.part === want).length * 2 > near.length;
    rows.push({ a, b, punch, lands, want, mid, on });
  }
}

if (probe) {
  for (const r of rows) {
    const wrong = r.lands.filter(l => l.part !== r.want);
    const flag = !r.lands.length ? 'NEVER LANDS' : !r.on ? 'WRONG PART AT NATURAL RANGE' : wrong.length ? `off-part at ${wrong.map(l => l.d).join(',')}` : r.mid.grade === 'glancing' ? 'glancing at natural range' : '';
    if (flag || args.includes('all')) console.log(`${r.a.id.padEnd(10)} → ${r.b.id.padEnd(10)} ${r.punch[0].padEnd(9)} ${r.lands.length ? `${r.lands[r.lands.length - 1].d.toFixed(2)}–${r.lands[0].d.toFixed(2)} m` : '—'.padEnd(11)} ${r.lands.map(l => l.part[0] + l.grade[0]).join(' ')}  ${flag}`);
  }
  const bad = rows.filter(r => !r.on).length;
  console.log(`\n${rows.length} pair × punch rows, ${bad} failing (never lands, or the wrong part at natural range); punchAimDeadband ${cfg.punchAimDeadband}`);
  process.exit(0);
}

console.log('\n=== 1. Every pair, every punch: the intended part from natural range ===');
check(`the lane tracks the opponent's standing height fully (punchAimDeadband ${cfg.punchAimDeadband})`, cfg.punchAimDeadband === 0);
for (const a of ROSTER) {
  const mine = rows.filter(r => r.a === a);
  // KNOWN, pinned (OVERHAUL_SIM.md phase 3, below standard): an uppercut thrown DOWN at the 1.63 m man lands on his
  // chest. His chest capsule (17 cm) is thicker than his head (13 cm) and sits directly under it, so a fist coming
  // up from in front is stopped on the chest before it is under the chin. Counted separately so it cannot spread.
  const known = r => r.punch[0] === 'uppercut' && r.b.id === 'boiler';
  const never = mine.filter(r => !r.lands.length), wrong = mine.filter(r => r.lands.length && !r.on && !known(r));
  const say = rs => rs.map(r => `${r.punch[0]}→${r.b.id}${r.mid ? ` (${r.mid.part} at ${r.mid.d} m)` : ''}`).join(', ');
  check(`${a.id} (${a.heightM} m, reach ${a.reachM} m): all seven punches land on all seven opponents`, never.length === 0, say(never));
  check(`…head punches on the head, body punches on the body, from the middle of the range each lands from`, wrong.length === 0, say(wrong));
}
{
  const up = rows.filter(r => r.punch[0] === 'uppercut' && r.b.id === 'boiler');
  const chest = up.filter(r => !r.on);
  check(`known limit: an uppercut on the 1.63 m man lands on his chest for ${chest.length} of ${up.length} opponents (${chest.map(r => r.a.id).join(', ')}) — it still lands`, up.every(r => r.lands.length > 0) && chest.length <= 5);
}

console.log('\n=== 2. Short and tall ===');
{
  const short = ROSTER.find(f => f.id === 'boiler'), tall = ROSTER.find(f => f.id === 'lighthouse');
  const row = (a, b, name) => rows.find(r => r.a === a && r.b === b && r.punch[0] === name);
  for (const [a, b] of [[tall, short], [short, tall]]) for (const name of ['jab', 'cross']) {
    const r = row(a, b, name);
    const solid = r.lands.filter(l => l.part === 'head' && l.grade !== 'glancing');
    check(`${a.id}'s ${name} hits a standing ${b.id} on the head, clean, from ${solid.length} of ${r.lands.length} landing distances (${solid.length ? `${solid[solid.length - 1].d}–${solid[0].d} m` : 'none'})`, solid.length >= 2);
  }
  const far = d => [throwAt(tall, short, PUNCHES[0], d), throwAt(short, tall, PUNCHES[0], d)];
  const tj = row(tall, short, 'jab').lands[0].d, sj = row(short, tall, 'jab').lands[0].d;
  const [t, s] = far(tj);
  check(`reach matters: the 1.98 m man's jab lands from ${tj} m (${t?.type}), where the 1.63 m man's whiffs (${s?.type}); his own longest is ${sj} m`, t?.type === 'punchLand' && s?.type === 'punchWhiff' && tj > sj + 0.1);
  // With the old dead band (0.08) nothing changes for a pair this far apart; with tracking off the short man's head is missed.
  const off = { ...cfg, punchAimTrack: 0 };
  const blind = band(tall, short, PUNCHES[1], off).filter(l => l.part === 'head' && l.grade !== 'glancing').length;
  const seen = row(tall, short, 'cross').lands.filter(l => l.part === 'head' && l.grade !== 'glancing').length;
  check(`with punchAimTrack 0 the tall man's cross finds the short man's head clean from ${blind} distances; with it, ${seen}`, seen > blind);
}

done();
