// Turns a Meshy generation (FBX + baked textures, no rig) into a game fighter:  npm run asset:meshy [name]
//   -> public/fighter/boxer_<name>.glb (mesh + 52-bone Mixamo skeleton, no animation) and, next to it,
//      boxer_<name>_c.webp (base colour 2048), _n (normal 2048), _r (roughness 1024),
//      _mask.webp (R trunks, G gloves, B boots; 1024) and _skin.webp (R skin, G hair; 1024).
// Input: env MESHY_ZIP (default: Nate's download, see docs/ASSETS.md). The zip is unpacked once into
// .cache/meshy/<zip name>/ (gitignored); raw downloads never go in git. Runs Blender headless on build_meshy.py.
//   PROBE=1 npm run asset:meshy   only measures the body and renders "before" images (no export).
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!existsSync(blender)) { console.error(`Blender not found at ${blender} (set BLENDER)`); process.exit(1); }
const zip = process.env.MESHY_ZIP
  || '/Users/nathanielwalker/Downloads/boxer-models/Meshy_AI_Realistic_Male_Boxer_20261117_image-to-3d-texture_fbx.zip';
const name = process.argv[2] || 'm1';
if (!/^[A-Za-z0-9_]+$/.test(name)) { console.error('name: letters, digits, _ only (e.g. m1)'); process.exit(1); }
if (!existsSync(zip)) { console.error(`zip not found: ${zip} (set MESHY_ZIP)`); process.exit(1); }

/** Minimal zip reader (stored / deflate entries, no zip64): writes every file entry flat into dir. */
function unzip(file, dir) {
  const b = readFileSync(file);
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a zip (no end record)');
  const n = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  mkdirSync(dir, { recursive: true });
  for (let k = 0; k < n; k++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const entry = b.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    if (entry.endsWith('/')) continue;
    const ds = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(ds, ds + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip method ${method} for ${entry}`);
    const out = join(dir, basename(entry));   // flat: no path components from the archive
    writeFileSync(out, data);
    console.log(`unzipped ${basename(entry).padEnd(60)} ${(data.length / 1e6).toFixed(1)} MB`);
  }
}

const cache = resolve(root, '.cache/meshy', basename(zip, '.zip'));
if (!existsSync(cache) || !readdirSync(cache).some(f => f.toLowerCase().endsWith('.fbx'))) unzip(zip, cache);
// the glove is a separate, swappable part: one LEFT glove (closed fist) from its own Meshy zip; mirrored for the right
const gloveZip = process.env.GLOVE_ZIP
  || '/Users/nathanielwalker/repos/boxinggame/boxer model/Meshy_AI_RedBoxingGlove3D_20261124_image-to-3d-texture_fbx.zip';
const gloveName = process.env.GLOVE_NAME || 'g1';
if (!existsSync(gloveZip)) { console.error(`glove zip not found: ${gloveZip} (set GLOVE_ZIP)`); process.exit(1); }
const gloveCache = resolve(root, '.cache/meshy', basename(gloveZip, '.zip'));
if (!existsSync(gloveCache) || !readdirSync(gloveCache).some(f => f.toLowerCase().endsWith('.fbx'))) unzip(gloveZip, gloveCache);
// the trunks are a separate, swappable part too: cut from a full-body T-pose boxer wearing them (same zip layout as a body)
const trunksZip = process.env.TRUNKS_ZIP || '/Users/nathanielwalker/repos/boxinggame/boxer model/vintage trunks.zip';
const trunksName = process.env.TRUNKS_NAME || 't1';
if (!existsSync(trunksZip)) { console.error(`trunks zip not found: ${trunksZip} (set TRUNKS_ZIP)`); process.exit(1); }
const trunksCache = resolve(root, '.cache/meshy', basename(trunksZip, '.zip'));
if (!existsSync(trunksCache) || !readdirSync(trunksCache).some(f => f.toLowerCase().endsWith('.fbx'))) unzip(trunksZip, trunksCache);
const outDir = resolve(root, 'public/fighter');
const glb = resolve(outDir, `boxer_${name}.glb`);
const shots = resolve(root, 'scripts/output');
mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const r = spawnSync(blender, ['--background', '--python', resolve(root, 'tools/blender/build_meshy.py'), '--',
  cache, glb, `_${name}`, shots, process.env.PROBE === 'glove' ? 'probeglove' : process.env.PROBE ? 'probe' : 'build', gloveCache, gloveName, trunksCache, trunksName], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`blender ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (process.env.PROBE) process.exit(0);
let total = 0;
for (const f of readdirSync(outDir)) {
  if (!f.startsWith(`boxer_${name}`) && !f.startsWith(`glove_${gloveName}`) && !f.startsWith(`trunks_${trunksName}_`)) continue;
  const sz = statSync(resolve(outDir, f)).size;
  total += sz;
  console.log(`${f.padEnd(28)} ${(sz / 1e6).toFixed(2)} MB`);
}
console.log(`total ${(total / 1e6).toFixed(2)} MB`);
