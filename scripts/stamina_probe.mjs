#!/usr/bin/env node
/**
 * stamina_probe.mjs — what everything costs, and how long a fighter lasts (polish phase, item 6).
 *
 *   node scripts/stamina_probe.mjs costs            # the cost of every action, measured from the sim
 *   node scripts/stamina_probe.mjs pace             # a scripted human pace over 3 × 60 s: where the tank is
 *   node scripts/stamina_probe.mjs bots             # the scripted bots against the AI: their pace and their tank
 *   node scripts/stamina_probe.mjs all key=value …  # config overrides
 *
 * Stamina is 0..1. "Tired" = below fatigueFrom (punches start to slow and lose power); "gassed" = below
 * lowStamina (the wind-up drags). The reference fighters, ratings off, unless `rated` is given.
 */
import { kit } from './bots/kit.mjs';
import * as jabAndMove from './bots/jab_and_move.mjs';
import * as insideFighter from './bots/inside_fighter.mjs';
import * as counterPuncher from './bots/counter_puncher.mjs';
import * as turtle from './bots/turtle.mjs';
import * as masher from './bots/masher.mjs';

const args = process.argv.slice(2);
const mode = args[0] ?? 'all';
const k = await kit({ rated: args.includes('rated') });
const cfg = { ...k.cfg };
for (const a of args) { const m = a.match(/^(\w+)=(.+)$/); if (m) cfg[m[1]] = m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]); }
const { inp, NONE, fresh } = k;
const pct = x => (x * 100).toFixed(1);

/** Stamina side `who` loses over a scripted exchange, with regeneration switched off so the cost stands alone. */
function costOf(script, { dist = 0.78, who = 0, ticks = 60, c = cfg, prep = null } = {}) {
  const cc = { ...c, staminaRegen: 0 };
  let s = fresh(cc, dist); if (prep) prep(s);
  const before = s.fighters[who].stamina, cap0 = s.fighters[who].staminaCap; let what = '';
  for (let i = 0; i < ticks; i++) {
    const r = k.sim.step(s, script(i), cc); s = r.state;
    for (const e of r.events) if (/punchLand|punchBlock|punchWhiff|perfectBlock/.test(e.type) && !what) what = e.type === 'punchLand' ? `land/${e.grade}` : e.type.replace('punch', '').toLowerCase();
  }
  return { cost: before - s.fighters[who].stamina, cap: cap0 - s.fighters[who].staminaCap, what };
}

