/**
 * check.js — the one assertion helper. Every test script uses it so the runner
 * can parse "N/N checks passed" and so a failing script prints exactly what
 * was expected and what it got, nothing else.
 *
 *   import { check, near, done } from './check.js';
 *   check('rng repeats for a seed', a === b, `got ${a} vs ${b}`);
 *   done();   // prints the tally and exits non-zero on any failure
 */
let passed = 0, failed = 0;

export function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else      { failed++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  return !!cond;
}

export function near(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

export function done() {
  const total = passed + failed;
  console.log(`\n${passed}/${total} checks passed`);
  process.exit(failed ? 1 : 0);
}
