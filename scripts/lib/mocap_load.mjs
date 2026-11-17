/**
 * mocap_load.mjs — inject the baked mocap library into core/mocap.ts in a Node test (the browser does it in
 * main.ts through src/core/mocapLoad.ts). Pass the loaded '/src/core/mocap.ts' namespace.
 *   const [core, sim, mocap] = await load('/src/core/index.ts', '/src/sim/index.ts', '/src/core/mocap.ts');
 *   const lib = loadMocapLib(mocap);
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function loadMocapLib(mocap) {
  const dir = resolve(ROOT, 'public/fighter/clips');
  const index = JSON.parse(readFileSync(resolve(dir, 'index.json'), 'utf8'));
  const roles = JSON.parse(readFileSync(resolve(dir, 'roles.json'), 'utf8'));
  const bin = readFileSync(resolve(dir, 'clips.bin'));
  const glb = readFileSync(resolve(ROOT, 'public/fighter/boxer.glb'));
  const lib = mocap.buildMocapLib(index, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), roles, new Uint8Array(glb));
  mocap.setMocapLib(lib);
  return lib;
}