export function costs(c = cfg, quiet = false) {
  const out = {};
  const say = (label, v, note = '') => { out[label] = v; if (!quiet) console.log(`  ${label.padEnd(52)} ${pct(v.cost).padStart(6)}%${v.cap > 1e-9 ? `  (+ ceiling −${pct(v.cap)}%)` : ''}  ${note}`); };
  if (!quiet) console.log('\nCost of each action, % of the tank (regeneration off so each stands alone)\n');
  for (const p of ['jab', 'cross', 'hook', 'uppercut']) {
    const d = p === 'hook' ? 0.72 : p === 'uppercut' ? 0.66 : 0.78;
    say(`${p} thrown and LANDED`, costOf(i => [inp({ [p]: i === 0 }), NONE], { dist: d, c }));
    say(`${p} thrown and MISSED`, costOf(i => [inp({ [p]: i === 0 }), NONE], { dist: 1.6, c }));
    say(`${p} thrown and BLOCKED`, costOf(i => [inp({ [p]: i === 0 }), inp({ block: true })], { dist: d, c }));
  }
  say('body hook landed (level held)', costOf(i => [inp({ hook: i === 6, level: i <= 6 }), NONE], { dist: 0.7, c }));
  say('overhand missed (level + stick forward)', costOf(i => [inp({ cross: i === 6, level: i <= 6, move: { x: 0, y: i === 6 ? 1 : 0 } }), NONE], { dist: 1.7, c }));
  say('a feinted cross', costOf(i => [inp({ cross: i === 0, block: i === 3 }), NONE], { ticks: 30, c }));
  if (!quiet) console.log('');
  for (const p of ['jab', 'cross', 'hook', 'uppercut']) {
    const d = p === 'hook' ? 0.72 : p === 'uppercut' ? 0.66 : 0.78;
    // The block is held only for the 30 ticks round the impact, and its holding cost is taken off, so this is the SHOT's cost.
    const hold = costOf(i => [NONE, inp({ block: i < 30 })], { who: 1, dist: 3, ticks: 30, c }).cost;
    const v = costOf(i => [inp({ [p]: i === 0 }), inp({ block: i < 30 })], { who: 1, dist: d, ticks: 30, c });
    say(`BLOCKING his ${p} (the shot itself)`, { ...v, cost: v.cost - hold });
    say(`TAKING his ${p} clean`, costOf(i => [inp({ [p]: i === 0 }), NONE], { who: 1, dist: d, c }));
  }
  say('taking a body hook clean', costOf(i => [inp({ hook: i === 6, level: i <= 6 }), NONE], { who: 1, dist: 0.7, c }));
  if (!quiet) console.log('');
  say('holding the guard up, per second', costOf(() => [inp({ block: true }), NONE], { dist: 3, ticks: 60, c }));
  say('walking, per second', costOf(() => [inp({ move: { x: 1, y: 0 } }), NONE], { dist: 3, ticks: 60, c }));
  say('a slip', costOf(i => [inp({ move: k.flick(1, 0)(i) }), NONE], { dist: 3, ticks: 40, c }));
  say('a burst (double-tap)', costOf(i => [inp({ move: k.doubleTap(0, -1)(i) }), NONE], { dist: 3, ticks: 40, c }));
  say('a pivot (block + flick)', costOf(i => [inp({ block: i < 6, move: k.flick(1, 0)(i) }), NONE], { dist: 3, ticks: 40, c }), '(includes ~0.1 s of guard)');
  if (!quiet) {
    console.log(`\n  regeneration ${pct(c.staminaRegen)}% /s when not punching, not blocking and ${c.staminaRegenDelay} s after being hit (${(c.staminaRegenDelay * c.staminaRegenDelayLight).toFixed(2)} s after a jab); ceiling floor ${pct(c.staminaCapFloor)}%`);
    console.log(`  tired below ${pct(c.fatigueFrom)}% (punches up to ${c.tiredPunchSlow}× slower, −${pct(c.tiredPowerLoss)}% power at empty); gassed below ${pct(c.lowStamina)}% (wind-up × ${c.lowStaminaCockMult})`);
    console.log(`  between rounds: ${pct(c.betweenRoundStaminaRestore)}% of what is missing comes back; ${pct(c.wearRestore)}% of the work-rate wear`);
  }
  return out;
}

/**
 * A scripted human pace for 3 × 60 s against a partner who stands in front of him: `ppm` punches a minute in
 * 1-2s and 1-2-3s, of which `miss` are thrown out of range (he steps back for them), the partner blocking `blocked`
 * of the rest; the partner throws `his` punches a minute back, of which the fighter blocks `guard` (holding the
 * guard for about half a second round each) and takes the rest; he walks the rest of the time.
 */
