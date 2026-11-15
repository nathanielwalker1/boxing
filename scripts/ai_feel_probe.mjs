#!/usr/bin/env node
/**
 * ai_feel_probe.mjs — measurement only. Why do a person's punches feel flat against the boxer / counter AI (they go
 * into a held guard), and why does the brawler smother him? Per AI style, at medium and hard, 6 seeded full fights
 * against two scripted humans (a jabber and a mixer). Prints tables A–F. Changes nothing.
 *
 *   node scripts/ai_feel_probe.mjs
 *
 * A punch outcomes · B the AI's guard · C what a blocked punch does (controlled, reference fighters) · D separation
 * bands · E stopping power (A/B replays from a snapshot: the same moment with and without the human's punch) · F outcome.
 */
import { kit } from './bots/kit.mjs';
import { makeBot, dist as distOf, ready } from './bots/util.mjs';

// Args (all optional, key=value): styles=swarmer,pressure  diff=medium|hard|medium,hard  seeds=6  humans=jabber,mixer
// respect=0|1 (aiRespectV2 for this run; default = the config)  brief=1 (skip tables A-by-type, C; fast).
//   node scripts/ai_feel_probe.mjs styles=swarmer,pressure,slugger diff=medium brief=1 respect=1
const ARGS = Object.fromEntries(process.argv.slice(2).map(x => x.split('=')));
const SEEDS = ARGS.seeds ? Number(ARGS.seeds) : 6;
const ALL_STYLES = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];
const STYLES = ARGS.styles ? ARGS.styles.split(',').filter(x => ALL_STYLES.includes(x)) : ALL_STYLES;
const BODY = { pressure: ['monsoon', 'red'], outboxer: ['lighthouse', 'blue'], counter: ['alambre', 'grandad'], swarmer: ['boiler'], slugger: ['raffle'] };
const HUMAN_BODIES = ['red', 'blue'];
const DIFFS = [['medium', 1], ['hard', 2]].filter(([n]) => !ARGS.diff || ARGS.diff.split(',').includes(n));
const HUMANS = ARGS.humans ? ARGS.humans.split(',') : ['jabber', 'mixer'];
const BRIEF = ARGS.brief === '1';
const kr = await kit({ rated: true });
const { sim, ai: AI, core } = kr;
const spec = id => core.ROSTER.find(f => f.id === id);
const pct = (a, b) => (b > 0 ? (100 * a / b).toFixed(0) : '-').toString().padStart(3);
const f1 = x => (x === null || x === undefined || Number.isNaN(x) ? '-' : x.toFixed(2));
const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ── The two scripted humans ──────────────────────────────────────────────────────────────────────────────────
function mkJabber(seed, cfg) {
  return makeBot(kr, seed, (b, s) => {
    const d = distOf(s);
    b.mem.wait = (b.mem.wait ?? 40) - 1;
    if (b.mem.wait <= 0 && d <= 1.1 && d >= 0.72 && ready(kr, s, cfg)) {
      b.mem.wait = 40 + Math.floor(core.rngRange(b.rng, 0, 55));
      if (b.chance(0.35)) b.combo([['jab'], ['cross']], 8); else b.combo([['jab']], 8);
      for (let i = 0; i < 6; i++) b.push({});
      return {};
    }
    return { block: d < 1.4, move: { x: 0, y: d > 1.02 ? 1 : d < 0.9 ? -1 : 0 } };
  });
}
function mkMixer(seed, cfg) {
  return makeBot(kr, seed, (b, s) => {
    const d = distOf(s);
    b.mem.wait = (b.mem.wait ?? 40) - 1;
    if (b.mem.wait <= 0 && d <= 0.98 && ready(kr, s, cfg)) {
      b.mem.wait = 40 + Math.floor(core.rngRange(b.rng, 0, 45));
      const r = core.rngRange(b.rng, 0, 10);
      if (r < 1.5) b.combo([['jab']], 8);
      else if (r < 3.5) b.combo([['jab'], ['cross']], 8);
      else if (r < 5.5) b.combo([['jab'], ['cross'], ['hook', -1]], 8);
      else if (r < 7) { b.combo([['jab'], ['cross']], 8); for (let i = 0; i < 3; i++) b.push({}); b.lowThen('hook', -1); }
      else if (r < 8.5) { b.combo([['jab']], 8); for (let i = 0; i < 3; i++) b.push({}); b.lowThen('hook', -1); }
      else if (r < 9.3) b.lowThen('cross');
      else b.combo([['cross'], ['hook', -1], ['cross']], 8);
      for (let i = 0; i < 8; i++) b.push({});
      return {};
    }
    return { block: d < 1.4, move: { x: 0, y: d > 0.9 ? 1 : d < 0.72 ? -1 : 0 } };
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const sepOf = s => Math.hypot(s.fighters[0].pos.x - s.fighters[1].pos.x, s.fighters[0].pos.z - s.fighters[1].pos.z);
/** Closing speed of fighter `who` toward the other, as a fraction of moveSpeed (walk + stagger + hop, as the sim reads it). */
function closingOf(s, who, cfg) {
  const a = s.fighters[who], o = s.fighters[1 - who];
  const dd = Math.hypot(o.pos.x - a.pos.x, o.pos.z - a.pos.z) || 1;
  const ux = (o.pos.x - a.pos.x) / dd, uz = (o.pos.z - a.pos.z) / dd;
  return ((a.vel.x + a.stagger.x + a.hop.x) * ux + (a.vel.z + a.stagger.z + a.hop.z) * uz) / cfg.moveSpeed;
}
const NONE = kr.NONE, inp = kr.inp;

/** E: replay from a snapshot (pre-step of a human press), the AI free, the human pressing `press` on tick 0 or never. */
function replay(snap, withPress, cfg, ticks) {
  let s = structuredClone(snap.s), ai = structuredClone(snap.ai);
  const sep = [], clo = []; let T = null, outcome = 'none';
  for (let i = 0; i < ticks; i++) {
    const d = AI.aiStep(ai, s, cfg); ai = d.ai;
    const r = sim.step(s, [withPress && i === 0 ? inp({ [snap.press]: true }) : NONE, d.input], cfg); s = r.state;
    sep.push(sepOf(s)); clo.push(closingOf(s, 1, cfg));
    if (T === null) for (const e of r.events) {
      if (e.side !== 0 && e.type !== 'perfectBlock') continue;
      if (e.type === 'punchLand' && e.side === 0) { T = i; outcome = e.grade === 'glancing' ? 'glancing' : 'clean'; }
      else if (e.type === 'punchBlock' && e.side === 0) { T = i; outcome = 'blocked'; }
      else if (e.type === 'perfectBlock') { T = i; outcome = 'perfect'; }
      else if (e.type === 'punchWhiff' && e.side === 0) { T = i; outcome = 'whiff'; }
    }
  }
  return { sep, clo, T, outcome };
}
function replayAB(snap, cfg) {
  const N = 150;
  const a = replay(snap, true, cfg, N), b = replay(snap, false, cfg, N);
  if (a.T === null || a.T + 100 >= N) return { outcome: a.outcome };
  let push = 0;
  for (let t = a.T; t < a.T + 60; t++) push = Math.max(push, a.sep[t] - b.sep[t]);
  let reclose = null;
  for (let t = a.T + 1; t < a.T + 100; t++) if (a.clo[t] >= cfg.jabStopSpeed) { reclose = t - a.T; break; }
  return { outcome: a.outcome, push, sep30: a.sep[a.T + 30] - b.sep[a.T + 30], reclose, T: a.T, cloAtLand: a.clo[a.T] };
}

// ── One fight ────────────────────────────────────────────────────────────────────────────────────────────────
function fight(human, style, diffIdx, seed) {
  const c = { ...kr.cfg, aiDifficulty: diffIdx, ...(ARGS.respect !== undefined ? { aiRespectV2: ARGS.respect === '1' } : {}) };
  let hid = HUMAN_BODIES[seed % 2];
  const aid = BODY[style][(seed >> 1) % BODY[style].length];
  if (hid === aid) hid = HUMAN_BODIES[(seed + 1) % 2];
  const specs = [spec(hid), spec(aid)];
  let s = sim.createState(specs, c, seed);
  let ai = AI.createAi(1, seed, c, AI.styleFor(specs[1], c));
  const bot = human === 'jabber' ? mkJabber(seed, c) : mkMixer(seed, c);
  const R = {
    ticks: 0, starts: [], rises: [], out: {}, bands: [0, 0, 0, 0, 0], blockTicks: 0, runs: [], run: 0, guardBreaks: 0, aiStarts: 0,
    blockEv: {}, winner: null, how: 'none', kd: [0, 0], lands: [0, 0], reps: [], lastRep: -999, closeNow: 0,
    alreadyUpAtResolve: 0, resolves: 0, aiBlockStam: 0,
  };
  const bump = (type, part, o) => { const k = `${type}|${part}|${o}`; R.out[k] = (R.out[k] ?? 0) + 1; };
  const maxTicks = Math.round((c.roundCount * (c.roundSeconds + c.betweenRoundSeconds) + 40) / kr.SIM_DT) * 2;
  const bandAt = d => (d < c.smotherDist ? 0 : d < 0.75 ? 1 : d < 0.95 ? 2 : d < c.rangeMax ? 3 : 4);
  for (let i = 0; i < maxTicks && s.round.phase !== 'over'; i++) {
    const hin = bot.step(s);
    const fighting = s.round.phase === 'fighting';
    let snap = null;
    if (fighting && (hin.jab || hin.cross) && s.fighters[0].punch.type === null && !s.fighters[0].down && !s.fighters[1].down
      && i - R.lastRep >= 60 && sepOf(s) <= 1.25 && closingOf(s, 1, c) >= c.jabStopSpeed) {
      snap = { s: structuredClone(s), ai: structuredClone(ai), press: hin.jab ? 'jab' : 'cross' };
      R.lastRep = i;
    }
    const aiBlockPre = s.fighters[1].block;
    const d = AI.aiStep(ai, s, c); ai = d.ai;
    const r = sim.step(s, [hin, d.input], c); s = r.state;
    if (snap) R.reps.push({ press: snap.press, ...replayAB(snap, c) });
    const fa = s.fighters[1];
    if (!aiBlockPre && fa.block) R.rises.push(i);
    const dd = sepOf(s);
    const slipped = r.events.some(e => e.type === 'slip' && e.side === 1 && e.dodged);
    if (s.round.phase === 'fighting') {
      R.ticks++; R.bands[bandAt(dd)]++;
      if (fa.block) { R.blockTicks++; R.run++; } else if (R.run) { R.runs.push(R.run); R.run = 0; }
    }
    for (const e of r.events) {
      if (e.type === 'punchStart' && e.side === 0) R.starts.push({ i, type: e.punch, alreadyUp: aiBlockPre, body: /body/i.test(e.variant) });
      else if (e.type === 'punchStart') R.aiStarts++;
      else if (e.type === 'guardBreak' && e.side === 1) R.guardBreaks++;
      else if (e.type === 'knockdown') R.kd[e.side]++;
      else if (e.type === 'ko' || e.type === 'tko') { R.winner = e.winner; R.how = e.type; }
      else if (e.type === 'decision') { R.winner = e.winner; R.how = 'decision'; }
      if (e.type === 'punchLand') R.lands[e.side]++;
      if ((e.type === 'punchLand' || e.type === 'punchBlock' || e.type === 'perfectBlock' || e.type === 'punchWhiff' || e.type === 'punchStuffed') && (e.side === 0 || (e.type === 'punchStuffed' && e.side === 0))) {
        const body = e.type === 'punchLand' ? e.part === 'body' : e.type === 'punchBlock' ? e.part === 'body' : /body/i.test(e.variant ?? '');
        const t = e.punch;
        if (e.type === 'punchLand') {
          const straight = t === 'jab' || t === 'cross';
          bump(t, body ? 'body' : 'head', straight && dd < c.smotherDist ? 'smothered' : e.grade === 'glancing' ? 'glancing' : 'clean');
          R.resolves++; if (aiBlockPre) R.alreadyUpAtResolve++;
        } else if (e.type === 'punchBlock' || e.type === 'perfectBlock') {
          bump(t, body ? 'body' : 'head', e.type === 'perfectBlock' ? 'perfect' : 'blocked');
          R.resolves++; if (aiBlockPre) R.alreadyUpAtResolve++;
          const st = [...R.starts].reverse().find(x => x.type === t);
          const lastRise = R.rises.length ? R.rises[R.rises.length - 1] : -1;
          if (st) { const kb = R.blockEv[t] ??= { n: 0, chip: 0, stun: 0, up: 0, delays: [] }; kb.n++; kb.chip += e.chip ?? 0; kb.stun += e.stun ?? 0; if (lastRise < st.i) kb.up++; else kb.delays.push(lastRise - st.i); }
        } else if (e.type === 'punchWhiff') bump(t, body ? 'body' : 'head', slipped ? 'slipped' : 'whiff');
        else if (e.type === 'punchStuffed') bump(t, body ? 'body' : 'head', 'stuffed');
      }
    }
  }
  if (R.run) R.runs.push(R.run);
  R.winner ??= null;
  R.dmg = [s.fighters[0].damage, s.fighters[1].damage].map(x => x.head + x.body);
  R.seconds = R.ticks * kr.SIM_DT;
  return R;
}

// ── Run everything, aggregate by cell ────────────────────────────────────────────────────────────────────────
const cells = {};
const t0 = Date.now();
for (const [dn, di] of DIFFS) for (const style of STYLES) for (const h of HUMANS) {
  const key = `${style}|${dn}|${h}`;
  cells[key] = [];
  for (let seed = 1; seed <= SEEDS; seed++) cells[key].push(fight(h, style, di, seed));
}
console.error(`fights done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const sum = (rs, f) => rs.reduce((t, r) => t + f(r), 0);
const OUTS = ['whiff', 'clean', 'glancing', 'smothered', 'blocked', 'perfect', 'slipped', 'stuffed'];
function outCount(rs, type = null, part = null) {
  const o = Object.fromEntries(OUTS.map(k => [k, 0]));
  for (const r of rs) for (const [k, v] of Object.entries(r.out)) { const [t, p, oc] = k.split('|'); if ((type === null || t === type) && (part === null || p === part)) o[oc] += v; }
  return o;
}
const row = o => { const n = OUTS.reduce((t, k) => t + o[k], 0); return `n=${String(n).padStart(4)} ` + OUTS.map(k => `${k} ${pct(o[k], n)}`).join(' | '); };
const cellsOf = (dn, h) => STYLES.map(st => [st, cells[`${st}|${dn}|${h}`]]);

console.log(`\nSetup: ${SEEDS} full fights per cell (${kr.cfg.roundCount} x ${kr.cfg.roundSeconds} s), ratings and styles on, human = red/blue, AI on its roster body. smotherDist ${kr.cfg.smotherDist}, rangeMax ${kr.cfg.rangeMax}.`);
console.log('Human pace (punches a minute):');
for (const h of HUMANS) console.log('  ' + h + ': ' + DIFFS.map(([dn]) => dn + ' ' + STYLES.map(st => { const rs = cells[`${st}|${dn}|${h}`]; return (sum(rs, r => r.starts.length) / (sum(rs, r => r.seconds) / 60)).toFixed(0); }).join('/')).join('   ') + '  (styles in order ' + STYLES.join('/') + ')');

console.log('\n=== A. Outcome of the human\'s punches (% of resolved) ===');
for (const [dn] of DIFFS) for (const h of HUMANS) {
  console.log(`-- ${dn}, ${h}`);
  for (const [st, rs] of cellsOf(dn, h)) console.log(`  ${st.padEnd(9)} ${row(outCount(rs))}`);
}
if (!BRIEF) console.log('-- by punch type and head/body, both humans pooled, medium');
if (!BRIEF && DIFFS.some(([n]) => n === 'medium')) for (const [st] of cellsOf('medium', HUMANS[0])) {
  const rs = HUMANS.flatMap(h => cells[`${st}|medium|${h}`]);
  for (const t of ['jab', 'cross', 'hook', 'uppercut']) for (const p of ['head', 'body']) {
    const o = outCount(rs, t, p); if (OUTS.reduce((a, k) => a + o[k], 0) >= 8) console.log(`  ${st.padEnd(9)} ${t.padEnd(8)} ${p.padEnd(4)} ${row(o)}`);
  }
}
if (!BRIEF && DIFFS.some(([n]) => n === 'hard')) console.log('-- hard, both humans pooled, head+body');
if (!BRIEF && DIFFS.some(([n]) => n === 'hard')) for (const st of STYLES) { const rs = HUMANS.flatMap(h => cells[`${st}|hard|${h}`]); for (const t of ['jab', 'cross', 'hook']) console.log(`  ${st.padEnd(9)} ${t.padEnd(8)}      ${row(outCount(rs, t))}`); }

console.log('\n=== B. The AI\'s guard ===');
for (const [dn] of DIFFS) {
  console.log(`-- ${dn} (both humans pooled): guard up % of fight | % of resolved punches arriving on an already-up guard | of starts with guard not up: % raised within 40 ticks, median ticks after start | blocked punches: median ticks after start the guard rose, % already up | mean/max guard hold s | raises per min | guard breaks per fight`);
  for (const st of STYLES) {
    const rs = HUMANS.flatMap(h => cells[`${st}|${dn}|${h}`]);
    const ticks = sum(rs, r => r.ticks);
    let notUp = 0, raised = 0; const delays = [];
    for (const r of rs) for (const x of r.starts) if (!x.alreadyUp) { notUp++; const rise = r.rises.find(q => q >= x.i && q <= x.i + 40); if (rise !== undefined) { raised++; delays.push(rise - x.i); } }
    const bd = [], up = { n: 0, up: 0 };
    for (const r of rs) for (const kb of Object.values(r.blockEv)) { bd.push(...kb.delays); up.n += kb.n; up.up += kb.up; }
    const runs = rs.flatMap(r => r.runs).map(x => x * kr.SIM_DT);
    console.log(`  ${st.padEnd(9)} ${pct(sum(rs, r => r.blockTicks), ticks)}% | ${pct(sum(rs, r => r.alreadyUpAtResolve), sum(rs, r => r.resolves))}% | ${pct(raised, notUp)}%, median ${median(delays) ?? '-'} t | ${median(bd) ?? '-'} t, ${pct(up.up, up.n)}% | ${f1(mean(runs))}/${f1(Math.max(0, ...runs))} s | ${(runs.length / (ticks * kr.SIM_DT / 60)).toFixed(1)} | ${(sum(rs, r => r.guardBreaks) / rs.length).toFixed(2)}`);
  }
}

// ── C. A blocked punch, controlled (reference fighters, ratings and styles off, regen off) ───────────────────
const kc = await kit({ rated: false });
const cc = { ...kc.cfg, staminaRegen: 0, healthRegen: 0, aiDifficulty: 1 };
function blockExp(p, d, blockerMode) {
  const run = (punch) => {
    let s = kc.fresh(cc, d);
    for (let i = 0; i < 25; i++) s = kc.sim.step(s, [kc.NONE, blockerMode === 'block' ? kc.inp({ block: true }) : kc.NONE], cc).state;
    const pre = { h1: s.fighters[1].health, st0: s.fighters[0].stamina, st1: s.fighters[1].stamina, gh: s.fighters[1].guardHp, x: s.fighters[1].pos.x, z: s.fighters[1].pos.z };
    const ax = s.fighters[0].pos.x, az = s.fighters[0].pos.z; const ux = (pre.x - ax) / Math.hypot(pre.x - ax, pre.z - az), uz = (pre.z - az) / Math.hypot(pre.x - ax, pre.z - az);
    let T = null, ev = null, stop = 0, adv0 = null, adv1 = null; let held = true;
    for (let i = 0; i < 90; i++) {
      const bi = blockerMode === 'block' && held ? kc.inp({ block: true }) : kc.NONE;
      const r = kc.sim.step(s, [kc.inp({ [punch]: i === 0 && punch !== 'none' }), bi], cc); s = r.state;
      for (const e of r.events) if (T === null && (e.type === 'punchBlock' || e.type === 'perfectBlock' || e.type === 'punchLand') && e.side === 0) { T = i; ev = e; held = false; }
      if (T !== null) {
        stop = Math.max(stop, Math.round(s.hitStop / kc.SIM_DT));
        if (adv0 === null && s.fighters[0].punch.type === null && kc.sim.canStartPunch(s.fighters[0], cc)) adv0 = i - T;
        if (adv1 === null && s.fighters[1].punch.type === null && kc.sim.canStartPunch(s.fighters[1], cc)) adv1 = i - T;
      }
    }
    return { T, ev, stop, adv0, adv1, h1: s.fighters[1].health, st0: s.fighters[0].stamina, st1: s.fighters[1].stamina, gh: s.fighters[1].guardHp, push: (s.fighters[1].pos.x - pre.x) * ux + (s.fighters[1].pos.z - pre.z) * uz, pre };
  };
  const a = run(p), base = run('none');
  return { kind: a.ev?.type ?? 'none', chipHealth: a.pre.h1 - a.h1, thrower: (a.pre.st0 - a.st0) - (base.pre.st0 - base.st0), blocker: (a.pre.st1 - a.st1) - (base.pre.st1 - base.st1), push: a.push, guardWear: a.pre.gh - a.gh, stun: a.ev?.stun, stop: a.stop, adv: a.adv0 !== null && a.adv1 !== null ? a.adv0 - a.adv1 : null, adv0: a.adv0, adv1: a.adv1 };
}
if (!BRIEF) console.log('\n=== C. What a punch does on a held guard vs taken clean (reference fighters, regen off; stamina/health in % of bar; push in cm; adv = ticks the thrower is ready later than the blocker, + = blocker punches first) ===');
if (!BRIEF) for (const p of ['jab', 'cross', 'hook', 'uppercut']) {
  const d = p === 'hook' ? 0.72 : p === 'uppercut' ? 0.66 : 0.78;
  for (const m of ['block', 'clean']) {
    const x = blockExp(p, d, m);
    console.log(`  ${p.padEnd(8)} ${m.padEnd(5)} -> ${x.kind.padEnd(12)} health -${(x.chipHealth * 100).toFixed(2)} | stamina blocker -${(x.blocker * -100 * -1).toFixed(2)} thrower -${(x.thrower * 100).toFixed(2)} | push ${(x.push * 100).toFixed(0)} cm | guard wear ${(x.guardWear * 100).toFixed(1)}% | block stun ${x.stun !== undefined ? x.stun.toFixed(2) + ' s' : '-'} | hit-stop ${x.stop} t | ready after impact: thrower ${x.adv0} t, blocker ${x.adv1} t (adv ${x.adv})`);
  }
}
if (!BRIEF) console.log('  In the real fights (medium, pooled): blocked punches, mean health chip % / mean block stun s');
if (!BRIEF) for (const st of STYLES) {
  const rs = HUMANS.flatMap(h => cells[`${st}|medium|${h}`] ?? []);
  console.log('   ' + st.padEnd(9) + ['jab', 'cross', 'hook', 'uppercut'].map(t => { let n = 0, ch = 0, sn = 0; for (const r of rs) { const kb = r.blockEv[t]; if (kb) { n += kb.n; ch += kb.chip; sn += kb.stun; } } return `${t} n=${n} chip ${n ? (100 * ch / n).toFixed(2) : '-'} stun ${n ? (sn / n).toFixed(2) : '-'}`; }).join(' | '));
}

console.log('\n=== D. Separation over the fight (% of fighting time): inside smother <0.61 | close 0.61-0.75 | mid 0.75-0.95 | long 0.95-1.2 | out of range >1.2 ===');
for (const [dn] of DIFFS) for (const h of HUMANS) {
  console.log(`-- ${dn}, ${h}`);
  for (const [st, rs] of cellsOf(dn, h)) { const tt = sum(rs, r => r.ticks); console.log(`  ${st.padEnd(9)} ` + [0, 1, 2, 3, 4].map(b => pct(sum(rs, r => r.bands[b]), tt)).join(' | ')); }
}

console.log('\n=== E. Stopping power: a standing human jab / cross thrown at an AI that is ADVANCING (closing >= jabStopSpeed) at the press; same moment replayed with no punch ===');
console.log('   outcome shares | for outcome=clean: median push-back vs no-punch (cm), median separation 30 t after landing vs no-punch (cm), median ticks until closing again (n not closing in 100 t)');
for (const [dn] of DIFFS) {
  console.log(`-- ${dn}, both humans pooled`);
  for (const st of STYLES) for (const press of ['jab', 'cross']) {
    const reps = HUMANS.flatMap(h => cells[`${st}|${dn}|${h}`]).flatMap(r => r.reps).filter(x => x.press === press);
    if (!reps.length) { console.log(`  ${st.padEnd(9)} ${press}: no qualifying presses`); continue; }
    const share = o => pct(reps.filter(x => x.outcome === o).length, reps.length);
    const det = o => { const q = reps.filter(x => x.outcome === o && x.push !== undefined); return q.length ? `${o} n=${q.length}: push ${(median(q.map(x => x.push)) * 100).toFixed(0)} cm, sep+30 ${(median(q.map(x => x.sep30)) * 100).toFixed(0)} cm, reclose ${median(q.filter(x => x.reclose !== null).map(x => x.reclose)) ?? '-'} t (${q.filter(x => x.reclose === null).length} never)` : `${o} n=0`; };
    console.log(`  ${st.padEnd(9)} ${press.padEnd(5)} n=${String(reps.length).padStart(3)} clean ${share('clean')} blocked ${share('blocked')} perfect ${share('perfect')} whiff ${share('whiff')} glancing ${share('glancing')} none ${share('none')} || ${det('clean')} || ${det('blocked')}`);
  }
}

console.log('\n=== F. Outcome (6 fights per row): human wins / AI wins / draws | KO-TKO | knockdowns human-took / AI-took (per fight) | damage dealt BY human / BY AI (% of a bar per fight) | lands human / AI per fight | punches started human / AI per fight ===');
for (const [dn] of DIFFS) for (const h of HUMANS) {
  console.log(`-- ${dn}, ${h}`);
  for (const [st, rs] of cellsOf(dn, h)) {
    const n = rs.length;
    console.log(`  ${st.padEnd(9)} ${rs.filter(r => r.winner === 0).length}/${rs.filter(r => r.winner === 1).length}/${rs.filter(r => r.winner === null).length} | ${rs.filter(r => r.how === 'ko' || r.how === 'tko').length} | ${(sum(rs, r => r.kd[0]) / n).toFixed(1)}/${(sum(rs, r => r.kd[1]) / n).toFixed(1)} | ${(100 * sum(rs, r => r.dmg[1]) / n).toFixed(0)}/${(100 * sum(rs, r => r.dmg[0]) / n).toFixed(0)} | ${(sum(rs, r => r.lands[0]) / n).toFixed(0)}/${(sum(rs, r => r.lands[1]) / n).toFixed(0)} | ${(sum(rs, r => r.starts.length) / n).toFixed(0)}/${(sum(rs, r => r.aiStarts) / n).toFixed(0)}`);
  }
}
