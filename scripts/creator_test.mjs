/**
 * creator_test.mjs — the create-your-fighter mapping (core/creator.ts): height and weight
 * alone set the ratings; the middle build plays exactly like today.
 */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [{ createConfig, defaultDraft, draftToSpec, buildRead, bodyDims, withBodyLock }] = await load('/src/core/index.ts');
const cfg = createConfig();
const R = ['power', 'speed', 'chin', 'stamina', 'defense'];
const sum = (s) => R.reduce((a, k) => a + s[k], 0);
const spec = (over) => draftToSpec({ ...defaultDraft(cfg), ...over }, cfg);

const mid = spec({});
check('middle draft: all five ratings are ratingNeutral', R.every(k => mid[k] === cfg.ratingNeutral), R.map(k => mid[k]).join(','));
check('id is my-fighter', mid.id === 'my-fighter');

const light = spec({ massKg: cfg.createMassMin }), heavy = spec({ massKg: cfg.createMassMax });
check('heavier: more power and chin, less speed and stamina',
  heavy.power > mid.power && mid.power > light.power && heavy.chin > mid.chin && mid.chin > light.chin &&
  heavy.speed < mid.speed && mid.speed < light.speed && heavy.stamina < mid.stamina && mid.stamina < light.stamina,
  `light ${R.map(k => light[k])} heavy ${R.map(k => heavy[k])}`);
check('min and max weight mirror each other around the middle build (rating sums, +-2)', Math.abs(sum(light) + sum(heavy) - 2 * sum(mid)) <= 2, `${sum(light)} ${sum(mid)} ${sum(heavy)}`);
check('defense is neutral for every build', [light, mid, heavy, spec({ heightM: 2.06 }), spec({ heightM: 1.78 })].every(s => s.defense === cfg.ratingNeutral));

const tall = spec({ heightM: cfg.createHeightMax }), small = spec({ heightM: cfg.createHeightMin });
check('taller: lower speed, more reach', tall.speed < mid.speed && mid.speed < small.speed && tall.reachM > mid.reachM && mid.reachM > small.reachM, `${tall.speed} ${mid.speed} ${small.speed}`);
check('reach is height x ratio', Math.abs(tall.reachM - tall.heightM * cfg.createReachRatio) < 0.006);

const over = spec({ heightM: 3, massKg: 400 }), under = spec({ heightM: 1, massKg: 10 }), nan = spec({ heightM: NaN, massKg: undefined });
check('out-of-range clamps to the ranges', over.heightM === cfg.createHeightMax && over.massKg === cfg.createMassMax && under.heightM === cfg.createHeightMin && under.massKg === cfg.createMassMin);
check('NaN / missing falls back to the middle', nan.heightM === mid.heightM && nan.massKg === mid.massKg);
check('ratings stay inside 30..97 and are integers', [over, under, tall, small, heavy, light].every(s => R.every(k => Number.isInteger(s[k]) && s[k] >= cfg.createRatingMin && s[k] <= cfg.createRatingMax)));

const empty = spec({ name: '   ', nickname: '', hometown: '\t' });
check('empty text falls back to defaults', !!empty.name && !!empty.nickname && !!empty.hometown && empty.name === empty.name.trim());
const long = spec({ name: '  ' + 'x'.repeat(80) + '  ', nickname: 'y'.repeat(30), hometown: 'z'.repeat(25) });
check('over-long text is capped at 24', long.name.length === 24 && long.nickname.length === 24 && long.hometown.length === 24);
check('text is trimmed', spec({ name: '  Ray   Jones ' }).name === 'Ray Jones');

check('same draft twice is a deep-equal spec', JSON.stringify(spec({ name: 'A', heightM: 1.99, massKg: 117 })) === JSON.stringify(spec({ name: 'A', heightM: 1.99, massKg: 117 })));
check('skin tone and colours carry through', spec({ skinTone: 'dark' }).skin === cfg.createSkinDark && spec({ skinTone: 'light' }).skin === cfg.createSkinLight && spec({ gloves: '#123456' }).gloves === '#123456' && spec({ boots: 'bogus' }).boots === mid.boots);
check('stance carries through', spec({ stance: 'southpaw' }).stance === 'southpaw');

