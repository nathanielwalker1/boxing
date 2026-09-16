/**
 * footwork_test.mjs — boxing footwork on the rig's foot planters (rig/feet.ts
 * has no three.js, so it runs in Node). The foot nearest the direction of
 * travel steps first, the other drags up shorter and lower; sideways steps are
 * shuffles; the feet never cross.
 */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [core, feet] = await load('/src/core/index.ts', '/src/rig/feet.ts');
const { createConfig, handLateralSign } = core;
const { FootPlanter, stepRoles } = feet;
const cfg = createConfig();
const ORTHO = handLateralSign('lead', 'orthodox');   // −1: the lead foot is the left foot
const SOUTH = handLateralSign('lead', 'southpaw');

// ── 1. Roles ────────────────────────────────────────────────────────────────
check('forward: the lead foot leads', stepRoles(1, 0, ORTHO).leader === 0 && !stepRoles(1, 0, ORTHO).lateral);
check('back: the rear foot leads', stepRoles(-1, 0, ORTHO).leader === 1);
check('orthodox, moving left (toward the lead side): the lead foot leads', stepRoles(0, -1, ORTHO).leader === 0 && stepRoles(0, -1, ORTHO).lateral);
check('orthodox, moving right (toward the rear side): the rear foot leads', stepRoles(0, 1, ORTHO).leader === 1);
check('southpaw mirrors: moving right → lead foot, left → rear foot', stepRoles(0, 1, SOUTH).leader === 0 && stepRoles(0, -1, SOUTH).leader === 1);
check('a diagonal that is mostly forward is a forward step', stepRoles(1, 0.5, ORTHO).leader === 0 && !stepRoles(1, 0.5, ORTHO).lateral);
check('standing still: nothing to lead', stepRoles(0, 0, ORTHO).leader === 0);

// ── 2. Planters: order, drag, shuffle ────────────────────────────────────────
// Two feet in a stance, the stance sliding along +x (forward) at a walking
// pace; the leader is updated first each frame, as the rig does it.
function simulate({ leader, lateral, speed = 2.0, dt = 1 / 60, seconds = 1.2 }) {
  const lead = new FootPlanter(), rear = new FootPlanter();
  const planters = [lead, rear];
  const stance = [{ x: 0.2, z: -0.17 }, { x: -0.24, z: 0.17 }];
  const dir = lateral ? { x: 0, z: 1 } : { x: 1, z: 0 };
  const events = [];   // step starts in order
  const stepping = [false, false];
  let pos = 0;
  const maxLift = [0, 0];
  const durations = [null, null];
  const startT = [0, 0];
  for (let t = 0; t < seconds; t += dt) {
    pos += speed * dt;
    for (const i of leader === 0 ? [0, 1] : [1, 0]) {
      const rest = { x: stance[i].x + dir.x * pos, y: 0, z: stance[i].z + dir.z * pos, rotY: 0 };
      const desired = { ...rest, x: rest.x + dir.x * speed * cfg.rigStepLead, z: rest.z + dir.z * speed * cfg.rigStepLead };
      const out = planters[i].update(desired, rest, { role: i === leader ? 'lead' : 'trail', lateral }, dt, cfg, planters[1 - i]);
      if (planters[i].stepping && !stepping[i]) { events.push(i); startT[i] = t; }
      if (!planters[i].stepping && stepping[i] && durations[i] === null) durations[i] = t - startT[i];
      stepping[i] = planters[i].stepping;
      maxLift[i] = Math.max(maxLift[i], out.y);
    }
  }
  return { events, maxLift, durations, out: planters.map(p => ({ ...p.out })) };
}
{
  const f = simulate({ leader: 0, lateral: false });
  check('walking forward: the lead foot steps first', f.events[0] === 0, `order ${f.events.join(',')}`);
  check('…and the feet alternate after that', f.events.length >= 3 && f.events.every((e, i) => i === 0 || e !== f.events[i - 1]), `order ${f.events.join(',')}`);
  check('the trailing foot lifts less than the leader', f.maxLift[1] < f.maxLift[0], `${f.maxLift[1].toFixed(3)} < ${f.maxLift[0].toFixed(3)}`);
  check('the trailing foot\'s step is quicker', f.durations[1] !== null && f.durations[0] !== null && f.durations[1] < f.durations[0], `${f.durations[1]?.toFixed(3)} vs ${f.durations[0]?.toFixed(3)}`);
  check('the feet never cross: the rear foot stays behind the lead foot', f.out[1].x < f.out[0].x, `rear ${f.out[1].x.toFixed(2)} lead ${f.out[0].x.toFixed(2)}`);
}
{
  const b = simulate({ leader: 1, lateral: false });
  check('walking back: the rear foot steps first', b.events[0] === 1, `order ${b.events.join(',')}`);
}
{
  const s = simulate({ leader: 1, lateral: true });
  const f = simulate({ leader: 0, lateral: false });
  check('sideways: the near foot steps first', s.events[0] === 1, `order ${s.events.join(',')}`);
  check('sideways steps are shuffles: quicker and lower than a forward step', s.durations[1] < f.durations[0] && s.maxLift[1] < f.maxLift[0], `${s.durations[1]?.toFixed(3)} s / ${s.maxLift[1].toFixed(3)} m vs ${f.durations[0]?.toFixed(3)} s / ${f.maxLift[0].toFixed(3)} m`);
  check('sideways: the stance width is kept (feet do not cross laterally)', s.out[1].z > s.out[0].z, `rear z ${s.out[1].z.toFixed(2)} lead z ${s.out[0].z.toFixed(2)}`);
}

done();
