/**
 * roster_test.mjs — the roster of eight and the seeded generator (overhaul 2026-11-11).
 *   - `red` and `blue` are first, and their sim-facing BodyDims are the numbers
 *     the sim tests were tuned on (pinned here from before build became morphs)
 *   - ids unique, every spec in range, bodies plausible
 *   - generateFighter: deterministic, valid, no NaN, plausible over 200 seeds
 */
import { load } from './load.mjs';
import { check, near, done } from './check.js';

const [{ bodyDims, createConfig, ROSTER, REFEREE, generateFighter }] = await load('/src/core/index.ts');
const cfg = createConfig();

// Computed from the Stage-3 body.ts (build: 'athletic' / 'lean') before the change. Do not edit.
const PINNED = {
  red: { heightM: 1.8, reachM: 1.85, massKg: 79, headR: 0.14516129032258066, gloveR: 0.0975483870967742, bodyR: 0.15300000000000002, shoulderW: 0.468, hipW: 0.30600000000000005, neckLen: 0.07258064516129033, chestLen: 0.32510322580645173, spineLen: 0.2659935483870969, upperArm: 0.3366, forearm: 0.3366, thigh: 0.43992, shin: 0.40608, bootH: 0.08709677419354839, hipY: 0.846, headY: 1.6548387096774195, shoulderY: 1.4045864516129034 },
  blue: { heightM: 1.86, reachM: 1.96, massKg: 82, headR: 0.15, gloveR: 0.1008, bodyR: 0.14229000000000003, shoulderW: 0.45942, hipW: 0.31620000000000004, neckLen: 0.075, chestLen: 0.33594000000000007, spineLen: 0.27486000000000005, upperArm: 0.34782, forearm: 0.34782, thigh: 0.454584, shin: 0.419616, bootH: 0.09, hipY: 0.8742, headY: 1.71, shoulderY: 1.451406 },
};
const PINNED_SPEC = {
  red: { stance: 'orthodox', power: 68, speed: 62, chin: 70, stamina: 65, defense: 60 },
  blue: { stance: 'orthodox', power: 58, speed: 74, chin: 62, stamina: 70, defense: 72 },
};

check('roster has eight fighters', ROSTER.length === 8, `${ROSTER.length}`);
check('red and blue are the first two', ROSTER[0].id === 'red' && ROSTER[1].id === 'blue');
for (const id of ['red', 'blue']) {
  const spec = ROSTER.find(f => f.id === id);
  const d = bodyDims(spec, cfg);
  const bad = Object.keys(PINNED[id]).filter(k => d[k] !== PINNED[id][k]);
  check(`${id}: every sim-facing BodyDims field is bit-identical to the pinned value`, bad.length === 0, bad.map(k => `${k} ${d[k]} vs ${PINNED[id][k]}`).join('; '));
  const s = PINNED_SPEC[id];
  check(`${id}: stance and ratings unchanged`, Object.keys(s).every(k => spec[k] === s[k]));
}
check('ids are unique', new Set(ROSTER.map(f => f.id)).size === ROSTER.length);
check('names are unique', new Set(ROSTER.map(f => f.name)).size === ROSTER.length);

