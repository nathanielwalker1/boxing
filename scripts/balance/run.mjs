/**
 * run.mjs — the balance run (`npm run balance -- <what> [fights] [label] [cfg json]`). Bundles the rules from src/ once,
 * fights the plan across worker threads, writes one JSON line a fight to scripts/output/balance/<label>.jsonl
 * (a re-run with the same label resumes), then prints the report tables.
 *   what    styles   every style pairing at medium, shared body, corners swapped     (default)
 *           exploit  each exploit bot against each medium style
 *           ladder   hard vs easy inside each style and across styles
 *           all      the three above
 *           a:b      one pairing, e.g. pressure:swarmer
 *   fights  per pairing, default 100 (half from each corner)
 *   label   output name, default <what>
 *   cfg     config overrides for the whole run, e.g. '{"roundSeconds":30}'
 * Rounds are 60 s (the menu default), set by BASE_CFG below.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { build } from 'esbuild';

const WHAT = process.argv[2] || 'styles', FIGHTS = +(process.argv[3] || 100), LABEL = process.argv[4] || WHAT.replace(':', '_');
const BASE_CFG = { roundSeconds: 60 };
const CFG = { ...BASE_CFG, ...(process.argv[5] ? JSON.parse(process.argv[5]) : {}) };
const WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));
const OUTDIR = fileURLToPath(new URL('../output/balance/', import.meta.url));
const OUT = OUTDIR + LABEL + '.jsonl';
mkdirSync(OUTDIR, { recursive: true });

const tb = Date.now();
await build({ entryPoints: [fileURLToPath(new URL('./entry.ts', import.meta.url))], outfile: OUTDIR + 'game.mjs', bundle: true, format: 'esm', platform: 'node', logLevel: 'error' });
if (WHAT === 'bundle') { console.log('bundled'); process.exit(0); }   // `npm run balance -- bundle`: refresh the rules for micro.mjs / micro2.mjs / _debug.mjs
const { runJobs } = await import('./pool.mjs');

const STYLES = ['pressure', 'outboxer', 'counter', 'swarmer', 'slugger'];
const EXPLOIT = ['spam_jab_head', 'spam_jab_body', 'spam_cross_head', 'spam_cross_body', 'spam_hook_head', 'spam_hook_body',
  'spam_upper_head', 'spam_upper_body', 'power_only', 'high_low', 'high_low_mix', 'runner', 'runner_pot', 'turtle', 'turtle_counter'];
const ai = (style, diff) => ({ kind: 'ai', style, diff });
const name = p => p.kind === 'bot' ? p.bot : `${p.style}${p.diff}`;
const jobs = [];
let sb = 1000;
/** n fights: n/2 seeds, each fought from both corners. */
function pair(tag, a, b, n) {
  sb += 500;
  for (let k = 0; k < Math.ceil(n / 2); k++) for (const swap of [0, 1]) {
    const seed = sb + k * 37;
    jobs.push({ tag, a: name(a), b: name(b), p0: swap ? b : a, p1: swap ? a : b, seed, swap, cfg: CFG, key: `${tag}|${name(a)}|${name(b)}|${seed}|${swap}` });
  }
}
const want = w => WHAT === w || WHAT === 'all';
const who = n => EXPLOIT.includes(n) ? { kind: 'bot', bot: n, style: 'pressure' } : ai(n, 1);
if (WHAT.includes(':')) { const [a, b] = WHAT.split(':'); pair(EXPLOIT.includes(a) || EXPLOIT.includes(b) ? 'exploit' : 'style_med', who(a), who(b), FIGHTS); }
// spam: the one-punch and power-loop bots against three styles, `fights` each (the repetition check, a third the size of `exploit`)
if (WHAT === 'spam') for (const b of EXPLOIT.filter(n => n.startsWith('spam_') || n.startsWith('high_low') || n === 'power_only')) for (const s of ['pressure', 'counter', 'swarmer']) pair('exploit', who(b), ai(s, 1), FIGHTS);
if (want('styles')) for (let i = 0; i < STYLES.length; i++) for (let j = i + 1; j < STYLES.length; j++) pair('style_med', ai(STYLES[i], 1), ai(STYLES[j], 1), FIGHTS);
if (want('exploit')) for (const b of EXPLOIT) for (const s of STYLES) pair('exploit', { kind: 'bot', bot: b, style: 'pressure' }, ai(s, 1), Math.max(2, Math.round(FIGHTS / 5)));
if (want('ladder')) for (const s of STYLES) {
  pair('ladder_in', ai(s, 2), ai(s, 0), Math.max(2, Math.round(FIGHTS / 5)));
  for (const o of STYLES) if (o !== s) pair('ladder_x', ai(s, 2), ai(o, 0), Math.max(2, Math.round(FIGHTS / 20)));
}
if (!jobs.length) { console.log(`nothing to run for "${WHAT}"`); process.exit(1); }

const done = new Set();
if (existsSync(OUT)) for (const line of readFileSync(OUT, 'utf8').split('\n')) if (line) done.add(JSON.parse(line).key);
const todo = jobs.filter(j => !done.has(j.key));
console.log(`${WHAT}: ${jobs.length} fights planned, ${done.size} already in ${LABEL}.jsonl, ${todo.length} to run on ${WORKERS} workers (bundle ${((Date.now() - tb) / 1000).toFixed(1)} s)`);
const t0 = Date.now();
// each fight is written as it finishes, so a stopped run keeps what it did and the next one resumes
const res = await runJobs(todo, WORKERS, (n, of, m) => {
  appendFileSync(OUT, JSON.stringify({ key: m.key, tag: m.tag, a: m.a, b: m.b, seed: m.seed, swap: m.swap, r: m.r }) + '\n');
  if (n % 100 === 0) console.log(`  ${n}/${of} fights, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
});
const secs = (Date.now() - t0) / 1000;
console.log(`ran ${res.length} fights in ${secs.toFixed(0)} s (${res.length ? (secs / res.length).toFixed(2) : '-'} s a fight wall clock)\n`);
const rep = spawnSync('node', [fileURLToPath(new URL('./report.mjs', import.meta.url)), LABEL], { encoding: 'utf8' });
console.log(rep.stdout + rep.stderr);
process.exit(0);