// Validity: roster_test's rules, with the height ceiling widened to this mode's range (2.06 m).
const STYLES = ['pressure', 'counter', 'outboxer', 'swarmer', 'slugger'];
const problems = (f) => {
  const m = f.morph, p = [];
  const morphs = [m.frame, m.muscle, m.bodyFat, m.limbLength, m.neck, ...Object.values(m.head)];
  if (!(f.heightM >= 1.6 && f.heightM <= 2.1)) p.push(`height ${f.heightM}`);
  if (!(f.reachM >= f.heightM * 0.94 && f.reachM <= f.heightM * 1.1)) p.push('reach');
  if (!(f.massKg >= 48 && f.massKg <= 130)) p.push(`mass ${f.massKg}`);
  if (!morphs.every(v => Number.isFinite(v) && v >= -1 && v <= 1) || Object.keys(m.head).length !== 7) p.push('morph');
  for (const k of R) if (!(Number.isInteger(f[k]) && f[k] >= 0 && f[k] <= 100)) p.push(k);
  if (!STYLES.includes(f.style)) p.push('style');
  for (const k of ['skin', 'trunksPrimary', 'trunksSecondary', 'gloves', 'boots']) if (!/^#[0-9a-f]{6}$/i.test(f[k])) p.push(k);
  if (!f.name || !f.id) p.push('name/id');
  const d = bodyDims(f, cfg);
  if (!Object.values(d).every(v => Number.isFinite(v) && v > 0)) p.push('bodyDims');
  return p;
};
const grid = [];
for (const h of [1.78, 1.92, 2.06]) for (const w of [91, 108, 125]) grid.push(spec({ heightM: h, massKg: w }));
check('all nine corner / middle builds pass the validity rules', grid.every(g => problems(g).length === 0), grid.map(problems).filter(x => x.length).join(' | '));

const reads = new Set();
for (const h of [1.78, 1.92, 2.06]) for (const w of [91, 108, 125]) reads.add(buildRead({ ...defaultDraft(cfg), heightM: h, massKg: w }, cfg));
check('build read: one sentence per band, at least 5 variants', reads.size >= 5 && [...reads].every(s => s.length > 20 && s.endsWith('.')), `${reads.size}`);
check('build read: tall and light matches the brief', buildRead({ ...defaultDraft(cfg), heightM: 2.06, massKg: 91 }, cfg) === 'Tall and light: long reach and quick hands, but easier to hurt.');

// The body lock: a locked save keeps its height and weight whatever an edit says.
const saved = { ...defaultDraft(cfg), heightM: 2.0, massKg: 120, locked: true, name: 'Old' };
const hacked = { ...defaultDraft(cfg), heightM: 1.78, massKg: 91, name: 'New', skinTone: 'dark', gloves: '#123456', stance: 'southpaw' };
const kept = draftToSpec(withBodyLock(saved, hacked), cfg);
check('locked: an edited draft keeps the saved height and weight', kept.heightM === 2 && kept.massKg === 120, kept.heightM + ' ' + kept.massKg);
check('locked: ratings and reach follow the saved body, not the incoming one', kept.power === spec({ heightM: 2.0, massKg: 120 }).power && kept.reachM === spec({ heightM: 2.0 }).reachM);
check('locked: name, stance, skin and kit still change', kept.name === 'New' && kept.stance === 'southpaw' && kept.skin === cfg.createSkinDark && kept.gloves === '#123456');
check('locked: stays locked whatever the incoming draft claims', withBodyLock(saved, { ...hacked, locked: false }).locked === true);
check('locked: out-of-range incoming values cannot move it either', draftToSpec(withBodyLock(saved, { ...hacked, heightM: 9, massKg: 999 }), cfg).massKg === 120);
check('unlocked save: the edit passes through (height and weight move)', draftToSpec(withBodyLock({ ...saved, locked: false }, hacked), cfg).heightM === 1.78 && withBodyLock(null, hacked).heightM === 1.78);
check('lock flag: stepping in locks, an unlocked try-out does not', withBodyLock(null, hacked, true).locked === true && withBodyLock(null, hacked, false).locked === false);
check('default draft is unlocked', defaultDraft(cfg).locked === false);
check('withBodyLock does not mutate its inputs', JSON.stringify(saved) === JSON.stringify({ ...defaultDraft(cfg), heightM: 2.0, massKg: 120, locked: true, name: 'Old' }));

done();