export function pace({ ppm = 32, miss = 0.25, blocked = 0.3, his = 24, guard = 0.6, heavy = 0.4, holdGuard = false, c = cfg, label = '' } = {}, quiet = false) {
  const cc = { ...c, roundSeconds: 60, roundCount: 3, healthDamagePerImpulse: 0, stunBase: 0, bodyHurtOn: false, liverOn: false, guardWearOn: false };
  let s = k.sim.createState(k.specs, cc, 7);
  const stat = { ticks: 0, sum: 0, tired: 0, gassed: 0, min: 1, thrown: 0, taken: 0, blockedByMe: 0, rounds: [], blockTicks: 0, landed: 0, whiffed: 0 };
  // Deterministic schedules: every action is placed on a beat (no rng).
  const beat = Math.round(3600 / ppm * 2.5);            // one burst of ~2.5 punches every `beat` ticks
  const hisBeat = Math.round(3600 / his);
  let n = 0, m = 0, queue = [], guardUntil = -1, lastRound = -1;
  for (let i = 0; i < 3 * 60 * 60 + 3000 && s.round.phase !== 'over'; i++) {
    const a = s.fighters[0], d = s.fighters[1];
    if (s.round.phase === 'fighting') {
      if (s.round.index !== lastRound) { lastRound = s.round.index; }
      const t = Math.round((cc.roundSeconds - s.round.clock) * 60);
      // Keep them in front of each other: the scripted fight is about the tank, not the ring.
      const gap = Math.hypot(a.pos.x - d.pos.x, a.pos.z - d.pos.z);
      // His punches: a jab or (every `1/heavy`-th) a hook / cross, on the beat.
      let hisIn = inp();
      if (t % hisBeat === 0) { m++; const hv = Math.floor(m * heavy) !== Math.floor((m - 1) * heavy); hisIn = inp({ [hv ? (m % 2 ? 'cross' : 'hook') : 'jab']: true }); if (Math.floor(m * guard) !== Math.floor((m - 1) * guard)) guardUntil = t + 30; }
      // The partner blocks `blocked` of my bursts.
      if (t % beat === 0) { n++; const far = Math.floor(n * miss) !== Math.floor((n - 1) * miss); queue = (n % 2 ? ['jab', 'cross', 'hook'] : ['jab', 'cross']).map((p, j) => ({ p, at: t + 4 + j * 9, far })); }
      const partnerBlocks = Math.floor(n * blocked) !== Math.floor((n - 1) * blocked) && queue.some(q => q.at >= t - 20);
      if (partnerBlocks && hisIn.jab + hisIn.cross + hisIn.hook === 0) hisIn = inp({ block: true });
      const q = queue.find(x => x.at === t);
      const far = queue.length && queue[0].far && t <= queue[queue.length - 1].at + 10;
      const want = far ? 1.45 : 0.78;
      const move = { x: 0, y: gap > want + 0.06 ? 1 : gap < want - 0.06 ? -1 : 0 };
      // `holdGuard`: the way most people play — the guard is up whenever he is not about to punch.
      const guarding = holdGuard ? !queue.some(x => x.at >= t && x.at - t < 14) : t <= guardUntil && !q;
      const mine = inp({ [q?.p ?? 'none']: true, move: q?.p === 'hook' ? { x: -1, y: move.y } : move, block: guarding });
      const r = k.sim.step(s, [mine, hisIn], cc); s = r.state;
      for (const e of r.events) {
        if (e.type === 'punchStart' && e.side === 0) stat.thrown++;
        if (e.type === 'punchLand' && e.side === 1) stat.taken++;
        if (e.type === 'punchLand' && e.side === 0) stat.landed++;
        if (e.type === 'punchWhiff' && e.side === 0) stat.whiffed++;
        if ((e.type === 'punchBlock' || e.type === 'perfectBlock') && e.side === 1) stat.blockedByMe++;
        if (e.type === 'roundEnd') stat.rounds.push({ end: s.fighters[0].stamina, cap: s.fighters[0].staminaCap });
      }
      const f = s.fighters[0];
      stat.ticks++; stat.sum += f.stamina; stat.min = Math.min(stat.min, f.stamina);
      if (f.fatigue > 0) stat.tired++;
      if (f.stamina < cc.lowStamina) stat.gassed++;
      if (f.block) stat.blockTicks++;
    } else { s = k.sim.step(s, [NONE, NONE], cc).state; }
  }
  const out = { ppm: stat.thrown / (stat.ticks / 3600), avg: stat.sum / stat.ticks, tired: stat.tired / stat.ticks, gassed: stat.gassed / stat.ticks, min: stat.min, rounds: stat.rounds, taken: stat.taken, blockedByMe: stat.blockedByMe, guard: stat.blockTicks / stat.ticks, landed: stat.landed, whiffed: stat.whiffed, thrown: stat.thrown };
  if (!quiet) console.log(`  ${label.padEnd(44)} ${out.ppm.toFixed(0).padStart(3)} thrown/min (${stat.landed} landed, ${stat.whiffed} missed) · takes ${stat.taken}, blocks ${stat.blockedByMe} · guard up ${pct(out.guard)}% · avg tank ${pct(out.avg)}% · tired ${pct(out.tired)}% of the time · gassed ${pct(out.gassed)}% · lowest ${pct(out.min)}% · end of rounds ${out.rounds.map(r => `${pct(r.end)}/${pct(r.cap)}`).join('  ')} (tank/ceiling)`);
  return out;
}

