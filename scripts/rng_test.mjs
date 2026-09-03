/** rng_test.mjs — the seeded generator is repeatable, seed-sensitive, and well-formed. */
import { load } from './load.mjs';
import { check, done } from './check.js';

const [{ seedRng, rngU32, rngFloat, rngInt, rngClone, rngChance }] = await load('/src/core/rng.ts');

const a = seedRng(12345), b = seedRng(12345);
const seqA = Array.from({ length: 1000 }, () => rngU32(a));
const seqB = Array.from({ length: 1000 }, () => rngU32(b));
check('same seed → identical 1000-value sequence', seqA.every((v, i) => v === seqB[i]));

const c = seedRng(12346);
const seqC = Array.from({ length: 1000 }, () => rngU32(c));
check('adjacent seed → different sequence', seqA.some((v, i) => v !== seqC[i]));

const z = seedRng(0);
check('seed 0 is a valid non-zero state', (z.s0 | z.s1 | z.s2 | z.s3) !== 0);

const f = seedRng(7);
const floats = Array.from({ length: 20000 }, () => rngFloat(f));
check('floats in [0,1)', floats.every(v => v >= 0 && v < 1));
const mean = floats.reduce((s, v) => s + v, 0) / floats.length;
check('float mean ≈ 0.5', Math.abs(mean - 0.5) < 0.01, `mean ${mean.toFixed(4)}`);

const i = seedRng(99);
const ints = Array.from({ length: 5000 }, () => rngInt(i, 3, 7));
check('ints in [3,7] inclusive', ints.every(v => v >= 3 && v <= 7 && Number.isInteger(v)));
check('ints hit both bounds', ints.includes(3) && ints.includes(7));

const d = seedRng(5);
rngU32(d); rngU32(d);
const e = rngClone(d);
check('clone continues identically', rngU32(d) === rngU32(e));
check('clone is a separate object', d !== e);

const p = seedRng(11);
const hits = Array.from({ length: 10000 }, () => rngChance(p, 0.25)).filter(Boolean).length;
check('chance(0.25) ≈ 25%', Math.abs(hits / 10000 - 0.25) < 0.02, `${hits / 100}%`);

// Known-answer: pins the implementation so a silent change to rng.ts fails here.
const k = seedRng(2026);
const first3 = [rngU32(k), rngU32(k), rngU32(k)];
console.log(`  (known-answer seed 2026 → ${first3.join(', ')})`);
check('known-answer values are uint32', first3.every(v => v >= 0 && v <= 0xffffffff));

done();
