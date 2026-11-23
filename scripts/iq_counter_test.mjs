/**
 * iq_counter_test.mjs — every evade loads a counter on both sides (cfg.iqLoadedCounter, docs/HIGH_IQ.md core loop).
 *   npm run test:quick iq_counter
 * Side 0 evades a scripted punch from side 1 at 1.0 m, then counters 6 ticks after the miss. With the key on: a bare hook after a
 * right lean is the rear hand and a bare uppercut after a left lean the lead hand, each as fast as the held-stick version; a pushed
 * stick still picks the hand; a rising uppercut and a body hook out of a duck are loaded; with no evade nothing changes; the lead
 * uppercut reaches as far as the rear one. With the key off a seeded fight ends in the state it does with the key absent.
 */
import { check, done } from './check.js';
import { makeEnv } from './bots/fight.mjs';
import { BOTS } from './bots/index.mjs';
import { load } from './load.mjs';

const env = await makeEnv();
const { core, sim, AI, cfg } = env;
const [outcome] = await load('/src/sim/outcome.ts');
const NONE = { move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false, level: false };
const inp = (o = {}) => ({ ...NONE, move: { x: 0, y: 0 }, ...o });
const R = { x: 1, y: 0 }, L = { x: -1, y: 0 };

/** Evade (`ev`), then the counter `type` 6 ticks after the foe's punch missed. Returns { dodged, hand, variant, hit (ticks press to hit), imp }. */
function scenario(on, ev, counter, dist = 1.0) {
  cfg.iqLoadedCounter = on;
  let s = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 7);
  s.fighters[0].pos = { x: -dist / 2, z: 0 }; s.fighters[1].pos = { x: dist / 2, z: 0 };
  for (let i = 0; i < 40; i++) s = sim.step(s, [inp(), inp()], cfg).state;
  const T0 = 5, out = {};
  let pressAt = -1, whiffAt = -1;
  for (let t = 0; t < 140 && !(out.hit !== undefined && (out.imp !== undefined || out.land === false)); t++) {
    const a = inp(), d = inp();
    if (ev && t === T0) d[ev.foe] = true;
    const t0 = T0 + (ev ? ev.delay : 0);
    if (ev) { a.move = t >= t0 && t < t0 + ev.len ? ev.stick : { x: 0, y: 0 }; a.level = !!ev.level && t >= t0; }
    if (!ev && t === T0) pressAt = t;
    if (whiffAt >= 0 && t >= whiffAt + 6) {
      if (t === whiffAt + 6) { pressAt = t; }
      if (counter.stick && t < whiffAt + 12) a.move = counter.stick;
      a.level = !!counter.level;
    }
    if (pressAt === t) { a[counter.type] = true; if (counter.stick) a.move = counter.stick; }
    const r = sim.step(s, [a, d], cfg); s = r.state;
    for (const e of r.events) {
      if (e.type === 'punchWhiff' && e.side === 1 && whiffAt < 0) { whiffAt = t; out.dodged = !!e.dodged; }
      if (e.side === 0 && pressAt >= 0 && t >= pressAt) {
        if (e.type === 'punchStart') { out.hand = e.hand; out.variant = e.variant; }
        if (e.type === 'punchLand') { out.hit = t - pressAt; out.land = true; out.imp = Math.hypot(e.impulse.x, e.impulse.y, e.impulse.z); }
        if (e.type === 'punchWhiff' && out.hit === undefined) { out.hit = t - pressAt; out.land = false; }
      }
    }
  }
  return out;
}

const slip = (stick, hold) => ({ foe: 'jab', delay: 2, len: hold ? 40 : 2, stick });
const tapR = slip(R, false), tapL = slip(L, false);
const duck = { foe: 'hook', delay: 4, len: 0, stick: R, level: true };
const dsc = o => `${o.hand} ${o.variant} ${o.hit}t`;

