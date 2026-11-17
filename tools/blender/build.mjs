// One command that rebuilds the boxer asset:  npm run asset:boxer
// Runs Blender headless on tools/blender/build_boxer.py -> public/fighter/boxer.glb (+ skin_dark.webp).
// Needs Blender (BLENDER env var overrides the macOS default), the MPFB extension and the MakeHuman
// system assets pack installed as described in docs/ASSETS.md.
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!existsSync(blender)) { console.error(`Blender not found at ${blender} (set BLENDER)`); process.exit(1); }
const glb = resolve(root, 'public/fighter/boxer.glb');
const dark = resolve(root, 'public/fighter/skin_dark.webp');
const r = spawnSync(blender, ['--background', '--python', resolve(root, 'tools/blender/build_boxer.py'), '--', glb, dark], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`boxer.glb ${(statSync(glb).size / 1e6).toFixed(2)} MB, skin_dark.webp ${(statSync(dark).size / 1e6).toFixed(2)} MB`);
