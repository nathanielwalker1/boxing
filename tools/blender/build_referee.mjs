// The Meshy referee -> game file:  node tools/blender/build_referee.mjs        (PROBE=1: measure + renders only)
//   -> public/fighter/referee.glb: mesh + the boxers' 52-bone Mixamo skeleton (same names, same rest layout), the
//      baked colour / normal / roughness embedded in the glb (one material; he is never tinted or masked).
// Input: env REF_ZIP (default: Nate's download in "boxer model/", see docs/ASSETS.md), unpacked once into
// .cache/meshy/<zip name>/ (gitignored). Runs Blender headless on build_referee.py. Blender exits 0 on a Python
// error, so a build that did not rewrite the glb is a failed build (look for a Traceback in the log).
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const blender = process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender';
if (!existsSync(blender)) { console.error(`Blender not found at ${blender} (set BLENDER)`); process.exit(1); }
const zip = process.env.REF_ZIP
  || '/Users/nathanielwalker/repos/boxinggame/boxer model/Meshy_AI_stylized_boxing_referee_20261125_image-to-3d-texture_fbx.zip';
if (!existsSync(zip)) { console.error(`zip not found: ${zip} (set REF_ZIP)`); process.exit(1); }

/** Minimal zip reader (stored / deflate entries, no zip64): writes every file entry flat into dir (as build_meshy.mjs). */
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
    writeFileSync(join(dir, basename(entry)), data);
    console.log(`unzipped ${basename(entry).padEnd(60)} ${(data.length / 1e6).toFixed(1)} MB`);
  }
}

const cache = resolve(root, '.cache/meshy', basename(zip, '.zip'));
if (!existsSync(cache) || !readdirSync(cache).some(f => f.toLowerCase().endsWith('.fbx'))) unzip(zip, cache);
const outDir = resolve(root, 'public/fighter');
const glb = resolve(outDir, 'referee.glb');
const shots = resolve(root, 'scripts/output');
mkdirSync(shots, { recursive: true });
const t0 = Date.now();
const r = spawnSync(blender, ['--background', '--python', resolve(root, 'tools/blender/build_referee.py'), '--',
  cache, glb, shots, process.env.PROBE ? 'probe' : 'build'], { stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`blender ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (process.env.PROBE) process.exit(0);
if (!existsSync(glb) || statSync(glb).mtimeMs < t0) { console.error(`BUILD FAILED: ${glb} was not written by this run (look for a Traceback above)`); process.exit(1); }
console.log(`referee.glb ${(statSync(glb).size / 1e6).toFixed(2)} MB`);
