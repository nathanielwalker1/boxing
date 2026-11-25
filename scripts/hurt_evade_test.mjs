/**
 * hurt_evade_test.mjs — a ROCKED man can slip, but worse (Nate 2026-11-24; audit P1 had taken his head movement away).
 *   1. rocked, a side tap still starts the slip
 *   2. it protects him for hurtEvadeWindow of the normal window (0.3 s to 0.15 s)
 *   3. the next evade waits hurtEvadeCooldown times longer (0.3 s to 0.6 s)
 *   4. winded from a body shot: the normal slip
 * Human mode, Node, no browser. `node scripts/hurt_evade_test.mjs`
 */
import { kit } from './bots/kit.mjs';
import { check, done } from './check.js';

const k = await kit({ rated: true });
const cfg = k.core.createConfig();
cfg.humanBody = true; cfg.mocapGeo = true; cfg.mocapOutcome = true;
k.core.applyHumanMode(cfg);

/** Side 0 taps sideways at tick 0 and again every `again` ticks; returns the ticks its slip was live and the ticks its slips started on. */
function tap(hurtKind, again = 0) {
  const s = k.fresh(cfg, 1.6, 30);
  let active = 0;
  const { evs } = k.run(s, 120, (i, st) => {
    const f = st.fighters[0];
    if (hurtKind) { f.hurt = 3; f.hurtKind = hurtKind; }   // held hurt for the whole run
    const on = i < 2 || (again > 0 && i >= again && (i - again) % 6 < 2);
    return [k.inp({ move: on ? { x: 1, y: 0 } : { x: 0, y: 0 } }), k.NONE];
  }, cfg, st => { if (st.fighters[0].slip.active) active++; });
  return { active, starts: k.of(evs, 'slip').filter(e => e.side === 0 && !e.dodged).map(e => e.tick) };
}
const T = sec => Math.round(sec / k.SIM_DT);
const ok = tap(null), rk = tap('head'), wd = tap('body');
check('healthy: a side tap slips', ok.starts.length === 1, `${ok.starts.length}`);
check('rocked: a side tap still slips', rk.starts.length === 1, `${rk.starts.length}`);
check('rocked: the slip protects for about hurtEvadeWindow of the normal window', Math.abs(rk.active - ok.active * cfg.hurtEvadeWindow) <= 2 && rk.active < ok.active, `rocked ${rk.active} ticks, healthy ${ok.active}`);
check('winded (body): the normal slip', wd.active === ok.active, `winded ${wd.active}, healthy ${ok.active}`);
// tapping again and again from tick 12: when does the second slip start?
const ok2 = tap(null, 12), rk2 = tap('head', 12);
const wantOk = T(cfg.evadeWindow + cfg.evadeCooldown), wantRk = T(cfg.evadeWindow * cfg.hurtEvadeWindow + cfg.evadeCooldown * cfg.hurtEvadeCooldown);
check('healthy: the second slip waits window + cooldown', ok2.starts.length >= 2 && Math.abs(ok2.starts[1] - wantOk) <= 6, `second at tick ${ok2.starts[1]}, clock ${wantOk}`);
check('rocked: the second slip waits its short window + the long cooldown', rk2.starts.length >= 2 && Math.abs(rk2.starts[1] - wantRk) <= 6 && rk2.starts[1] > ok2.starts[1], `second at tick ${rk2.starts[1]}, clock ${wantRk}; healthy ${ok2.starts[1]}`);
done();