// ---- 1. the loaded hand follows the evade (key on) ----
{
  const hookR = scenario(true, tapR, { type: 'hook' }), hookRheld = scenario(true, slip(R, true), { type: 'hook', stick: R });
  const upL = scenario(true, tapL, { type: 'uppercut' }), upLheld = scenario(true, slip(L, true), { type: 'uppercut', stick: L });
  check('right lean, bare hook: both counters evaded and landed', hookR.dodged && hookR.land && upL.dodged && upL.land, JSON.stringify({ hookR, upL }));
  check('right lean, bare hook is the REAR hook', hookR.hand === 'rear', dsc(hookR));
  check('…as fast as the held-stick version', hookR.hit === hookRheld.hit && hookRheld.hand === 'rear', `${dsc(hookR)} vs ${dsc(hookRheld)}`);
  check('left lean, bare uppercut is the LEAD uppercut', upL.hand === 'lead', dsc(upL));
  check('…as fast as the held-stick version', upL.hit === upLheld.hit && upLheld.hand === 'lead', `${dsc(upL)} vs ${dsc(upLheld)}`);
  const upLoff = scenario(false, tapL, { type: 'uppercut' });
  check('key off: the same bare left-lean uppercut is the unloaded rear hand, slower', upLoff.hand === 'rear' && upLoff.hit > upL.hit, `${dsc(upLoff)} vs ${dsc(upL)}`);
  check('the loaded counter hits harder than the unloaded one', upL.imp > upLoff.imp * 1.1, `${upL.imp.toFixed(0)} vs ${upLoff.imp.toFixed(0)}`);
}

// ---- 2. a pushed stick still picks the hand ----
{
  const a = scenario(true, tapR, { type: 'hook', stick: L }), b = scenario(true, tapL, { type: 'hook', stick: R });
  check('right lean, then a hook with the stick pushed LEFT: lead hand (the push wins)', a.hand === 'lead', dsc(a));
  check('left lean, then a hook with the stick pushed RIGHT: rear hand (the push wins)', b.hand === 'rear', dsc(b));
}

// ---- 3. a duck loads the rising punches on both hands ----
{
  const upOff = scenario(false, duck, { type: 'uppercut' }), upOn = scenario(true, duck, { type: 'uppercut' });
  const bhOff = scenario(false, duck, { type: 'hook', level: true }), bhOn = scenario(true, duck, { type: 'hook', level: true });
  check('duck: the foe hook was ducked and the rising uppercut landed', upOn.dodged && upOn.land && upOn.variant === 'risingUppercut', JSON.stringify(upOn));
  check('duck: the rising uppercut is faster than a cold one', upOn.hit < upOff.hit, `${upOn.hit} vs ${upOff.hit} ticks`);
  check('duck: …and harder', upOn.imp > upOff.imp * 1.1, `${upOn.imp.toFixed(0)} vs ${upOff.imp.toFixed(0)}`);
  check('duck: the body hook is faster than a cold one and harder', bhOn.variant === 'bodyHook' && bhOn.hit < bhOff.hit && bhOn.imp > bhOff.imp * 1.1, `${bhOn.hit}t ${bhOn.imp.toFixed(0)} vs ${bhOff.hit}t ${bhOff.imp.toFixed(0)}`);
}

// ---- 4. no evade: nothing changes ----
{
  const hook = scenario(true, null, { type: 'hook' }), up = scenario(true, null, { type: 'uppercut' });
  const hookOff = scenario(false, null, { type: 'hook' }), upOff = scenario(false, null, { type: 'uppercut' });
  check('no evade: a bare hook is the lead hand, a bare uppercut the rear', hook.hand === 'lead' && up.hand === 'rear', `${dsc(hook)} / ${dsc(up)}`);
  check('no evade: the key makes no difference to speed', hook.hit === hookOff.hit && up.hit === upOff.hit, `${dsc(hook)} / ${dsc(up)} vs ${dsc(hookOff)} / ${dsc(upOff)}`);
}

