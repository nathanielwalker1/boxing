// npm run mocap — Mixamo clip folder -> raw JSON cache -> stats + auto labels -> inventory + contact sheets.
// MOCAP_DIR overrides the clip folder; BLENDER overrides the Blender path; MOCAP_SHEETS=1 or --sheets forces a
// sheet redraw (sheets are otherwise redrawn only when something was extracted).
// Only new or changed files (size / mtime vs .cache/mocap/manifest.json) go through Blender.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clipStats } from './stats.mjs';
import { classify, findDuplicates } from './classify.mjs';
import { writeInventory } from './inventory.mjs';
import { renderSheets } from './sheets.mjs';
import { bake } from './bake.mjs';

const t0 = Date.now();
const RAW_FORMAT = 'mocap-raw/2';   // must match FORMAT in extract.py
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = process.env.MOCAP_DIR || '/Users/nathanielwalker/Downloads/Mixamo';
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
const cache = resolve(root, '.cache/mocap');
const rawDir = join(cache, 'raw');
const manifestPath = join(cache, 'manifest.json');
mkdirSync(rawDir, { recursive: true });

// "Boxing (3).fbx" -> boxing_3 ; "Head Hit.fbx copy" -> head_hit_copy
export const slugOf = (name) => name.replace(/\.fbx/i, ' ').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

const files = readdirSync(dir).filter((n) => /\.fbx( copy\d*)?$/i.test(n)).sort();
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
const clips = [];
const seen = new Set();
for (const file of files) {
  const st = statSync(join(dir, file));
  let slug = slugOf(file);
  while (seen.has(slug)) slug += '_x';
  seen.add(slug);
  clips.push({ slug, file, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
}
const todo = clips.filter((c) => {
  const m = manifest[c.slug];
  return !m || m.fmt !== RAW_FORMAT || m.size !== c.size || m.mtimeMs !== c.mtimeMs || m.file !== c.file || !existsSync(join(rawDir, c.slug + '.json'));
});

let extracted = 0;
if (todo.length) {
  if (!existsSync(blender)) { console.error(`Blender not found at ${blender} (set BLENDER)`); process.exit(1); }
  const jobPath = join(cache, 'job.json');
  writeFileSync(jobPath, JSON.stringify(todo.map((c) => ({ fbx: join(dir, c.file), out: join(rawDir, c.slug + '.json') }))));
  console.log(`extracting ${todo.length} clip(s) in one Blender process...`);
  const r = spawnSync(blender, ['--background', '--python-exit-code', '1', '--python', resolve(root, 'tools/mocap/extract.py'), '--', jobPath],
    { cwd: cache, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  for (const line of out.split('\n')) if (/^MOCAP_(OK|FAIL|DONE)/.test(line)) console.log('  ' + line);
  if (r.status !== 0) { console.error(out.slice(-3000)); process.exit(r.status ?? 1); }
  for (const c of todo) {
    if (existsSync(join(rawDir, c.slug + '.json'))) { manifest[c.slug] = { file: c.file, size: c.size, mtimeMs: c.mtimeMs, fmt: RAW_FORMAT }; extracted++; }
  }
  unlinkSync(jobPath);
}
// forget clips whose FBX is gone
for (const slug of Object.keys(manifest)) if (!clips.some((c) => c.slug === slug)) delete manifest[slug];
writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
const tExtract = Date.now();

const overridesPath = resolve(root, 'tools/mocap/overrides.json');
const overrides = existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {};
const rows = [];
const raws = {};
for (const c of clips) {
  const p = join(rawDir, c.slug + '.json');
  if (!existsSync(p)) { console.warn(`no raw for ${c.slug} (extract failed)`); continue; }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  raws[c.slug] = raw;
  const s = clipStats(raw);
  rows.push({ ...c, stats: s, ...classify(s, c, overrides[c.slug]) });
}
findDuplicates(rows, raws);
writeFileSync(join(cache, 'stats.json'), JSON.stringify(rows.map(({ stats, ...rest }) => ({ ...rest, stats })), null, 1));
const baked = bake(resolve(root, 'public/fighter/clips'), rows, raws);
writeInventory(resolve(root, 'docs/anim/MOCAP_INVENTORY.md'), rows, JSON.parse(readFileSync(resolve(root, 'public/fighter/clips/roles.json'), 'utf8')));
console.log(`baked ${baked.clips} clips -> public/fighter/clips (${(baked.bytes / 1e6).toFixed(2)} MB), roles: ${baked.roles}`);

const sheetDir = resolve(root, 'scripts/output/mocap_sheets');
if (extracted || process.env.MOCAP_SHEETS === '1' || process.argv.includes('--sheets') || !existsSync(join(sheetDir, 'sheet_01.png'))) {
  const n = await renderSheets(sheetDir, rows, raws);
  console.log(`${n} contact sheet(s) -> ${sheetDir}`);
}
console.log(`${clips.length} clips, ${extracted} extracted (${((tExtract - t0) / 1000).toFixed(1)} s), total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