export function paces(c = cfg) {
  console.log('\nA scripted human pace, 3 × 60 s (he throws 1-2s and 1-2-3s on a beat; the partner hits back on a beat)\n');
  return {
    easy: pace({ ppm: 25, his: 18, label: 'steady: 25 a minute, a quarter missed', c }),
    normal: pace({ ppm: 32, his: 24, label: 'normal: 32 a minute, a quarter missed', c }),
    busy: pace({ ppm: 40, his: 30, label: 'busy: 40 a minute, a quarter missed', c }),
    guardNormal: pace({ ppm: 32, his: 24, holdGuard: true, label: 'normal, guard up between bursts', c }),
    guardBusy: pace({ ppm: 60, his: 40, holdGuard: true, label: 'hard: 60 a minute, guard up between bursts', c }),
    wild: pace({ ppm: 40, his: 24, miss: 0.7, label: 'wild: 40 a minute, most of them missed', c }),
    wildBusy: pace({ ppm: 70, his: 24, miss: 0.7, holdGuard: true, label: 'wild and busy: 70 a minute, most missed', c }),
    shell: pace({ ppm: 12, his: 40, guard: 1, heavy: 0.2, label: 'behind the guard: 40 a minute at him, light', c }),
    shellHeavy: pace({ ppm: 12, his: 40, guard: 1, heavy: 0.8, label: 'behind the guard: 40 a minute at him, heavy', c }),
  };
}

export async function bots(c = cfg, n = 4) {
  console.log(`\nThe scripted bots against the pressure AI (medium), 3 × 60 s, ${n} seeds each, ratings on\n`);
  const kr = await kit({ rated: true });
  const cc = { ...kr.cfg, roundSeconds: 60, roundCount: 3, aiDifficulty: 1 };
  for (const [key, v] of Object.entries(c)) if (cfg[key] !== k.cfg[key]) cc[key] = v;   // carry the command-line overrides
  const spec = id => kr.core.ROSTER.find(f => f.id === id);
  const out = {};
  for (const bot of [jabAndMove, insideFighter, counterPuncher, turtle, masher]) {
    const t = { ticks: 0, sum: [0, 0], tired: [0, 0], gassed: [0, 0], thrown: [0, 0], block: [0, 0] };
    for (let seed = 1; seed <= n; seed++) {
      const specs = [spec(seed % 2 ? 'red' : 'blue'), spec('monsoon')];
      let s = kr.sim.createState(specs, cc, seed);
      let ai = kr.ai.createAi(1, seed, cc, kr.ai.styleFor(specs[1], cc));
      const player = bot.create(kr, seed, cc);
      for (let i = 0; i < 40000 && s.round.phase !== 'over'; i++) {
        const d = kr.ai.aiStep(ai, s, cc); ai = d.ai;
        const r = kr.sim.step(s, [player.step(s), d.input], cc); s = r.state;
        for (const e of r.events) if (e.type === 'punchStart') t.thrown[e.side]++;
        if (s.round.phase !== 'fighting') continue;
        t.ticks++;
        for (const side of [0, 1]) { const f = s.fighters[side]; t.sum[side] += f.stamina; if (f.fatigue > 0) t.tired[side]++; if (f.stamina < cc.lowStamina) t.gassed[side]++; if (f.block) t.block[side]++; }
      }
    }
    const row = side => `${(t.thrown[side] / (t.ticks / 3600)).toFixed(0).padStart(3)} thrown/min · guard up ${pct(t.block[side] / t.ticks).padStart(5)}% · avg tank ${pct(t.sum[side] / t.ticks).padStart(5)}% · tired ${pct(t.tired[side] / t.ticks).padStart(5)}% · gassed ${pct(t.gassed[side] / t.ticks).padStart(5)}%`;
    console.log(`  ${bot.name.padEnd(16)} ${row(0)}   ‖ the AI: ${row(1)}`);
    out[bot.name] = { ppm: t.thrown[0] / (t.ticks / 3600), avg: t.sum[0] / t.ticks, tired: t.tired[0] / t.ticks, gassed: t.gassed[0] / t.ticks, ai: { ppm: t.thrown[1] / (t.ticks / 3600), avg: t.sum[1] / t.ticks, tired: t.tired[1] / t.ticks, gassed: t.gassed[1] / t.ticks } };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (mode === 'costs' || mode === 'all') costs();
  if (mode === 'pace' || mode === 'all') paces();
  if (mode === 'bots' || mode === 'all') await bots();
}
