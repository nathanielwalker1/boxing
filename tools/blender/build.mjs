// One command that rebuilds the boxer asset:  npm run asset:boxer          -> public/fighter/boxer.glb
//                                              node tools/blender/build.mjs boxer_v2 -> public/fighter/boxer_v2.glb
// Runs Blender headless on tools/blender/build_boxer.py. The optional argument is the output name; anything after
// "boxer" becomes the suffix of every texture the build writes (boxer_v2 -> skin_dark_v2.webp, glove_n_v2.webp, ...),
// so a new look can be built next to the one the game is using. Needs Blender (BLENDER env var overrides the macOS
// default), the MPFB extension and the MakeHuman system assets pack installed as described in docs/ASSETS.md.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!existsSync(blender)) { console.error(`Blender not found at ${blender} (set BLENDER)`); process.exit(1); }
const name = process.argv[2] || 'boxer';
if (!/^boxer[A-Za-z0-9_]*$/.test(name)) { console.error('output name must start with "boxer", e.g. boxer_v2'); process.exit(1); }
const suffix = name.slice('boxer'.length);
const outDir = resolve(root, 'public/fighter');
const glb = resolve(outDir, `${name}.glb`);
const dark = resolve(outDir, `skin_dark${suffix}.webp`);
const r = spawnSync(blender, ['--background', '--python', resolve(root, 'tools/blender/build_boxer.py'), '--', glb, dark, suffix],
  { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
let total = 0;
for (const f of readdirSync(outDir)) {
  const ours = f === `${name}.glb` || (f.endsWith(`${suffix}.webp`) && (suffix !== '' || !/_v\d+\.webp$/.test(f)));
  if (!ours) continue;
  const sz = statSync(resolve(outDir, f)).size;
  total += sz;
  console.log(`${f.padEnd(24)} ${(sz / 1e6).toFixed(2)} MB`);
}
console.log(`total ${(total / 1e6).toFixed(2)} MB`);