// ---- 5. the lead uppercut reaches as far as the rear one ----
{
  const s0 = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 5);
  const f = s0.fighters[0], d = s0.fighters[1];
  cfg.iqLoadedCounter = false;
  const leadOff = outcome.punchBand(f, 'uppercut', 'lead', 'uppercut', cfg, d).far, rearOff = outcome.punchBand(f, 'uppercut', 'rear', 'uppercut', cfg, d).far;
  cfg.iqLoadedCounter = true;
  const leadOn = outcome.punchBand(f, 'uppercut', 'lead', 'uppercut', cfg, d).far, rearOn = outcome.punchBand(f, 'uppercut', 'rear', 'uppercut', cfg, d).far;
  check(`lead uppercut far end rises to iqLeadUpperReach (${leadOff.toFixed(2)} -> ${leadOn.toFixed(2)} m)`, leadOn > leadOff + 0.05 && leadOn >= cfg.iqLeadUpperReach * f.body.heightM / cfg.mocapBandRefHeight - 1e-9);
  check(`the rear uppercut is untouched (${rearOff.toFixed(2)} m)`, rearOn === rearOff);
  const far = scenario(true, tapL, { type: 'uppercut' }, 1.28);
  check('left lean at 1.28 m: the loaded lead uppercut lands', far.land === true && far.hand === 'lead', JSON.stringify(far));
}

// ---- 6. key off = key absent, bit for bit ----
{
  const play = absent => {
    const c = core.createConfig();
    c.humanBody = true; c.mocapGeo = true; c.mocapOutcome = true; c.humanIqLoadedCounter = false;
    core.applyHumanMode(c);
    if (absent) delete c.iqLoadedCounter; else c.iqLoadedCounter = false;
    const specs = [{ ...core.ROSTER[0], style: 'pressure' }, { ...core.ROSTER[0], style: 'counter' }];
    let s = sim.createState(specs, c, 21);
    const bot = BOTS.masher_mix.make(0, 21, { game: c, jabReach: env.jabReach, delay: 12 });
    let foe = AI.createAi(1, 21, c, AI.styleFor(specs[1], c));
    for (let t = 0; t < 1800; t++) {
      const mine = bot(s, t), d = AI.aiStep(foe, s, c); foe = d.ai;
      s = sim.step(s, [mine, d.input], c).state;
    }
    return JSON.stringify(s);
  };
  const a = play(false), b = play(true);
  check('key off: a 1800-tick seeded fight ends in the same state as with the key absent', a === b, `${a.length} vs ${b.length} chars`);
}

// ---- 7. level + punch in the same press is the body punch (cfg.iqLevelAtPress) ----
{
  const press = (on, type) => {
    cfg.iqLevelAtPress = on;
    let s = sim.createState([core.ROSTER[0], core.ROSTER[0]], cfg, 7);
    s.fighters[0].pos = { x: -0.45, z: 0 }; s.fighters[1].pos = { x: 0.45, z: 0 };
    for (let i = 0; i < 40; i++) s = sim.step(s, [inp(), inp()], cfg).state;
    let variant = null;
    for (let t = 0; t < 30 && variant === null; t++) {
      const r = sim.step(s, [inp({ level: true, [type]: t === 0 }), inp()], cfg); s = r.state;
      for (const e of r.events) if (e.type === 'punchStart' && e.side === 0) variant = e.variant;
    }
    return variant;
  };
  const on = ['jab', 'cross', 'hook', 'uppercut'].map(t => press(true, t)), off = ['jab', 'cross', 'hook', 'uppercut'].map(t => press(false, t));
  check('level + punch on the same tick: body jab, body cross, body hook, rising uppercut', on.join() === 'bodyJab,bodyCross,bodyHook,risingUppercut', on.join());
  check('key off: the same presses are the head versions', !off.some(v => /body|rising/i.test(v)), off.join());
  cfg.iqLevelAtPress = true;
}

done();
