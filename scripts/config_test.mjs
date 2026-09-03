/** config_test.mjs — every tunable is well-formed and the flat Config matches the schema. */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [{ SCHEMA, createConfig, configGroups, SIM_DT, RING_SIZE }] = await load('/src/core/config.ts');

const keys = Object.keys(SCHEMA);
check('schema is non-empty', keys.length > 20, `${keys.length} keys`);

const badDesc = keys.filter(k => !SCHEMA[k].desc || SCHEMA[k].desc.length < 4);
check('every entry has a description', badDesc.length === 0, badDesc.join(', '));

const badRange = keys.filter(k => SCHEMA[k].kind === 'number' && !(SCHEMA[k].min < SCHEMA[k].max));
check('numeric entries have min < max', badRange.length === 0, badRange.join(', '));

const outOfRange = keys.filter(k => SCHEMA[k].kind === 'number' && (SCHEMA[k].value < SCHEMA[k].min || SCHEMA[k].value > SCHEMA[k].max));
check('numeric defaults sit inside their range', outOfRange.length === 0, outOfRange.join(', '));

const badStep = keys.filter(k => SCHEMA[k].kind === 'number' && !(SCHEMA[k].step > 0));
check('numeric entries have a positive step', badStep.length === 0, badStep.join(', '));

const badColor = keys.filter(k => SCHEMA[k].kind === 'color' && !/^#[0-9a-f]{6}$/i.test(SCHEMA[k].value));
check('colour entries are #rrggbb', badColor.length === 0, badColor.join(', '));

// Groups contiguous: once a group ends it never reappears.
const seen = new Set(); let lastGroup = null, contiguous = true;
for (const k of keys) {
  const g = SCHEMA[k].group;
  if (g !== lastGroup) { if (seen.has(g)) contiguous = false; seen.add(g); lastGroup = g; }
}
check('groups are contiguous in schema order', contiguous);
check('configGroups lists each group once', new Set(configGroups()).size === configGroups().length && configGroups().length === seen.size);

const cfg = createConfig();
check('createConfig has exactly the schema keys', Object.keys(cfg).length === keys.length && keys.every(k => k in cfg));
check('createConfig copies defaults', keys.every(k => cfg[k] === SCHEMA[k].value));
check('createConfig returns a fresh object each time', createConfig() !== cfg);

check('SIM_DT is 1/60', Math.abs(SIM_DT - 1 / 60) < 1e-12);
check('ring is 6.1 m', RING_SIZE === 6.1);

done();
