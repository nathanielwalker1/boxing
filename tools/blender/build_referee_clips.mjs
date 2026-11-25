// The referee's own Mixamo clips -> public/fighter/referee_clips/{index.json,clips.bin}:  node tools/blender/build_referee_clips.mjs
// The same steps as `npm run mocap` (tools/mocap: extract.py in Blender, stats, labels, bake), into a separate library so
// the boxers' clip set and roles.json are never touched. Input: the .fbx files in REF_CLIPS_DIR (default: Nate's
// "boxer model" folder: idles, walks, strafes, a nod, counting). Raw cache in .cache/mocap_ref (gitignored).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipStats } from '../mocap/stats.mjs';
import { classify } from '../mocap/classify.mjs';
import { bake } from '../mocap/bake.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.REF_CLIPS_DIR || '/Users/nathanielwalker/repos/boxinggame/boxer model';
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const cache = resolve(root, '.cache/mocap_ref');
const rawDir = join(cache, 'raw');
mkdirSync(rawDir, { recursive: true });
const slugOf = (name) => name.replace(/\.fbx/i, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
const clips = readdirSync(dir).filter(n => /\.fbx$/i.test(n)).sort().map(file => ({ slug: slugOf(file), file, size: statSync(join(dir, file)).size }));
const todo = clips.filter(c => !existsSync(join(rawDir, c.slug + '.json')));
if (todo.length) {
  const jobPath = join(cache, 'job.json');
  writeFileSync(jobPath, JSON.stringify(todo.map(c => ({ fbx: join(dir, c.file), out: join(rawDir, c.slug + '.json') }))));
  console.log(`extracting ${todo.length} clip(s)...`);
  const r = spawnSync(blender, ['--background', '--python-exit-code', '1', '--python', resolve(root, 'tools/mocap/extract.py'), '--', jobPath],
    { cwd: cache, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const line of out.split('\n')) if (/^MOCAP_(OK|FAIL|DONE)|Traceback/.test(line)) console.log('  ' + line);
  if (r.status !== 0) { console.error(out.slice(-3000)); process.exit(r.status ?? 1); }
}
const rows = [], raws = {};
for (const c of clips) {
  const p = join(rawDir, c.slug + '.json');
  if (!existsSync(p)) { console.warn(`no raw for ${c.slug} (extract failed)`); continue; }
  raws[c.slug] = JSON.parse(readFileSync(p, 'utf8'));
  const s = clipStats(raws[c.slug]);
  rows.push({ ...c, stats: s, ...classify(s, c, undefined) });
}
const out = resolve(root, 'public/fighter/referee_clips');
mkdirSync(out, { recursive: true });
const b = bake(out, rows, raws);
console.log(`baked ${b.clips} clips -> ${out} (${(b.bytes / 1e6).toFixed(2)} MB)`);
for (const r of rows) console.log(`  ${r.slug.padEnd(36)} ${String(r.stats?.frames ?? '').padStart(4)} frames  ${r.label ?? ''}`);
