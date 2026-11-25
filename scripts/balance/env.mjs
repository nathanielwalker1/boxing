/**
 * env.mjs — loads the game rules (scripts/output/balance/game.mjs, bundled from src/ by run.mjs) under the real
 * human-mode config, and fights two participants with detailed bookkeeping. From the 2026-11-24 audit (~/boxing-audit).
 *
 * Participant descriptor (plain JSON so it can cross a worker boundary):
 *   { kind: 'ai',  style, diff: 0|1|2, mod?: 'nojab'|'jab2cross'|'headonly', spec?: rosterId, ratings?: {power..} }
 *   { kind: 'bot', bot: <name in bots.mjs or the snapshot's BOTS>, style?: guard/style id, spec?, ratings? }
 */
import { readFileSync } from 'node:fs';
import { core, sim, AI, mocap, outcome } from '../output/balance/game.mjs';
import { BOTS as SNAP_BOTS } from '../bots/index.mjs';
import { MY_BOTS } from './bots.mjs';

const SNAP = new URL('../../', import.meta.url);   // the repo root

export function makeEnv() {
  const rd = p => readFileSync(new URL(p, SNAP));
  const index = JSON.parse(rd('public/fighter/clips/index.json').toString('utf8'));
  const roles = JSON.parse(rd('public/fighter/clips/roles.json').toString('utf8'));
  const bin = rd('public/fighter/clips/clips.bin');
  const glb = rd('public/fighter/boxer.glb');
  mocap.setMocapLib(mocap.buildMocapLib(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), roles, new Uint8Array(glb)));
  const cfg = core.createConfig();
  cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
  core.applyHumanMode(cfg);
  const a = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 1);
  const reach = {};
  for (const [p, hand] of [['jab', 'lead'], ['cross', 'rear'], ['hook', 'rear'], ['uppercut', 'rear']]) {
    const b = outcome.punchBand(a.fighters[0], p, hand, p, cfg, a.fighters[1]);
    reach[p] = { far: b.far, step: b.step, near: b.near };
  }
  const jabReach = reach.jab.far - 0.5 * reach.jab.step;
  return { core, sim, AI, outcome, cfg, jabReach, reach };
}

const PUNCHES = ['jab', 'cross', 'hook', 'uppercut'];
const blankPunch = () => ({ thrown: 0, landHead: 0, landBody: 0, blocked: 0, whiff: 0, dodged: 0, powHead: 0, powBody: 0, dmgHead: 0, dmgBody: 0 });
const blank = () => ({
  p: Object.fromEntries(PUNCHES.map(k => [k, blankPunch()])),
  counters: 0, grades: { glancing: 0, clean: 0, flush: 0 }, perfectBlocks: 0, slipsDodged: 0, feints: 0,
  rockedGiven: 0, bodyHurtGiven: 0, guardBreakGiven: 0, kdGiven: 0, kdCauses: {}, kdFalls: {}, kdKinds: {},
  rockedConverted: 0,                       // rocked -> knockdown before the hurt cleared
  vsHurt: { land: 0, block: 0, miss: 0 },   // my punches that resolved while the target was hurt
  vsOk: { land: 0, block: 0, miss: 0 },
  stamSum: 0, stamMin: 1, ticks: 0, stamEnd: 0, healthEnd: 0, distSum: 0, away: 0, blockTicks: 0,
  stamAtRoundEnd: [],
  dodgeKinds: {}, counterAfter: {}, counterDmg: 0,   // which evade dodged (slip / roll / duck / lean / pull = made to miss by range), which one each counter followed, health the counters took
});

function specFor(env, p) {
  const { core } = env;
  const base = p.spec ? core.specById(p.spec) : core.ROSTER[0];
  const spec = { ...base };
  if (p.style) spec.style = p.style;
  if (p.ratings) Object.assign(spec, p.ratings);   // ratings are flat fields on the spec: power, speed, chin, stamina, defense
  return spec;
}

function driver(env, cfg, p, side, seed, spec) {
  const { AI } = env;
  if (p.kind === 'bot') {
    const bcfg = { game: cfg, jabReach: env.jabReach, reach: env.reach, delay: 12 };
    const make = MY_BOTS[p.bot] ?? SNAP_BOTS[p.bot]?.make;
    if (!make) throw new Error('unknown bot ' + p.bot);
    const f = make(side, seed, bcfg);
    return (st, t) => {
      const o = f(st, t), m = Math.hypot(o.move.x, o.move.y);
      if (m > 1) o.move = { x: o.move.x / m, y: o.move.y / m };
      return o;
    };
  }
  // the AI reads its timed-block skill from cfg.aiDifficulty (ai/index.ts), so each AI gets its own copy of the config
  const acfg = { ...cfg, aiDifficulty: p.diff ?? 1 };
  let ai = AI.createAi(side, seed, acfg, AI.styleFor(spec, acfg, p.diff ?? 1));
  return (st) => {
    const d = AI.aiStep(ai, st, acfg); ai = d.ai;
    let i = d.input;
    if (p.mod === 'nojab' && i.jab) i = { ...i, jab: false };
    else if (p.mod === 'jab2cross' && i.jab) i = { ...i, jab: false, cross: true };
    else if (p.mod === 'headonly' && i.level) i = { ...i, level: false };
    return i;
  };
}