const STYLES = ['pressure', 'counter', 'outboxer', 'swarmer', 'slugger'];
const validSpec = (f) => {
  const m = f.morph;
  const morphs = [m.frame, m.muscle, m.bodyFat, m.limbLength, m.neck, ...Object.values(m.head)];
  const problems = [];
  if (!(f.heightM >= 1.6 && f.heightM <= 2.0)) problems.push(`height ${f.heightM}`);
  if (!(f.reachM >= f.heightM * 0.94 && f.reachM <= f.heightM * 1.1)) problems.push(`reach ${f.reachM} for ${f.heightM}`);
  if (!(f.massKg >= 48 && f.massKg <= 130)) problems.push(`mass ${f.massKg}`);
  if (!morphs.every(v => Number.isFinite(v) && v >= -1 && v <= 1)) problems.push('morph out of −1..1');
  if (Object.keys(m.head).length !== 7) problems.push('head morph fields');
  for (const k of ['power', 'speed', 'chin', 'stamina', 'defense']) if (!(Number.isInteger(f[k]) && f[k] >= 0 && f[k] <= 100)) problems.push(`${k} ${f[k]}`);
  if (!STYLES.includes(f.style)) problems.push(`style ${f.style}`);
  for (const k of ['skin', 'trunksPrimary', 'trunksSecondary', 'gloves', 'boots']) if (!/^#[0-9a-f]{6}$/i.test(f[k])) problems.push(`${k} ${f[k]}`);
  if (!f.name || !f.id) problems.push('name / id');
  return problems;
};
const validBody = (f) => {
  const d = bodyDims(f, cfg);
  const problems = [];
  if (!Object.values(d).every(v => Number.isFinite(v) && v > 0)) problems.push('non-finite or non-positive dim');
  if (!near(d.headY + d.headR, f.heightM, 1e-9)) problems.push('head top is not the height');
  if (!(d.hipY < d.shoulderY && d.shoulderY < d.headY - d.headR * 0.9)) problems.push('joints do not stack (hip < shoulder < chin)');
  if (!(d.shoulderW > d.hipW * 1.1)) problems.push(`shoulders ${d.shoulderW.toFixed(3)} not wider than hips ${d.hipW.toFixed(3)}`);
  if (!(d.bodyR > 0.09 && d.bodyR < 0.26)) problems.push(`bodyR ${d.bodyR.toFixed(3)}`);
  const legs = d.hipY / f.heightM, torso = (d.shoulderY - d.hipY) / f.heightM;
  if (!(legs > 0.42 && legs < 0.52)) problems.push(`legs ${legs.toFixed(3)} of height`);
  if (!(torso > 0.26 && torso < 0.36)) problems.push(`torso ${torso.toFixed(3)} of height`);
  const reach = d.shoulderW + 2 * (d.upperArm + d.forearm + d.gloveR);
  if (Math.abs(reach - f.reachM) / f.reachM > 0.15) problems.push(`modelled reach ${reach.toFixed(2)} vs ${f.reachM}`);
  return problems;
};
for (const f of ROSTER) {
  const p = [...validSpec(f), ...validBody(f)];
  check(`${f.id}: spec in range, body plausible`, p.length === 0, p.join('; '));
}
check('referee still has a body and an outfit', validBody(REFEREE).length === 0 && !!REFEREE.outfit, validBody(REFEREE).join('; '));

// The eight differ wildly.
const hs = ROSTER.map(f => f.heightM), ms = ROSTER.map(f => f.massKg);
check('heights span 1.63 – 1.98', Math.min(...hs) <= 1.63 && Math.max(...hs) >= 1.98, `${Math.min(...hs)}–${Math.max(...hs)}`);
check('masses span at least 45 kg', Math.max(...ms) - Math.min(...ms) >= 45, `${Math.min(...ms)}–${Math.max(...ms)}`);
check('every style is on the roster', STYLES.every(s => ROSTER.some(f => f.style === s)));
check('at least one southpaw', ROSTER.some(f => f.stance === 'southpaw'));
check('no two share a hair style', new Set(ROSTER.map(f => f.hair)).size === ROSTER.length);
const widths = ROSTER.map(f => bodyDims(f, cfg).bodyR / f.heightM);
check('torso girth (bodyR / height) spans ×1.5', Math.max(...widths) / Math.min(...widths) >= 1.5, `${(Math.max(...widths) / Math.min(...widths)).toFixed(2)}`);

// Generator.
check('same seed → identical spec', JSON.stringify(generateFighter(7)) === JSON.stringify(generateFighter(7)));
check('different seeds → different fighters', JSON.stringify(generateFighter(7)) !== JSON.stringify(generateFighter(8)));
let bad = [];
const seen = { styles: new Set(), hair: new Set(), stance: new Set(), cuts: new Set() };
let hMin = 9, hMax = 0;
for (let seed = 1; seed <= 200; seed++) {
  const f = generateFighter(seed);
  const p = [...validSpec(f), ...validBody(f)];
  if (p.length) bad.push(`seed ${seed}: ${p.join(', ')}`);
  if (f.id !== `gen-${seed}`) bad.push(`seed ${seed}: id ${f.id}`);
  seen.styles.add(f.style); seen.hair.add(f.hair); seen.stance.add(f.stance); seen.cuts.add(f.trunksStyle);
  hMin = Math.min(hMin, f.heightM); hMax = Math.max(hMax, f.heightM);
}
check('200 seeds: every spec valid, no NaN, plausible proportions', bad.length === 0, bad.slice(0, 4).join(' | '));
check('200 seeds: all five styles, both stances, ≥ 12 hair styles, ≥ 5 trunk cuts appear', seen.styles.size === 5 && seen.stance.size === 2 && seen.hair.size >= 12 && seen.cuts.size >= 5, `styles ${seen.styles.size}, hair ${seen.hair.size}, cuts ${seen.cuts.size}`);
check('200 seeds: heights use the range (≤ 1.68 and ≥ 1.92 both occur)', hMin <= 1.68 && hMax >= 1.92, `${hMin}–${hMax}`);
// Ratings fit the body: the heaviest tenth hit harder and move slower than the lightest tenth.
const all = Array.from({ length: 200 }, (_, i) => generateFighter(i + 1)).sort((a, b) => a.massKg - b.massKg);
const avg = (xs, k) => xs.reduce((s, f) => s + f[k], 0) / xs.length;
const light = all.slice(0, 20), heavy = all.slice(-20);
check('heavier fighters hit harder and are slower', avg(heavy, 'power') > avg(light, 'power') + 8 && avg(heavy, 'speed') < avg(light, 'speed') - 8, `power ${avg(light, 'power').toFixed(0)}→${avg(heavy, 'power').toFixed(0)}, speed ${avg(light, 'speed').toFixed(0)}→${avg(heavy, 'speed').toFixed(0)}`);

done();
