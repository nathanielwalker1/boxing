/**
 * bots/fight.mjs — one full seeded fight (the game's default rounds and rest, ending by KO / TKO / decision) between two
 * participants under the real human-mode config. Shared by bot_ladder.mjs and bots_test.mjs.
 * A participant is { id, kind: 'bot' | 'ai', make?, style }. Both fighters get the SAME body (ROSTER[0]); only the style
 * (guard shape, AI style) differs, so strategy is isolated from build.
 */
import { load } from '../load.mjs';
import { loadMocapLib } from '../lib/mocap_load.mjs';
import { BOTS } from './index.mjs';

export async function makeEnv() {
  const [core, sim, AI, mocap, outcome] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/ai/index.ts', '/src/core/mocap.ts', '/src/sim/outcome.ts');
  loadMocapLib(mocap);
  const cfg = core.createConfig();
  cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
  core.applyHumanMode(cfg);
  // jab reach, centre to centre, for a standing man (the arm plus half the step the body adds): what "the edge of my jab" means to a bot
  const a = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 1);
  const band = outcome.punchBand(a.fighters[0], 'jab', 'lead', 'jab', cfg, a.fighters[1]);
  const jabReach = band.far - 0.5 * band.step;
  return { core, sim, AI, cfg, jabReach };
}

export function participants() {
  const list = Object.entries(BOTS).map(([id, b]) => ({ id, kind: 'bot', make: b.make, style: b.style, group: b.group }));
  return list;
}

export function aiParticipants(AI) {
  return AI.STYLE_IDS.map(st => ({ id: 'ai_' + st, kind: 'ai', style: st, group: 'ai' }));
}

const blank = () => ({ thrown: 0, landed: 0, ticks: 0, distSum: 0, away: 0 });

/** Fight p0 (side 0) against p1 (side 1). Returns { winner: 0 | 1 | null, method, ticks, stats: [two blank()s] }. */
export function fight(env, p0, p1, seed) {
  const { core, sim, AI, cfg } = env;
  const specs = [p0, p1].map(p => ({ ...core.ROSTER[0], style: p.style }));
  let s = sim.createState(specs, cfg, seed);
  const bcfg = { game: cfg, jabReach: env.jabReach, delay: 12 };
  const drivers = [p0, p1].map((p, side) => {
    if (p.kind === 'bot') { const f = p.make(side, seed, bcfg); return { step: (st, t) => f(st, t) }; }
    let ai = AI.createAi(side, seed, cfg, AI.styleFor(specs[side], cfg));
    return { step: (st) => { const d = AI.aiStep(ai, st, cfg); ai = d.ai; return d.input; } };
  });
  const stats = [blank(), blank()];
  const maxTicks = 60 * (cfg.roundCount * (cfg.roundSeconds + cfg.betweenRoundSeconds + 40)) + 600;
  let winner = null, method = 'none', t = 0;
  for (; t < maxTicks; t++) {
    const ins = [drivers[0].step(s, t), drivers[1].step(s, t)];
    const r = sim.step(s, ins, cfg); s = r.state;
    if (s.round.phase === 'fighting') {
      const f0 = s.fighters[0], f1 = s.fighters[1];
      const dx = f1.pos.x - f0.pos.x, dz = f1.pos.z - f0.pos.z, d = Math.hypot(dx, dz) || 1e-6;
      for (const side of [0, 1]) {
        const f = s.fighters[side], q = stats[side], k = side === 0 ? 1 : -1;
        q.ticks++; q.distSum += d;
        if (-(f.vel.x * dx + f.vel.z * dz) * k / d > 0.3) q.away++;   // own velocity component away from the other man, > 0.3 m/s
      }
    }
    for (const e of r.events) {
      if (e.type === 'punchStart') stats[e.side].thrown++;
      else if (e.type === 'punchLand') stats[e.side].landed++;
      else if (e.type === 'ko' || e.type === 'tko') { winner = e.winner; method = 'ko'; }
      else if (e.type === 'decision') { winner = e.winner; method = 'decision'; }
    }
    if (s.round.phase === 'over') break;
  }
  return { winner, method, ticks: t, stats };
}