/** One full fight. Returns { winner: 0|1|null, method: 'ko'|'tko'|'decision'|'none', ticks, rounds, stats: [s0, s1] }. */
export function fight(env, p0, p1, seed, cfgOver = null) {
  const { sim } = env;
  const cfg = cfgOver ? { ...env.cfg, ...cfgOver } : env.cfg;
  const specs = [specFor(env, p0), specFor(env, p1)];
  let s = sim.createState(specs, cfg, seed);
  const drv = [driver(env, cfg, p0, 0, seed, specs[0]), driver(env, cfg, p1, 1, seed, specs[1])];
  const stats = [blank(), blank()];
  const rockedOpen = [false, false], lastDodge = [null, null];
  const maxTicks = 60 * (cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds + 40)) + 600;
  let winner = null, method = 'none', t = 0, firstRocked = null;   // firstRocked: the side that was rocked first (the comeback rate)
  for (; t < maxTicks; t++) {
    const pre = s;
    const preHurt = [pre.fighters[0].hurt > 0, pre.fighters[1].hurt > 0];
    const preHealth = [pre.fighters[0].health, pre.fighters[1].health];
    const r = sim.step(s, [drv[0](s, t), drv[1](s, t)], cfg); s = r.state;
    if (s.round.phase === 'fighting') {
      const f0 = s.fighters[0], f1 = s.fighters[1];
      const dx = f1.pos.x - f0.pos.x, dz = f1.pos.z - f0.pos.z, d = Math.hypot(dx, dz) || 1e-6;
      for (const side of [0, 1]) {
        const f = s.fighters[side], q = stats[side], k = side === 0 ? 1 : -1;
        q.ticks++; q.distSum += d; q.stamSum += f.stamina; if (f.stamina < q.stamMin) q.stamMin = f.stamina;
        if (f.block) q.blockTicks++;
        if (-(f.vel.x * dx + f.vel.z * dz) * k / d > 0.3) q.away++;
        if (rockedOpen[side] && f.hurt <= 0 && !f.down) rockedOpen[side] = false;
      }
    }
    for (const e of r.events) {
      switch (e.type) {
        case 'punchStart': stats[e.side].p[e.punch].thrown++; break;
        case 'punchLand': {
          const q = stats[e.side], pp = q.p[e.punch], body = e.part !== 'head';
          const dmg = Math.max(0, preHealth[e.target] - s.fighters[e.target].health);
          if (body) { pp.landBody++; pp.powBody += e.power; pp.dmgBody += dmg; } else { pp.landHead++; pp.powHead += e.power; pp.dmgHead += dmg; }
          if (e.counter) { q.counters++; const k = lastDodge[e.side] || 'none'; q.counterAfter[k] = (q.counterAfter[k] || 0) + 1; q.counterDmg += dmg; }
          if (q.grades[e.grade] !== undefined) q.grades[e.grade]++;
          (preHurt[e.target] ? q.vsHurt : q.vsOk).land++;
          break;
        }
        case 'punchBlock': stats[e.side].p[e.punch].blocked++; (preHurt[e.target] ? stats[e.side].vsHurt : stats[e.side].vsOk).block++; break;
        case 'perfectBlock': stats[e.side].p[e.punch].blocked++; stats[e.target].perfectBlocks++; (preHurt[e.target] ? stats[e.side].vsHurt : stats[e.side].vsOk).block++; break;
        case 'punchWhiff': {
          const pp = stats[e.side].p[e.punch]; if (e.dodged) pp.dodged++; else pp.whiff++;
          (preHurt[1 - e.side] ? stats[e.side].vsHurt : stats[e.side].vsOk).miss++;
          break;
        }
        case 'slip': if (e.dodged) { const q = stats[e.side]; q.slipsDodged++; const k = e.kind === 'pull' && e.chain === 0 ? 'range' : e.kind || 'slip' + (e.dir ?? ''); /* 'range' = made to miss by range (no evade pressed) */ q.dodgeKinds[k] = (q.dodgeKinds[k] || 0) + 1; lastDodge[e.side] = k; } break;
        case 'feint': stats[e.side].feints++; break;
        case 'rocked': stats[e.by].rockedGiven++; rockedOpen[e.side] = true; if (firstRocked === null) firstRocked = e.side; break;
        case 'bodyHurt': stats[e.by].bodyHurtGiven++; break;
        case 'guardBreak': stats[e.by].guardBreakGiven++; break;
        case 'knockdown': {
          const q = stats[1 - e.side]; q.kdGiven++;
          q.kdCauses[e.cause] = (q.kdCauses[e.cause] || 0) + 1;
          if (e.fall) q.kdFalls[e.fall] = (q.kdFalls[e.fall] || 0) + 1;
          if (e.kind) q.kdKinds[e.kind] = (q.kdKinds[e.kind] || 0) + 1;
          if (rockedOpen[e.side]) { q.rockedConverted++; rockedOpen[e.side] = false; }
          break;
        }
        case 'roundEnd': stats[0].stamAtRoundEnd.push(s.fighters[0].stamina); stats[1].stamAtRoundEnd.push(s.fighters[1].stamina); break;
        case 'ko': winner = e.winner; method = 'ko'; break;
        case 'tko': winner = e.winner; method = 'tko'; break;
        case 'decision': winner = e.winner; method = 'decision'; break;
      }
    }
    if (s.round.phase === 'over') break;
  }
  for (const side of [0, 1]) { stats[side].stamEnd = s.fighters[side].stamina; stats[side].healthEnd = s.fighters[side].health; }
  return { winner, method, firstRocked, ticks: t, rounds: s.round.index + 1, stats };
}
