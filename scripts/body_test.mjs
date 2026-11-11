/** body_test.mjs — sizes from spec are sane, ordered, and reach-honest. */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [{ bodyDims, createConfig, ROSTER, restFighterState, punchFixture }] = await load('/src/core/index.ts');
const cfg = createConfig();

for (const spec of ROSTER) {
  const d = bodyDims(spec, cfg);
  check(`${spec.id}: head top ≈ height`, near(d.headY + d.headR, spec.heightM, 1e-9), `${d.headY + d.headR} vs ${spec.heightM}`);
  check(`${spec.id}: joints stack hip < shoulder < head`, d.hipY < d.shoulderY && d.shoulderY < d.headY);
  check(`${spec.id}: glove is gloveScale × fist`, near(d.gloveR, d.headR * 0.42 * cfg.gloveScale, 1e-9));
  const reach = d.shoulderW + 2 * (d.upperArm + d.forearm + d.gloveR);
  check(`${spec.id}: modelled reach within 15% of spec reach`, Math.abs(reach - spec.reachM) / spec.reachM < 0.15, `${reach.toFixed(3)} vs ${spec.reachM}`);
  check(`${spec.id}: all dims positive`, Object.values(d).every(v => v > 0));
}

// Taller fighter → taller everything, same proportions.
const tall = { ...ROSTER[0], heightM: 1.95, reachM: 2.0 }, short = { ...ROSTER[0], heightM: 1.65, reachM: 1.7 };
const dt = bodyDims(tall, cfg), ds = bodyDims(short, cfg);
check('taller → bigger head, longer legs, higher hip', dt.headR > ds.headR && dt.thigh > ds.thigh && dt.hipY > ds.hipY);
// Build morphs (overhaul 2026-11-11): each one moves what it says, and nothing else it should not.
const base = ROSTER[0], d0 = bodyDims(base, cfg);
const withMorph = m => bodyDims({ ...base, morph: { ...base.morph, ...m } }, cfg);
check('more muscle → wider torso and shoulders than less', withMorph({ muscle: 0.9 }).bodyR > withMorph({ muscle: -0.5 }).bodyR && withMorph({ muscle: 0.9 }).shoulderW > withMorph({ muscle: -0.5 }).shoulderW);
check('muscle −0.5 is the old lean (×0.9), +0.9 the old heavy (×1.18)', near(withMorph({ muscle: -0.5 }).bodyR, d0.bodyR * 0.9, 1e-12) && near(withMorph({ muscle: 0.9 }).bodyR, d0.bodyR * 1.18, 1e-12));
check('frame → wider shoulders and hips, same height', withMorph({ frame: 1 }).shoulderW > d0.shoulderW && withMorph({ frame: 1 }).hipW > d0.hipW && withMorph({ frame: 1 }).headY === d0.headY);
check('body fat adds girth; being shredded does not shrink the capsule', withMorph({ bodyFat: 1 }).bodyR > d0.bodyR && withMorph({ bodyFat: -1 }).bodyR === d0.bodyR);
check('limb length → longer legs, shorter torso, same height', withMorph({ limbLength: 1 }).hipY > d0.hipY && withMorph({ limbLength: 1 }).chestLen < d0.chestLen && withMorph({ limbLength: 1 }).headY === d0.headY);
check('a thick neck is a short one: shoulders rise, head stays', withMorph({ neck: 1 }).neckLen < d0.neckLen && withMorph({ neck: 1 }).shoulderY > d0.shoulderY && withMorph({ neck: 1 }).headY === d0.headY);
check('head shape never moves a sim dimension', JSON.stringify(withMorph({ head: { width: 1, jaw: 1, chin: 1, brow: 1, nose: 1, ears: 1, height: 1 } })) === JSON.stringify(d0));

// Rest state: hitboxes are where the body is.
const s = restFighterState(ROSTER[0], cfg, { x: 0.5, z: -0.2 }, 0);
check('rest head box sits at headY above pos', near(s.headBox.y, s.body.headY) && near(s.headBox.x, 0.5) && near(s.headBox.z, -0.2));
check('rest body capsule spans hip→shoulder', near(s.bodyBox.a.y, s.body.hipY) && near(s.bodyBox.b.y, s.body.shoulderY));
check('orthodox lead glove is on the left (−z when facing +x)', s.gloves[0].pos.z < s.pos.z && s.gloves[1].pos.z > s.pos.z);
check('lead glove is further forward than rear at rest', s.gloves[0].pos.x > s.gloves[1].pos.x);

// Punch fixture: full extension puts the glove near reach, recovers to guard.
const ext = punchFixture(ROSTER[0], cfg, { x: 0, z: 0 }, 0, 'cross', 'rear', 0.55);
const rest = restFighterState(ROSTER[0], cfg, { x: 0, z: 0 }, 0);
check('cross at peak reaches forward', ext.gloves[1].pos.x > rest.gloves[1].pos.x + 0.4, `${ext.gloves[1].pos.x.toFixed(2)}`);
const rec = punchFixture(ROSTER[0], cfg, { x: 0, z: 0 }, 0, 'cross', 'rear', 1);
check('cross at p=1 is back at rest', near(rec.gloves[1].pos.x, rest.gloves[1].pos.x, 1e-6));
const hook = punchFixture(ROSTER[0], cfg, { x: 0, z: 0 }, 0, 'hook', 'lead', 0.25);
check('hook cocks wide on its own side', hook.gloves[0].pos.z < rest.gloves[0].pos.z - 0.2);
check('hook at p=0 is the guard', near(punchFixture(ROSTER[0], cfg, { x: 0, z: 0 }, 0, 'hook', 'lead', 0).gloves[0].pos.z, rest.gloves[0].pos.z));
const upCock = punchFixture(ROSTER[0], cfg, { x: 0, z: 0 }, 0, 'uppercut', 'rear', 0.25);
const upPeak = punchFixture(ROSTER[0], cfg, { x: 0, z: 0 }, 0, 'uppercut', 'rear', 0.6);
check('uppercut cocks below the guard', upCock.gloves[1].pos.y < rest.gloves[1].pos.y - 0.2);
check('uppercut peak rises above the head', upPeak.gloves[1].pos.y > rest.body.headY);

// Facing π mirrors x.
const faced = restFighterState(ROSTER[0], cfg, { x: 0, z: 0 }, Math.PI);
check('yaw π: lead glove is at +z, forward is -x', faced.gloves[0].pos.z > 0 && faced.gloves[0].pos.x < faced.gloves[1].pos.x);

done();
